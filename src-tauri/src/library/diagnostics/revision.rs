//! 诊断序号域叶子（issue #399 自 diagnostics.rs 拆出）：reserve_revision
//! 与 LAST_REVISION 是 diagnostics.rs 与 recovery_events.rs 共用的序号
//! 原语，此前寄居 diagnostics.rs 使父↔子互依成环——按 Dependency Design
//! 提取为叶子，两侧单向依赖。

use std::sync::atomic::{AtomicU64, Ordering};

use crate::library::error::LibraryError;

/// 与原生进程同寿命；所有诊断生产者共用。前端随原生进程重启建立新会话。
pub(super) static LAST_REVISION: AtomicU64 = AtomicU64::new(0);

/// 在操作前预留序号，失败允许留空号；耗尽时拒绝操作，绝不回绕到旧序号。
pub(super) fn reserve_revision(counter: &AtomicU64) -> Result<u64, LibraryError> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| LibraryError::Limit {
            detail: "图库诊断序号已耗尽，请重启应用".into(),
        })
}
