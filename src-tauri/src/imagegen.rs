//! 画布内 AI 图像生成代理（docs/data-model.md §13 首个落地切片：文生图）。
//!
//! - `llm_image_generate`：前端只传 provider 配置、prompt、尺寸与 job id；
//!   API key 密文在本进程解密（与 `llm_chat` 同域，明文不出后端），请求
//!   OpenAI 兼容 `/images/generations`（GPT Image 系恒回 base64；部分兼容
//!   实现只回 `url`，则回退下载——目标与每跳重定向均过公网边界校验，
//!   恶意/被入侵 provider 不得驱使桌面端探入用户本机/内网），响应体
//!   流式限读、产物按字节魔数定型 MIME、过大小上限后原子落盘进项目
//!   `assets/`（`source=generated`），返回项目级 AssetRef。
//! - `llm_image_cancel`：协作式取消——登记取消标志，进行中的生成在请求
//!   返回后与落盘前检查并放弃结果。

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use reqwest::Url;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::http_util::{append_capped, read_text_capped, ProxyError};

/// 生成产物大小上限（32 MiB）：防异常响应把内存/磁盘撑爆。pwmedia 项目
/// scope 的读取上限（256 MiB 防御界）远超本值——生成产物契约是项目资产
/// 持久化契约的真子集（评审修复 P2-2/P2-4）。
const GENERATED_IMAGE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// 响应体读取上限（64 MiB）：主响应是 JSON 文本，base64 膨胀约 4/3 加
/// JSON 开销，按产物上限放宽一倍封顶——流式聚合、超限即中止，恶意/
/// 异常 provider 的超大响应在物化前被拒，上限真正护住内存。
const RESPONSE_BODY_MAX_BYTES: usize = GENERATED_IMAGE_MAX_BYTES * 2;

/// 有上限地流式读取响应体为字节（url 回退下载，cap = 产物上限）。
async fn read_bytes_capped(response: reqwest::Response, cap: usize) -> Result<Vec<u8>, ProxyError> {
    let mut resp = response;
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(ProxyError::Read)? {
        // 限读错误经 Body 透传（#45 首片类型）：文案与来源链原样保留
        append_capped(&mut buf, &chunk, cap).map_err(ProxyError::Body)?;
    }
    Ok(buf)
}

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
/// 中毒后行为（issue #145）：可验证恢复——纯内存建议性状态，set 单项
/// infallible 操作不会留下结构损坏；恢复经 `crate::lock::recover_guard`，
/// 取消登记真实生效才报成功（不静默忽略），is_cancelled 如实回答。
static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_jobs() -> &'static Mutex<HashSet<String>> {
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_cancelled(job_id: &str) -> bool {
    crate::lock::recover_guard(cancelled_jobs().lock(), "生成取消登记表").contains(job_id)
}

fn clear_cancel(job_id: &str) {
    crate::lock::recover_guard(cancelled_jobs().lock(), "生成取消登记表").remove(job_id);
}

/// url 回退下载的重定向上限：禁用客户端自动跟随、逐跳显式复验目标，
/// 防重定向链绕过首跳校验。
const DOWNLOAD_REDIRECT_LIMIT: usize = 5;

/// url 回退下载超时：只拉一帧 ≤32MiB 的图像，远小于生成超时。
const IMAGE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// 一次生成作业的总时间预算（issue #141）：覆盖 provider 凭据读取
/// （阻塞线程池）、生成 POST（含响应体读取）与 url 回退下载链（逐跳
/// DNS 解析 + 请求 + 响应体读取，最多 5 跳重定向可发 6 次请求）。作业
/// 开始时刻起算，各阶段等待上界均为剩余预算（[`with_stage_budget`] /
/// [`bounded_key_load`]）；预算耗尽即放弃并按阶段给出诊断，产物不写
/// 回，也不发出可能计费的请求。逐跳 120s 与 POST 300s 客户端上限保留
/// 为单阶段兜底。
const IMAGE_JOB_TOTAL_BUDGET_SECS: u64 = 600;

/// 作业剩余预算：截止时刻已过即 None（调用方按预算耗尽处置）。
fn remaining_budget(deadline: std::time::Instant) -> Option<std::time::Duration> {
    deadline.checked_duration_since(std::time::Instant::now())
}

/// 统一作业预算内核（issue #141）：把剩余预算作为等待上界套在任一
/// 阶段 future（DNS 解析 / 每跳请求 / 响应体读取）上——预算内完成则
/// 结果与自身错误原样透传（不过度介入既有诊断），超时即放弃等待并
/// 返回带阶段标签的 [`ProxyError::JobBudgetExhausted`]。诊断区分阶段，
/// 满足验收「超时诊断区分阶段」。
async fn with_stage_budget<T, F>(
    deadline: std::time::Instant,
    stage: &'static str,
    fut: F,
) -> Result<T, ProxyError>
where
    F: std::future::Future<Output = Result<T, ProxyError>>,
{
    let Some(remaining) = remaining_budget(deadline) else {
        return Err(ProxyError::JobBudgetExhausted {
            stage,
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        });
    };
    match tokio::time::timeout(remaining, fut).await {
        Ok(result) => result,
        Err(_elapsed) => Err(ProxyError::JobBudgetExhausted {
            stage,
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        }),
    }
}

/// IPv4 公网判定：环回（127/8）、RFC1918 私有（10/8、172.16/12、
/// 192.168/16）、链路本地（169.254/16，含云元数据端点）、CGNAT
/// （100.64/10）、0/8、未指定、多播、广播均非公网。
fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xC0) == 0x40))
}

/// IPv6 公网判定：环回、唯一本地（fc00::/7）、链路本地（fe80::/10）、
/// 未指定、多播均非公网；IPv4 映射/兼容地址按内嵌 IPv4 复验。
fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || (s[0] & 0xFFC0) == 0xFE80
        || ip.to_ipv4().is_some_and(|v4| !is_public_ipv4(v4)))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_ipv4(v4),
        IpAddr::V6(v6) => is_public_ipv6(v6),
    }
}

/// 下载目标的静态校验（可单测的纯部分）：scheme 仅 http(s)——data:/file:
/// 等协议不经网络边界；主机为 IP 字面量时立即按公网分类。返回
/// Some(原因) 即拒绝；域名主机交由解析复验（见 ensure_public_download_target）。
fn static_target_violation(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Some("图像 url 协议非法（仅支持 http/https）".into());
    }
    let host = url.host_str()?;
    // IPv6 主机串带方括号（如 "[::1]"），IpAddr 解析不接受——剥后判字面量
    let literal = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = literal.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Some(format!("图像 url 主机 {host} 非公网地址，已拒绝下载"));
        }
    }
    None
}

/// 下载目标公网边界（首跳与每跳重定向共用）：IP 字面量即时分类；域名
/// 主机解析后要求全部地址为公网——`localhost` 等 DNS 名同样可能指向
/// 环回/内网。注：本校验的解析与客户端连接各自解析存在固有的 DNS
/// 再绑定窗口，此层为纵深防御而非绝对边界（威胁模型见 AGENTS.md）。
/// 解析受作业剩余预算约束（issue #141）。超时后的资源生命周期：`to_
/// socket_addrs` 是阻塞系统调用，进入阻塞线程池后无法取消——预算耗尽
/// 只是放弃等待（join future 被丢弃），解析任务本身继续运行至系统
/// 解析器返回，其结果随即被丢弃；该任务不持有任何应用锁或可变状态，
/// 仅临时占用一个阻塞池线程，线程池在其返回后回收，不遗留无限后台
/// 任务。
async fn ensure_public_download_target(
    url: &Url,
    deadline: std::time::Instant,
) -> Result<(), ProxyError> {
    if let Some(reason) = static_target_violation(url) {
        return Err(ProxyError::DownloadRefused { detail: reason });
    }
    let refused = |detail: String| ProxyError::DownloadRefused { detail };
    let host = url
        .host_str()
        .ok_or_else(|| refused("图像 url 缺少主机".into()))?;
    let literal = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if literal.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| refused("图像 url 端口未知".into()))?;
    let target = format!("{host}:{port}");
    // std 解析是阻塞调用：挪到阻塞线程池，不占异步工作线程；等待上界
    // 为作业剩余预算（内核见 with_stage_budget——超时只放弃 join，
    // 阻塞任务生命周期见函数文档）
    with_stage_budget(deadline, "解析图像主机", async {
        tauri::async_runtime::spawn_blocking(move || target.to_socket_addrs())
            .await
            .map_err(|e| refused(format!("解析图像主机失败：{e}")))?
            .map_err(|e| refused(format!("解析图像主机 {host} 失败：{e}")))
            .map(|addrs| addrs.collect::<Vec<std::net::SocketAddr>>())
    })
    .await
    .and_then(|list| {
        if list.is_empty() {
            Err(refused(format!("图像主机 {host} 未解析到地址")))
        } else if list.iter().any(|a| !is_public_ip(a.ip())) {
            Err(refused(format!(
                "图像主机 {host} 解析到非公网地址，已拒绝下载"
            )))
        } else {
            Ok(())
        }
    })
}

/// url 成员回退下载：目标与每跳重定向均过公网边界校验（仅 http(s)、
/// 环回/私网/链路本地/CGNAT 等一律拒绝）；禁用自动重定向、逐跳显式
/// 复验（上限 DOWNLOAD_REDIRECT_LIMIT 跳）；字节仍按魔数定型 MIME。
/// 整链受作业总预算约束（issue #141）：逐跳 DNS 解析、请求与响应体
/// 读取的等待上界均为作业剩余预算（`deadline`，由命令在作业开始时
/// 起算传入），预算耗尽按阶段给出诊断并放弃——各请求的
/// IMAGE_DOWNLOAD_TIMEOUT_SECS 仍作单跳兜底。
async fn fetch_image_url(url: &str, deadline: std::time::Instant) -> Result<Vec<u8>, ProxyError> {
    let refused = |detail: String| ProxyError::DownloadRefused { detail };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(IMAGE_DOWNLOAD_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ProxyError::Client {
            context: "构造下载客户端失败".into(),
            source: e,
        })?;
    let mut current: Url = url.parse().map_err(|_| refused("图像 url 非法".into()))?;
    for _ in 0..=DOWNLOAD_REDIRECT_LIMIT {
        ensure_public_download_target(&current, deadline).await?;
        let response = with_stage_budget(deadline, "下载图像", async {
            client
                .get(current.clone())
                .send()
                .await
                .map_err(|e| ProxyError::Send {
                    context: "下载图像失败".into(),
                    source: e,
                })
        })
        .await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| refused("图像重定向缺少 Location".into()))?;
            current = current
                .join(location)
                .map_err(|_| refused("图像重定向 Location 非法".into()))?;
            continue;
        }
        let status = response.status();
        let bytes = with_stage_budget(
            deadline,
            "读取图像",
            read_bytes_capped(response, GENERATED_IMAGE_MAX_BYTES),
        )
        .await?;
        if !status.is_success() {
            return Err(ProxyError::DownloadStatus(status));
        }
        return Ok(bytes.to_vec());
    }
    Err(refused(format!(
        "图像下载重定向超过 {DOWNLOAD_REDIRECT_LIMIT} 跳上限"
    )))
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

/// 生成请求体（§13）：只含 model/prompt/size——**不携带 `response_format`**：
/// GPT Image 系（gpt-image-1 等）不接受该参数（携带即 400 unsupported
/// parameter，主路径在生成前失败），且总是返回 base64；DALL·E 系默认 url
/// 响应由响应侧 url 成员回退下载兜住。
fn generation_request_body(model: &str, prompt: &str, size: &str) -> Value {
    json!({ "model": model, "prompt": prompt, "size": size })
}

/// 文生图命令（§13）：成功返回 `source=generated` 的项目级 AssetRef，
/// 前端直接并入会话资产索引。请求返回后与落盘前各检查一次取消标志：
/// 协作式取消即放弃结果；落盘后在**命令内**完成 §9.3 预检（形状 +
/// 实路径复验）——生成后到返回前不再跨命令边界，消除前端二次 IPC 的
/// 卸载丢结果窗口。
/// provider API key 读取（provider_secret 为同步阻塞访问：设置文件读取
/// 与系统钥匙串）挪入阻塞线程池并受作业剩余预算约束（issue #141 评审
/// ——总预算自命令进入起算，前置阻塞不得在预算耗尽后仍发起计费请求）。
/// 阻塞任务不可取消：预算耗尽只是放弃等待，任务返回后结果被丢弃、不
/// 持有应用锁（同 DNS 解析的资源生命周期）。`load` 的错误文案原样
/// 透传；预算耗尽诊断标明读取凭据阶段。
async fn bounded_key_load(
    deadline: std::time::Instant,
    load: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    let budget = || {
        ProxyError::JobBudgetExhausted {
            stage: "读取凭据",
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        }
        .to_string()
    };
    let Some(remaining) = remaining_budget(deadline) else {
        return Err(budget());
    };
    match tokio::time::timeout(remaining, tauri::async_runtime::spawn_blocking(load)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("读取 API key 失败：{join}")),
        Err(_) => Err(budget()),
    }
}

/// 生成请求 → 图像字节（自 llm_image_generate 提取，PR #220 评审：命令
/// 体超出 80 代码行硬上限）：POST 与响应体限读共同消费作业剩余预算
/// （issue #141 评审——预算被前置工作耗尽时在 POST 之前拒绝，不发出
/// 可能计费的请求）→ 读取后取消检查点（保持提取前位置与语义）→ 解析
/// b64 优先，url 成员回退预算化下载链。错误统一转既有展示文案。
async fn generate_image_bytes(
    base_url: &str,
    key: &str,
    body: &Value,
    job_id: &str,
    job_deadline: std::time::Instant,
) -> Result<Vec<u8>, String> {
    let (status, response_url, text) = with_stage_budget(job_deadline, "生成请求", async {
        let response = crate::provider_transport::post_json(
            base_url,
            "images/generations",
            key,
            body,
            IMAGE_REQUEST_TIMEOUT_SECS,
        )
        .await?;
        let status = response.status();
        let response_url = response.url().clone();
        // 展示边界转换（issue #45 首片）：文案与历史 format! 输出逐字一致
        let text = read_text_capped(response, RESPONSE_BODY_MAX_BYTES)
            .await
            .map_err(ProxyError::Body)?;
        Ok((status, response_url, text))
    })
    .await
    .map_err(|error| match error {
        // 保留生成入口既有的超时展示文案；聊天入口保留 SendTimeout 分类。
        ProxyError::SendTimeout { source, .. } => format!("请求失败：{source}"),
        other => other.to_string(),
    })?;
    if is_cancelled(job_id) {
        clear_cancel(job_id);
        return Err("已取消".into());
    }
    if !status.is_success() {
        // 网关/代理回显请求 URL 或密钥时展示不泄露（issue #149）
        let head = crate::http_util::redact_status_head(&text, key, &response_url);
        return Err(format!("服务返回 {status}：{head}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
    match decode_b64_image(&parsed) {
        Some(b) => Ok(b),
        None => {
            let url = image_url_of(&parsed).ok_or("服务未返回图像内容")?;
            fetch_image_url(&url, job_deadline)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn llm_image_generate(app: AppHandle, request: ImageGenRequest) -> Result<Value, String> {
    // 作业总预算自命令进入时刻起算（issue #141）：覆盖 POST 与下载链
    let job_deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(IMAGE_JOB_TOTAL_BUDGET_SECS);
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
    let key = {
        let app = app.clone();
        bounded_key_load(job_deadline, move || {
            crate::prefs::provider_secret(&app, &provider_id)
        })
        .await?
    };
    let body = generation_request_body(&model, prompt, &size);
    // POST 与下载链（含预算耗尽）的失败经同一展示文案上浮
    let bytes = generate_image_bytes(&base_url, &key, &body, &job_id, job_deadline).await?;
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
    let projects = crate::store::projects_dir(&app).map_err(crate::store::to_ipc_text)?;
    let pending = app.state::<crate::assets::project_media::PendingProjectAssets>();
    let written =
        crate::assets::write_generated_asset(&projects, &project_id, &bytes, mime, &pending)
            .map_err(|e| e.to_string())?;
    // §9.3 预检并入命令内（同一根句柄）：返回的产物已完成形状+实路径校验
    let asset = crate::assets::validate_project_asset_with(&projects, &project_id, &written)
        .map_err(|e| e.to_string())?;
    clear_cancel(&job_id);
    Ok(asset)
}

/// 协作式取消命令：登记取消标志（中毒恢复——登记真实生效才报成功，
/// issue #145）；进行中的生成会在检查点放弃结果。
#[tauri::command]
pub fn llm_image_cancel(job_id: String) -> Result<(), String> {
    crate::lock::recover_guard(cancelled_jobs().lock(), "生成取消登记表").insert(job_id);
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
        // 与并行的中毒恢复用例共存（PR #219 评审）：静态表可能被并行
        // 用例注入中毒，本用例的直接访问同样走恢复路径，保持套件确定性
        crate::lock::recover_guard(cancelled_jobs().lock(), "生成取消登记表").insert(job.clone());
        assert!(is_cancelled(&job));
        clear_cancel(&job);
        assert!(!is_cancelled(&job));
    }

    #[test]
    fn cancel_registry_recovers_after_poison() {
        // [issue #145](https://github.com/hailingu/PlotWeave/issues/145)：
        // 取消表中毒恢复——持锁 panic 后，取消登记真实生效才报成功
        // （不静默忽略却报成功），is_cancelled 如实回答。静态表此后保持
        // 中毒状态，后续用例经同一恢复路径照常工作（透明恢复）
        let job = format!("job-{}", crate::store::new_id());
        std::thread::spawn(|| {
            let _guard = cancelled_jobs().lock().expect("先取得锁");
            panic!("测试注入的持锁 panic");
        })
        .join()
        .expect_err("注入 panic 应发生");
        llm_image_cancel(job.clone()).expect("中毒后取消登记仍应成功");
        assert!(is_cancelled(&job), "中毒后取消登记须真实生效");
        clear_cancel(&job);
        assert!(!is_cancelled(&job), "中毒后清理须照常");
    }

    #[test]
    fn request_body_omits_response_format() {
        // GPT Image 系（gpt-image-1 等）不接受 response_format（携带即
        // 400 unsupported parameter，生成前的主路径直接失败）
        let body = generation_request_body("gpt-image-1", "雨夜霓虹", "1024x1024");
        assert_eq!(
            body,
            json!({ "model": "gpt-image-1", "prompt": "雨夜霓虹", "size": "1024x1024" })
        );
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn public_ip_allows_global_addresses() {
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700::1111",
            "2400:cb00::1",
        ] {
            let ip: std::net::IpAddr = s.parse().expect(s);
            assert!(is_public_ip(ip), "{s} 应判定为公网");
        }
    }

    #[test]
    fn public_ip_rejects_private_and_special_ranges() {
        for s in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "0.1.2.3",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
        ] {
            let ip: std::net::IpAddr = s.parse().expect(s);
            assert!(!is_public_ip(ip), "{s} 应判定为非公网");
        }
    }

    #[test]
    fn download_target_static_checks_reject_nonpublic_literals() {
        for s in [
            "http://127.0.0.1/a.png",
            "http://[::1]/a.png",
            "http://169.254.169.254/meta",
            "https://10.0.0.5/a.png",
            "ftp://8.8.8.8/a.png",
            "file:///etc/passwd",
        ] {
            let url: Url = s.parse().expect(s);
            assert!(static_target_violation(&url).is_some(), "{s} 应被静态拒绝");
        }
        // 公网 IP 字面量与域名（域名走解析复验，不在静态层拒绝）
        assert!(static_target_violation(&"https://8.8.8.8/a.png".parse().unwrap()).is_none());
        assert!(
            static_target_violation(&"http://cdn.example.test/a.png".parse().unwrap()).is_none()
        );
    }

    #[test]
    fn remaining_budget_bounds_job_stages() {
        let future = std::time::Instant::now() + std::time::Duration::from_secs(600);
        assert!(remaining_budget(future).is_some(), "未到期预算应可用");
        let past = std::time::Instant::now() - std::time::Duration::from_secs(1);
        assert!(remaining_budget(past).is_none(), "已过期预算应耗尽");
    }

    /// 前置阻塞消费预算（issue #141 评审）：凭据读取（同步阻塞访问）在
    /// 预算耗尽后不得发起——过期截止时间下，阻塞闭包一次都不被调用，
    /// 诊断标明读取凭据阶段。
    #[test]
    fn key_load_budget_gate_skips_blocking_access_when_expired() {
        let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let err = tauri::async_runtime::block_on(bounded_key_load(deadline, || {
            panic!("预算耗尽不得发起阻塞凭据访问")
        }))
        .expect_err("预算耗尽应拒绝");
        assert!(err.contains("总预算"), "实际诊断：{err}");
        assert!(err.contains("读取凭据"), "诊断应标明阶段：{err}");
    }

    /// 非零前置耗时后的过期用例（issue #141 评审）：预算已被前置工作
    /// 耗尽时，生成 POST 不得发出（合法 URL 会产生计费请求，故以会快速
    /// 失败的非法 URL 验证——修复前该用例落到 endpoint_url 解析错误，
    /// 修复后在 POST 之前即按预算拒绝），诊断标明生成请求阶段。
    #[test]
    fn generate_request_budget_gate_precedes_post_when_expired() {
        let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let body = generation_request_body("m", "p", "1024x1024");
        let err = tauri::async_runtime::block_on(generate_image_bytes(
            "not-a-url",
            "sk-FICTITIOUS",
            &body,
            "job-1",
            deadline,
        ))
        .expect_err("预算耗尽应在 POST 前拒绝");
        assert!(err.contains("总预算"), "实际诊断：{err}");
        assert!(err.contains("生成请求"), "诊断应标明阶段：{err}");
    }

    /// 受控慢响应（issue #141）：挂起 future 与剩余预算赛跑——统一预算
    /// 内核必须在预算耗尽时放弃等待并保留阶段标签；预算内的快 future 与
    /// 自身错误原样透传（不过度介入）。
    #[test]
    fn with_stage_budget_times_out_hanging_future_and_labels_stage() {
        // 短预算（50ms）驱动超时路径：受控测试不等真实预算
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
        let started = std::time::Instant::now();
        let err = tauri::async_runtime::block_on(with_stage_budget(
            deadline,
            "测试阶段",
            std::future::pending::<Result<(), ProxyError>>(),
        ))
        .expect_err("挂起 future 应在预算耗尽时被放弃");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "预算内核应在短预算内放弃等待，实际等待 {:?}",
            started.elapsed()
        );
        assert!(
            matches!(
                err,
                ProxyError::JobBudgetExhausted {
                    stage: "测试阶段",
                    ..
                }
            ),
            "实际错误：{err:?}"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        let ok = tauri::async_runtime::block_on(with_stage_budget(deadline, "测试阶段", async {
            Ok::<_, ProxyError>(7)
        }))
        .expect("预算内完成应透传");
        assert_eq!(ok, 7);
        let inner =
            tauri::async_runtime::block_on(with_stage_budget(deadline, "测试阶段", async {
                Err::<(), _>(ProxyError::InvalidResponse {
                    detail: "内部错误".into(),
                })
            }))
            .expect_err("预算内的自身错误应原样透传");
        assert!(
            matches!(inner, ProxyError::InvalidResponse { .. }),
            "实际错误：{inner:?}"
        );
    }

    /// 作业总预算（issue #141）：预算已耗尽时，下载链在任何网络请求与
    /// DNS 之前即拒绝（公网字面量目标，不触网）——产物无从产生，更不会
    /// 写回；诊断标明阶段与总预算。
    #[test]
    fn download_chain_rejects_expired_budget_before_any_request() {
        let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let err =
            tauri::async_runtime::block_on(fetch_image_url("https://8.8.8.8/a.png", deadline))
                .expect_err("预算耗尽应拒绝");
        assert!(
            matches!(
                err,
                ProxyError::JobBudgetExhausted {
                    stage: "下载图像",
                    ..
                }
            ),
            "实际错误：{err:?}"
        );
        let shown = err.to_string();
        assert!(shown.contains("总预算"), "实际诊断：{shown}");
        assert!(shown.contains("下载图像"), "诊断应标明阶段：{shown}");
    }

    /// DNS 阶段预算门（issue #141）：预算耗尽时在解析器之前拒绝——
    /// 不发起 spawn_blocking 解析（域名主机，静态层不拒绝）；诊断标明
    /// 解析阶段。
    #[test]
    fn dns_budget_gate_precedes_resolver() {
        let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let url: Url = "http://cdn.example.test/a.png".parse().expect("合法 url");
        let err = tauri::async_runtime::block_on(ensure_public_download_target(&url, deadline))
            .expect_err("预算耗尽应拒绝");
        assert!(
            matches!(
                err,
                ProxyError::JobBudgetExhausted {
                    stage: "解析图像主机",
                    ..
                }
            ),
            "实际错误：{err:?}"
        );
        let shown = err.to_string();
        assert!(shown.contains("解析图像主机"), "实际诊断：{shown}");
    }

    /// 超时诊断区分阶段（issue #141 验收）：三个阶段的预算耗尽诊断
    /// 互不相同且都携带总预算。
    #[test]
    fn budget_exhausted_diagnostics_distinguish_stages() {
        let mk = |stage: &'static str| ProxyError::JobBudgetExhausted {
            stage,
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        };
        let texts: Vec<String> = ["解析图像主机", "下载图像", "读取图像"]
            .iter()
            .map(|s| mk(s).to_string())
            .collect();
        assert_ne!(texts[0], texts[1], "不同阶段不得共享同一诊断");
        assert_ne!(texts[1], texts[2], "不同阶段不得共享同一诊断");
        for t in &texts {
            assert!(t.contains(&IMAGE_JOB_TOTAL_BUDGET_SECS.to_string()), "{t}");
        }
    }
}
