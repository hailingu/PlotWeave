//! 同步持久化命令的调度边界：文件 I/O、序列化和锁等待统一离开 invoke／异步工作线程。
//!
//! 已知边界（issue #400）：worker panic 折叠为单一返回文案——不打印
//! panic 载荷或命令参数是有意取舍（载荷可能含项目内容／密钥，落日志即
//! 泄露面），代价是返回错误不含领域上下文。本调度层**自身输出**
//! （stderr 诊断行与返回文案）按稳定诊断码区分 panic 与 worker 未完成
//! （`code=worker-panicked`／`code=worker-incomplete`），使「不变量被
//! 破坏」与「未交付结果」可分诊，且不含载荷、参数或密钥——无泄露保证
//! 仅覆盖本层输出。进程级残留边界（PR #408 评审修订）：worker 线程
//! panic 时 Rust 默认 panic hook 先于 join 错误运行，仍会按默认格式把
//! panic 载荷写入 stderr；压制该 hook 是影响全应用诊断的全局取舍，
//! 不由本层单方面决定，另行登记处置。

/// 等待整个同步内核结束后再返回结果；锁须在闭包内取得、释放，业务错误原样上浮。
/// 已开始的工作不随等待者取消而中断；依赖操作仍由调用方 await 串联。
/// worker panic／未完成折叠为 `{command} 后台任务异常退出`（既有文案
/// 契约），分类诊断码只落 stderr（issue #400）。
pub(crate) async fn run<T: Send + 'static>(
    command: &'static str,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| {
            // 本层不打印 panic 载荷或命令参数，避免把项目内容／密钥写入
            // 诊断（worker 线程默认 panic hook 的进程级行为见模块文档）。
            eprintln!("{}", worker_failure_line(command, &e));
            format!("{command} 后台任务异常退出")
        })?
}

/// worker 失败的结构化 stderr 诊断行（issue #400）：join 错误按来源分类
/// ——panic（领域不变量被破坏，最需关注）与未完成（取消／饱和／进程级
/// 资源异常）使用不同 `code=`；非 JoinError 的错误保守归入未完成。
fn worker_failure_line(command: &str, error: &tauri::Error) -> String {
    let code = match error {
        tauri::Error::JoinError(e) if e.is_panic() => "worker-panicked",
        _ => "worker-incomplete",
    };
    format!("[blocking] command={command} code={code}")
}

#[cfg(test)]
mod tests {
    use super::{run, worker_failure_line};

    #[test]
    fn retains_operation_error_and_recovers_after_worker_panic() {
        tauri::async_runtime::block_on(async {
            let error = run("fixture", || Err::<(), _>("领域拒绝".into())).await;
            assert_eq!(error, Err("领域拒绝".into()));
            let panic = run("fixture", || -> Result<(), String> { panic!("fixture") }).await;
            assert_eq!(panic, Err("fixture 后台任务异常退出".into()));
            assert_eq!(run("fixture", || Ok(42)).await, Ok(42));
        });
    }

    #[test]
    fn classifies_worker_panic_and_incomplete_codes() {
        // issue #400：join 失败须按稳定诊断码分类——第 1 类（领域代码
        // panic，不变量被破坏）与第 2/3 类（worker 未交付结果：取消/
        // 饱和/进程级资源异常）可区分，且诊断行不携带 panic 载荷或命令
        // 参数之外的任何内容。两类错误均以真实 JoinError 构造。
        tauri::async_runtime::block_on(async {
            let panicked: tauri::Error = tauri::async_runtime::spawn(async { panic!("fixture") })
                .await
                .expect_err("panic 任务应 join 失败");
            assert_eq!(
                worker_failure_line("fixture", &panicked),
                "[blocking] command=fixture code=worker-panicked"
            );

            let cancelled = tauri::async_runtime::spawn(std::future::pending::<()>());
            cancelled.abort();
            let incomplete: tauri::Error = cancelled.await.expect_err("被取消任务应 join 失败");
            assert_eq!(
                worker_failure_line("fixture", &incomplete),
                "[blocking] command=fixture code=worker-incomplete"
            );
        });
    }
}
