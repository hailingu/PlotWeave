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
                record_completion,
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

    let copied = fx.call_ok(&format!(
        "{{\"op\":\"copyProjectAssets\",\"fromId\":\"{id}\",\"toId\":\"{id}\"}}"
    ));
    assert!(
        copied.contains("ok"),
        "同源自拷贝按 no-op/报错语义处理：{copied}"
    );
}

#[test]
fn cancel_is_safe_for_unknown_and_settled_requests() {
    let fx = Fixture::new("cancel");
    // 未知 id：安全 no-op，不影响后续请求
    unsafe { plotweave_ffi::pw_request_cancel(fx.core, 999_999) };
    let id = fx.submit("{\"op\":\"listProjects\"}");
    let (_done, status, _text) = fx.receiver.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(status, plotweave_ffi::PW_STATUS_OK);
    // 已完成请求的取消同样 no-op，不得重复回执
    unsafe { plotweave_ffi::pw_request_cancel(fx.core, id) };
    assert!(fx
        .receiver
        .recv_timeout(Duration::from_millis(300))
        .is_err());
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
                record_completion,
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
