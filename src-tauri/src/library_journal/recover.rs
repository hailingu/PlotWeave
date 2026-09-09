//! 删除事务的恢复内核（§7.2，issue #39 自 library_journal.rs 拆出）：恢复
//! 入口逐条消费日志，按「共享引用 → 索引仍引用 → 索引已去项」分支收敛——
//! 回迁/清理只动媒体与日志，不改 library.json 的权威索引状态。

use cap_std::fs::Dir as CapDir;
use serde_json::Value;

use crate::library_fs::{assets_root, open_parent_dir};
use crate::store::new_id;

use super::journal_io::{read_journal, write_journal, JournalEntry};
use super::trash::{
    ensure_trash_dir, fsync_dir, identity_bound_unlink, open_trash_dir, path_identity,
    restore_from_trash, verify_trash_identity, PathIdentity, TrashVerdict, TRASH_DIR,
};

/// 恢复结果：warnings 为恢复过程产生的诊断；cleanup_pending 为保留在隔离
/// 区的未清理项；conflicted 为冲突期不可用的 assetId（列表标记 + 导入拒绝
/// 服务）；read_only 表示日志异型、所有库写入/删除暂停。
#[derive(Default, Debug)]
pub(crate) struct Recovery {
    pub warnings: Vec<String>,
    pub cleanup_pending: Vec<String>,
    pub conflicted: Vec<String>,
    pub read_only: bool,
}

/// 原 relPath 的已绑定父目录句柄与终点名（父目录缺失返回 None）。
fn original_parent(assets: &CapDir, rel_path: &str) -> Result<Option<(CapDir, String)>, String> {
    let suffix = rel_path
        .strip_prefix("assets/")
        .ok_or_else(|| format!("日志 relPath 越出 assets/：{rel_path}"))?;
    open_parent_dir(assets, suffix)
}

/// 日志条目在规范化索引中的引用态：索引是否仍含该 assetId、其他条目是否
/// 引用同一文件位置（同 relPath 即同一物理文件——库资产 relPath 一文一位）。
struct IndexRefs {
    index_has: bool,
    other_same_rel: bool,
}

fn index_refs(index: &Value, entry: &JournalEntry) -> IndexRefs {
    let mut refs = IndexRefs {
        index_has: false,
        other_same_rel: false,
    };
    if let Some(by_id) = index["assets"]["byId"].as_object() {
        for a in by_id.values() {
            let id = a.get("id").and_then(Value::as_str).unwrap_or_default();
            let rel = a.get("relPath").and_then(Value::as_str).unwrap_or_default();
            if id == entry.asset_id {
                refs.index_has = true;
            } else if rel == entry.rel_path {
                refs.other_same_rel = true;
            }
        }
    }
    refs
}

/// 隔离项按身份绑定能力清理：成功返回 true（日志条目可移除）；失败（能力
/// 缺失/身份不符）按契约保留现场并记录 cleanupPending。
fn try_bound_cleanup(
    trash: &CapDir,
    entry: &JournalEntry,
    recovery: &mut Recovery,
) -> Result<bool, String> {
    match verify_trash_identity(trash, entry)? {
        TrashVerdict::IdentityOk(f) => match identity_bound_unlink(&f) {
            Ok(()) => {
                fsync_dir(trash)?;
                Ok(true)
            }
            Err(_) => {
                recovery.cleanup_pending.push(format!(
                    "隔离项保留（身份绑定清理不可用）：{} / {}",
                    entry.asset_id, entry.trash_name
                ));
                Ok(false)
            }
        },
        TrashVerdict::Missing => Ok(true), // 隔离项不存在：日志条目可清除
        TrashVerdict::Mismatch => {
            // 身份不符/被占用：保留现场与日志（评审修复：不得静默清除证据）
            recovery.cleanup_pending.push(format!(
                "隔离项保留（身份不符或被占用）：{} / {}",
                entry.asset_id, entry.trash_name
            ));
            Ok(false)
        }
    }
}

/// 恢复入口（§7.2：启动及每次库列表/写入前调用）：重读规范化索引并逐条
/// 消费日志。日志当前状态以 `current` 持有，分支变更即时可落盘（重隔离的
/// 新映射在 rename 前耐久记录，评审修复）。只动日志与文件（回迁/清理），
/// 不改 library.json——索引的权威状态不受恢复影响。
pub(crate) fn recover(library: &CapDir) -> Result<Recovery, String> {
    // 锁由调用方在操作边界持有（library_op_lock）——recover 不再自持。
    // 先读索引（不落盘）+ 读日志，日志异型判定优先于索引迁移落盘（评审修复，
    // PR #33 第三轮）：journal 异型须进入只读告警态，不得先把 library.json
    // 迁移改写；迁移落盘推迟到日志确认非异型之后。迁移/归一化警告并入
    // recovery.warnings 随命令响应可见。
    let normalized = crate::library_fs::read_index_normalized(library)?;
    let index = normalized.index;
    let index_warnings = normalized.warnings;
    let migrated = normalized.migrated;
    let mut recovery = Recovery::default();
    let (entries, malformed) = read_journal(library, &mut recovery.warnings);
    if malformed {
        recovery.read_only = true;
        // 只读态诊断与实际行为一致（评审修复，PR #33 第十三轮）：journal 异型
        // 判定后即返回，只读归一化由 list/媒体/导入的只读分流各自执行——其
        // 诊断声称隔离（真实行为），本路径不再掺入上面可重发版本的「已重发」
        // 声明
        return Ok(recovery);
    }
    recovery.warnings.extend(index_warnings);
    // 日志非异型：此刻才允许把索引迁移/修复原子落盘（重发 id 跨读稳定）
    if migrated {
        crate::library_fs::write_index(library, &index)?;
    }
    if entries.is_empty() {
        return Ok(recovery);
    }
    let assets = assets_root(library)?;
    let mut current = entries.clone();
    let mut changed = false;
    for entry in &entries {
        recover_entry(
            library,
            &assets,
            &index,
            entry,
            &mut recovery,
            &mut current,
            &mut changed,
        )?;
    }
    if changed {
        write_journal(library, &current)?;
    }
    Ok(recovery)
}

/// 从当前日志状态移除事务条目（清理完成/未开始/回迁一致）。
fn retire_entry(current: &mut Vec<JournalEntry>, entry: &JournalEntry) {
    current.retain(|e| e.id != entry.id);
}

/// 单条日志恢复。分支次序对齐 §7.2：共享引用 → 索引仍引用 → 索引已去项。
fn recover_entry(
    library: &CapDir,
    assets: &CapDir,
    index: &Value,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    let refs = index_refs(index, entry);
    let trash = open_trash_dir(assets)?;
    // 共享引用须以身份复核为准（评审修复）：relPath 字符串相等但占用者
    // 身份不符时，替换文件不得被当作共享引用方放行——继续走证据分支
    if refs.other_same_rel && original_binds_expected(assets, entry)? {
        return recover_shared_file(trash, entry, recovery, current, changed);
    }
    if refs.index_has {
        return recover_index_still_references(assets, entry, trash, recovery, current, changed);
    }
    recover_index_committed(library, assets, entry, trash, recovery, current, changed)
}

/// 其他条目引用同一文件位置：不得移动/删除其当前目录项；隔离项存在时仅
/// 按身份绑定能力清理，能力不足保留 cleanupPending；隔离项不存在清除日志。
fn recover_shared_file(
    trash: Option<CapDir>,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    match trash {
        Some(trash) => {
            if try_bound_cleanup(&trash, entry, recovery)? {
                retire_entry(current, entry);
                *changed = true;
            }
            // 清理失败：条目保留在 current（已在步骤①落盘，无需改动）
        }
        None => {
            retire_entry(current, entry);
            *changed = true;
        }
    }
    Ok(())
}

/// 标记冲突期不可用（§7.2）：日志条目保留在 current 并随列表返回警告。
fn mark_conflict(entry: &JournalEntry, recovery: &mut Recovery, why: &str) {
    recovery.conflicted.push(entry.asset_id.clone());
    recovery.warnings.push(format!(
        "资产 {} 删除事务冲突（{why}），标记为不可用",
        entry.asset_id
    ));
}

/// 原路径是否仍绑定事务预期身份（恢复分支共用判定）。
fn original_binds_expected(assets: &CapDir, entry: &JournalEntry) -> Result<bool, String> {
    Ok(match original_parent(assets, &entry.rel_path)? {
        Some((parent, last)) => matches!(
            path_identity(&parent, &last)?,
            PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
        ),
        None => false,
    })
}

/// 隔离项身份一致：原路径空缺则回迁（回到未开始态），被占用则冲突。
fn recover_restore_if_vacant(
    assets: &CapDir,
    entry: &JournalEntry,
    trash: &CapDir,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => {
            mark_conflict(entry, recovery, "原父目录缺失");
            return Ok(());
        }
    };
    match path_identity(&parent, &last)? {
        PathIdentity::Missing => {
            restore_from_trash(trash, entry, &parent, &last)?;
            retire_entry(current, entry);
            *changed = true; // 回到一致态：事务视为未开始
        }
        // 硬链接窗口恢复（评审修复）：hard_link 成功但 remove_file 失败或进程
        // 中断后，原名与隔离名同时绑定预期身份——原子移动失败残留。
        // 识别同一身份即清理隔离名并收敛，不标记冲突。
        PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino) => {
            let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
            // 耐久顺序（评审修复）：先让原名持久化，再释放隔离名——
            // 中断不致于隔离名已删而原名未持久
            fsync_dir(&parent)?;
            trash
                .remove_file(file_name)
                .map_err(|e| format!("清理硬链接残留失败（{}）：{e}", entry.asset_id))?;
            fsync_dir(trash)?;
            retire_entry(current, entry);
            *changed = true;
        }
        _ => mark_conflict(entry, recovery, "原路径已被后来文件占用"),
    }
    Ok(())
}

/// 索引仍含 assetId：隔离项身份一致且原名空缺 → 回迁并清除日志；原名占用
/// 或身份不符/缺失 → 保留日志并标记冲突不可用；隔离项未生成且原路径仍绑
/// 定预期身份 → 清除未开始事务。
fn recover_index_still_references(
    assets: &CapDir,
    entry: &JournalEntry,
    trash: Option<CapDir>,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    // 隔离项 Missing（目录缺失/条目缺失/rename 失败未生成）与无隔离目录
    // 同义：媒体仍绑定预期身份即未开始事务（评审修复：rename 失败残留的
    // 日志不得永久标记冲突）
    let verdict = match &trash {
        Some(trash) => verify_trash_identity(trash, entry)?,
        None => TrashVerdict::Missing,
    };
    match verdict {
        TrashVerdict::IdentityOk(_) => {
            let trash = trash.expect("IdentityOk 必有隔离目录");
            recover_restore_if_vacant(assets, entry, &trash, recovery, current, changed)
        }
        TrashVerdict::Missing => {
            if original_binds_expected(assets, entry)? {
                retire_entry(current, entry);
                *changed = true; // rename 失败的未开始事务：媒体原位且身份一致
            } else {
                mark_conflict(entry, recovery, "媒体缺失或身份不符");
            }
            Ok(())
        }
        TrashVerdict::Mismatch => {
            mark_conflict(entry, recovery, "隔离项身份不符");
            Ok(())
        }
    }
}

/// 索引已无 assetId：隔离项存在则仅尝试身份绑定清理（能力不足保留
/// cleanupPending）；隔离项已不存在且原路径不再绑定预期身份 → 清理完成；
/// 原路径仍绑定预期身份 → 重新执行身份核验隔离，绝不按原名删除。
fn recover_index_committed(
    library: &CapDir,
    assets: &CapDir,
    entry: &JournalEntry,
    trash: Option<CapDir>,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    let verdict = match &trash {
        Some(trash) => Some(verify_trash_identity(trash, entry)?),
        None => None,
    };
    match verdict {
        Some(TrashVerdict::IdentityOk(f)) => match identity_bound_unlink(&f) {
            Ok(()) => {
                fsync_dir(trash.as_ref().expect("trash"))?;
                retire_entry(current, entry);
                *changed = true;
            }
            Err(_) => {
                recovery.cleanup_pending.push(format!(
                    "隔离项保留（身份绑定清理不可用）：{} / {}",
                    entry.asset_id, entry.trash_name
                ));
            }
        },
        // 身份不符/被占用：保留现场与日志（不得静默清除证据）
        Some(TrashVerdict::Mismatch) => {
            recovery.cleanup_pending.push(format!(
                "隔离项保留（身份不符或被占用）：{} / {}",
                entry.asset_id, entry.trash_name
            ));
        }
        // 隔离项缺失（无隔离目录或该条目不存在）：复查原路径——仍绑定预期
        // 身份则重新隔离，否则清理完成（评审修复：此前 Missing 直接清日志，
        // 漏掉"媒体回到原位"的脏数据状态）
        Some(TrashVerdict::Missing) | None => {
            let original_bound = match original_parent(assets, &entry.rel_path)? {
                Some((parent, last)) => matches!(
                    path_identity(&parent, &last)?,
                    PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
                ),
                None => false,
            };
            if original_bound {
                re_quarantine(library, assets, entry, recovery, current)?;
            } else {
                retire_entry(current, entry);
            }
            *changed = true;
        }
    }
    Ok(())
}

/// 重新执行身份核验隔离（索引已去项但媒体仍在原位）：新映射先于 rename
/// 耐久记录进日志（评审修复：先改后记的窗口会让中断后的恢复按旧名收敛、
/// 永久孤儿化新隔离项），再 rename 并按能力清理。
#[cfg(unix)]
fn re_quarantine(
    library: &CapDir,
    assets: &CapDir,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
) -> Result<(), String> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => return Err(format!("重隔离失败：原父目录缺失（{}）", entry.rel_path)),
    };
    let trash = ensure_trash_dir(assets)?;
    let txn = format!("t-{}", new_id());
    let mut updated = entry.clone();
    updated.trash_name = format!("{TRASH_DIR}/{txn}");
    retire_entry(current, entry);
    current.push(updated.clone());
    write_journal(library, current)?;
    parent
        .rename(&last, &trash, &txn)
        .map_err(|e| format!("重隔离失败（{}）：{e}", entry.asset_id))?;
    fsync_dir(&trash)?;
    fsync_dir(&parent)?;
    if !try_bound_cleanup(&trash, &updated, recovery)? {
        recovery
            .cleanup_pending
            .push(format!("重隔离项保留待清理：{}", entry.asset_id));
    } else {
        retire_entry(current, &updated);
        write_journal(library, current)?;
    }
    Ok(())
}
