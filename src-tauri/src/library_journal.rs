//! 库删除事务与恢复内核（docs/data-model.md §7.2 可恢复提交协议 + §10.5）：
//! 持久化日志驱动的身份绑定隔离事务——①捕获媒体文件身份并把事务耐久写入
//! `library/asset-delete-journal.json`；②原目录项原子 rename 进保留的
//! `library/assets/.trash/` 隔离区并复核身份；③原子提交去项索引；④仅以
//! 绑定①身份的操作系统原语清理隔离项（受支持平台均无该原语——Linux
//! `/proc/self/fd` 是 procfs 符号链接，unlink 不解引用最终符号链接返回
//! EPERM——故保留隔离项并报告 `cleanupPending`，绝不按名删除）。
//! 启动及每次库列表/写入前按日志恢复未完成事务；冲突期条目标为不可用；
//! 日志异型时整份恢复进入只读告警态，所有库写入/删除暂停。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};

use crate::library_fs::{assets_root, open_parent_dir, read_index_capped, INDEX_MAX_BYTES};
use crate::store::{atomic_write, is_valid_asset_rel_path, new_id, open_dir_bound};

pub(crate) const JOURNAL_FILE_NAME: &str = "asset-delete-journal.json";
pub(super) const TRASH_DIR: &str = "assets/.trash";

/// 单条删除事务：assetId、原 relPath（固定 assets/ 基准）、预期文件身份
/// (dev, ino) 与未公开的 `assets/.trash/<随机名>`。
#[derive(Clone, Debug)]
pub(super) struct JournalEntry {
    pub(super) id: String,
    pub(super) asset_id: String,
    pub(super) rel_path: String,
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) trash_name: String,
}

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

/// 身份绑定删除原语（§7.2 步骤④）：当前受支持平台均未提供不经名字解析、
/// 直接绑定已打开 inode 的删除系统调用——Linux 的 `/proc/self/fd/<fd>` 是
/// procfs 符号链接，unlink 不解引用最终符号链接（EPERM），不得伪装修复。
/// 按契约统一报告能力缺失：保留隔离项与日志并记录 cleanupPending，索引
/// 不回滚；未来接入等价原语（如内核提供的 funlink）时在此收口。
pub(super) fn identity_bound_unlink(_file: &cap_std::fs::File) -> Result<(), String> {
    Err("平台缺少身份绑定删除原语".into())
}

/// 目录持久性屏障（Unix）。
#[cfg(unix)]
pub(super) fn fsync_dir(dir: &CapDir) -> Result<(), String> {
    dir.open_dir(".")
        .and_then(|d| d.into_std_file().sync_all())
        .map_err(|e| format!("同步目录失败（持久性屏障缺失）：{e}"))
}

#[cfg(not(unix))]
pub(super) fn fsync_dir(_dir: &CapDir) -> Result<(), String> {
    Ok(())
}

/// 解析 journal 单元格式的身份对象。
fn parse_identity(v: Option<&Value>) -> Option<(u64, u64)> {
    let o = v?.as_object()?;
    let dev = o.get("dev")?.as_u64()?;
    let ino = o.get("ino")?.as_u64()?;
    Some((dev, ino))
}

/// 字段为合法形状的字符串（trim 后非空）。
fn valid_str(v: Option<&Value>) -> Option<&str> {
    v?.as_str().filter(|s| !s.trim().is_empty())
}

/// 严格校验单条日志：任一字段异型/重复 id/路径越界即 None，调用方整份
/// 进入只读态。relPath 复用资产路径全量词法校验（首段 assets、无空段/
/// `.`/`..`/反斜杠/绝对路径）并额外排除保留隔离目录；trashName 必须是
/// `assets/.trash/` 的单一子项（评审修复：`assets/../…` 类词法不得进入
/// 恢复的句柄遍历，否则恢复整体失败而非进入只读态）。
fn parse_entry(v: &Value, seen: &mut Vec<String>) -> Option<JournalEntry> {
    let o = v.as_object()?;
    let id = valid_str(o.get("id"))?.trim().to_string();
    if seen.iter().any(|s| s == &id) {
        return None;
    }
    let asset_id = valid_str(o.get("assetId"))?.trim().to_string();
    let rel_path = valid_str(o.get("relPath"))?;
    // 保留隔离目录按路径组件匹配（评审修复：contains 会把 cover.trash 这类
    // 普通文件名误判为越界，自产生的合法删除日志反而锁死整库）
    if !is_valid_asset_rel_path(rel_path) || rel_path.split('/').any(|c| c == ".trash") {
        return None;
    }
    let trash_name = valid_str(o.get("trashName"))?;
    let trash_leaf = trash_name.strip_prefix("assets/.trash/")?;
    if trash_leaf.is_empty() || trash_leaf.contains('/') || trash_leaf == "." || trash_leaf == ".."
    {
        return None;
    }
    let (dev, ino) = parse_identity(o.get("identity"))?;
    seen.push(id.clone());
    Some(JournalEntry {
        id,
        asset_id,
        rel_path: rel_path.to_string(),
        dev,
        ino,
        trash_name: trash_name.to_string(),
    })
}

/// 读取日志：缺失回退空表。no-follow 归类（拒符号链接，要求普通文件——
/// FIFO/目录等异型在打开前拒绝，不阻塞命令）+ 大小上限内受限读取；根非
/// 数组/条目异型/重复 id/越界路径 → 只读态（评审修复）。
pub(super) fn read_journal(
    library: &CapDir,
    warnings: &mut Vec<String>,
) -> (Vec<JournalEntry>, bool) {
    let blocked = |warnings: &mut Vec<String>, why: &str| {
        warnings.push(format!("删除日志{why}，库写入已暂停（只读告警态）"));
        (Vec::new(), true)
    };
    let md = match library.symlink_metadata(JOURNAL_FILE_NAME) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), false),
        Err(_) => return blocked(warnings, "读取失败"),
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return blocked(warnings, "是符号链接或非普通文件");
    }
    let text = {
        let f = match library.open(JOURNAL_FILE_NAME) {
            Ok(f) => f,
            Err(_) => return blocked(warnings, "读取失败"),
        };
        let mut buf = Vec::new();
        if f.take((INDEX_MAX_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .is_err()
        {
            return blocked(warnings, "读取失败");
        }
        if buf.len() > INDEX_MAX_BYTES {
            return blocked(warnings, "超过大小上限");
        }
        String::from_utf8_lossy(&buf).into_owned()
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(arr)) => {
            let mut seen = Vec::new();
            let mut entries = Vec::new();
            for item in &arr {
                match parse_entry(item, &mut seen) {
                    Some(e) => entries.push(e),
                    None => {
                        warnings.push("删除日志异型，库写入已暂停（只读告警态）".into());
                        return (Vec::new(), true);
                    }
                }
            }
            (entries, false)
        }
        _ => {
            warnings.push("删除日志异型，库写入已暂停（只读告警态）".into());
            (Vec::new(), true)
        }
    }
}

/// 日志原子落盘（library/ 句柄相对）并 fsync 所在目录。
pub(super) fn write_journal(library: &CapDir, entries: &[JournalEntry]) -> Result<(), String> {
    let items: Vec<Value> = entries
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "assetId": e.asset_id,
                "relPath": e.rel_path,
                "identity": { "dev": e.dev, "ino": e.ino },
                "trashName": e.trash_name,
            })
        })
        .collect();
    let text = serde_json::to_string(&json!(items)).map_err(|e| format!("序列化日志失败：{e}"))?;
    atomic_write(library, JOURNAL_FILE_NAME, &text)?;
    fsync_dir(library)
}

/// 相对锚定句柄读取路径身份：缺失/占用/异型分别处置（§7.2 恢复分支）。
#[cfg(unix)]
pub(super) enum PathIdentity {
    Missing,
    Regular(u64, u64),
    Other,
}

#[cfg(unix)]
pub(super) fn path_identity(parent: &CapDir, name: &str) -> PathIdentity {
    use cap_std::fs::MetadataExt;
    match parent.symlink_metadata(name) {
        Ok(md) if md.file_type().is_symlink() => PathIdentity::Other,
        Ok(md) if md.is_file() => PathIdentity::Regular(md.dev(), md.ino()),
        Ok(_) => PathIdentity::Other,
        Err(_) => PathIdentity::Missing,
    }
}

/// no-follow 打开 .trash 隔离项并复核身份的三态判别（评审修复：缺失与
/// 身份不符必须区分——清理分支只允许在确认缺失时清除日志，身份不符/
/// 被占用保留现场与日志，不得丢失证据）。
#[cfg(unix)]
pub(super) enum TrashVerdict {
    IdentityOk(cap_std::fs::File),
    Missing,
    Mismatch,
}

#[cfg(unix)]
fn verify_trash_identity(trash: &CapDir, entry: &JournalEntry) -> Result<TrashVerdict, String> {
    let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
    let md = match trash.symlink_metadata(file_name) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TrashVerdict::Missing),
        Err(e) => {
            return Err(format!("读取隔离项元数据失败（{}）：{e}", entry.trash_name));
        }
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return Ok(TrashVerdict::Mismatch);
    }
    use cap_std::fs::MetadataExt;
    if (md.dev(), md.ino()) != (entry.dev, entry.ino) {
        return Ok(TrashVerdict::Mismatch);
    }
    let f = trash
        .open(file_name)
        .map_err(|e| format!("打开隔离项失败（{}）：{e}", entry.trash_name))?;
    let fm = f
        .metadata()
        .map_err(|e| format!("读取隔离项句柄元数据失败：{e}"))?;
    if (fm.dev(), fm.ino()) != (entry.dev, entry.ino) {
        return Ok(TrashVerdict::Mismatch);
    }
    Ok(TrashVerdict::IdentityOk(f))
}

/// 打开 .trash 隔离区目录句柄（缺失返回 None；不在此创建——创建只发生在
/// 事务步骤①与恢复重隔离，且都在已验证资产根句柄下）。
fn open_trash_dir(assets: &CapDir) -> Result<Option<CapDir>, String> {
    match assets.symlink_metadata(".trash") {
        Ok(md) if md.file_type().is_symlink() => Err("隔离目录是符号链接，拒绝操作".into()),
        Ok(md) if md.is_dir() => open_dir_bound(assets, ".trash", &md, "隔离目录").map(Some),
        Ok(_) => Err("隔离目录路径不是目录，拒绝操作".into()),
        Err(_) => Ok(None),
    }
}

/// 在已验证资产根句柄下确保 .trash 为真实目录并 fsync 资产根。
#[cfg(unix)]
pub(super) fn ensure_trash_dir(assets: &CapDir) -> Result<CapDir, String> {
    if let Err(e) = assets.create_dir(".trash") {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(format!("创建隔离目录失败：{e}"));
        }
    }
    let md = assets
        .symlink_metadata(".trash")
        .map_err(|e| format!("读取隔离目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err("隔离目录被占用为非目录，拒绝操作".into());
    }
    let dir = open_dir_bound(assets, ".trash", &md, "隔离目录")?;
    fsync_dir(assets)?;
    Ok(dir)
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
    if let Some(arr) = index["assets"].as_array() {
        for a in arr {
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

/// 隔离项回迁原位（仅原名空缺时调用）：句柄相对 rename + 双侧目录 fsync。
#[cfg(unix)]
pub(super) fn restore_from_trash(
    trash: &CapDir,
    entry: &JournalEntry,
    parent: &CapDir,
    last: &str,
) -> Result<(), String> {
    let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
    trash
        .rename(file_name, parent, last)
        .map_err(|e| format!("回迁隔离项失败（{}）：{e}", entry.asset_id))?;
    fsync_dir(trash)?;
    fsync_dir(parent)
}

/// 恢复入口（§7.2：启动及每次库列表/写入前调用）：重读规范化索引并逐条
/// 消费日志，重写发生变化的日志文件。只动日志与文件（回迁/清理），不改
/// library.json——索引的权威状态不受恢复影响。
pub(crate) fn recover(library: &CapDir) -> Result<Recovery, String> {
    let (index, _) = read_index_capped(library)?;
    let mut recovery = Recovery::default();
    let (entries, malformed) = read_journal(library, &mut recovery.warnings);
    if malformed {
        recovery.read_only = true;
        return Ok(recovery);
    }
    if entries.is_empty() {
        return Ok(recovery);
    }
    let assets = assets_root(library)?;
    let mut retained = Vec::new();
    let mut changed = false;
    for entry in &entries {
        recover_entry(
            &assets,
            &index,
            entry,
            &mut recovery,
            &mut retained,
            &mut changed,
        )?;
    }
    if changed {
        write_journal(library, &retained)?;
    }
    Ok(recovery)
}

/// 单条日志恢复。分支次序对齐 §7.2：共享引用 → 索引仍引用 → 索引已去项。
fn recover_entry(
    assets: &CapDir,
    index: &Value,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    retained: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    let refs = index_refs(index, entry);
    let trash = open_trash_dir(assets)?;
    if refs.other_same_rel {
        return recover_shared_file(trash, entry, recovery, retained, changed);
    }
    if refs.index_has {
        return recover_index_still_references(assets, entry, trash, recovery, retained, changed);
    }
    recover_index_committed(assets, entry, trash, recovery, retained, changed)
}

/// 其他条目引用同一文件位置：不得移动/删除其当前目录项；隔离项存在时仅
/// 按身份绑定能力清理，能力不足保留 cleanupPending；隔离项不存在清除日志。
fn recover_shared_file(
    trash: Option<CapDir>,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    retained: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    match trash {
        Some(trash) => {
            if try_bound_cleanup(&trash, entry, recovery)? {
                *changed = true;
            } else {
                retained.push(entry.clone());
            }
        }
        None => *changed = true,
    }
    Ok(())
}

/// 标记冲突期不可用（§7.2）：保留日志条目并随列表返回警告。
fn mark_conflict(
    entry: &JournalEntry,
    recovery: &mut Recovery,
    retained: &mut Vec<JournalEntry>,
    why: &str,
) {
    recovery.conflicted.push(entry.asset_id.clone());
    recovery.warnings.push(format!(
        "资产 {} 删除事务冲突（{why}），标记为不可用",
        entry.asset_id
    ));
    retained.push(entry.clone());
}

/// 原路径是否仍绑定事务预期身份（恢复分支共用判定）。
fn original_binds_expected(assets: &CapDir, entry: &JournalEntry) -> Result<bool, String> {
    Ok(match original_parent(assets, &entry.rel_path)? {
        Some((parent, last)) => matches!(
            path_identity(&parent, &last),
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
    retained: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), String> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => {
            mark_conflict(entry, recovery, retained, "原父目录缺失");
            return Ok(());
        }
    };
    if matches!(path_identity(&parent, &last), PathIdentity::Missing) {
        restore_from_trash(trash, entry, &parent, &last)?;
        *changed = true; // 回到一致态：事务视为未开始
    } else {
        mark_conflict(entry, recovery, retained, "原路径已被后来文件占用");
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
    retained: &mut Vec<JournalEntry>,
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
            recover_restore_if_vacant(assets, entry, &trash, recovery, retained, changed)
        }
        TrashVerdict::Missing => {
            if original_binds_expected(assets, entry)? {
                *changed = true; // rename 失败的未开始事务：媒体原位且身份一致
            } else {
                mark_conflict(entry, recovery, retained, "媒体缺失或身份不符");
            }
            Ok(())
        }
        TrashVerdict::Mismatch => {
            mark_conflict(entry, recovery, retained, "隔离项身份不符");
            Ok(())
        }
    }
}

/// 索引已无 assetId：隔离项存在则仅尝试身份绑定清理（能力不足保留
/// cleanupPending）；隔离项已不存在且原路径不再绑定预期身份 → 清理完成；
/// 原路径仍绑定预期身份 → 重新执行身份核验隔离，绝不按原名删除。
fn recover_index_committed(
    assets: &CapDir,
    entry: &JournalEntry,
    trash: Option<CapDir>,
    recovery: &mut Recovery,
    retained: &mut Vec<JournalEntry>,
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
                *changed = true;
            }
            Err(_) => {
                recovery.cleanup_pending.push(format!(
                    "隔离项保留（身份绑定清理不可用）：{} / {}",
                    entry.asset_id, entry.trash_name
                ));
                retained.push(entry.clone());
            }
        },
        // 身份不符/被占用：保留现场与日志（不得静默清除证据）
        Some(TrashVerdict::Mismatch) => {
            recovery.cleanup_pending.push(format!(
                "隔离项保留（身份不符或被占用）：{} / {}",
                entry.asset_id, entry.trash_name
            ));
            retained.push(entry.clone());
        }
        // 隔离项缺失（无隔离目录或该条目不存在）：复查原路径——仍绑定预期
        // 身份则重新隔离，否则清理完成（评审修复：此前 Missing 直接清日志，
        // 漏掉"媒体回到原位"的脏数据状态）
        Some(TrashVerdict::Missing) | None => {
            let original_bound = match original_parent(assets, &entry.rel_path)? {
                Some((parent, last)) => matches!(
                    path_identity(&parent, &last),
                    PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
                ),
                None => false,
            };
            if original_bound {
                re_quarantine(assets, entry, recovery, retained)?;
            }
            *changed = true;
        }
    }
    Ok(())
}

/// 重新执行身份核验隔离（索引已去项但媒体仍在原位）：rename 进新建隔离
/// 区后按能力清理，能力不足保留隔离项与日志并报告 cleanupPending。
#[cfg(unix)]
fn re_quarantine(
    assets: &CapDir,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    retained: &mut Vec<JournalEntry>,
) -> Result<(), String> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => return Err(format!("重隔离失败：原父目录缺失（{}）", entry.rel_path)),
    };
    let trash = ensure_trash_dir(assets)?;
    let txn = format!("t-{}", new_id());
    parent
        .rename(&last, &trash, &txn)
        .map_err(|e| format!("重隔离失败（{}）：{e}", entry.asset_id))?;
    fsync_dir(&parent)?;
    fsync_dir(&trash)?;
    let mut updated = entry.clone();
    updated.trash_name = format!("{TRASH_DIR}/{txn}");
    if try_bound_cleanup(&trash, &updated, recovery)? {
        return Ok(()); // 已清理：日志不再保留该条
    }
    retained.push(updated);
    Ok(())
}

mod transaction;
pub(crate) use transaction::{delete_asset_transacted, ensure_importable};

#[cfg(test)]
mod tests;
