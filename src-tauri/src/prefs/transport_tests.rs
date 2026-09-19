//! #136：聊天入口必须在网络发送前拒绝远程明文端点；测试凭据为虚构占位值。

use super::*;

#[test]
fn chat_rejects_remote_http_before_sending_credentials() {
    let error = tauri::async_runtime::block_on(chat_completion(
        "http://192.0.2.1:9/v1",
        "test-model",
        serde_json::json!([]),
        None,
        "test-only-token",
        0,
    ))
    .unwrap_err();
    assert!(
        error.to_string().contains("HTTPS"),
        "应在发送前返回传输策略诊断，实际：{error}"
    );
    assert!(!matches!(
        error,
        ProxyError::Send { .. } | ProxyError::SendTimeout { .. }
    ));
}
