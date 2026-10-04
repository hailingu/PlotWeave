//! PlotWeave 供 Swift 链接的 C ABI 边界（迁移计划 §2.3/§4.3，矩阵 M14）。
//!
//! 契约要点：
//! - **窄边界**：业务请求与结果均以 JSON 文本传递（`{"op":...}` →
//!   `{"ok":...}` / `{"error":"..."}`）；媒体字节不经过本通道（§4.1，后续
//!   经 WKURLSchemeHandler 的资源协议读取）。
//! - **数据根注入**：`pw_core_new(data_root)` 以宿主提供的路径打开受信
//!   projects 根（内核 `open_projects_root`：canonicalize、归类与身份绑定）；
//!   验证应用使用独立数据根（§4.3），打开失败返回 NULL，不伪造句柄。
//! - **异步完成**：请求在单一工作线程上串行执行（单写入者语义），完成后
//!   在**工作线程**回调 `pw_completion`——宿主负责回投自己的线程（如主
//!   队列）；回调携带请求 id、状态码与结果 JSON。
//! - **状态码**：`PW_STATUS_OK`（结果 JSON 为 `{"ok":...}`）、
//!   `PW_STATUS_ERROR`（`{"error":"..."}`，含内核校验失败与坏请求）、
//!   `PW_STATUS_CANCELLED`（结果指针为 NULL）。
//! - **取消**：`pw_request_cancel` 对未派发的请求生效（回执 CANCELLED）；
//!   已开始执行的文件系统操作不被中断，其迟到结果照常交付——迟到结果
//!   守卫（§4.1 超时/陈旧会话）由宿主按请求 id 实施。未知/已落定 id 的
//!   取消是安全 no-op。
//! - **内存与生命周期**：结果字符串由 Rust 分配、宿主用 `pw_string_free`
//!   释放（NULL 容忍）；`pw_core_free` 等待队列排空并 join 工作线程后
//!   释放——回调与 context 指针在 core 释放前有效，且 free 返回后不再有
//!   任何回调（宿主不得在 free 前卸载回调代码）。
//! - **panic 不跨 FFI**：每个请求经 `catch_unwind` 包裹，panic 转为
//!   ERROR 回执（结果未知语义），进程不因内核 panic 崩溃。
//!
//! 支持的操作（载荷经桥接边界由 `dispatch` 逐字段校验）：`listProjects`
//! /`createProject`/`loadProject`/`saveProject`/`deleteProject`
//! /`loadAiSession`/`saveAiSession`/`verifyProjectAssets`
//! /`copyProjectAssets`。`saveProject` 的可选 `expectExisting` 布尔值与
//! Tauri 保存契约一致：为真时已删除的副本不可被迟到保存重新创建。

use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cap_std::fs::Dir as CapDir;
use plotweave_core::store as core_store;

/// 成功：结果 JSON 为 `{"ok":...}`。
pub const PW_STATUS_OK: u8 = 0;
/// 失败：结果 JSON 为 `{"error":"..."}`。
pub const PW_STATUS_ERROR: u8 = 1;
/// 已取消：结果指针为 NULL（未派发的请求）。
pub const PW_STATUS_CANCELLED: u8 = 2;

/// 完成回调：在工作线程调用；`result_json` 归宿主释放（ cancelled 为 NULL）。
pub type PwCompletion =
    extern "C" fn(request_id: u32, status: u8, result_json: *mut c_char, context: *mut c_void);

/// 队列任务：context 是宿主指针，契约保证其存活至回执或 core 释放。
struct Job {
    id: u32,
    request: String,
    callback: PwCompletion,
    context: *mut c_void,
}

// 回调指针与 context 仅由唯一工作线程解引用；宿主契约（见模块文档）
// 保证其存活期覆盖回执时机，此处显式声明跨线程传递。
unsafe impl Send for Job {}

/// C ABI 句柄：单工作线程（持受信根克隆）+ 请求 id 分配 + 取消登记。
pub struct PwCore {
    sender: Mutex<Option<Sender<Job>>>,
    cancelled: Arc<Mutex<HashSet<u32>>>,
    next_id: AtomicU32,
    worker: Option<JoinHandle<()>>,
}

impl PwCore {
    /// 组装并启动工作线程（生产入口是 `pw_core_new`）。
    fn start(data_root: &Path) -> Option<PwCore> {
        let root = Arc::new(core_store::open_projects_root(data_root).ok()?);
        let (sender, receiver) = channel::<Job>();
        let cancelled: Arc<Mutex<HashSet<u32>>> = Arc::new(Mutex::new(HashSet::new()));
        let worker_root = Arc::clone(&root);
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = std::thread::Builder::new()
            .name("pw-ffi-worker".into())
            .spawn(move || worker_loop(worker_root, receiver, worker_cancelled))
            .ok()?;
        Some(PwCore {
            sender: Mutex::new(Some(sender)),
            cancelled,
            next_id: AtomicU32::new(0),
            worker: Some(worker),
        })
    }
}

/// 工作线程主循环：sender 全部释放且队列排空后退出；退出前所有任务均获回执。
fn worker_loop(root: Arc<CapDir>, receiver: Receiver<Job>, cancelled: Arc<Mutex<HashSet<u32>>>) {
    while let Ok(job) = receiver.recv() {
        handle_job(&root, &cancelled, job);
    }
}

/// 单任务处理：取消门（未派发）→ 执行（panic 包裹）→ 回执。
fn handle_job(root: &CapDir, cancelled: &Mutex<HashSet<u32>>, job: Job) {
    if cancelled.lock().unwrap().remove(&job.id) {
        deliver(job, PW_STATUS_CANCELLED, None);
        return;
    }
    let (status, text) = execute(root, &job.request);
    deliver(job, status, text);
}

/// 执行一层：内核 panic 不得跨 FFI（§4.3），转为 ERROR 回执。
fn execute(root: &CapDir, request: &str) -> (u8, Option<String>) {
    match catch_unwind(AssertUnwindSafe(|| dispatch(root, request))) {
        Ok(Ok(text)) => (PW_STATUS_OK, Some(text)),
        Ok(Err(message)) => (PW_STATUS_ERROR, Some(error_json(&message))),
        Err(_) => (
            PW_STATUS_ERROR,
            Some(error_json("内核发生 panic，本次结果未知")),
        ),
    }
}

fn error_json(message: &str) -> String {
    format!("{{\"error\":{}}}", serde_json::json!(message))
}

fn ok_json<T: serde::Serialize>(value: T) -> Result<String, String> {
    serde_json::to_string(&serde_json::json!({ "ok": value }))
        .map_err(|e| format!("序列化结果失败：{e}"))
}

/// 请求解析与分发：载荷逐字段校验（§4.1 桥接边界校验），异型整次拒绝。
fn dispatch(root: &CapDir, request: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(request).map_err(|e| format!("请求不是合法 JSON：{e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "请求必须是 JSON 对象".to_string())?;
    let op = object
        .get("op")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少 op 字段".to_string())?;
    let id_field = |key: &str| -> Result<String, String> {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("缺少 {key} 字段"))
    };
    match op {
        "listProjects" => {
            ok_json(core_store::list_project_metas(root).map_err(core_store::to_ipc_text)?)
        }
        "createProject" => ok_json(
            core_store::create_project_in(root, &id_field("name")?)
                .map_err(core_store::to_ipc_text)?,
        ),
        "loadProject" => ok_json(
            core_store::load_project_file(root, &id_field("id")?)
                .map_err(core_store::error::load_project_ipc_text)?,
        ),
        "saveProject" => {
            let doc: core_store::ProjectFile =
                serde_json::from_value(object.get("doc").cloned().ok_or("缺少 doc 字段")?)
                    .map_err(|e| format!("doc 不是合法项目信封：{e}"))?;
            let expect_existing = match object.get("expectExisting") {
                None => false,
                Some(serde_json::Value::Bool(value)) => *value,
                _ => return Err("expectExisting 必须是布尔值".into()),
            };
            ok_json(
                core_store::persist_project_expect_existing(
                    root,
                    &id_field("id")?,
                    doc,
                    expect_existing,
                )
                .map_err(core_store::to_ipc_text)?,
            )
        }
        "deleteProject" => {
            core_store::delete_project_files(root, &id_field("id")?)
                .map_err(core_store::to_ipc_text)?;
            ok_json(serde_json::Value::Null)
        }
        "loadAiSession" => ok_json(
            core_store::load_ai_session_file(root, &id_field("id")?)
                .map_err(core_store::to_ipc_text)?,
        ),
        "saveAiSession" => {
            let session = object.get("session").cloned().ok_or("缺少 session 字段")?;
            core_store::save_ai_session_file(root, &id_field("id")?, &session)
                .map_err(core_store::to_ipc_text)?;
            ok_json(serde_json::Value::Null)
        }
        "verifyProjectAssets" => {
            let assets = object.get("assets").cloned().ok_or("缺少 assets 字段")?;
            let id = id_field("id")?;
            core_store::validate_id(&id)?;
            ok_json(core_store::unverifiable_asset_keys(root, &id, &assets))
        }
        "copyProjectAssets" => {
            core_store::copy_assets_tree(root, &id_field("fromId")?, &id_field("toId")?)
                .map_err(core_store::to_ipc_text)?;
            ok_json(serde_json::Value::Null)
        }
        #[cfg(test)]
        "debugPanic" => panic!("FFI 边界 panic 注入"),
        _ => Err(format!("未知操作：{op}")),
    }
}

/// 回执一层：JSON → CString → 裸指针；CANCELLED 传 NULL。结果指针归宿主
/// （`pw_string_free`）释放。
fn deliver(job: Job, status: u8, text: Option<String>) {
    let ptr = match text.and_then(|t| CString::new(t).ok()) {
        Some(cstring) => cstring.into_raw(),
        None => std::ptr::null_mut(),
    };
    (job.callback)(job.id, status, ptr, job.context);
}

/// 以宿主注入的数据根建立 core；路径非法/UTF-8 无效/开根失败返回 NULL。
///
/// # Safety
///
/// `data_root` 必须是 NULL 或指向以 NUL 结尾的有效 C 字符串；返回的句柄
/// 只能传给本 ABI 的其他入口，并最终经 `pw_core_free` 释放。
#[no_mangle]
pub unsafe extern "C" fn pw_core_new(data_root: *const c_char) -> *mut PwCore {
    if data_root.is_null() {
        return std::ptr::null_mut();
    }
    let Ok(path) = CStr::from_ptr(data_root).to_str() else {
        return std::ptr::null_mut();
    };
    match PwCore::start(Path::new(path)) {
        Some(core) => Box::into_raw(Box::new(core)),
        None => std::ptr::null_mut(),
    }
}

/// 释放 core：关闭提交口 → 等待队列排空并 join 工作线程 → 释放。
/// 返回后不再有任何回调（见模块文档的生命周期契约）；NULL 容忍。
///
/// # Safety
///
/// `core` 必须是 NULL 或 `pw_core_new` 返回且尚未释放的句柄；释放后不得
/// 再传入任何入口（含并发中的调用——宿主负责先停止提交再释放）。
#[no_mangle]
pub unsafe extern "C" fn pw_core_free(core: *mut PwCore) {
    if core.is_null() {
        return;
    }
    let mut core = Box::from_raw(core);
    *core.sender.lock().unwrap() = None;
    if let Some(worker) = core.worker.take() {
        let _ = worker.join();
    }
}

/// 提交请求：返回非零请求 id，回执经 `completion` 在工作线程送达。
/// core/请求/回调为 NULL 或请求非 UTF-8 时拒绝（返回 0，不产生回调）。
///
/// # Safety
///
/// `core` 须为有效句柄；`request_json` 为 NULL 或 NUL 结尾的 UTF-8 C 字符串；
/// `completion` 为有效函数指针；`context` 指针须保持有效直到该请求回执送达
/// 或 core 释放。
#[no_mangle]
pub unsafe extern "C" fn pw_request_submit(
    core: *mut PwCore,
    request_json: *const c_char,
    completion: PwCompletion,
    context: *mut c_void,
) -> u32 {
    if core.is_null() || request_json.is_null() {
        return 0;
    }
    let core = &*core;
    let Ok(request) = CStr::from_ptr(request_json).to_str() else {
        return 0;
    };
    let id = core.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    if id == 0 {
        return 0;
    }
    let job = Job {
        id,
        request: request.to_owned(),
        callback: completion,
        context,
    };
    let guard = core.sender.lock().unwrap();
    match guard.as_ref() {
        Some(sender) if sender.send(job).is_ok() => id,
        _ => 0,
    }
}

/// 取消请求：未派发 → CANCELLED 回执；已派发 → 不中断、迟到结果照常交付
/// （§4.1 迟到结果守卫由宿主实施）。未知/已落定 id 为安全 no-op。
///
/// # Safety
///
/// `core` 须为 NULL 或有效句柄。
#[no_mangle]
pub unsafe extern "C" fn pw_request_cancel(core: *mut PwCore, request_id: u32) {
    if core.is_null() || request_id == 0 {
        return;
    }
    (*core).cancelled.lock().unwrap().insert(request_id);
}

/// 释放 Rust 分配的结果字符串；NULL 容忍。
///
/// # Safety
///
/// `string` 必须是 NULL 或本 ABI 回执交付的、尚未释放的结果指针；每个
/// 指针只能释放一次。
#[no_mangle]
pub unsafe extern "C" fn pw_string_free(string: *mut c_char) {
    if !string.is_null() {
        drop(CString::from_raw(string));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" fn record(_id: u32, status: u8, result: *mut c_char, ctx: *mut c_void) {
        let slot = unsafe { &mut *(ctx as *mut (u8, Option<String>)) };
        slot.0 = status;
        slot.1 = if result.is_null() {
            None
        } else {
            let text = unsafe { CStr::from_ptr(result) }
                .to_string_lossy()
                .into_owned();
            unsafe { pw_string_free(result) };
            Some(text)
        };
    }

    /// 取消门：已登记取消的任务不执行内核，回执 CANCELLED + NULL 结果。
    #[test]
    fn cancelled_job_skips_kernel_and_reports_null() {
        let cancelled = Mutex::new(HashSet::from([7u32]));
        let mut outcome = (PW_STATUS_OK, Some("init".to_string()));
        handle_job(
            &CapDir::open_ambient_dir(std::env::temp_dir(), cap_std::ambient_authority()).unwrap(),
            &cancelled,
            Job {
                id: 7,
                request: "{\"op\":\"listProjects\"}".into(),
                callback: record,
                context: &mut outcome as *mut _ as *mut c_void,
            },
        );
        assert_eq!(outcome.0, PW_STATUS_CANCELLED);
        assert!(outcome.1.is_none());
        assert!(cancelled.lock().unwrap().is_empty(), "取消登记须随门消耗");
    }

    /// panic 不跨 FFI：注入 panic 的操作转为 ERROR 回执。
    #[test]
    fn kernel_panic_becomes_error_receipt() {
        let root =
            CapDir::open_ambient_dir(std::env::temp_dir(), cap_std::ambient_authority()).unwrap();
        let (status, text) = execute(&root, "{\"op\":\"debugPanic\"}");
        assert_eq!(status, PW_STATUS_ERROR);
        assert!(text.unwrap().contains("panic"));
    }

    /// 坏请求在分发层结构化失败，不触达内核。
    #[test]
    fn malformed_request_is_structured_error() {
        let root =
            CapDir::open_ambient_dir(std::env::temp_dir(), cap_std::ambient_authority()).unwrap();
        let (status, text) = execute(&root, "not-json");
        assert_eq!(status, PW_STATUS_ERROR);
        assert!(text.unwrap().contains("JSON"));
    }
}
