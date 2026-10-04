//! #136：使用虚构凭据和有界本机 HTTP 夹具验证真实 reqwest 请求/重定向。

use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::time::Instant;

const TEST_KEY: &str = "test-only-token";

/// 完整读取小型测试请求，避免仅收到头部时遗漏 POST 请求体。
fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0, "请求未完整到达");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 64 * 1024);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(|value| value.parse().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return String::from_utf8(bytes).unwrap();
            }
        }
    }
}

/// 多请求服务器补足 testhttp 的单次连接夹具；接受等待有界，不连接公网。
fn local_server(responses: Vec<String>) -> (String, Receiver<String>) {
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // BSD/macOS：accept 出的流继承监听器的非阻塞标志，
                        // CI 负载下首次 read 即可能 EAGAIN（WouldBlock）——
                        // 显式切回阻塞式，让 read_request 的读超时语义成立
                        stream.set_nonblocking(false).unwrap();
                        tx.send(read_request(&mut stream)).unwrap();
                        stream.write_all(response.as_bytes()).unwrap();
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

/// 线上 HTTP 报文夹具，连接关闭便于同源重定向独立采集每一跳。
fn response(status: &str, extra_headers: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\n{extra_headers}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    )
}

/// 经生产传输内核发请求；两个 endpoint 都使用相同的虚构输入。
fn post(base: &str, endpoint: &str) -> Result<reqwest::Response, ProxyError> {
    tauri::async_runtime::block_on(post_json(
        base,
        endpoint,
        TEST_KEY,
        &serde_json::json!({"model": "test-model"}),
        5,
    ))
}

#[test]
fn endpoint_policy_accepts_custom_https_and_explicit_loopback_only() {
    for base in [
        "https://custom.example/v1",
        "https://192.168.1.2/api",
        "http://localhost:8000/v1",
        "http://LOCALHOST:8000/v1",
        "http://127.0.0.1:8000/v1",
        "http://127.42.0.1/v1",
        "http://[::1]:8000/v1",
    ] {
        assert!(endpoint_url(base, "chat/completions").is_ok(), "{base}");
    }
    for base in [
        "http://remote.example/v1",
        "http://192.168.1.2/v1",
        "http://10.0.0.1/v1",
        "http://localhost.example/v1",
        "http://[::]/v1",
        "http://[::ffff:127.0.0.1]/v1",
        "ftp://localhost/v1",
        "file:///tmp/provider",
        "invalid",
    ] {
        assert!(
            matches!(
                endpoint_url(base, "images/generations"),
                Err(ProxyError::ProviderRefused { .. })
            ),
            "{base}"
        );
    }
}

#[test]
fn both_endpoints_reject_plaintext_before_connecting_and_allow_local_retry() {
    let blocked = TcpListener::bind("0.0.0.0:0").unwrap();
    blocked.set_nonblocking(true).unwrap();
    let base = format!("http://0.0.0.0:{}", blocked.local_addr().unwrap().port());
    for endpoint in ["chat/completions", "images/generations"] {
        assert!(matches!(
            post(&base, endpoint),
            Err(ProxyError::ProviderRefused { .. })
        ));
        assert_eq!(
            blocked.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (local, received) = local_server(vec![response("200 OK", "")]);
        assert!(post(&format!("{local}/v1/"), endpoint)
            .unwrap()
            .status()
            .is_success());
        let request = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.starts_with(&format!("POST /v1/{endpoint} HTTP/1.1")));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {TEST_KEY}")));
        let body: serde_json::Value =
            serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["model"], "test-model");
    }
}

#[test]
fn same_origin_redirect_preserves_bearer_and_post_body() {
    for status in ["307 Temporary Redirect", "308 Permanent Redirect"] {
        let (local, received) = local_server(vec![
            response(status, "Location: /next\r\n"),
            response("200 OK", ""),
        ]);
        assert!(post(&local, "chat/completions")
            .unwrap()
            .status()
            .is_success());
        let first = received.recv_timeout(Duration::from_secs(3)).unwrap();
        let next = received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(next.starts_with("POST /next HTTP/1.1"));
        assert!(next
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {TEST_KEY}")));
        assert_eq!(
            first.split("\r\n\r\n").nth(1),
            next.split("\r\n\r\n").nth(1)
        );
    }
}

#[test]
fn cross_port_redirect_does_not_restore_stripped_credentials() {
    let (target, received) = local_server(vec![response("200 OK", "")]);
    let (local, initial) = local_server(vec![response(
        "307 Temporary Redirect",
        &format!("Location: {target}/next\r\n"),
    )]);
    assert!(post(&local, "images/generations")
        .unwrap()
        .status()
        .is_success());
    assert!(initial
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .to_ascii_lowercase()
        .contains("authorization:"));
    let next = received.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(!next.to_ascii_lowercase().contains("authorization:"));
    assert!(next.starts_with("POST /next HTTP/1.1"));
}

#[test]
fn redirects_to_remote_http_are_rejected_without_connecting() {
    let target = TcpListener::bind("0.0.0.0:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!(
        "http://0.0.0.0:{}/next",
        target.local_addr().unwrap().port()
    );
    let (local, _received) = local_server(vec![response(
        "307 Temporary Redirect",
        &format!("Location: {location}\r\n"),
    )]);
    let error = post(&local, "chat/completions").unwrap_err();
    assert!(
        matches!(error, ProxyError::ProviderRefused { .. }),
        "{error:?}"
    );
    assert!(error.to_string().contains("HTTPS"));
    assert_eq!(
        target.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn https_history_forbids_downgrade_even_to_loopback() {
    let https = Url::parse("https://localhost:8443/v1").unwrap();
    for next in [
        "http://localhost:8443/next",
        "http://127.0.0.1/next",
        "http://[::1]/next",
    ] {
        assert!(
            validate_redirect(&Url::parse(next).unwrap(), std::slice::from_ref(&https)).is_err()
        );
    }
    let upgraded = Url::parse("https://relay.example/next").unwrap();
    assert!(validate_redirect(&upgraded, &[Url::parse("http://localhost/v1").unwrap()]).is_ok());
    assert!(validate_redirect(&upgraded, &[https]).is_ok());
}

#[test]
fn redirect_loops_remain_bounded_by_reqwest_default_limit() {
    let (local, received) = local_server(vec![
        response(
            "307 Temporary Redirect",
            "Location: /again\r\n"
        );
        11
    ]);
    let error = post(&local, "chat/completions").unwrap_err();
    assert!(matches!(error, ProxyError::Send { source, .. } if source.is_redirect()));
    assert_eq!(received.try_iter().count(), 11);
}
