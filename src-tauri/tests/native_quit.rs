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
    let _runtime = tauri::Builder::default()
        .build(tauri::generate_context!())
        .unwrap();
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
