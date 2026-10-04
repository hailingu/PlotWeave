//! 删除清理累计指标的校验与旧旁路归档迁移读取（issue #421）：新写入由
//! journal_io 把指标与事务条目同次原子提交。本模块只在旧数组/缺失日志时
//! 读取 asset-delete-archive.json；迁移后保留旧文件但不再消费或写入。
//! 指标仍为咨询性数据，异型只告警按 0/未知重计，不改变事务恢复判定。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use serde_json::Value;

/// 折叠计数旁路归档文件名（library/ 句柄相对）。
pub(crate) const ARCHIVE_FILE_NAME: &str = "asset-delete-archive.json";

/// 归档大小上限：合法内容为 `{"retainedCleanupCount":<u64>,"trashBytes":<u64>}`
/// （约 70 字节），超限即异型——受限读取截断后解析失败，不物化超大文件。
const ARCHIVE_MAX_BYTES: usize = 128;

/// 计数合理上限（评审 5346397307/5346909203）：每笔折叠对应隔离区中
/// 一个真实文件，超过物理不可达文件计数上界（`u32::MAX`）的值只可能
/// 来自手工投毒的脏归档——读取侧按异型处置（告警并按 0 重计），防止与
/// 折叠累加时 u64 溢出 panic（debug）或回绕清零隐藏全部保留项
/// （release）；累加侧同样收敛进本上限（写入不得产出自己下次读取会判
/// 异型的值）——上限处的合法折叠把计数钉在上限持续报告，而非归零失联。
pub(super) const ARCHIVE_COUNT_MAX: u64 = u32::MAX as u64;

/// 读取累计折叠计数与隔离区字节量级：缺失回退 (0, None)；符号链接/非
/// 普通文件/超限/异型 JSON/非法形状（非对象、字段缺失或非 u64）或计数
/// 超过合理上限（评审 5346397307）→ 告警并按 (0, None) 继续；本轮折叠
/// 发生时写入新日志快照修复。`trashBytes` 缺失（旧格式归档）按
/// 未知（None）呈现、不告警——存在但非 u64 才是脏数据，告警并按未知。
pub(super) fn read_archive(library: &CapDir, warnings: &mut Vec<String>) -> (u64, Option<u64>) {
    let blocked = |warnings: &mut Vec<String>, why: &str| {
        warnings.push(format!(
            "清理归档计数{why}，按 0 重新累计（下次折叠将覆写修复）"
        ));
        (0, None)
    };
    let md = match library.symlink_metadata(ARCHIVE_FILE_NAME) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (0, None),
        Err(_) => return blocked(warnings, "读取失败"),
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return blocked(warnings, "是符号链接或非普通文件");
    }
    let text = {
        let f = match library.open(ARCHIVE_FILE_NAME) {
            Ok(f) => f,
            Err(_) => return blocked(warnings, "读取失败"),
        };
        let mut buf = Vec::new();
        if f.take((ARCHIVE_MAX_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .is_err()
        {
            return blocked(warnings, "读取失败");
        }
        if buf.len() > ARCHIVE_MAX_BYTES {
            return blocked(warnings, "超过大小上限");
        }
        match String::from_utf8(buf) {
            Ok(t) => t,
            Err(_) => return blocked(warnings, "不是合法 UTF-8"),
        }
    };
    let value = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v,
        Err(_) => return blocked(warnings, "异型"),
    };
    parse_totals(&value, warnings)
}

/// 旧归档与新日志共用的咨询性指标判型：计数异型按 0/未知，字节异型
/// 仅按未知；不把字段降级放大为事务日志只读态。
pub(super) fn parse_totals(value: &Value, warnings: &mut Vec<String>) -> (u64, Option<u64>) {
    let count = match value.get("retainedCleanupCount").and_then(Value::as_u64) {
        Some(count) if count <= ARCHIVE_COUNT_MAX => count,
        other => {
            let why = if other.is_some() {
                "超过合理上限"
            } else {
                "异型"
            };
            warnings.push(format!(
                "清理归档计数{why}，按 0 重新累计（下次日志写入将修复）"
            ));
            return (0, None);
        }
    };
    let bytes = match value.get("trashBytes") {
        None => None,
        Some(n) => match n.as_u64() {
            Some(b) => Some(b),
            None => {
                warnings.push("清理归档字节数异型，按未知呈现（下次折叠将覆写修复）".into());
                None
            }
        },
    };
    (count, bytes)
}
