//! 目录持久性屏障叶子（issue #399 自 trash 拆出）：`fsync_dir` 是
//! archive / journal_io / trash / recover / transaction 共用的耐久写原语，
//! 此前寄居 trash 使 journal_io ↔ trash 互依、域内成环——按 Dependency
//! Design「共享策略移到所有者」拆为本叶子模块，协议各分支单向依赖此处。
//!
//! 平台边界（issue #546）：两个 cfg 变体保持同名同签名，本叶子在非 Unix
//! 目标上参与编译（官方仅支持 macOS；Windows 等由使用者自行构建，见
//! README 平台声明）——屏障能力缺失时按 §7.2「无法提供时不得进入下一
//! 阶段」显式拒绝，不静默降级耐久性。

use cap_std::fs::Dir as CapDir;

use crate::library::error::LibraryError;

/// 目录持久性屏障（Unix）。
#[cfg(unix)]
pub(super) fn fsync_dir(dir: &CapDir) -> Result<(), LibraryError> {
    let sync = || dir.open_dir(".").and_then(|d| d.into_std_file().sync_all());
    #[cfg(test)]
    let result = crate::store::atomic_write_faults::run(
        crate::store::atomic_write_faults::Stage::LibraryDirectorySync,
        sync,
    );
    #[cfg(not(test))]
    let result = sync();
    result.map_err(|e| LibraryError::io("同步目录失败（持久性屏障缺失）", e))
}

/// 非 Unix 无目录句柄持久性屏障原语：按 §7.2 契约显式拒绝进入下一阶段，
/// 返回类型与 Unix 变体一致（issue #546 修复此前的 `Result<(), String>`
/// 签名漂移）。
#[cfg(not(unix))]
pub(super) fn fsync_dir(_dir: &CapDir) -> Result<(), LibraryError> {
    Err(LibraryError::refused(
        "平台缺少目录持久性屏障，无法完成耐久提交",
    ))
}
