//! 真实 Wry 命令分发的主线程响应性回归；独立进程、独立应用目录，不访问用户项目。

#[cfg(target_os = "macos")]
#[path = "invoke_responsiveness/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--invoke-child") {
        macos::run();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--invoke-child")
        .output()
        .unwrap();
    print!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(output.status.success(), "{:?}", output);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("invoke 响应性原生回归仅在 macOS 运行");
}
