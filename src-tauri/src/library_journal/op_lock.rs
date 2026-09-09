//! 库操作互斥锁（issue #25 评审修复，issue #39 自 library_journal.rs 拆出）：
//! 进程内 Mutex（同进程并发删除/导入/更新的串行）+ 跨进程文件锁（flock——
//! 两个 Tauri 进程各自持有独立内存锁，文件系统层串行化完整事务）。锁覆盖
//! 完整 read/recover/mutate/commit 边界，任一时刻至多一个库操作持有索引/
//! 日志/媒体的写侧。

use std::sync::{Mutex, MutexGuard, OnceLock};

use cap_std::fs::Dir as CapDir;

/// 库操作互斥锁（issue #25 评审修复）：进程内 Mutex（同进程并发删除/导入/
/// 更新的串行）+ 跨进程文件锁（flock on journal 文件——两个 Tauri 进程各自
/// 持有独立内存锁，文件系统层串行化完整事务）。锁覆盖完整 read/recover/
/// mutate/commit 边界，任一时刻至多一个库操作持有索引/日志/媒体的写侧。
static LIBRARY_OP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn library_op_lock() -> MutexGuard<'static, ()> {
    LIBRARY_OP_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("库操作锁被污染")
}

/// 跨进程文件锁：对 asset-delete-journal.json 持有排他 flock——两个并发
/// Tauri 进程的库写入在同一日志文件上串行（flock 语义：内核保证、不依赖
/// 进程内内存）。返回的句柄句柄用于解锁（drop 时释放）。
pub(crate) fn library_file_lock(library: &CapDir) -> Result<cap_std::fs::File, String> {
    // 独立持久锁文件（评审修复）：journal 会被 write_journal 原子替换，
    // flock 随旧 inode 失效；锁文件永不被替换
    let file = library
        .open_with(
            ".library-op.lock",
            cap_std::fs::OpenOptions::new().write(true).create(true),
        )
        .map_err(|e| format!("打开库操作锁文件失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // flock 排他锁：同一文件上两个并发进程串行
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err("获取库操作文件锁失败".into());
        }
    }
    #[cfg(not(unix))]
    {
        // 非 Unix 无 flock：回退到进程内 Mutex（文档已记录威胁模型边界）
    }
    Ok(file)
}
