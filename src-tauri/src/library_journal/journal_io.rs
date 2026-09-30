//! 删除日志的解析与读写（issue #39 自 library_journal.rs 拆出）：单条日志
//! 的严格形状校验（异型/重复 id/越界路径整份只读态）、受限读取与原子落盘。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};

use crate::library::error::LibraryError;
use crate::library_fs::INDEX_MAX_BYTES;
use crate::store::{atomic_write, is_valid_asset_rel_path};

use super::archive::{parse_totals, read_archive, ARCHIVE_FILE_NAME};
use super::fsync::fsync_dir;

/// 删除事务与清理累计指标的单一原子快照文件。
pub(crate) const JOURNAL_FILE_NAME: &str = "asset-delete-journal.json";

/// 完整日志快照（issue #421）：任何写入口都携带既有累计指标，折叠退役
/// 与指标增量不可分离；needs_write 标记旧格式迁移或咨询性字段修复。
#[derive(Clone, Default)]
pub(super) struct Journal {
    pub(super) entries: Vec<JournalEntry>,
    pub(super) cleanup_count: u64,
    pub(super) trash_bytes: Option<u64>,
    pub(super) needs_write: bool,
}

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
    /// 索引损坏时无法证明删除已提交；持久保留现场，不从缺失项推断清理。
    /// 存活期只覆盖索引损坏期间：索引恢复为可解析权威视图后由恢复复位，
    /// 条目按当前索引重新判定（issue #389）。
    pub(super) index_uncertain: bool,
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
    let index_uncertain = match o.get("indexUncertain") {
        None => false,
        Some(value) => value.as_bool()?,
    };
    seen.push(id.clone());
    Some(JournalEntry {
        id,
        asset_id,
        rel_path: rel_path.to_string(),
        dev,
        ino,
        trash_name: trash_name.to_string(),
        index_uncertain,
    })
}

/// 在已锚定目录内受限读取日志；缺失与读取失败分开，异型不打开。
fn read_journal_text(library: &CapDir) -> Result<Option<String>, &'static str> {
    let md = match library.symlink_metadata(JOURNAL_FILE_NAME) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("读取失败"),
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return Err("是符号链接或非普通文件");
    }
    let f = library.open(JOURNAL_FILE_NAME).map_err(|_| "读取失败")?;
    let mut buf = Vec::new();
    f.take((INDEX_MAX_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| "读取失败")?;
    if buf.len() > INDEX_MAX_BYTES {
        return Err("超过大小上限");
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| "不是合法 UTF-8")
}

/// 旧数组/缺失日志仅在迁移前读取旁路；新对象永不消费陈旧归档。
fn parse_journal(library: &CapDir, value: Value, warnings: &mut Vec<String>) -> Option<Journal> {
    let legacy = value.is_array();
    let items = if legacy {
        value.as_array()?
    } else {
        value.as_object()?.get("entries")?.as_array()?
    };
    let mut seen = Vec::new();
    let mut entries = Vec::new();
    for item in items {
        entries.push(parse_entry(item, &mut seen)?);
    }
    let prior_warnings = warnings.len();
    let (cleanup_count, trash_bytes) = if legacy {
        read_archive(library, warnings)
    } else {
        parse_totals(&value, warnings)
    };
    Some(Journal {
        entries,
        cleanup_count,
        trash_bytes,
        needs_write: legacy || warnings.len() > prior_warnings,
    })
}

/// no-follow 归类与受限读取后解析完整状态。旧数组兼容迁移；事务形状
/// 异型仍只读，咨询性指标异型告警重计而不阻断库操作。
pub(super) fn read_journal(library: &CapDir, warnings: &mut Vec<String>) -> (Journal, bool) {
    let result = read_journal_text(library).and_then(|text| {
        let value = match text {
            Some(text) => serde_json::from_str(&text).map_err(|_| "异型")?,
            None if matches!(library.symlink_metadata(ARCHIVE_FILE_NAME),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(Journal::default());
            }
            None => json!([]),
        };
        parse_journal(library, value, warnings).ok_or("异型")
    });
    match result {
        Ok(journal) => (journal, false),
        Err(why) => {
            warnings.push(format!("删除日志{why}，库写入已暂停（只读告警态）"));
            (Journal::default(), true)
        }
    }
}

/// 单条事务 → journal JSON 形状（write_journal 与 transaction 的上限投影
/// 共用；issue #399 自 transaction 收编——日志条目的序列化形状归日志
/// 解析与读写所有者，避免 journal_io 反向依赖事务主体成环）。
pub(super) fn journal_entry_value(e: &JournalEntry) -> Value {
    let mut value = json!({
        "id": e.id,
        "assetId": e.asset_id,
        "relPath": e.rel_path,
        "identity": { "dev": e.dev, "ino": e.ino },
        "trashName": e.trash_name,
    });
    if e.index_uncertain {
        value["indexUncertain"] = json!(true);
    }
    value
}

/// 完整对象根的唯一序列化入口，写入与删除投影上限使用同一口径。
pub(super) fn serialize_journal(journal: &Journal) -> Result<String, LibraryError> {
    let items: Vec<Value> = journal.entries.iter().map(journal_entry_value).collect();
    let mut value = json!({"entries":items,"retainedCleanupCount":journal.cleanup_count});
    if let Some(bytes) = journal.trash_bytes {
        value["trashBytes"] = json!(bytes);
    }
    serde_json::to_string(&value).map_err(|e| LibraryError::serialize("序列化日志失败", e))
}

/// 将事务与累计指标同次原子落盘并同步目录，任何屏障失败均传播原错误；
/// 重试只可能读取完整旧态或完整新态，不能丢失已退役条目的指标。
pub(super) fn write_journal(library: &CapDir, journal: &Journal) -> Result<(), LibraryError> {
    let text = serialize_journal(journal)?;
    if text.len() > INDEX_MAX_BYTES {
        return Err(LibraryError::Limit {
            detail: "删除日志更新超过大小上限，拒绝写入".into(),
        });
    }
    atomic_write(library, JOURNAL_FILE_NAME, &text).map_err(LibraryError::from)?;
    fsync_dir(library)
}
