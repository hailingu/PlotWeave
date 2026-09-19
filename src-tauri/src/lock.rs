//! 共享 Mutex 的中毒后领域策略（issue #145，规范依据
//! docs/development/rust-standard.md「锁与共享状态」）：本 crate 的共享
//! Mutex 一律采用**可验证恢复**——中毒（此前有持锁 panic）不传播 panic、
//! 不静默忽略，经本模块统一恢复并留结构化诊断。各锁的恢复论证
//! （为什么 into_inner 后状态依然自洽）记录于 rust-standard 的锁策略
//! 条目：磁盘一致性由独立协议保证（§7.2 日志可恢复提交、§10.2 原子写）
//! 或守卫对象为纯内存建议性状态（登记表/取消表/计数闸门，单项 infallible
//! 操作不会留下结构损坏）。

use std::sync::{LockResult, MutexGuard};

/// 中毒恢复内核（issue #145）：锁被污染时不传播 panic、不静默忽略——
/// 留下结构化诊断后以 `into_inner` 继续，守卫数据原样交还（Rust 内存
/// 安全保证锁内数据无结构损坏；各锁的自洽性论证见模块文档与
/// rust-standard）。`Mutex::lock` 与 `Condvar::wait` 同一 LockResult
/// 形状，共用本内核。`label` 为锁的领域名（用于诊断）。
pub(crate) fn recover_guard<'a, T>(
    result: LockResult<MutexGuard<'a, T>>,
    label: &str,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(|poisoned| {
        eprintln!(
            "[lock] {label}：此前有持锁 panic，按中毒恢复策略继续（panic 现场见 panic hook 输出）"
        );
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// [issue #145](https://github.com/hailingu/PlotWeave/issues/145)：中毒
    /// 恢复内核——持锁 panic 后不传播 panic、不静默忽略；已提交的状态
    /// 保留，恢复后读写照常（重复恢复亦成立）。
    #[test]
    fn recover_guard_continues_after_poison_and_preserves_state() {
        let mutex = Mutex::new(vec![1]);
        std::thread::scope(|s| {
            s.spawn(|| {
                let mut guard = mutex.lock().expect("先取得锁");
                guard.push(2);
                panic!("测试注入的持锁 panic");
            })
            .join()
            .expect_err("注入 panic 应发生");
        });
        // 已提交状态（panic 前的 push）保留；恢复后照常读写
        recover_guard(mutex.lock(), "测试锁").push(3);
        assert_eq!(
            *recover_guard(mutex.lock(), "测试锁"),
            vec![1, 2, 3],
            "中毒恢复须保留已提交状态并允许后续访问"
        );
    }
}
