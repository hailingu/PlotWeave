//! 库操作互斥锁（issue #25 评审修复，issue #39 自 library_journal.rs 拆出）：
//! 进程内 Mutex（同进程并发删除/导入/更新的串行）+ 跨进程文件锁（flock——
//! 两个 Tauri 进程各自持有独立内存锁，文件系统层串行化完整事务）。锁覆盖
//! 完整 read/recover/mutate/commit 边界，任一时刻至多一个库操作持有索引/
//! 日志/媒体的写侧。

use std::sync::{Mutex, MutexGuard, OnceLock};

use cap_std::fs::Dir as CapDir;

use crate::library::error::LibraryError;

/// 库操作互斥锁（issue #25 评审修复）：进程内 Mutex（同进程并发删除/导入/
/// 更新的串行）+ 跨进程文件锁（flock on journal 文件——两个 Tauri 进程各自
/// 持有独立内存锁，文件系统层串行化完整事务）。锁覆盖完整 read/recover/
/// mutate/commit 边界，任一时刻至多一个库操作持有索引/日志/媒体的写侧。
/// 中毒后行为（issue #145）：可验证恢复——本锁不守卫内存状态，磁盘一致性
/// 由 §7.2 日志可恢复提交协议独立保证（持锁 panic 对盘上状态等价于崩溃，
/// recover 在每个操作起始照常执行），经 `crate::lock::recover_guard` 恢复
/// 并留诊断，不传播 panic。
static LIBRARY_OP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn library_op_lock() -> MutexGuard<'static, ()> {
    crate::lock::recover_guard(
        LIBRARY_OP_LOCK.get_or_init(|| Mutex::new(())).lock(),
        "库操作锁",
    )
}

/// 跨进程文件锁：对 asset-delete-journal.json 持有排他 flock——两个并发
/// Tauri 进程的库写入在同一日志文件上串行（flock 语义：内核保证、不依赖
/// 进程内内存）。返回的句柄句柄用于解锁（drop 时释放）。
/// no-follow 归类（issue #721）：锁文件打开与同域其余入口（索引/资产/
/// .trash）同一纪律——既有符号链接或非普通文件按类别保护性拒绝，仅确证
/// NotFound 才首建；归类与打开之间的名字交换属已记录范围外威胁模型
/// （TOCTOU），不在本层防御。
pub(crate) fn library_file_lock(library: &CapDir) -> Result<cap_std::fs::File, LibraryError> {
    // 独立持久锁文件（评审修复）：journal 会被 write_journal 原子替换，
    // flock 随旧 inode 失效；锁文件永不被替换
    let file = open_lock_file_classified(library)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // flock 排他锁：同一文件上两个并发进程串行
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(LibraryError::refused("获取库操作文件锁失败"));
        }
    }
    #[cfg(not(unix))]
    {
        // 非 Unix 无 flock：回退到进程内 Mutex（文档已记录威胁模型边界）
    }
    Ok(file)
}

/// 锁文件 no-follow 归类打开（issue #721）：先 `symlink_metadata` 归类，
/// 既有条目必须是普通文件才直接打开；仅确证 NotFound 以 `create_new`
/// 首建，open 不跟随未归类的既有符号链接。跨进程首建竞态（NotFound
/// 归类后他进程抢先创建，`create_new` 返回 AlreadyExists）通过重新归类
/// 收敛；有界次数内未收敛按保护性拒绝报告。
fn open_lock_file_classified(library: &CapDir) -> Result<cap_std::fs::File, LibraryError> {
    const LOCK_FILE_NAME: &str = ".library-op.lock";
    const OPEN_ATTEMPTS: usize = 4;
    for _ in 0..OPEN_ATTEMPTS {
        match library.symlink_metadata(LOCK_FILE_NAME) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(LibraryError::refused("库操作锁文件是符号链接，拒绝打开"));
            }
            Ok(md) if !md.is_file() => {
                return Err(LibraryError::refused("库操作锁文件不是普通文件"));
            }
            Ok(_) => {
                return library
                    .open_with(LOCK_FILE_NAME, cap_std::fs::OpenOptions::new().write(true))
                    .map_err(|e| LibraryError::io("打开库操作锁文件失败", e));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match library.open_with(
                    LOCK_FILE_NAME,
                    cap_std::fs::OpenOptions::new().write(true).create_new(true),
                ) {
                    Ok(f) => return Ok(f),
                    // 归类后他进程抢先首建：重新归类走既有文件分支
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => {
                        return Err(LibraryError::io("创建库操作锁文件失败", e));
                    }
                }
            }
            Err(e) => return Err(LibraryError::io("读取库操作锁文件元数据失败", e)),
        }
    }
    Err(LibraryError::refused(
        "库操作锁文件创建竞态未收敛，拒绝打开",
    ))
}
