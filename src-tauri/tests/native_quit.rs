//! 用独立主线程进程调用 AppKit terminate:，验证 Dock Quit 使用的原生退出边界。
#[cfg(target_os = "macos")]
#[path = "../src/native_quit.rs"]
mod native_quit;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--native-quit-child") {
        child();
        return;
    }
    if std::env::args().any(|arg| arg == "--native-quit-panic-child") {
        panic_child();
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--native-quit-child")
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("native-quit-cancelled"),
        "AppKit 在退出屏障处理前终止了进程：{:?}",
        output
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("termination-unexpectedly-blocked"));

    // issue #547：退出回调 panic 必须遏制在 Rust 侧——子进程不 abort、
    // 终止被拒绝（marker 得以打印）、稳定诊断码落 stderr、guard 卸载不受影响。
    let panicked = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--native-quit-panic-child")
        .output()
        .unwrap();
    assert!(panicked.status.success(), "{:?}", panicked);
    let panic_stdout = String::from_utf8_lossy(&panicked.stdout);
    assert!(
        panic_stdout.contains("native-quit-panic-contained"),
        "回调 panic 跨 extern \"C\" 边界中断了进程：{:?}",
        panicked
    );
    assert!(
        panic_stdout.contains("native-quit-panic-guard-dropped"),
        "panic 后 guard 卸载失败：{:?}",
        panicked
    );
    assert!(
        String::from_utf8_lossy(&panicked.stderr)
            .contains("[native-quit] code=quit-callback-panicked"),
        "回调 panic 未产生结构化诊断：{:?}",
        panicked
    );
}

/// 构建真实 Tauri 运行时以获得 AppKit delegate：generate_context! 内嵌的
/// Info.plist 段每个二进制仅可展开一次，两个子进程模式共用本入口。
#[cfg(target_os = "macos")]
fn tauri_runtime() -> tauri::App {
    tauri::Builder::default()
        .build(tauri::generate_context!())
        .unwrap()
}

/// issue #547：退出回调 panic 须遏制在 Rust 侧——不跨 extern "C" 边界
/// unwind、不中断进程；终止按未知冲刷状态保守拒绝（到达 marker 即证明
/// terminate: 未就地退出进程），guard 卸载与再次退出请求不受遏制影响。
#[cfg(target_os = "macos")]
fn panic_child() {
    use std::ffi::{c_char, c_void};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    let _runtime = tauri_runtime();
    // SAFETY: selector 与签名均来自 AppKit/NSObject；此子进程在主线程执行。
    unsafe {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_arg: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let app = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let barrier = native_quit::install(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            panic!("fixture");
        })
        .unwrap();
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        // 到达即证明：panic 未跨边界 abort，且返回值拒绝了本次终止。
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        assert_eq!(
            requests.load(Ordering::SeqCst),
            2,
            "遏制后回调路径仍可进入：退出请求可重试"
        );
        println!("native-quit-panic-contained");
        drop(barrier);
        println!("native-quit-panic-guard-dropped");
    }
}

/// 使用 Tauri 创建的真实 AppKit delegate 与 terminate:；取消后仍可继续执行并收到通知。
#[cfg(target_os = "macos")]
fn child() {
    use std::ffi::{c_char, c_void};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    let _runtime = tauri_runtime();
    // SAFETY: 所有 selector 与签名均来自 AppKit/NSObject；此子进程在主线程执行。
    unsafe {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_arg: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let app = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let requests = Arc::new(AtomicUsize::new(0));
        let observed = requests.clone();
        let barrier = native_quit::install(move || {
            observed.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        println!("native-quit-cancelled");
        drop(barrier);
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        println!("termination-unexpectedly-blocked");
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {}
