//! C ABI 边界集成测试（迁移计划 §4.3、矩阵 M14）：以 Rust 侧直接调用
//! extern "C" 入口验证同一 ABI 契约——注入数据根、分配/释放、异步完成、
//! 错误与取消。真实 Swift 链接与主线程回投属 P2 后续切片。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

type Completion = (u32, u8, Option<String>);

/// 记录型完成回调：经 context 指针回投通道，复制结果后立即释放 Rust 分配。
extern "C" fn record_completion(
    request_id: u32,
    status: u8,
    result_json: *mut c_char,
    context: *mut c_void,
) {
    let text = if result_json.is_null() {
        None
    } else {
        let copied = unsafe { CStr::from_ptr(result_json) }
            .to_string_lossy()
            .into_owned();
        unsafe { plotweave_ffi::pw_string_free(result_json) };
        Some(copied)
    };
    let sender = unsafe { &*(context as *const mpsc::Sender<Completion>) };
    sender.send((request_id, status, text)).unwrap();
}

/// 每用例独立的数据根 + core 句柄 + 完成通道。
struct Fixture {
    core: *mut plotweave_ffi::PwCore,
    root: PathBuf,
    sender: mpsc::Sender<Completion>,
    receiver: mpsc::Receiver<Completion>,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pw-ffi-abi-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("建临时数据根");
        let c_root = CString::new(root.to_str().unwrap()).unwrap();
        let core = unsafe { plotweave_ffi::pw_core_new(c_root.as_ptr()) };
        assert!(!core.is_null(), "合法数据根必须建出 core");
        let (sender, receiver) = mpsc::channel();
        Fixture {
            core,
            root,
            sender,
            receiver,
        }
    }

    /// 提交请求并等待完成；断言回执 id 一致并返回 (状态, 结果文本)。
    fn call(&self, request: &str) -> (u8, Option<String>) {
        let id = self.submit(request);
        let (done_id, status, text) = self
            .receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("完成回调必须送达");
        assert_eq!(done_id, id, "回执必须携带请求身份");
        (status, text)
    }

    fn submit(&self, request: &str) -> u32 {
        let id = unsafe {
            plotweave_ffi::pw_request_submit(
                self.core,
                CString::new(request).unwrap().as_ptr(),
                Some(record_completion),
                &self.sender as *const _ as *mut c_void,
            )
        };
        assert_ne!(id, 0, "合法请求必须得到非零请求 id");
        id
    }

    fn call_ok(&self, request: &str) -> String {
        let (status, text) = self.call(request);
        assert_eq!(status, plotweave_ffi::PW_STATUS_OK, "期望成功：{text:?}");
        text.expect("成功回执必须携带结果 JSON")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe { plotweave_ffi::pw_core_free(self.core) };
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn roundtrip_create_save_load_delete_over_abi() {
    let fx = Fixture::new("roundtrip");

    let created = fx.call_ok("{\"op\":\"createProject\",\"name\":\"午夜出租车\"}");
    let id = json_path(&created, &["ok", "id"]);
    assert!(id.starts_with("p-"), "内核生成的项目 id 形态：{id}");

    assert!(fx
        .call_ok("{\"op\":\"listProjects\"}")
        .contains("午夜出租车"));

    let loaded = fx.call_ok(&format!("{{\"op\":\"loadProject\",\"id\":\"{id}\"}}"));
    assert!(
        loaded.contains("\"schemaVersion\""),
        "加载返回完整信封：{loaded}"
    );

    // 用加载到的净本改名单后保存（载荷必然过保存边界校验）
    let mut doc: serde_json::Value = serde_json::from_str(&loaded).unwrap();
    doc["ok"]["project"]["name"] = serde_json::json!("改名后的剧");
    let saved = fx.call_ok(&format!(
        "{{\"op\":\"saveProject\",\"id\":\"{id}\",\"doc\":{}}}",
        doc["ok"]
    ));
    assert!(saved.contains("改名后的剧"), "保存回执携带新摘要：{saved}");

    let reloaded = fx.call_ok(&format!("{{\"op\":\"loadProject\",\"id\":\"{id}\"}}"));
    assert!(reloaded.contains("改名后的剧"), "重开恢复已保存内容");

    fx.call_ok(&format!("{{\"op\":\"deleteProject\",\"id\":\"{id}\"}}"));
    let (status, text) = fx.call(&format!("{{\"op\":\"loadProject\",\"id\":\"{id}\"}}"));
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    assert!(
        text.as_deref().unwrap_or_default().contains("项目不存在"),
        "删除后读取须上浮内核错误：{text:?}"
    );
}

#[test]
fn error_paths_surface_structured_errors() {
    let fx = Fixture::new("errors");

    let (status, text) = fx.call("{\"op\":\"loadProject\",\"id\":\"missing-1\"}");
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    assert!(text.unwrap().contains("项目不存在"));

    let (status, text) = fx.call("{\"op\":\"nope\"}");
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    assert!(text.unwrap().contains("error"), "未知操作须结构化失败");

    let (status, _text) = fx.call("not-json");
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR, "坏 JSON 须错误回执");
}

#[test]
fn ai_session_and_asset_ops_roundtrip() {
    let fx = Fixture::new("session");
    let created = fx.call_ok("{\"op\":\"createProject\",\"name\":\"会话剧\"}");
    let id = json_path(&created, &["ok", "id"]);

    let empty = fx.call_ok(&format!("{{\"op\":\"loadAiSession\",\"id\":\"{id}\"}}"));
    assert!(empty.contains("\"session\":null"), "新项目无会话：{empty}");

    fx.call_ok(&format!(
        "{{\"op\":\"saveAiSession\",\"id\":\"{id}\",\"session\":{{\"schemaVersion\":1,\"entries\":[]}}}}"
    ));
    let loaded = fx.call_ok(&format!("{{\"op\":\"loadAiSession\",\"id\":\"{id}\"}}"));
    assert!(loaded.contains("\"corrupt\":false") && loaded.contains("entries"));

    let keys = fx.call_ok(&format!(
        "{{\"op\":\"verifyProjectAssets\",\"id\":\"{id}\",\"assets\":{{}}}}"
    ));
    assert!(keys.contains("[]"), "空资产索引复验为空清单：{keys}");

    // dev 复制契约：已有目标项目目录不能被覆盖，源与目标相同亦须拒绝。
    let (status, _) = fx.call(
        &serde_json::json!({
            "op":"copyProjectAssets", "fromId":id, "toId":id,
        })
        .to_string(),
    );
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    let created_copy = fx.call_ok(r#"{"op":"createProject","name":"会话副本"}"#);
    let copy_id = json_path(&created_copy, &["ok", "id"]);
    let copied = fx.call_ok(
        &serde_json::json!({
            "op":"copyProjectAssets", "fromId":id, "toId":copy_id,
        })
        .to_string(),
    );
    let response: serde_json::Value = serde_json::from_str(&copied).unwrap();
    assert_eq!(response["ok"], serde_json::Value::Null);
}

#[test]
fn cancel_is_safe_for_unknown_and_settled_requests() {
    let fx = Fixture::new("cancel");
    // 未知 id：安全 no-op，不影响后续请求
    unsafe { plotweave_ffi::pw_request_cancel(fx.core, 1) };
    let id = fx.submit("{\"op\":\"listProjects\"}");
    let (done, status, _text) = fx.receiver.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(done, id);
    assert_eq!(status, plotweave_ffi::PW_STATUS_OK);
    // 已完成请求的取消同样 no-op，不得重复回执
    unsafe { plotweave_ffi::pw_request_cancel(fx.core, id) };
    assert!(fx
        .receiver
        .recv_timeout(Duration::from_millis(300))
        .is_err());
}

/// 完成回调的闸门把工作线程停在已派发状态，确定性地保留后续排队请求。
struct PausedCompletion {
    sender: mpsc::Sender<Completion>,
    release: mpsc::Receiver<()>,
}

/// 先交付已执行请求的结果，再等待测试释放；不在任何 core 锁内阻塞。
extern "C" fn paused_completion(id: u32, status: u8, result: *mut c_char, context: *mut c_void) {
    let paused = unsafe { &*(context as *const PausedCompletion) };
    record_completion(
        id,
        status,
        result,
        &paused.sender as *const _ as *mut c_void,
    );
    paused
        .release
        .recv_timeout(Duration::from_secs(20))
        .unwrap();
}

/// 已派发／未来 id 的取消不留墓碑；重复取消只影响排队请求，free 排空一次回执。
#[test]
fn only_queued_requests_cancel_and_free_drains_each_receipt_once() {
    let mut fx = Fixture::new("queued-cancel");
    let (release, gate) = mpsc::channel();
    let paused = PausedCompletion {
        sender: fx.sender.clone(),
        release: gate,
    };
    let request = CString::new(r#"{"op":"listProjects"}"#).unwrap();
    let first = unsafe {
        plotweave_ffi::pw_request_submit(
            fx.core,
            request.as_ptr(),
            Some(paused_completion),
            &paused as *const _ as *mut c_void,
        )
    };
    let (done, status, _) = fx.receiver.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!((done, status), (first, plotweave_ffi::PW_STATUS_OK));
    let cancelled = fx.submit(r#"{"op":"createProject","name":"不得创建"}"#);
    let ready = fx.submit(r#"{"op":"listProjects"}"#);
    unsafe {
        plotweave_ffi::pw_request_cancel(fx.core, first);
        plotweave_ffi::pw_request_cancel(fx.core, cancelled);
        plotweave_ffi::pw_request_cancel(fx.core, cancelled);
        plotweave_ffi::pw_request_cancel(fx.core, ready + 1);
        plotweave_ffi::pw_request_cancel(fx.core, 0);
    }
    let future = fx.submit(r#"{"op":"listProjects"}"#);
    release.send(()).unwrap();
    unsafe { plotweave_ffi::pw_core_free(fx.core) };
    fx.core = std::ptr::null_mut();
    let outcomes: Vec<_> = fx.receiver.try_iter().collect();
    assert_eq!(outcomes.len(), 3, "free 返回前每个排队请求恰有一次回执");
    assert_eq!(
        outcomes[0],
        (cancelled, plotweave_ffi::PW_STATUS_CANCELLED, None)
    );
    for (outcome, id) in outcomes[1..].iter().zip([ready, future]) {
        assert_eq!((outcome.0, outcome.1), (id, plotweave_ffi::PW_STATUS_OK));
        let value: serde_json::Value = serde_json::from_str(outcome.2.as_ref().unwrap()).unwrap();
        assert_eq!(value["ok"], serde_json::json!([]), "取消的创建不能落盘");
    }
}

#[test]
fn allocation_boundaries_reject_bad_input() {
    // 数据根落在普通文件之下：开根失败必须返回 null，不得伪造句柄
    let file = std::env::temp_dir().join(format!("pw-ffi-badroot-{}", std::process::id()));
    std::fs::write(&file, b"not a dir").unwrap();
    let c_path = CString::new(file.to_str().unwrap()).unwrap();
    assert!(unsafe { plotweave_ffi::pw_core_new(c_path.as_ptr()) }.is_null());
    let _ = std::fs::remove_file(&file);

    // null 指针的提交/释放：拒绝且不崩
    assert_eq!(
        unsafe {
            plotweave_ffi::pw_request_submit(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(record_completion),
                std::ptr::null_mut(),
            )
        },
        0
    );
    unsafe { plotweave_ffi::pw_string_free(std::ptr::null_mut()) };
    unsafe { plotweave_ffi::pw_core_free(std::ptr::null_mut()) };
    unsafe { plotweave_ffi::pw_request_cancel(std::ptr::null_mut(), 1) };
}

/// JSON 取径助手（结果断言用）。
fn json_path(json: &str, path: &[&str]) -> String {
    let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
    for key in path {
        value = value[key].clone();
    }
    match value {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }
}

/// dev 保存存在性契约也经 FFI 生效：副本删除后不得因迟到保存复活，
/// 普通保存仍保持允许首次新建的语义，非法存在性参数在边界拒绝。
#[test]
fn expect_existing_save_cannot_recreate_deleted_project() {
    let fx = Fixture::new("expect-existing");
    let created = fx.call_ok(r#"{"op":"createProject","name":"副本"}"#);
    let id = json_path(&created, &["ok", "id"]);
    let loaded = fx.call_ok(&serde_json::json!({"op":"loadProject", "id":id}).to_string());
    let doc: serde_json::Value = serde_json::from_str(&loaded).unwrap();
    let mut save =
        serde_json::json!({"op":"saveProject", "id":id, "doc":doc["ok"], "expectExisting":true});
    fx.call_ok(&save.to_string());
    fx.call_ok(&serde_json::json!({"op":"deleteProject", "id":id}).to_string());
    let (status, _) = fx.call(&save.to_string());
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    assert!(!fx.root.join("projects").join(format!("{id}.json")).exists());
    save["expectExisting"] = serde_json::json!("true");
    let (status, _) = fx.call(&save.to_string());
    assert_eq!(status, plotweave_ffi::PW_STATUS_ERROR);
    save.as_object_mut().unwrap().remove("expectExisting");
    fx.call_ok(&save.to_string());
    assert!(fx.root.join("projects").join(format!("{id}.json")).exists());
}

/// Rejected inputs consume no request identity and cannot enqueue a side effect or completion.
#[test]
fn null_completion_and_invalid_pointers_reject_before_dispatch() {
    let mut fx = Fixture::new("null-completion");
    let create = CString::new(r#"{"op":"createProject","name":"must-not-create"}"#).unwrap();
    let invalid_utf8 = CString::new(vec![0xff]).unwrap();
    let context = &fx.sender as *const _ as *mut c_void;
    for (core, request, completion) in [
        (fx.core, create.as_ptr(), None),
        (
            fx.core,
            std::ptr::null(),
            Some(record_completion as plotweave_ffi::PwCompletion),
        ),
        (
            std::ptr::null_mut(),
            create.as_ptr(),
            Some(record_completion as plotweave_ffi::PwCompletion),
        ),
        (
            fx.core,
            invalid_utf8.as_ptr(),
            Some(record_completion as plotweave_ffi::PwCompletion),
        ),
    ] {
        assert_eq!(
            unsafe { plotweave_ffi::pw_request_submit(core, request, completion, context) },
            0
        );
    }
    let first = fx.submit(r#"{"op":"listProjects"}"#);
    assert_eq!(first, 1, "rejection must precede request ID allocation");
    // Join drains the queue: no sleep window can hide a late request or callback.
    unsafe { plotweave_ffi::pw_core_free(fx.core) };
    fx.core = std::ptr::null_mut();
    let receipts: Vec<_> = fx.receiver.try_iter().collect();
    assert_eq!(receipts.len(), 1, "only the valid request may complete");
    assert_eq!(
        (receipts[0].0, receipts[0].1),
        (first, plotweave_ffi::PW_STATUS_OK)
    );
    let result: serde_json::Value = serde_json::from_str(receipts[0].2.as_ref().unwrap()).unwrap();
    assert_eq!(
        result["ok"],
        serde_json::json!([]),
        "rejected create must not run"
    );
}
