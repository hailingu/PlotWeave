//! 库命令诊断的进程内序号：持有既有库操作锁和文件锁执行操作、附加序号，
//! 再释放锁。序号仅用于同一原生进程的 IPC 快照排序，不写入资产或日志。

use cap_std::fs::Dir;
use serde_json::Value;

use super::error::LibraryError;
use crate::library_journal::Recovery;

mod recovery_events;
mod revision;
pub(crate) use recovery_events::{publish_recovery, with_recovery_snapshot};
use recovery_events::{with_observations, RecoverySnapshot};

/// 六个诊断命令的共同执行边界（列表也供组列表消费）；锁内生成完整响应，
/// 按实际库操作顺序标号。业务失败仍经事件发布已完成恢复；未完成恢复不
/// 伪造快照。成功只返回最终响应，避免前置恢复事件覆盖删除等后续变更。
pub(super) fn with_snapshot(
    library: &Dir,
    operation: impl FnOnce(&Dir, &mut dyn FnMut(&Recovery)) -> Result<Value, LibraryError>,
    publish: impl FnOnce(RecoverySnapshot),
) -> Result<Value, LibraryError> {
    with_observations(
        library,
        |dir, report, revision| {
            let mut response = operation(dir, report)?;
            let object = response
                .as_object_mut()
                .ok_or_else(|| LibraryError::Corrupt {
                    detail: "图库诊断响应必须为对象".into(),
                })?;
            object.insert(
                "diagnosticsRevision".into(),
                Value::String(revision.to_string()),
            );
            Ok(response)
        },
        |result, snapshot| {
            if result.is_err() {
                publish(snapshot);
            }
        },
    )
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
