//! 下载链（url 回退下载）的本机服务器行为测试（issue #398）：真实
//! reqwest 客户端驱动 [`fetch_with`] 的重定向循环与响应体
//! 限读——相对/绝对 Location、缺失/非 UTF-8/不可解析 Location、跳数
//! 上限、逐跳公网复验、协议门与超限即中止。测试经 [`PublicIpClassifier`]
//! 注入「环回放行」分类器使下载目标可指向本机 TLS 夹具；生产判定逻辑与
//! 拒绝范围不变（真实分类器的既有断言见 tests.rs 的 public_ip_* 与
//! download_target_static_checks_*）。

use super::*;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
mod tls_fixture;
use tls_fixture::TlsFixture;

/// Only the owned local transport is admitted in tests; production keeps its native-aligned classifier.
fn allow_loopback(ip: IpAddr) -> bool {
    ip.is_loopback() || is_public_ip(ip)
}

/// Normal fixture chains finish immediately, with a bounded deadline for a broken implementation.
fn test_deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

/// Keep real redirect/body behavior while replacing the old HTTP fixture with authenticated local TLS.
fn local_server(build: impl FnOnce(&str) -> Vec<Vec<u8>>) -> (TlsFixture, Receiver<String>) {
    TlsFixture::new(|base| build(base).into_iter().map(|bytes| (bytes, 0)).collect())
}

/// 重定向响应（空体、连接关闭），location 由调用方给出任意形态。
fn redirect(status: &str, location: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status}\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .into_bytes()
}

/// 成功响应，承载任意字节体。
fn ok_body(body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

/// 取回一跳请求并断言其请求行（路径级断言，确认客户端真实到访）。
fn expect_hop(received: &Receiver<String>, request_line: &str) {
    let request = received
        .recv_timeout(Duration::from_secs(3))
        .expect("应收到下一跳请求");
    assert!(
        request.starts_with(request_line),
        "期望请求行 {request_line}，实际 {request}"
    );
}

/// 有界等待恰好 `expected_requests` 跳请求行（issue #809）：客户端收到
/// 响应只证明夹具已打印请求行，不证明 stdout 读取线程已完成向 channel
/// 的转发，「必须发生」的跳数不能立即非阻塞计数；随后仅对「不应存在的
/// 更多跳」做非阻塞断言——该方向没有必须到达的消息，不引入固定 sleep。
fn expect_exact_request_hops(received: &Receiver<String>, expected_requests: usize) {
    for hop in 1..=expected_requests {
        received
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|_| panic!("应收到第 {hop} 跳请求"));
    }
    assert_eq!(received.try_iter().count(), 0, "拒绝后不应存在更多请求跳");
}

/// 验收：相对（根相对与纯相对）与绝对 Location 均经 `Url::join` 解析，
/// 真实重定向循环逐跳推进、终态字节原样返回。
#[test]
fn download_follows_relative_and_absolute_locations_to_success() {
    let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 1, 2, 3];
    let (local, received) = local_server(|base| {
        vec![
            redirect("302 Found", "/hop2"),
            redirect("302 Found", "hop3"),
            redirect("302 Found", &format!("{base}/final.png")),
            ok_body(&png),
        ]
    });
    let bytes =
        tauri::async_runtime::block_on(local.fetch(&format!("{local}/start.png"), test_deadline()))
            .expect("合法重定向链应成功");
    assert_eq!(bytes, png, "终态响应体应原样返回");
    expect_hop(&received, "GET /start.png HTTP/1.1");
    expect_hop(&received, "GET /hop2 HTTP/1.1");
    expect_hop(&received, "GET /hop3 HTTP/1.1");
    expect_hop(&received, "GET /final.png HTTP/1.1");
}

/// 执行真实下载并验证拒绝类型、诊断和已发送跳数；各用例仍拥有原始响应。
fn assert_refused_download(
    local: &TlsFixture,
    received: &Receiver<String>,
    diagnostic: &str,
    expected_requests: usize,
) {
    let err =
        tauri::async_runtime::block_on(local.fetch(&format!("{local}/start.png"), test_deadline()))
            .expect_err("下载应被拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "期望诊断 {diagnostic}，实际错误：{err:?}"
    );
    assert!(
        err.to_string().contains(diagnostic),
        "期望 {diagnostic}，实际诊断：{err}"
    );
    expect_exact_request_hops(received, expected_requests);
}

/// 验收：重定向响应缺少 LOCATION 头即拒绝，且不发起第二跳请求。
#[test]
fn download_rejects_redirect_without_location_header() {
    let (local, received) = local_server(|_| {
        vec![b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]
    });
    assert_refused_download(&local, &received, "缺少 Location", 1);
}

/// 验收：LOCATION 头值含非 UTF-8 原始字节——`to_str` 解码失败并入
/// 「缺少 Location」诊断（头部存在但不可解码与缺失同置）。
#[test]
fn download_rejects_non_utf8_location_header() {
    let (local, received) = local_server(|_| {
        vec![
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:\xFF\xFE/hop2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ]
    });
    assert_refused_download(&local, &received, "缺少 Location", 1);
}

/// 验收：LOCATION 为不可解析的绝对 URL（`http://` 空主机）——`Url::join`
/// 失败即拒绝，诊断「Location 非法」。
#[test]
fn download_rejects_unparsable_absolute_location() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "http://")]);
    assert_refused_download(&local, &received, "Location 非法", 1);
}

/// 验收：重定向链恰在 `DOWNLOAD_REDIRECT_LIMIT + 1` 次请求后终止
/// （`0..=limit` 迭代），诊断携带跳数上限；第 7 跳请求不存在。
#[test]
fn download_redirect_chain_is_bounded_by_hop_limit() {
    let (local, received) =
        local_server(|_| vec![redirect("302 Found", "/again"); DOWNLOAD_REDIRECT_LIMIT + 1]);
    assert_refused_download(
        &local,
        &received,
        &format!("重定向超过 {DOWNLOAD_REDIRECT_LIMIT} 跳"),
        DOWNLOAD_REDIRECT_LIMIT + 1,
    );
}

/// 验收（SSRF 核心）：重定向到非公网字面量（10.0.0.1——注入分类器下
/// 仍非公网）在下一跳请求发出之前被拒——逐跳复验不是首跳一次性检查。
#[test]
fn download_revalidates_each_hop_against_public_boundary() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "https://10.0.0.1/x.png")]);
    assert_refused_download(&local, &received, "非公网", 1);
}

/// 验收：重定向到非 http(s) 协议（ftp——即便主机是公网 IP）逐跳拒绝。
#[test]
fn download_rejects_non_http_scheme_redirect() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "ftp://8.8.8.8/x.png")]);
    assert_refused_download(&local, &received, "协议非法", 1);
}

/// 验收：非成功状态码（小响应体）返回 [`ProxyError::DownloadStatus`]，
/// 诊断携带状态码。
#[test]
fn download_reports_status_error_for_small_body() {
    let (local, _received) = local_server(|_| {
        vec![
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot-found"
                .to_vec(),
        ]
    });
    let err = tauri::async_runtime::block_on(
        local.fetch(&format!("{local}/missing.png"), test_deadline()),
    )
    .expect_err("404 应失败");
    assert!(
        matches!(
            err,
            ProxyError::DownloadStatus(code) if code == reqwest::StatusCode::NOT_FOUND
        ),
        "实际错误：{err:?}"
    );
    assert_eq!(err.to_string(), "下载图像返回 404 Not Found");
}

/// 超限响应夹具：Content-Length 声明 cap + 512 KiB，实际只发送
/// cap + 64 KiB 后持连接 20 秒——尾部永不到达，任何「读完再检查」的
/// 实现都会等待尾部直至预算耗尽（[`ProxyError::JobBudgetExhausted`]）；
/// 限读的正确实现则在跨过 cap 的分块上立即出错，超限尾部从不物化。
fn spawn_oversize_body(status_line: String) -> TlsFixture {
    let declared = GENERATED_IMAGE_MAX_BYTES + 512 * 1024;
    let sent = GENERATED_IMAGE_MAX_BYTES + 64 * 1024;
    TlsFixture::new(|_| {
        let mut response = format!(
            "HTTP/1.1 {status_line}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        response.extend_from_slice(&vec![0xAB; sent]);
        vec![(response, 20)]
    })
    .0
}

/// 超限错误的共用断言：[`ProxyError::Body`] 内层
/// [`crate::http_util::ReadBodyError::ResponseTooLarge`] 携带生产上限值，
/// 展示文案可诊断。预算收紧到 15 秒：等尾部的错误实现会先撞预算耗尽
/// （变体不同），与本变体可区分。
fn expect_oversize_abort(base: &TlsFixture) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let err = tauri::async_runtime::block_on(base.fetch(&format!("{base}/big.png"), deadline))
        .expect_err("超限响应体应被限读拒绝");
    assert!(
        matches!(
            err,
            ProxyError::Body(crate::http_util::ReadBodyError::ResponseTooLarge {
                limit: GENERATED_IMAGE_MAX_BYTES
            })
        ),
        "实际错误：{err:?}"
    );
    assert_eq!(
        err.to_string(),
        format!("响应体超过 {GENERATED_IMAGE_MAX_BYTES} 字节上限")
    );
}

/// 验收：成功状态下的超限响应体——限读立即中止并给出可诊断错误，
/// 未送达的尾部（服务器持连接不发）从不被读入内存。
#[test]
fn download_cap_aborts_oversize_success_body_without_awaiting_tail() {
    expect_oversize_abort(&spawn_oversize_body("200 OK".into()));
}

/// 验收：非成功状态码带超限响应体——现行契约是先限读后判状态：超限
/// 错误优先于 [`ProxyError::DownloadStatus`]（读取中止在状态判定之前）。
#[test]
fn download_oversize_body_on_error_status_hits_cap_first() {
    expect_oversize_abort(&spawn_oversize_body("404 Not Found".into()));
}

/// 边界：响应体恰好等于上限应完整返回（防 cap 回归为提前一字节拒绝，
/// issue #398 指出的回归形态）。
#[test]
fn download_accepts_body_exactly_at_cap() {
    let body = vec![0xCD; GENERATED_IMAGE_MAX_BYTES];
    let (local, _received) = local_server(move |_| vec![ok_body(&body)]);
    let bytes = tauri::async_runtime::block_on(
        local.fetch(&format!("{local}/at-cap.png"), test_deadline()),
    )
    .expect("恰好达上限的响应体应完整返回");
    assert_eq!(bytes.len(), GENERATED_IMAGE_MAX_BYTES);
    assert_eq!(bytes[0], 0xCD);
}

/// Any client fallback lookup is forbidden: removing address pinning deterministically fails locally.
struct DenyResolution(std::sync::atomic::AtomicUsize);
impl reqwest::dns::Resolve for DenyResolution {
    /// No real DNS or external connection is available to this fixture.
    fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Err(std::io::Error::other("second DNS lookup forbidden").into()) })
    }
}

/// Two real TLS hops retain Host/SNI and use exactly their approved addresses, bypassing even an explicit proxy.
#[test]
fn pinned_dns_preserves_tls_identity_without_second_resolution_or_proxy() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let (fixture, received) =
        local_server(|_| vec![redirect("302 Found", "/final"), ok_body(b"pinned")]);
    let parsed: Url = fixture.parse().unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], parsed.port().unwrap()));
    let target = format!("https://fixture.invalid:{}/start", address.port());
    let fallback = Arc::new(DenyResolution(AtomicUsize::new(0)));
    let calls = AtomicUsize::new(0);
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let bytes = tauri::async_runtime::block_on(fetch_with(
        &target,
        test_deadline(),
        allow_loopback,
        |_, host, _| {
            assert_eq!(host, "fixture.invalid");
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Ok(vec![address]) }
        },
        || {
            reqwest::Client::builder()
                .add_root_certificate(fixture.certificate.clone())
                .dns_resolver(fallback.clone())
                .proxy(
                    reqwest::Proxy::all(format!("http://{}", proxy.local_addr().unwrap())).unwrap(),
                )
        },
    ))
    .expect("approved address and original certificate identity must succeed");
    assert_eq!(bytes, b"pinned");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(fallback.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        proxy.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    for path in ["/start", "/final"] {
        let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
        assert!(request
            .to_lowercase()
            .contains(&format!("host: fixture.invalid:{}", address.port())));
        assert!(request.contains("Fixture-SNI: fixture.invalid"));
    }
}

/// Every answer in every hop is checked; a mixed rebinding answer cannot reach the second connection.
#[test]
fn redirect_mixed_dns_answer_is_rejected_before_connecting() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (fixture, received) = local_server(|_| vec![redirect("302 Found", "/second")]);
    let port = Url::parse(&fixture).unwrap().port().unwrap();
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let calls = AtomicUsize::new(0);
    let error = tauri::async_runtime::block_on(fetch_with(
        &format!("https://fixture.invalid:{port}/first"),
        test_deadline(),
        allow_loopback,
        |_, _, _| {
            let attempt = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                Ok(if attempt == 0 {
                    vec![address]
                } else {
                    vec![address, "10.0.0.1:443".parse().unwrap()]
                })
            }
        },
        || reqwest::Client::builder().add_root_certificate(fixture.certificate.clone()),
    ))
    .unwrap_err();
    assert!(matches!(error, ProxyError::DownloadRefused { .. }));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    expect_hop(&received, "GET /first HTTP/1.1");
    assert_eq!(
        received.try_iter().count(),
        0,
        "混合答案应在第二跳连接前被拒，不存在第二跳请求"
    );
}

/// HTTPS downgrade is refused on the next hop, even when the destination is an owned loopback server.
#[test]
fn download_rejects_https_to_http_downgrade() {
    let (fixture, received) =
        local_server(|base| vec![redirect("302 Found", &base.replacen("https:", "http:", 1))]);
    assert_refused_download(&fixture, &received, "仅支持 HTTPS", 1);
}

/// Default certificate trust and hostname validation stay enabled when the socket address is pinned.
#[test]
fn pinned_tls_rejects_untrusted_certificate_and_wrong_hostname() {
    for trust_fixture in [false, true] {
        let (fixture, received) = local_server(|_| vec![ok_body(b"must not be read")]);
        let port = Url::parse(&fixture).unwrap().port().unwrap();
        let target = format!(
            "https://{}:{port}/secret",
            if trust_fixture {
                "wrong.invalid"
            } else {
                "fixture.invalid"
            }
        );
        let error = tauri::async_runtime::block_on(fetch_with(
            &target,
            test_deadline(),
            allow_loopback,
            |_, _, _| async move { Ok(vec![([127, 0, 0, 1], port).into()]) },
            || {
                let builder = reqwest::Client::builder();
                if trust_fixture {
                    builder.add_root_certificate(fixture.certificate.clone())
                } else {
                    builder
                }
            },
        ))
        .unwrap_err();
        assert!(matches!(error, ProxyError::Send { .. }), "{error:?}");
        assert_eq!(
            received.try_iter().count(),
            0,
            "TLS failure must precede HTTP"
        );
    }
}
