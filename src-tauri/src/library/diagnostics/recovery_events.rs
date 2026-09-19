//! 不返回图库信封的恢复入口：锁内收集诊断，锁外通过同一序号域发布事件。
//! 媒体/导入最终失败也不能丢掉已完成恢复的警告；不延长媒体字节读取的锁。

use cap_std::fs::Dir;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{reserve_revision, LAST_REVISION};
use crate::library::error::LibraryError;
use crate::library_journal::{library_file_lock, library_op_lock, Recovery};

/// 与命令响应共用的诊断信封；没有成功恢复时不构造伪空快照。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySnapshot {
    diagnostics_revision: String,
    warnings: Vec<String>,
    cleanup_pending: Vec<String>,
}

impl RecoverySnapshot {
    /// 同一操作中的后续观察刷新当前项，警告保留，避免一次性修复诊断丢失。
    fn capture(&mut self, recovery: &Recovery) {
        self.cleanup_pending.clone_from(&recovery.cleanup_pending);
        for warning in &recovery.warnings {
            if !self.warnings.contains(warning) {
                self.warnings.push(warning.clone());
            }
        }
    }
}

/// 库媒体 URL、媒体打开与项目导入共用的锁/发号边界。内核显式报告每次
/// 成功恢复；操作失败仍发布已收集快照，未完成恢复则只传播原始错误。
/// 发布发生在释放锁之后，事件和命令响应可乱序，消费者按序号收敛。
pub(crate) fn with_recovery_snapshot<T, E: From<LibraryError>>(
    library: &Dir,
    operation: impl FnOnce(&Dir, &mut dyn FnMut(&Recovery)) -> Result<T, E>,
    publish: impl FnOnce(RecoverySnapshot),
) -> Result<T, E> {
    let (result, snapshot) = {
        let _op = library_op_lock();
        let _file_lock = library_file_lock(library)?;
        let revision = reserve_revision(&LAST_REVISION)?;
        let mut snapshot = None;
        let result = operation(library, &mut |recovery| {
            let current = snapshot.get_or_insert_with(|| RecoverySnapshot {
                diagnostics_revision: revision.to_string(),
                warnings: Vec::new(),
                cleanup_pending: Vec::new(),
            });
            current.capture(recovery);
        });
        (result, snapshot)
    };
    if let Some(snapshot) = snapshot {
        publish(snapshot);
    }
    result
}

/// Tauri 事件适配器：发送失败留结构化日志，不把已落定操作伪报成失败。
pub(crate) fn publish_recovery(app: &AppHandle, snapshot: RecoverySnapshot) {
    if let Err(error) = app.emit("library-diagnostics", snapshot) {
        eprintln!("[library] LIBRARY_DIAGNOSTICS_EMIT_FAILED: {error}");
    }
}

#[cfg(test)]
#[path = "recovery_events_tests.rs"]
mod tests;
