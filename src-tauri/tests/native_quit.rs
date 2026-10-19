//! 用独立主线程进程调用 AppKit terminate:，验证 Dock Quit 使用的原生退出边界。
#[cfg(target_os = "macos")]
#[path = "../src/logging.rs"]
mod logging;
#[cfg(target_os = "macos")]
#[path = "../src/native_quit.rs"]
mod native_quit;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--native-quit-logger-panic-child") {
        panic_logger_child();
        return;
    }
    logging::init();
    if std::env::args().any(|arg| arg == "--native-quit-child") {
        child();
        return;
    }
    if std::env::args().any(|arg| arg == "--native-quit-panic-child") {
        panic_child();
        return;
    }
    if std::env::args().any(|arg| arg == "--native-quit-broken-stderr-child") {
        panic_broken_stderr_child();
        return;
    }
    if std::env::args().any(|arg| arg == "--native-quit-payload-drop-child") {
        panic_payload_drop_child();
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
        has_quit_panic_record(&panicked.stderr),
        "回调 panic 未产生结构化诊断：{:?}",
        panicked
    );

    // PR #580 评审：stderr 不可写时诊断写入失败不得使遏制失效——写失败自身
    // 不允许产生新的越界 panic。断管（EPIPE）是 std 不吞错的确定性触发
    // （EBADF 被 std::io 特判为成功）；stdout 仍为有效管道，marker 照常可达。
    let sealed = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--native-quit-broken-stderr-child")
        .output()
        .unwrap();
    assert!(sealed.status.success(), "{:?}", sealed);
    assert!(
        String::from_utf8_lossy(&sealed.stdout).contains("native-quit-broken-stderr-contained"),
        "stderr 断管引发的二次 panic 跨边界中断了进程：{:?}",
        sealed
    );

    // PR #580 第二轮评审：panic 载荷自身的 Drop panic 不得越过边界——
    // panic_any 注入 Drop 中 panic 的载荷，terminate: 后进程仍须存活。
    let payload = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--native-quit-payload-drop-child")
        .output()
        .unwrap();
    assert!(payload.status.success(), "{:?}", payload);
    assert!(
        String::from_utf8_lossy(&payload.stdout).contains("native-quit-payload-drop-contained"),
        "载荷析构 panic 跨边界中断了进程：{:?}",
        payload
    );
    assert_logger_panic_containment();
}

/// Issues #547/#633: inspect the stable diagnostic code and parsed level/target metadata, not output layout.
#[cfg(target_os = "macos")]
fn has_quit_panic_record(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|record| {
            record["target"] == "plotweave::native_quit"
                && record["level"] == "ERROR"
                && record["message"] == "code=quit-callback-panicked"
        })
}

/// Issue #633: a panicking installed logger cannot turn a caught quit failure into a C-boundary unwind.
#[cfg(target_os = "macos")]
fn assert_logger_panic_containment() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--native-quit-logger-panic-child")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("native-quit-logger-panic-contained"),
        "{output:?}"
    );
}

/// Both the installed logger and its panic payload's destructor fail; the original quit decision stays conservative.
#[cfg(target_os = "macos")]
fn panic_logger_child() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    struct PayloadDropPanics;
    impl Drop for PayloadDropPanics {
        fn drop(&mut self) {
            panic!("fixture: logger payload drop");
        }
    }
    struct PanickingLogger;
    impl log::Log for PanickingLogger {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.target() == "plotweave::native_quit"
        }
        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                assert_eq!(record.level(), log::Level::Error);
                CALLS.fetch_add(1, Ordering::SeqCst);
                std::panic::panic_any(PayloadDropPanics);
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: PanickingLogger = PanickingLogger;
    log::set_logger(&LOGGER).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    logging::init();
    assert_eq!(log::max_level(), log::LevelFilter::Trace);
    panic_child();
    assert_eq!(CALLS.load(Ordering::SeqCst), 2);
    println!("native-quit-logger-panic-contained");
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

/// PR #580 评审：回调 panic 且 stderr 不可写时，诊断写入失败不得产生新的
/// 越界 panic。把 fd 2 换成读端已关闭的管道写端——写入稳定返回 EPIPE，
/// 且完全在子进程内构造、无父子竞态；EBADF（fd 关闭/只读）被 std::io
/// 特判为成功，构不成触发。terminate: 后进程仍须存活并拒绝终止。
#[cfg(target_os = "macos")]
fn panic_broken_stderr_child() {
    use std::ffi::{c_char, c_void};
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
        let barrier = native_quit::install(|| panic!("fixture")).unwrap();
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(libc::pipe(fds.as_mut_ptr()), 0, "创建断管夹具失败");
        assert_eq!(libc::dup2(fds[1], 2), 2);
        libc::close(fds[0]);
        libc::close(fds[1]);
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        // 到达即证明：诊断写失败被静默吞掉，遏制在 stderr 断管时仍然成立。
        println!("native-quit-broken-stderr-contained");
        drop(barrier);
    }
}

/// PR #580 第二轮评审：catch_unwind 捕获的 panic 载荷若在 Drop 中 panic，
/// 其析构发生在 catch 之外的 extern "C" 函数体内——必须同样被遏制。
/// 经 panic_any 注入 Drop 中 panic 的自定义载荷验证。
#[cfg(target_os = "macos")]
fn panic_payload_drop_child() {
    use std::ffi::{c_char, c_void};
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    struct PayloadDropPanics;
    impl Drop for PayloadDropPanics {
        fn drop(&mut self) {
            panic!("fixture: 载荷析构");
        }
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
        let barrier = native_quit::install(|| {
            std::panic::panic_any(PayloadDropPanics);
        })
        .unwrap();
        send_arg(app, sel_registerName(c"terminate:".as_ptr()), app);
        // 到达即证明：载荷析构 panic 被遏制在边界内，终止被拒绝。
        println!("native-quit-payload-drop-contained");
        drop(barrier);
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
