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

use crate::library_fs::{
    assets_root, ensure_index_size, open_parent_dir, read_index_capped, write_index,
    INDEX_MAX_BYTES,
};
use crate::store::{asset_stat, atomic_write, is_valid_asset_rel_path, new_id, open_dir_bound};

pub(crate) const JOURNAL_FILE_NAME: &str = "asset-delete-journal.json";
const TRASH_DIR: &str = "assets/.trash";

/// 单条删除事务：assetId、原 relPath（固定 assets/ 基准）、预期文件身份
/// (dev, ino) 与未公开的 `assets/.trash/<随机名>`。
#[derive(Clone, Debug)]
struct JournalEntry {
    id: String,
    asset_id: String,
    rel_path: String,
    dev: u64,
    ino: u64,
    trash_name: String,
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
fn identity_bound_unlink(_file: &cap_std::fs::File) -> Result<(), String> {
    Err("平台缺少身份绑定删除原语".into())
}

/// 目录持久性屏障（Unix）。
#[cfg(unix)]
fn fsync_dir(dir: &CapDir) -> Result<(), String> {
    dir.open_dir(".")
        .and_then(|d| d.into_std_file().sync_all())
        .map_err(|e| format!("同步目录失败（持久性屏障缺失）：{e}"))
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &CapDir) -> Result<(), String> {
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
    if !is_valid_asset_rel_path(rel_path) || rel_path.contains(".trash") {
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
fn read_journal(library: &CapDir, warnings: &mut Vec<String>) -> (Vec<JournalEntry>, bool) {
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
fn write_journal(library: &CapDir, entries: &[JournalEntry]) -> Result<(), String> {
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
enum PathIdentity {
    Missing,
    Regular(u64, u64),
    Other,
}

#[cfg(unix)]
fn path_identity(parent: &CapDir, name: &str) -> PathIdentity {
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
enum TrashVerdict {
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
fn ensure_trash_dir(assets: &CapDir) -> Result<CapDir, String> {
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
fn restore_from_trash(
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
    let mark_conflict = |recovery: &mut Recovery, why: &str, retained: &mut Vec<JournalEntry>| {
        recovery.conflicted.push(entry.asset_id.clone());
        recovery.warnings.push(format!(
            "资产 {} 删除事务冲突（{}），标记为不可用",
            entry.asset_id, why
        ));
        retained.push(entry.clone());
    };
    match trash {
        Some(trash) => match verify_trash_identity(&trash, entry)? {
            TrashVerdict::IdentityOk(_) => {
                let (parent, last) = match original_parent(assets, &entry.rel_path)? {
                    Some(p) => p,
                    None => {
                        mark_conflict(recovery, "原父目录缺失", retained);
                        return Ok(());
                    }
                };
                if matches!(path_identity(&parent, &last), PathIdentity::Missing) {
                    restore_from_trash(&trash, entry, &parent, &last)?;
                    *changed = true; // 回到一致态：事务视为未开始
                } else {
                    mark_conflict(recovery, "原路径已被后来文件占用", retained);
                }
            }
            TrashVerdict::Missing => mark_conflict(recovery, "隔离项缺失", retained),
            TrashVerdict::Mismatch => mark_conflict(recovery, "隔离项身份不符", retained),
        },
        None => {
            let started = match original_parent(assets, &entry.rel_path)? {
                Some((parent, last)) => matches!(
                    path_identity(&parent, &last),
                    PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
                ),
                None => false,
            };
            if started {
                *changed = true; // 未开始事务（媒体仍在原位且身份一致）
            } else {
                mark_conflict(recovery, "媒体缺失或身份不符", retained);
            }
        }
    }
    Ok(())
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
    match trash {
        Some(trash) => {
            if try_bound_cleanup(&trash, entry, recovery)? {
                *changed = true;
            } else {
                retained.push(entry.clone());
            }
        }
        None => {
            let original_bound = match original_parent(assets, &entry.rel_path)? {
                Some((parent, last)) => matches!(
                    path_identity(&parent, &last),
                    PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
                ),
                None => false,
            };
            if original_bound {
                re_quarantine(assets, entry, recovery, retained)?;
                *changed = true;
            } else {
                *changed = true; // 清理已完成
            }
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

/// 删除事务（§7.2 四步）：返回携带 warnings 与 cleanupPending 的响应负载。
pub(crate) fn delete_asset_transacted(library: &CapDir, id: &str) -> Result<Value, String> {
    #[cfg(not(unix))]
    {
        let _ = (library, id);
        return Err("平台缺少文件身份能力，删除暂不可用".into());
    }
    #[cfg(unix)]
    {
        delete_asset_transacted_unix(library, id)
    }
}

#[cfg(unix)]
fn delete_asset_transacted_unix(library: &CapDir, id: &str) -> Result<Value, String> {
    let mut recovery = recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    let (mut index, mut warnings) = read_index_capped(library)?;
    warnings.append(&mut recovery.warnings);
    let assets = assets_root(library)?;
    let assets_arr = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let pos = assets_arr
        .iter()
        .position(|a| a.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    let rel = assets_arr[pos]
        .get("relPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assets_arr.remove(pos);
    ensure_index_size(&index)?;
    if needs_no_quarantine(&assets, &index, &rel)? {
        write_index(library, &index)?;
        return Ok(json!({ "warnings": warnings, "cleanupPending": recovery.cleanup_pending }));
    }
    commit_quarantined_delete(library, &assets, id, &rel, index, warnings, recovery)
}

/// 无需隔离的情形：其他条目仍引用同一文件位置（同 relPath = 同一物理
/// 文件，只提交去项索引），或媒体/父目录已缺失（幂等收敛）。
fn needs_no_quarantine(assets: &CapDir, index: &Value, rel: &str) -> Result<bool, String> {
    let shared = index["assets"].as_array().is_some_and(|arr| {
        arr.iter()
            .any(|e| e.get("relPath").and_then(Value::as_str) == Some(rel))
    });
    if shared {
        return Ok(true);
    }
    let suffix = rel
        .strip_prefix("assets/")
        .ok_or_else(|| format!("relPath 越出 assets/：{rel}"))?;
    Ok(match open_parent_dir(assets, suffix)? {
        None => true,
        Some((parent, last)) => matches!(
            parent.symlink_metadata(&last),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound
        ),
    })
}

/// 隔离事务主体：①身份捕获 + 日志耐久记录 ②原子隔离 + 身份复核
/// ③原子提交去项索引 ④身份绑定清理（能力不足保留隔离项）。
#[cfg(unix)]
fn commit_quarantined_delete(
    library: &CapDir,
    assets: &CapDir,
    id: &str,
    rel: &str,
    index: Value,
    mut warnings: Vec<String>,
    recovery: Recovery,
) -> Result<Value, String> {
    use cap_std::fs::MetadataExt;

    // ① no-follow 打开待删普通文件、捕获平台稳定身份并保持句柄/父目录句柄
    let suffix = rel
        .strip_prefix("assets/")
        .ok_or_else(|| format!("relPath 越出 assets/：{rel}"))?;
    let (parent, last) =
        open_parent_dir(assets, suffix)?.ok_or_else(|| format!("资产父目录缺失：{rel}"))?;
    let md = asset_stat(&parent, &last, rel)?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(format!("资产路径不是普通文件，拒绝删除：{rel}"));
    }
    let identity = (md.dev(), md.ino());
    let file = parent
        .open(&last)
        .map_err(|e| format!("打开待删资产失败（{rel}）：{e}"))?;
    let fm = file
        .metadata()
        .map_err(|e| format!("读取待删资产句柄元数据失败：{e}"))?;
    if (fm.dev(), fm.ino()) != identity {
        return Err(format!("待删文件在校验期间被替换：{rel}"));
    }
    // 隔离区确保存在且与源文件同一文件系统（跨设备原子 rename 不成立）
    let trash = ensure_trash_dir(assets)?;
    let tm = trash
        .dir_metadata()
        .map_err(|e| format!("读取隔离目录句柄元数据失败：{e}"))?;
    if tm.dev() != identity.0 {
        return Err("隔离区与媒体不在同一文件系统，无法原子隔离".into());
    }
    // ① 日志耐久记录（先于任何移动）
    let txn = format!("t-{}", new_id());
    let entry = JournalEntry {
        id: txn.clone(),
        asset_id: id.to_string(),
        rel_path: rel.to_string(),
        dev: identity.0,
        ino: identity.1,
        trash_name: format!("{TRASH_DIR}/{txn}"),
    };
    let (mut entries, malformed) = read_journal(library, &mut warnings);
    if malformed {
        return Err("删除日志异常，库写入/删除已暂停".into());
    }
    entries.push(entry.clone());
    write_journal(library, &entries)?;
    // ② 原子隔离 + 双侧目录 fsync + 身份复核
    parent
        .rename(&last, &trash, &txn)
        .map_err(|e| format!("隔离媒体失败（{rel}）：{e}"))?;
    fsync_dir(&parent)?;
    fsync_dir(&trash)?;
    if matches!(
        verify_trash_identity(&trash, &entry)?,
        TrashVerdict::Missing | TrashVerdict::Mismatch
    ) {
        return resolve_quarantine_conflict(library, &trash, &entry, &parent, &last, entries);
    }
    // ③ 原子提交去项索引（保持已打开身份句柄直至本函数结束）
    write_index(library, &index)?;
    // ④ 身份绑定清理；能力不足/隔离项身份变化均保留隔离项与日志（评审
    // 修复：不得静默清除证据），索引不回滚。日志条目已在步骤①落盘——
    // 仅在清理成功时重写移除，失败分支保持原样即可。
    let mut cleanup_pending = recovery.cleanup_pending;
    match verify_trash_identity(&trash, &entry)? {
        TrashVerdict::IdentityOk(f) => {
            if identity_bound_unlink(&f).is_ok() {
                fsync_dir(&trash)?;
                entries.retain(|e| e.id != txn);
                write_journal(library, &entries)?;
            } else {
                cleanup_pending.push(format!("媒体已隔离待清理：{rel}"));
            }
        }
        TrashVerdict::Missing | TrashVerdict::Mismatch => {
            cleanup_pending.push(format!("隔离项身份异常，保留现场待恢复：{rel}"));
        }
    }
    Ok(json!({ "warnings": warnings, "cleanupPending": cleanup_pending }))
}

/// 步骤②身份复核失败的处置：原名空缺则恢复原状并移除日志项（用户重试）；
/// 原名被占用则保留隔离项与日志报冲突（恢复流程标记冲突不可用）。
#[cfg(unix)]
fn resolve_quarantine_conflict(
    library: &CapDir,
    trash: &CapDir,
    entry: &JournalEntry,
    parent: &CapDir,
    last: &str,
    mut entries: Vec<JournalEntry>,
) -> Result<Value, String> {
    if matches!(path_identity(parent, last), PathIdentity::Missing) {
        restore_from_trash(trash, entry, parent, last)?;
        entries.retain(|e| e.id != entry.id);
        write_journal(library, &entries)?;
        return Err(format!(
            "资产 {} 隔离窗口内被替换，已恢复原状，请重试",
            entry.asset_id
        ));
    }
    Err(format!(
        "资产 {} 隔离期身份冲突：原路径已被后来文件占用，事务保留待恢复",
        entry.asset_id
    ))
}

/// 导入前的冲突期隔离检查（§7.2）：日志只读态与冲突 assetId 均拒绝服务。
pub(crate) fn ensure_importable(library: &CapDir, library_asset_id: &str) -> Result<(), String> {
    let recovery = recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    if recovery.conflicted.iter().any(|c| c == library_asset_id) {
        return Err(format!(
            "库资产 {library_asset_id} 处于删除事务冲突期，拒绝导入"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
