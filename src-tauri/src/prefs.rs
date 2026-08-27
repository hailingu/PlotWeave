//! 应用设置与 Provider 密钥（docs/ui-design.md §8.2 设置页）。
//!
//! - 设置本体（provider 配置 / 默认模型）存应用数据目录 `settings.json`，
//!   结构对前端自有，以 `serde_json::Value` 透传，仅做大小与文件名校验。
//! - API key 只进系统钥匙串（macOS Security Framework，经 `keyring` crate），
//!   界面只经命令读「是否已配置」状态，从不回显明文。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

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

/// 写入 provider API key（只进钥匙串，不落 JSON、不回显）。
#[tauri::command]
pub fn set_provider_key(provider_id: String, key: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    if key.trim().is_empty() {
        return Err("API key 不能为空".into());
    }
    entry
        .set_password(key.trim())
        .map_err(|e| format!("写入钥匙串失败：{e}"))
}

/// 清除 provider API key。
#[tauri::command]
pub fn clear_provider_key(provider_id: String) -> Result<(), String> {
    validate_provider_id(&provider_id)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("清除钥匙串失败：{e}")),
    }
}

/// 查询 provider API key 状态：仅返回是否已配置，不回传明文（§8.2）。
#[tauri::command]
pub fn has_provider_key(provider_id: String) -> Result<bool, String> {
    validate_provider_id(&provider_id)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("读取钥匙串失败：{e}")),
    }
}

/// LLM 对话代理（§6/数据模型 §12.2）：key 只在钥匙串与 Rust 内存中
/// 流转，不出后端；前端只传 provider 配置、消息列表与可选工具表。
/// OpenAI 兼容 chat completions，非流式；返回 choices[0].message 原文
/// （content 字符串 + 可选 tool_calls 数组），工具调用由前端解析执行。
#[tauri::command]
pub async fn llm_chat(
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
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    let key = entry
        .get_password()
        .map_err(|_| "未配置 API key，请在设置页填写".to_string())?;

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
    if let Some(tools) = tools {
        if tools.is_array() && !tools.as_array().is_none_or(|t| t.is_empty()) {
            body["tools"] = tools;
            body["tool_choice"] = serde_json::json!("auto");
        }
    }
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_rules() {
        assert!(validate_provider_id("openai").is_ok());
        assert!(validate_provider_id("volcengine-ark").is_ok());
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("a/b").is_err());
        assert!(validate_provider_id(&"x".repeat(65)).is_err());
    }
}
