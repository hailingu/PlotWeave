//! 删除日志的解析与读写（issue #39 自 library_journal.rs 拆出）：单条日志
//! 的严格形状校验（异型/重复 id/越界路径整份只读态）、受限读取与原子落盘。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};

use crate::library_fs::INDEX_MAX_BYTES;
use crate::store::{atomic_write, is_valid_asset_rel_path};

use super::transaction::journal_entry_value;
use super::trash::fsync_dir;

pub(crate) const JOURNAL_FILE_NAME: &str = "asset-delete-journal.json";

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
        match String::from_utf8(buf) {
            Ok(t) => t,
            Err(_) => return blocked(warnings, "不是合法 UTF-8"),
        }
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
    let items: Vec<Value> = entries.iter().map(journal_entry_value).collect();
    let text = serde_json::to_string(&json!(items)).map_err(|e| format!("序列化日志失败：{e}"))?;
    atomic_write(library, JOURNAL_FILE_NAME, &text)?;
    fsync_dir(library)
}
