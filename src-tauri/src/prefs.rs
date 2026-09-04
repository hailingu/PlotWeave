//! 应用设置与 Provider 密钥（docs/ui-design.md §8.2 修订）。
//!
//! - 设置本体（provider 配置 / 默认模型 / 加密 key）存应用数据目录
//!   `settings.json`，结构对前端自有，以 `serde_json::Value` 透传，
//!   仅做大小与文件名校验。
//! - API key 不入钥匙串：经 `seal` 模块 AES-256-GCM 加密（绑定本机），
//!   密文随 provider 配置落 `settings.json`（`keyEnc` 字段）；
//!   明文只在加密/请求的进程内存中出现，不落盘、不回显。
//!   历史钥匙串数据保留只读回退，不再写入。

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// 对话请求超时（120s）：非流式补全耗时可能长于普通 API（长回复、慢
/// 模型），但不长于图像生成（imagegen 取 300s）——落 issue #15 验收
/// 基线"不低于 120s"，防 provider 网关不回包/慢速滴流时命令无限挂起。
const CHAT_REQUEST_TIMEOUT_SECS: u64 = 120;

/// 对话响应体读取上限（16 MiB）：chat completions 主响应为纯 JSON 文本
/// （无 base64 图像膨胀），约为 imagegen 上限（64 MiB）的 1/4——容纳
/// 超长回复与工具调用数组的 JSON 开销仍有余量，超大响应经流式限读在
/// 物化前被拒（issue #15）。
const CHAT_RESPONSE_BODY_MAX_BYTES: usize = 16 * 1024 * 1024;

/// 钥匙串服务名（应用标识）。
const KEYCHAIN_SERVICE: &str = "com.plotweave.app";

/// 设置文件大小上限（1 MiB），防异常输入撑爆读写。
const PREFS_MAX_BYTES: usize = 1024 * 1024;

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    Ok(dir.join("settings.json"))
}

/// 读取应用设置；文件不存在返回空对象（首次启动）。
#[tauri::command]
pub fn load_prefs(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = prefs_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => {
            if text.len() > PREFS_MAX_BYTES {
                return Err("设置文件过大".into());
            }
            serde_json::from_str(&text).map_err(|e| format!("设置文件损坏：{e}"))
        }
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// 全量保存应用设置（原子写：临时文件 + 改名）。
#[tauri::command]
pub fn save_prefs(app: AppHandle, prefs: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| format!("序列化失败：{e}"))?;
    if text.len() > PREFS_MAX_BYTES {
        return Err("设置内容过大".into());
    }
    let path = prefs_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入设置失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("落盘设置失败：{e}"))
}

/// provider id 约束：钥匙串账号安全字符集。
fn validate_provider_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法 provider id：{id}"))
    }
}

/// 加密 provider API key：返回 envelope 密文，由前端随 settings.json 落盘。
/// 明文只在本次调用的进程内存中出现，不落盘、不回显、不入钥匙串。
#[tauri::command]
pub fn set_provider_key(provider_id: String, key: String) -> Result<String, String> {
    validate_provider_id(&provider_id)?;
    if key.trim().is_empty() {
        return Err("API key 不能为空".into());
    }
    crate::seal::seal(key.trim())
}

/// 解析 provider 当前可用的 key：优先 settings.json 的 `keyEnc` 密文；
/// 密文缺失时只读回退历史钥匙串数据（不再写入钥匙串）。
/// crate 内共享：图像生成代理（imagegen）与对话代理（llm_chat）同域。
pub(crate) fn provider_secret(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    validate_provider_id(provider_id)?;
    let path = prefs_path(app)?;
    if let Ok(text) = fs::read_to_string(&path) {
        // 信任边界：与 load_prefs 同一大小上限，防篡改的超大文件拖垮解析
        if text.len() > PREFS_MAX_BYTES {
            return Err("设置文件过大，拒绝读取密文".into());
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let enc = v
                .get("providers")
                .and_then(|p| p.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(provider_id))
                })
                .and_then(|p| p.get("keyEnc"))
                .and_then(|x| x.as_str());
            if let Some(envelope) = enc {
                return crate::seal::open(envelope);
            }
        }
    }
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err("未配置 API key，请在设置页填写".to_string()),
        Err(e) => Err(format!("读取 key 失败：{e}")),
    }
}

/// 对话补全传输内核（不含 AppHandle 与密文解析，便于对接本地 HTTP
/// 夹具做行为测试）：构造带超时的客户端、发送 OpenAI 兼容补全请求、
/// 响应体流式限读后提取 choices[0].message。`timeout_secs` 由调用方
/// 注入——生产为 CHAT_REQUEST_TIMEOUT_SECS；测试注入短超时以驱动
/// 慢速/挂起响应路径，不必等待真实上限。
async fn chat_completion(
    base_url: &str,
    model: &str,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
    key: &str,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
    if let Some(tools) = tools {
        if tools.is_array() && !tools.as_array().is_none_or(|t| t.is_empty()) {
            body["tools"] = tools;
            body["tool_choice"] = serde_json::json!("auto");
        }
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败：{e}"))?;
    let response = client
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（{timeout_secs}s）：{e}")
            } else {
                format!("请求失败：{e}")
            }
        })?;
    let status = response.status();
    let text = crate::http_util::read_text_capped(response, CHAT_RESPONSE_BODY_MAX_BYTES).await?;
    if !status.is_success() {
        let head: String = text.chars().take(200).collect();
        return Err(format!("服务返回 {status}：{head}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
    parsed
        .pointer("/choices/0/message")
        .cloned()
        .filter(|m| m.is_object())
        .ok_or_else(|| "服务未返回回复内容".to_string())
}

/// LLM 对话代理（§6/数据模型 §12.2）：key 的密文存 settings.json，
/// 请求前在 Rust 内存中解密——明文不出后端；前端只传 provider 配置、
/// 消息列表与可选工具表。OpenAI 兼容 chat completions，非流式；
/// 返回 choices[0].message 原文（content 字符串 + 可选 tool_calls 数组）。
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    provider_id: String,
    base_url: String,
    model: String,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    validate_provider_id(&provider_id)?;
    if model.trim().is_empty() {
        return Err("未选择模型".into());
    }
    let key = provider_secret(&app, &provider_id)?;
    chat_completion(
        &base_url,
        &model,
        messages,
        tools,
        &key,
        CHAT_REQUEST_TIMEOUT_SECS,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    #[test]
    fn provider_id_rules() {
        assert!(validate_provider_id("openai").is_ok());
        assert!(validate_provider_id("volcengine-ark").is_ok());
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("a/b").is_err());
        assert!(validate_provider_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn chat_defense_limits_meet_issue_baseline() {
        // issue #15 验收基线：对话为非流式补全（长回复、慢模型），超时
        // 不低于 120s；主响应是纯 JSON 文本（无 base64 图像膨胀），上限
        // 无需 64 MiB，按对话 JSON 合理放宽（16 MiB 量级）。
        assert!(CHAT_REQUEST_TIMEOUT_SECS >= 120);
        assert!(CHAT_RESPONSE_BODY_MAX_BYTES >= 1024 * 1024);
        assert!(CHAT_RESPONSE_BODY_MAX_BYTES <= 16 * 1024 * 1024);
    }

    /// 本地 HTTP 夹具：环回一次性 TCP 服务器，接受一次连接后按给定脚本
    /// 处理（丢弃请求、写出响应、可保持连接模拟慢速/挂起）。返回基址。
    /// 强制 NO_PROXY 环回直连，防环境代理劫持夹具流量。
    fn spawn_local_http(handler: impl FnOnce(TcpStream) + Send + 'static) -> String {
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定环回端口");
        let port = listener.local_addr().expect("读取端口").port();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                handler(stream);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    /// 请求体积小于缓冲：尽力读一次即丢弃，防客户端写端阻塞。
    fn drain_request(stream: &mut TcpStream) {
        let mut buf = [0u8; 8192];
        let _ = stream.read(&mut buf);
    }

    #[test]
    fn chat_completion_returns_choices0_message_over_local_http() {
        let payload = serde_json::json!({
            "choices": [{ "message": { "role": "assistant", "content": "你好" } }]
        })
        .to_string();
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
                payload.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let result = tauri::async_runtime::block_on(chat_completion(
            &base_url,
            "test-model",
            serde_json::json!([{ "role": "user", "content": "hi" }]),
            None,
            "sk-test",
            30,
        ));
        assert_eq!(result.expect("应返回 message 对象")["content"], "你好");
    }

    #[test]
    fn chat_completion_rejects_oversize_body_from_local_http() {
        // 超 16 MiB 上限一字节：流式限读须在物化前拒绝（评审第 2 条行为
        // 回归测试——常量必须真实作用于传输路径）
        let total = CHAT_RESPONSE_BODY_MAX_BYTES + 1;
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {total}\r\n\r\n"
            );
            let _ = stream.write_all(header.as_bytes());
            let chunk = vec![b'a'; 65536];
            let mut sent = 0usize;
            while sent < total {
                let n = total.saturating_sub(sent).min(chunk.len());
                // 客户端在超限处断开：写端报错即终止，不阻塞线程
                if stream.write_all(&chunk[..n]).is_err() {
                    break;
                }
                sent += n;
            }
        });
        let result = tauri::async_runtime::block_on(chat_completion(
            &base_url,
            "test-model",
            serde_json::json!([{ "role": "user", "content": "hi" }]),
            None,
            "sk-test",
            30,
        ));
        let err = result.expect_err("超限响应应被拒绝");
        assert!(err.contains("响应体超过"), "实际错误：{err}");
        assert!(
            err.contains(&CHAT_RESPONSE_BODY_MAX_BYTES.to_string()),
            "实际错误：{err}"
        );
    }

    #[test]
    fn chat_completion_classifies_body_read_timeout() {
        // 只写响应头并保持连接：模拟 provider 回完 headers 后慢速滴流/
        // 挂起——总超时在响应体读取阶段触发，错误必须保留超时分类
        // （评审第 1 条）
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n",
            );
            std::thread::sleep(std::time::Duration::from_secs(10));
        });
        let result = tauri::async_runtime::block_on(chat_completion(
            &base_url,
            "test-model",
            serde_json::json!([{ "role": "user", "content": "hi" }]),
            None,
            "sk-test",
            1,
        ));
        let err = result.expect_err("挂起的响应体应超时");
        assert!(err.contains("读取响应超时"), "实际错误：{err}");
    }

    #[test]
    fn chat_completion_classifies_send_phase_timeout() {
        // 收到请求后不回任何字节：总超时在 send 阶段触发
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            std::thread::sleep(std::time::Duration::from_secs(10));
        });
        let result = tauri::async_runtime::block_on(chat_completion(
            &base_url,
            "test-model",
            serde_json::json!([{ "role": "user", "content": "hi" }]),
            None,
            "sk-test",
            1,
        ));
        let err = result.expect_err("不回包应超时");
        assert!(err.contains("请求超时"), "实际错误：{err}");
    }
}
