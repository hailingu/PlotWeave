//! 下载链（url 回退下载）的本机服务器行为测试（issue #398）：真实
//! reqwest 客户端驱动 [`fetch_image_url_with`] 的重定向循环与响应体
//! 限读——相对/绝对 Location、缺失/非 UTF-8/不可解析 Location、跳数
//! 上限、逐跳公网复验、协议门与超限即中止。测试经 [`PublicIpClassifier`]
//! 注入「环回放行」分类器使下载目标可指向本机夹具；生产判定逻辑与
//! 拒绝范围不变（真实分类器的既有断言见 tests.rs 的 public_ip_* 与
//! download_target_static_checks_*）。

use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

/// 测试分类器：环回放行（本机夹具可达）叠加生产公网分类——10.0.0.1
/// 等非公网目标在本组用例中仍被拒绝，注入不放宽生产拒绝范围。
fn allow_loopback(ip: IpAddr) -> bool {
    ip.is_loopback() || is_public_ip(ip)
}

/// 宽裕的作业截止时间（链路毫秒级完成；预算耗尽另有专测，见 tests.rs）。
fn test_deadline() -> std::time::Instant {
    std::time::Instant::now() + Duration::from_secs(30)
}

/// 读取 GET 请求头（无请求体）：读到头部终止符即返回；读超时防挂。
fn read_request_head(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0u8; 1024];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0, "请求未完整到达");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 64 * 1024);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            return String::from_utf8_lossy(&bytes[..end]).into_owned();
        }
    }
}

/// 多请求本机夹具（参照 provider_transport/tests.rs 的 local_server）：
/// 绑定环回后以基址调用 `build` 生成按序响应（Vec<u8> 原始字节，支持
/// 非 UTF-8 头值），逐连接回放并经通道回收每跳请求头——响应带
/// Connection: close，一跳一连接，重定向链的每一跳可独立断言。
fn local_server(build: impl FnOnce(&str) -> Vec<Vec<u8>>) -> (String, Receiver<String>) {
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let responses = build(&url);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // BSD/macOS：accept 出的流继承监听器的非阻塞标志，
                        // 显式切回阻塞式，让读超时语义成立
                        stream.set_nonblocking(false).unwrap();
                        tx.send(read_request_head(&mut stream)).unwrap();
                        let _ = stream.write_all(&response);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("本机夹具失败：{error}"),
                }
            }
        }
    });
    (url, rx)
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
    let bytes = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect("合法重定向链应成功");
    assert_eq!(bytes, png, "终态响应体应原样返回");
    expect_hop(&received, "GET /start.png HTTP/1.1");
    expect_hop(&received, "GET /hop2 HTTP/1.1");
    expect_hop(&received, "GET /hop3 HTTP/1.1");
    expect_hop(&received, "GET /final.png HTTP/1.1");
}

/// 验收：重定向响应缺少 LOCATION 头即拒绝，且不发起第二跳请求。
#[test]
fn download_rejects_redirect_without_location_header() {
    let (local, received) = local_server(|_| {
        vec![b"HTTP/1.1 302 Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]
    });
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("缺 Location 的重定向应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().contains("缺少 Location"), "实际诊断：{err}");
    assert_eq!(received.try_iter().count(), 1, "不得发起第二跳");
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
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("非 UTF-8 Location 应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().contains("缺少 Location"), "实际诊断：{err}");
    assert_eq!(received.try_iter().count(), 1, "不得发起第二跳");
}

/// 验收：LOCATION 为不可解析的绝对 URL（`http://` 空主机）——`Url::join`
/// 失败即拒绝，诊断「Location 非法」。
#[test]
fn download_rejects_unparsable_absolute_location() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "http://")]);
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("不可解析 Location 应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().contains("Location 非法"), "实际诊断：{err}");
    assert_eq!(received.try_iter().count(), 1, "不得发起第二跳");
}

/// 验收：重定向链恰在 `DOWNLOAD_REDIRECT_LIMIT + 1` 次请求后终止
/// （`0..=limit` 迭代），诊断携带跳数上限；第 7 跳请求不存在。
#[test]
fn download_redirect_chain_is_bounded_by_hop_limit() {
    let (local, received) =
        local_server(|_| vec![redirect("302 Found", "/again"); DOWNLOAD_REDIRECT_LIMIT + 1]);
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("超跳数上限应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    let shown = err.to_string();
    assert!(
        shown.contains(&format!("重定向超过 {DOWNLOAD_REDIRECT_LIMIT} 跳")),
        "实际诊断：{shown}"
    );
    assert_eq!(
        received.try_iter().count(),
        DOWNLOAD_REDIRECT_LIMIT + 1,
        "恰 6 次请求后终止"
    );
}

/// 验收（SSRF 核心）：重定向到非公网字面量（10.0.0.1——注入分类器下
/// 仍非公网）在下一跳请求发出之前被拒——逐跳复验不是首跳一次性检查。
#[test]
fn download_revalidates_each_hop_against_public_boundary() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "http://10.0.0.1/x.png")]);
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("重定向到非公网目标应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().contains("非公网"), "实际诊断：{err}");
    assert_eq!(received.try_iter().count(), 1, "拒绝发生在第二跳请求之前");
}

/// 验收：重定向到非 http(s) 协议（ftp——即便主机是公网 IP）逐跳拒绝。
#[test]
fn download_rejects_non_http_scheme_redirect() {
    let (local, received) = local_server(|_| vec![redirect("302 Found", "ftp://8.8.8.8/x.png")]);
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/start.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect_err("非 http(s) 重定向应拒绝");
    assert!(
        matches!(err, ProxyError::DownloadRefused { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().contains("协议非法"), "实际诊断：{err}");
    assert_eq!(received.try_iter().count(), 1, "不得发起第二跳");
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
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/missing.png"),
        test_deadline(),
        allow_loopback,
    ))
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
fn spawn_oversize_body(status_line: String) -> String {
    let declared = GENERATED_IMAGE_MAX_BYTES + 512 * 1024;
    let sent = GENERATED_IMAGE_MAX_BYTES + 64 * 1024;
    crate::testhttp::spawn_local_http(move |mut stream| {
        crate::testhttp::drain_request(&mut stream);
        let head = format!(
            "HTTP/1.1 {status_line}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&vec![0xAB; sent]);
        std::thread::sleep(Duration::from_secs(20));
    })
}

/// 超限错误的共用断言：[`ProxyError::Body`] 内层
/// [`crate::http_util::ReadBodyError::ResponseTooLarge`] 携带生产上限值，
/// 展示文案可诊断。预算收紧到 15 秒：等尾部的错误实现会先撞预算耗尽
/// （变体不同），与本变体可区分。
fn expect_oversize_abort(base: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let err = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{base}/big.png"),
        deadline,
        allow_loopback,
    ))
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
    let bytes = tauri::async_runtime::block_on(fetch_image_url_with(
        &format!("{local}/at-cap.png"),
        test_deadline(),
        allow_loopback,
    ))
    .expect("恰好达上限的响应体应完整返回");
    assert_eq!(bytes.len(), GENERATED_IMAGE_MAX_BYTES);
    assert_eq!(bytes[0], 0xCD);
}
