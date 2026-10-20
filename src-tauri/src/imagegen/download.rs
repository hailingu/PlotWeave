//! Image-only HTTPS transport: every hop connects solely to its validated DNS snapshot.

use super::public_address::is_public_ip;
use super::{
    remaining_budget, with_stage_budget, DOWNLOAD_REDIRECT_LIMIT, GENERATED_IMAGE_MAX_BYTES,
    IMAGE_DOWNLOAD_TIMEOUT_SECS, IMAGE_JOB_TOTAL_BUDGET_SECS,
};
use crate::http_util::{append_capped, ProxyError};
use reqwest::Url;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

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

/// 不可取消 DNS 解析的并发上限（issue #141，PR #220 第四轮评审）：
/// `to_socket_addrs` 无法取消——超时只是放弃等待，解析线程仍继续运行。
/// 解析不占用 Tokio 阻塞池（连续挂起会耗尽池、饿死凭据读取等其他
/// 阻塞工作），改投自带严格并发上限的专用线程：在途计数到顶即
/// fail-fast（解析繁忙），线程返回即归还额度（可恢复）。上限取 2：
/// 图像生成是低频用户操作余量充足，连续挂起的泄漏被钉死在本常量个
/// 线程内，不蔓延到任何共享池。
pub(super) const DNS_RESOLVE_MAX_IN_FLIGHT: usize = 2;

/// 在途解析计数（专用线程的额度账本）：fetch_add/sub 配对，线程返回
/// 即归还；挂起只表现为计数暂不归零（fail-fast 隔离其他工作）。
pub(super) static DNS_RESOLVE_IN_FLIGHT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// 解析阶段的预算耗尽错误（复用 [`ProxyError::JobBudgetExhausted`]）。
fn dns_budget_error() -> ProxyError {
    ProxyError::JobBudgetExhausted {
        stage: "解析图像主机",
        budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
    }
}

/// 有界解析内核（生产与测试共用，`resolve` 注入以便夹具替换）：专用
/// 线程跑不可取消的解析，结果经 tokio 异步通道回传（`blocking_send`
/// 在接收端被丢弃时立即返回，线程不会卡死）；等待侧不经任何阻塞池
/// 任务，由 `timeout_at(绝对截止时间)` 约束（PR #220 第五轮评审——
/// 阻塞池排队不会把等待拖过 deadline，也不存在按入队前陈旧相对时长
/// 计时的窗口）。预算耗尽先于一切（不占用额度），在途到顶 fail-fast
/// （解析繁忙），解析线程返回即归还额度（可恢复）。
pub(super) async fn resolve_host_bounded_with(
    target: String,
    host: &str,
    deadline: std::time::Instant,
    resolve: impl FnOnce(String) -> std::io::Result<Vec<std::net::SocketAddr>> + Send + 'static,
) -> Result<Vec<std::net::SocketAddr>, ProxyError> {
    use std::sync::atomic::Ordering;
    if remaining_budget(deadline).is_none() {
        return Err(dns_budget_error());
    }
    if DNS_RESOLVE_IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= DNS_RESOLVE_MAX_IN_FLIGHT {
        DNS_RESOLVE_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        return Err(ProxyError::DownloadRefused {
            detail: "图像主机解析繁忙（并发解析已达上限），请稍后重试".into(),
        });
    }
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    std::thread::spawn(move || {
        let _ = tx.blocking_send(resolve(target));
        DNS_RESOLVE_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    });
    let host = host.to_string();
    match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), rx.recv()).await {
        Ok(Some(Ok(addrs))) => Ok(addrs),
        Ok(Some(Err(io))) => Err(ProxyError::DownloadRefused {
            detail: format!("解析图像主机 {host} 失败：{io}"),
        }),
        Ok(None) => Err(ProxyError::DownloadRefused {
            detail: format!("解析图像主机 {host} 失败：解析线程异常终止"),
        }),
        Err(_) => Err(dns_budget_error()),
    }
}

/// 生产解析入口：std 阻塞解析器投到专用线程（有界隔离见常量文档）。
async fn resolve_host_bounded(
    target: String,
    host: &str,
    deadline: std::time::Instant,
) -> Result<Vec<std::net::SocketAddr>, ProxyError> {
    resolve_host_bounded_with(target, host, deadline, |t| {
        t.to_socket_addrs().map(|i| i.collect())
    })
    .await
}

/// Test classifiers admit owned loopback fixtures; production always uses the native-aligned policy.
pub(super) type PublicIpClassifier = fn(IpAddr) -> bool;

/// Syntax and literal validation never perform DNS or send a request.
pub(super) fn static_target_violation_with(
    url: &Url,
    is_public: PublicIpClassifier,
) -> Option<String> {
    if url.scheme() != "https" {
        return Some("图像 url 协议非法（仅支持 HTTPS）".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Some("图像 url 必须没有内嵌凭据且端口有效".into());
    }
    let Some(host) = url.host_str() else {
        return Some("图像 url 缺少主机".into());
    };
    if host
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|ip| !is_public(ip))
    {
        return Some("图像 url 主机非公网地址，已拒绝下载".into());
    }
    None
}

/// Keep the approved answer set instead of discarding it before a second client resolution.
async fn approved_addresses<F, Fut>(
    url: &Url,
    deadline: Instant,
    is_public: PublicIpClassifier,
    resolve: &F,
) -> Result<Vec<SocketAddr>, ProxyError>
where
    F: Fn(String, String, Instant) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SocketAddr>, ProxyError>>,
{
    if let Some(detail) = static_target_violation_with(url, is_public) {
        return Err(ProxyError::DownloadRefused { detail });
    }
    let host = url.host_str().ok_or_else(|| refused("图像 url 缺少主机"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| refused("图像 url 端口未知"))?;
    let addresses = if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        resolve(format!("{host}:{port}"), host.to_string(), deadline).await?
    };
    if addresses.is_empty() {
        return Err(refused("图像主机未解析到地址"));
    }
    if addresses.iter().any(|a| !is_public(a.ip())) {
        return Err(refused("图像主机解析到非公网地址，已拒绝下载"));
    }
    Ok(addresses)
}

/// Production DNS remains capped at two dedicated blocking threads and the original absolute deadline.
async fn resolve(
    target: String,
    host: String,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, ProxyError> {
    resolve_host_bounded(target, &host, deadline).await
}

/// Direct validation tests use the same answer-preserving operation as the request loop.
#[cfg(test)]
pub(super) async fn ensure_public_download_target_with(
    url: &Url,
    deadline: Instant,
    is_public: PublicIpClassifier,
) -> Result<Vec<SocketAddr>, ProxyError> {
    approved_addresses(url, deadline, is_public, &resolve).await
}

/// A fresh client per hop cannot reuse a connection authorized by an earlier DNS snapshot.
fn pinned_client(
    url: &Url,
    addresses: &[SocketAddr],
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, ProxyError> {
    builder
        .no_proxy()
        .timeout(Duration::from_secs(IMAGE_DOWNLOAD_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(
            url.host_str().ok_or_else(|| refused("图像 url 缺少主机"))?,
            addresses,
        )
        .build()
        .map_err(|source| ProxyError::Client {
            context: "构造下载客户端失败".into(),
            source,
        })
}

/// Inject DNS and a client builder only at the edge; policy, pinning and budgets remain real.
pub(super) async fn fetch_with<F, Fut, B>(
    url: &str,
    deadline: Instant,
    is_public: PublicIpClassifier,
    resolve: F,
    builder: B,
) -> Result<Vec<u8>, ProxyError>
where
    F: Fn(String, String, Instant) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<SocketAddr>, ProxyError>>,
    B: Fn() -> reqwest::ClientBuilder,
{
    let mut current: Url = url.parse().map_err(|_| refused("图像 url 非法"))?;
    for _ in 0..=DOWNLOAD_REDIRECT_LIMIT {
        let addresses = approved_addresses(&current, deadline, is_public, &resolve).await?;
        let client = pinned_client(&current, &addresses, builder())?;
        let response = with_stage_budget(deadline, "下载图像", async {
            client
                .get(current.clone())
                .send()
                .await
                .map_err(|source| ProxyError::Send {
                    context: "下载图像失败".into(),
                    source,
                })
        })
        .await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| refused("图像重定向缺少 Location"))?;
            current = current
                .join(location)
                .map_err(|_| refused("图像重定向 Location 非法"))?;
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
        return Ok(bytes);
    }
    Err(refused(&format!(
        "图像下载重定向超过 {DOWNLOAD_REDIRECT_LIMIT} 跳上限"
    )))
}

/// Production has no custom trust roots; the original URL retains Host and TLS identity.
pub(super) async fn fetch_image_url(url: &str, deadline: Instant) -> Result<Vec<u8>, ProxyError> {
    fetch_with(
        url,
        deadline,
        is_public_ip,
        resolve,
        reqwest::Client::builder,
    )
    .await
}

/// Policy diagnostics never embed URL credentials or queries.
fn refused(detail: &str) -> ProxyError {
    ProxyError::DownloadRefused {
        detail: detail.into(),
    }
}
