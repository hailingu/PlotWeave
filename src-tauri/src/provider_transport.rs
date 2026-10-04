//! BYOK 请求的传输边界（issue #136）：远程服务必须使用 HTTPS，HTTP 仅供
//! 显式回环地址；逐跳复验并禁止 HTTPS 降级。聊天/生图共用，下载 URL 不走此策略。

use std::error::Error;
use std::net::IpAddr;
use std::time::Duration;

use reqwest::{redirect, Url};

use crate::http_util::ProxyError;

/// 策略拒绝不含原始 URL，避免把查询参数或内嵌凭据带入诊断。
#[derive(Debug)]
struct TransportRefusal(&'static str);

impl std::fmt::Display for TransportRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl Error for TransportRefusal {}

/// 域名例外只接受 localhost；IP 按 URL 解析后的地址分类，不依赖 DNS 结果。
fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// 每次发送与每跳重定向共用的目标检查；HTTPS 不按 provider id 限定域名。
fn validate_target(url: &Url) -> Result<(), TransportRefusal> {
    match url.scheme() {
        "https" if url.host_str().is_some() => Ok(()),
        "http" if is_loopback_host(url) => Ok(()),
        "http" => Err(TransportRefusal(
            "远程服务必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.0/8 或 [::1] 回环地址",
        )),
        _ => Err(TransportRefusal("服务地址必须是有效的 HTTP 或 HTTPS URL")),
    }
}

/// HTTPS 一旦建立，后续不得降级到任何 HTTP 目标（包括回环地址）。
fn validate_redirect(next: &Url, previous: &[Url]) -> Result<(), TransportRefusal> {
    validate_target(next)?;
    if next.scheme() == "http" && previous.iter().any(|url| url.scheme() == "https") {
        return Err(TransportRefusal("服务重定向不能从 HTTPS 降级到 HTTP"));
    }
    Ok(())
}

/// 复验后委托默认策略保留 10 跳限制；reqwest 继续负责跨 host/port 敏感头剥离。
fn redirect_policy() -> redirect::Policy {
    redirect::Policy::custom(|attempt| {
        if let Err(error) = validate_redirect(attempt.url(), attempt.previous()) {
            return attempt.error(error);
        }
        redirect::Policy::default().redirect(attempt)
    })
}

/// 保持已有路径拼接方式，在构造客户端、附加 Bearer 之前校验最终请求地址。
fn endpoint_url(base_url: &str, endpoint: &str) -> Result<Url, ProxyError> {
    let url =
        Url::parse(&format!("{}/{endpoint}", base_url.trim_end_matches('/'))).map_err(|_| {
            ProxyError::ProviderRefused {
                detail: "服务地址必须是有效的 HTTP 或 HTTPS URL".into(),
            }
        })?;
    validate_target(&url).map_err(|error| ProxyError::ProviderRefused {
        detail: error.to_string(),
    })?;
    Ok(url)
}

/// 从 reqwest 的来源链取出策略拒绝，供 UI 获得明确原因而非泛化的跳转错误。
fn send_error(error: reqwest::Error, timeout_secs: u64) -> ProxyError {
    let mut source: Option<&dyn Error> = Some(&error);
    while let Some(cause) = source {
        if let Some(refusal) = cause.downcast_ref::<TransportRefusal>() {
            return ProxyError::ProviderRefused {
                detail: refusal.to_string(),
            };
        }
        source = cause.source();
    }
    if error.is_timeout() {
        ProxyError::SendTimeout {
            secs: timeout_secs,
            source: error,
        }
    } else {
        ProxyError::Send {
            context: "请求失败".into(),
            source: error,
        }
    }
}

/// 两个 provider 入口共用带凭据 POST：发送前校验、逐跳复验、保留超时分类。
/// 返回响应句柄，响应体限读与领域解析仍由聊天/生图入口负责。
pub(crate) async fn post_json(
    base_url: &str,
    endpoint: &str,
    key: &str,
    body: &serde_json::Value,
    timeout_secs: u64,
) -> Result<reqwest::Response, ProxyError> {
    let url = endpoint_url(base_url, endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(redirect_policy())
        .build()
        .map_err(|source| ProxyError::Client {
            context: "构造 HTTP 客户端失败".into(),
            source,
        })?;
    client
        .post(url)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|error| send_error(error, timeout_secs))
}

#[cfg(test)]
mod tests;
