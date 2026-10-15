//! AppKit 正常退出适配：取消原生 terminate:，交由既有前端保存屏障放行。
//! 回调和关联指针仅在主线程使用，guard 由 run 持有至事件循环结束；无全局应用状态。
//! 回调 panic 遏制在 Rust 侧并保守拒绝退出（issue #547）。
use std::ffi::{c_char, c_void};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
    fn objc_retain(object: *mut c_void) -> *mut c_void;
    fn objc_release(object: *mut c_void);
    fn object_getClass(object: *mut c_void) -> *mut c_void;
    fn class_getInstanceMethod(class: *mut c_void, selector: *mut c_void) -> *mut c_void;
    fn class_addMethod(
        class: *mut c_void,
        selector: *mut c_void,
        implementation: *const c_void,
        types: *const c_char,
    ) -> bool;
    fn objc_setAssociatedObject(
        object: *mut c_void,
        key: *const u8,
        value: *mut c_void,
        policy: usize,
    );
    fn objc_getAssociatedObject(object: *mut c_void, key: *const u8) -> *mut c_void;
}

// 只使用地址作为 Objective-C 关联键；不存放进程级可变状态。
static HANDLER_KEY: u8 = 0;

/// 主线程拥有的退出回调；raw pointer 使 guard 不可 Send/Sync，销毁时先解除关联。
pub struct NativeQuit {
    delegate: *mut c_void,
    // 外层 Box 提供关联所需的稳定薄指针；内层持有闭包的动态分发信息。
    request: Box<Box<dyn Fn()>>,
}

impl Drop for NativeQuit {
    fn drop(&mut self) {
        // SAFETY: guard 在安装线程销毁；解除关联后才释放 request。
        unsafe {
            objc_setAssociatedObject(self.delegate, &HANDLER_KEY, std::ptr::null_mut(), 0);
            objc_release(self.delegate);
        }
    }
}

/// 在 Tauri 创建 AppKit delegate 后安装一次；必须在主线程调用并持有返回值至退出。
pub fn install(request: impl Fn() + 'static) -> Result<NativeQuit, String> {
    // SAFETY: pthread_main_np 无前置条件；后续 selector 均为 NSObject/AppKit 的无参对象返回值。
    unsafe {
        if libc::pthread_main_np() != 1 {
            return Err("原生退出屏障必须在主线程安装".into());
        }
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let application = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let delegate = send(application, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() {
            return Err("原生退出屏障缺少 AppKit delegate".into());
        }
        let class = object_getClass(delegate);
        let selector = sel_registerName(c"applicationShouldTerminate:".as_ptr());
        if !class_getInstanceMethod(class, selector).is_null() {
            return Err("AppKit delegate 已有退出处理器，无法安装保存屏障".into());
        }
        // NSUInteger applicationShouldTerminate:(NSApplication *)；当前 macOS 目标均为 64 位。
        if !class_addMethod(
            class,
            selector,
            should_terminate as *const c_void,
            c"Q@:@".as_ptr(),
        ) {
            return Err("安装原生退出屏障失败".into());
        }
        let mut barrier = NativeQuit {
            delegate: objc_retain(delegate),
            request: Box::new(Box::new(request)),
        };
        let pointer = (&mut *barrier.request as *mut Box<dyn Fn()>).cast();
        // ASSIGN 不会对 Rust 指针执行 Objective-C retain/release；生命周期由 guard 管理。
        objc_setAssociatedObject(delegate, &HANDLER_KEY, pointer, 0);
        Ok(barrier)
    }
}

/// AppKit 主线程回调：先通知前端，再返回 NSTerminateCancel；受控 app_exit 不走 terminate:。
/// 回调 panic 不跨 extern "C" 边界（issue #547）：遏制后按未知冲刷状态保守
/// 拒绝本次终止——批准终止只能发生在保存冲刷完成的受控路径上，panic 后
/// 是否已通知前端不可知，就地放行可能中断在途保存。
extern "C" fn should_terminate(delegate: *mut c_void, _: *mut c_void, _: *mut c_void) -> usize {
    // SAFETY: 关联由 install 建立且由同一主线程的 guard 管理；未安装时允许正常退出。
    unsafe {
        let pointer = objc_getAssociatedObject(delegate, &HANDLER_KEY).cast::<Box<dyn Fn()>>();
        if pointer.is_null() {
            return 1; // NSTerminateNow
        }
        // AssertUnwindSafe：回调可能持有共享应用状态（QuitGate 等），panic 后
        // 其不变量或已受损；本层只承诺不再调用并拒绝退出，不负责恢复其状态。
        if let Err(payload) = catch_unwind(AssertUnwindSafe(|| (*pointer)())) {
            // 与 blocking.rs 同口径（issue #400）：不落 panic 载荷，仅稳定诊断码。
            // 显式忽略写错误而非 eprintln!（PR #580 评审）：eprintln! 在写失败
            // （如断管 EPIPE）时自身 panic，且此处已在 catch_unwind 之外，
            // 会重新越过 extern "C" 边界使遏制失效；诊断尽力而为，静默放弃。
            let _ = writeln!(
                std::io::stderr(),
                "[native-quit] code=quit-callback-panicked"
            );
            // 载荷自身的 Drop 也可能 panic（panic_any 自定义载荷，PR #580 第二轮
            // 评审）：显式绑定并在边界内二次遏制其析构；若析构再次 panic，其
            // 嵌套载荷直接遗忘、不再递归展开——该失败路径至多泄漏一枚载荷。
            if let Err(nested) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
                std::mem::forget(nested);
            }
        }
        0 // NSTerminateCancel
    }
}
