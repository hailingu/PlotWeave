//! 库命令诊断的进程内序号：持有既有库操作锁和文件锁执行操作、附加序号，
//! 再释放锁。序号仅用于同一原生进程的 IPC 快照排序，不写入资产或日志。

use std::sync::atomic::{AtomicU64, Ordering};

use cap_std::fs::Dir;
use serde_json::Value;

use super::error::LibraryError;
use crate::library_journal::Recovery;

mod recovery_events;
pub(crate) use recovery_events::{publish_recovery, with_recovery_snapshot};
use recovery_events::{with_observations, RecoverySnapshot};

/// 与原生进程同寿命；所有诊断生产者共用。前端随原生进程重启建立新会话。
static LAST_REVISION: AtomicU64 = AtomicU64::new(0);

/// 在操作前预留序号，失败允许留空号；耗尽时拒绝操作，绝不回绕到旧序号。
fn reserve_revision(counter: &AtomicU64) -> Result<u64, LibraryError> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| LibraryError::Limit {
            detail: "图库诊断序号已耗尽，请重启应用".into(),
        })
}

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
