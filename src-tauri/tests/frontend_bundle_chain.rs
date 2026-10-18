//! 前端 bundle → IPC → Rust 命令 → 真实落盘 的全链路回归入口（issue #551）：
//! 真实 Wry webview 经自注册 `pw-bundle://` scheme 加载 `dist/` 真实构建产物，
//! 由页面 JS 侧驱动核心命令并断言磁盘结果——与 invoke_responsiveness 同为
//! harness=false 子进程模式，但方向相反（命令从 webview 发起而非 Rust 侧
//! 构造 InvokeRequest），补上前端 mock IPC 测试与 Rust 侧驱动之间的链路空档。
//! `dist/` 缺失时（本地未构建前端）显式提示并跳过，不阻断路由检查命令。

#[cfg(target_os = "macos")]
#[path = "frontend_bundle_chain/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--bundle-chain-child") {
        let code = macos::run_child();
        std::process::exit(code);
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--bundle-chain-child")
        .output()
        .unwrap();
    print!("{}", String::from_utf8_lossy(&output.stdout));
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "{:?}", output);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("前端 bundle 全链路回归仅在 macOS 运行");
}
