//! 已完成删除事务清理项的折叠归档（issue #359）：「索引已提交 + 隔离项
//! 身份核验一致 + 平台无身份绑定删除原语」的终态条目在恢复时从删除日志
//! 退役，累计计数与隔离区字节量级（issue #427）折叠进本旁路文件
//! `library/asset-delete-archive.json`（`{"retainedCleanupCount":N,"trashBytes":B}`）
//! ——日志不再随生命周期线性累积，每次命令的恢复成本与 `cleanupPending`
//! 响应大小均有界；字节量级在折叠时从已核验句柄累计并持久化，恢复路径
//! 不做任何隔离区目录遍历（媒体 URL 解析与打开同样逐请求恢复，遍历会使
//! 成本重新随历史删除数线性增长，issue #427 评审 5355629881）。
//!
//! 计数与字节数是咨询性指标，不参与恢复判定：读取异型/失败只告警并按
//! 0/未知继续（单点脏数据不放大为全局只读，威胁模型），落盘失败不阻断
//! 已完成的日志退役（fail-soft）。写入次序为「先日志退役、后归档」，
//! 崩溃窗口只会少计、不会重复计；用户整体清理 `assets/.trash/` 后由恢复
//! 归零（部分清理可能使计数与字节数偏高，已知边界，见
//! docs/data-model/assets.md）。旧格式归档缺 `trashBytes` 按未知（None）
//! 呈现、不告警；该未知跨折叠保持（历史份额不可测，折叠不得把未知总量
//! 改写为仅新增字节，评审 5355849137），直到整体清理归零后重新可知。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use serde_json::json;

use crate::library::error::LibraryError;
use crate::store::atomic_write;

use super::fsync::fsync_dir;

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
/// 发生时 write_archive 覆写修复。`trashBytes` 缺失（旧格式归档）按
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
    let count = match value.get("retainedCleanupCount").and_then(|n| n.as_u64()) {
        Some(count) if count <= ARCHIVE_COUNT_MAX => count,
        Some(_) => return blocked(warnings, "超过合理上限"),
        None => return blocked(warnings, "异型"),
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

/// 计数与字节量级原子落盘（library/ 句柄相对）并 fsync 所在目录；
/// `bytes` 为 None（未知）时省略字段，保持旧格式形状。
pub(super) fn write_archive(
    library: &CapDir,
    count: u64,
    bytes: Option<u64>,
) -> Result<(), LibraryError> {
    let mut value = json!({ "retainedCleanupCount": count });
    if let Some(b) = bytes {
        value["trashBytes"] = json!(b);
    }
    let text = serde_json::to_string(&value)
        .map_err(|e| LibraryError::serialize("序列化清理归档失败", e))?;
    if text.len() > ARCHIVE_MAX_BYTES {
        return Err(LibraryError::Limit {
            detail: "清理归档计数超过大小上限，拒绝写入".into(),
        });
    }
    atomic_write(library, ARCHIVE_FILE_NAME, &text).map_err(LibraryError::from)?;
    fsync_dir(library)
}
