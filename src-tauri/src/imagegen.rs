//! 画布内 AI 图像生成代理（docs/data-model.md §13 首个落地切片：文生图）。
//!
//! - `llm_image_generate`：前端只传 provider 配置、prompt、尺寸与 job id；
//!   API key 密文在本进程解密（与 `llm_chat` 同域，明文不出后端），请求
//!   OpenAI 兼容 `/images/generations`（`response_format=b64_json`；部分兼容
//!   实现只回 `url`，则回退下载），产物按字节魔数定型 MIME、过大小上限后
//!   原子落盘进项目 `assets/`（`source=generated`），返回项目级 AssetRef。
//! - `llm_image_cancel`：协作式取消——登记取消标志，进行中的生成在请求
//!   返回后与落盘前检查并放弃结果。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::AppHandle;

/// 生成产物大小上限（32 MiB）：防异常响应把内存/磁盘撑爆。
const GENERATED_IMAGE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// 生成请求超时：图像模型普遍慢于对话，放宽到 5 分钟。
const IMAGE_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 图像 MIME 嗅探（字节魔数）：PNG/JPEG/WebP/GIF 之外的格式拒绝落盘——
/// provider 声称的 content-type 不可信，落盘条目以字节实情为准。
pub(crate) fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

/// 响应成员 `data[0].b64_json` 解码：成员缺失、非字符串或 base64 非法均
/// 返回 None（交由调用方决定是否走 url 回退）。
fn decode_b64_image(resp: &Value) -> Option<Vec<u8>> {
    let b64 = resp.pointer("/data/0/b64_json")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 响应成员 `data[0].url`：仅接受字符串。
fn image_url_of(resp: &Value) -> Option<String> {
    resp.pointer("/data/0/url")?.as_str().map(str::to_string)
}

/// 已取消 job id 的登记表（协作式取消标志）：取消即登记，生成流程在
/// 请求返回后与落盘前消费查询；job 结束（成功或自身失败）清理自己的标志。
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_jobs() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_cancelled(job_id: &str) -> bool {
    cancelled_jobs()
        .lock()
        .map(|set| set.contains(job_id))
        .unwrap_or(false)
}

fn clear_cancel(job_id: &str) {
    if let Ok(mut set) = cancelled_jobs().lock() {
        set.remove(job_id);
    }
}

/// url 成员回退下载：仅接受 http(s)——data:/file: 等协议不经网络边界；
/// 字节仍按魔数定型 MIME，重定向由客户端默认策略约束。
async fn fetch_image_url(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("图像 url 协议非法（仅支持 http/https）".into());
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载图像失败：{e}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取图像失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("下载图像返回 {status}"));
    }
    Ok(bytes.to_vec())
}

/// 生成请求参数（前端单对象传入：provider 配置 + 生成输入 + job 标识）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenRequest {
    project_id: String,
    job_id: String,
    provider_id: String,
    base_url: String,
    model: String,
    prompt: String,
    size: String,
}

/// 文生图命令（§13）：成功返回 `source=generated` 的项目级 AssetRef，
/// 前端经 `validate_project_asset` 预检后并入会话资产索引（§9.3 同域）。
/// 请求返回后与落盘前各检查一次取消标志：协作式取消即放弃结果。
#[tauri::command]
pub async fn llm_image_generate(app: AppHandle, request: ImageGenRequest) -> Result<Value, String> {
    let ImageGenRequest {
        project_id,
        job_id,
        provider_id,
        base_url,
        model,
        prompt,
        size,
    } = request;
    if is_cancelled(&job_id) {
        clear_cancel(&job_id);
        return Err("已取消".into());
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt 不能为空".into());
    }
    if model.trim().is_empty() {
        return Err("未选择模型".into());
    }
    let key = crate::prefs::provider_secret(&app, &provider_id)?;
    let url = format!("{}/images/generations", base_url.trim_end_matches('/'));
    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "response_format": "b64_json",
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(IMAGE_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败：{e}"))?;
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
    if is_cancelled(&job_id) {
        clear_cancel(&job_id);
        return Err("已取消".into());
    }
    if !status.is_success() {
        let head: String = text.chars().take(200).collect();
        return Err(format!("服务返回 {status}：{head}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
    let bytes = match decode_b64_image(&parsed) {
        Some(b) => b,
        None => {
            let url = image_url_of(&parsed).ok_or("服务未返回图像内容")?;
            fetch_image_url(&client, &url).await?
        }
    };
    if bytes.len() > GENERATED_IMAGE_MAX_BYTES {
        return Err(format!(
            "生成图像超出大小上限（{GENERATED_IMAGE_MAX_BYTES} 字节）"
        ));
    }
    let mime = sniff_image_mime(&bytes).ok_or("生成内容不是支持的图像格式（PNG/JPEG/WebP/GIF）")?;
    if is_cancelled(&job_id) {
        clear_cancel(&job_id);
        return Err("已取消".into());
    }
    let projects = crate::store::projects_dir(&app)?;
    let asset = crate::assets::write_generated_asset(&projects, &project_id, &bytes, mime)?;
    clear_cancel(&job_id);
    Ok(asset)
}

/// 协作式取消命令：登记取消标志；进行中的生成会在检查点放弃结果。
#[tauri::command]
pub fn llm_image_cancel(job_id: String) -> Result<(), String> {
    if let Ok(mut set) = cancelled_jobs().lock() {
        set.insert(job_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sniff_matches_known_magics() {
        assert_eq!(
            sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A]),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(
            sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"GIF89a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"GIF87a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"<html>not an image</html>"), None);
        assert_eq!(sniff_image_mime(b""), None);
    }

    #[test]
    fn decode_b64_reads_data_member() {
        // "QUJD" = "ABC"
        let resp = json!({ "data": [{ "b64_json": "QUJD" }] });
        assert_eq!(decode_b64_image(&resp).as_deref(), Some(b"ABC".as_slice()));
        assert_eq!(decode_b64_image(&json!({ "data": [] })), None);
        assert_eq!(
            decode_b64_image(&json!({ "data": [{ "b64_json": 7 }] })),
            None
        );
        assert_eq!(
            decode_b64_image(&json!({ "data": [{ "b64_json": "!!!not-base64!!!" }] })),
            None
        );
    }

    #[test]
    fn image_url_reads_string_member() {
        let resp = json!({ "data": [{ "url": "https://cdn.example.test/a.png" }] });
        assert_eq!(
            image_url_of(&resp).as_deref(),
            Some("https://cdn.example.test/a.png")
        );
        assert_eq!(image_url_of(&json!({ "data": [{}] })), None);
        assert_eq!(image_url_of(&json!({ "data": [{ "url": 42 }] })), None);
    }

    #[test]
    fn cancel_flags_register_and_clear() {
        let job = format!("job-{}", crate::store::new_id());
        assert!(!is_cancelled(&job));
        cancelled_jobs()
            .lock()
            .expect("登记取消")
            .insert(job.clone());
        assert!(is_cancelled(&job));
        clear_cancel(&job);
        assert!(!is_cancelled(&job));
    }
}
