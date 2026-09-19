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
mod tests;
