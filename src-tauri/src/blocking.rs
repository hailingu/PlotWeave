//! 同步持久化命令的调度边界：文件 I/O、序列化和锁等待统一离开 invoke／异步工作线程。

/// 等待整个同步内核结束后再返回结果；锁须在闭包内取得、释放，业务错误原样上浮。
/// 已开始的工作不随等待者取消而中断；依赖操作仍由调用方 await 串联。
pub(crate) async fn run<T: Send + 'static>(
    command: &'static str,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| {
            // 不打印 panic 载荷或命令参数，避免把项目内容／密钥写入诊断。
            eprintln!("[blocking] command={command} code=worker-failed");
            format!("{command} 后台任务异常退出")
        })?
}

#[cfg(test)]
mod tests {
    use super::run;

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
}
