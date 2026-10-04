//! 目录持久性屏障叶子（issue #399 自 trash 拆出）：`fsync_dir` 是
//! archive / journal_io / trash / recover / transaction 共用的耐久写原语，
//! 此前寄居 trash 使 journal_io ↔ trash 互依、域内成环——按 Dependency
//! Design「共享策略移到所有者」拆为本叶子模块，协议各分支单向依赖此处。

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

#[cfg(not(unix))]
pub(super) fn fsync_dir(_dir: &CapDir) -> Result<(), String> {
    Ok(())
}
