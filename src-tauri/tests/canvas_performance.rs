//! 显式 opt-in 的 Tauri/Wry 同夹具性能基线；每规模使用独立主线程子进程。

#[cfg(target_os = "macos")]
#[path = "canvas_performance/attribution.rs"]
mod attribution;
#[cfg(target_os = "macos")]
#[path = "invoke_responsiveness/cleanup.rs"]
mod cleanup;
#[cfg(target_os = "macos")]
#[path = "canvas_performance/config.rs"]
mod config;
#[cfg(target_os = "macos")]
#[path = "canvas_performance/macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
#[path = "canvas_performance/memory.rs"]
mod memory;
#[cfg(target_os = "macos")]
#[path = "canvas_performance/report.rs"]
mod report;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|argument| argument == "--canvas-perf-child") {
        let scale = std::env::args()
            .skip_while(|argument| argument != "--scale")
            .nth(1)
            .and_then(|value| value.parse::<u32>().ok())
            .expect("Tauri 性能子进程需要 --scale");
        let code = macos::run_child(scale);
        std::process::exit(code);
    }
    if std::env::var_os("PLOTWEAVE_CANVAS_PERF_URL").is_none() {
        println!("Tauri 真实性能测量未启用：设置 PLOTWEAVE_CANVAS_PERF_URL 后运行");
        return;
    }
    for scale in config::SCALES {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--canvas-perf-child")
            .arg("--scale")
            .arg(scale.to_string())
            .output()
            .unwrap();
        print!("{}", String::from_utf8_lossy(&output.stdout));
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        assert!(
            output.status.success(),
            "scale {scale} 测量失败：{output:?}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("Tauri 真实性能测量仅在 macOS 运行");
}
