//! 出站 HTTP 代理共享助手：`imagegen` 与 `prefs::llm_chat` 两个面向
//! provider 的代理共用的响应体流式限读内核（issue #15）。
//!
//! provider 响应属外部输入（信任边界）：异常/恶意 provider 的超大响应
//! 必须在物化前被拒——分块流式累加、超限立即中止且不落半截。限读内核
//! 单一真源，避免两份实现漂移。

/// 响应体限读错误（模块所属类型，issue #45 首片）：区分超限（携带
/// 上限）、读取超时、读取失败与 UTF-8 编码失败，底层 reqwest/UTF-8
/// 来源经 `source` 链保留，调用方在展示边界（Tauri 命令出口）转字符串。
#[derive(Debug)]
pub(crate) enum ReadBodyError {
    /// 响应体超过字节上限（携带 limit）——异常/恶意 provider 的超大
    /// 响应在物化前被拒。
    ResponseTooLarge { limit: usize },
    /// 读取阶段超时（总超时在 send 成功后才触发，如 provider 回完
    /// headers 后慢速滴流/挂起，issue #15）。
    ReadTimeout(reqwest::Error),
    /// 非超时的读取失败（连接中断、协议错误等）。
    Read(reqwest::Error),
    /// 响应体不是有效 UTF-8（文本读取路径）。
    InvalidUtf8(std::string::FromUtf8Error),
}

/// 展示边界契约：文案与历史 `format!` 输出逐字一致，前端可见诊断不变。
impl std::fmt::Display for ReadBodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadBodyError::ResponseTooLarge { limit } => {
                write!(f, "响应体超过 {limit} 字节上限")
            }
            ReadBodyError::ReadTimeout(e) => write!(f, "读取响应超时：{e}"),
            ReadBodyError::Read(e) => write!(f, "读取响应失败：{e}"),
            ReadBodyError::InvalidUtf8(e) => write!(f, "响应不是有效 UTF-8：{e}"),
        }
    }
}

impl std::error::Error for ReadBodyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ReadBodyError::ResponseTooLarge { .. } => None,
            ReadBodyError::ReadTimeout(e) | ReadBodyError::Read(e) => Some(e),
            ReadBodyError::InvalidUtf8(e) => Some(e),
        }
    }
}

/// 分块累加内核：超限立即中止且不落半截（可单测的纯函数）。
pub(crate) fn append_capped(
    buf: &mut Vec<u8>,
    chunk: &[u8],
    cap: usize,
) -> Result<(), ReadBodyError> {
    if buf.len() + chunk.len() > cap {
        return Err(ReadBodyError::ResponseTooLarge { limit: cap });
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// 有上限地流式读取响应体为 UTF-8 文本（非流式 JSON 主响应）。读取
/// 阶段的超时（总超时在 send 成功后才触发，如 provider 回完 headers
/// 后慢速滴流/挂起）单独分类，与一般读取失败可区分（issue #15）。
pub(crate) async fn read_text_capped(
    response: reqwest::Response,
    cap: usize,
) -> Result<String, ReadBodyError> {
    let mut resp = response;
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        if e.is_timeout() {
            ReadBodyError::ReadTimeout(e)
        } else {
            ReadBodyError::Read(e)
        }
    })? {
        append_capped(&mut buf, &chunk, cap)?;
    }
    String::from_utf8(buf).map_err(ReadBodyError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testhttp::{drain_request, spawn_local_http};
    use std::io::Write;
    use std::time::Duration;

    #[test]
    fn append_capped_rejects_oversize_without_partial_write() {
        let mut buf = vec![1u8, 2, 3];
        assert!(append_capped(&mut buf, &[4, 5], 10).is_ok());
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
        // 超限即拒：缓冲保持原状不落半截，错误变体携带上限供调用方区分
        let err = append_capped(&mut buf, &[6, 7, 8, 9, 10, 11], 10).unwrap_err();
        assert!(matches!(err, ReadBodyError::ResponseTooLarge { limit: 10 }));
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_capped_accepts_total_exactly_at_cap() {
        let mut buf = vec![0u8; 8];
        assert!(append_capped(&mut buf, &[9, 10], 10).is_ok());
        assert_eq!(buf.len(), 10);
    }

    /// 展示边界契约：变体 Display 文案须与既有前端可见错误逐字一致
    /// （Tauri 命令出口以 `to_string` 转换，issue #45 首片不改 IPC 形状）。
    #[test]
    fn oversize_display_matches_ipc_boundary_text() {
        assert_eq!(
            ReadBodyError::ResponseTooLarge { limit: 42 }.to_string(),
            "响应体超过 42 字节上限"
        );
    }

    /// 以短超时客户端请求夹具并把响应交给限读内核（真实传输路径）。
    async fn capped_read_from(
        base_url: &str,
        cap: usize,
        timeout: Duration,
    ) -> Result<String, ReadBodyError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("构造夹具客户端");
        let response = client.get(base_url).send().await.expect("夹具请求应发出");
        read_text_capped(response, cap).await
    }

    #[test]
    fn read_text_capped_returns_text_exactly_at_cap() {
        let body = "hello 画布";
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
        });
        let text = tauri::async_runtime::block_on(capped_read_from(
            &base_url,
            body.len(),
            Duration::from_secs(10),
        ))
        .expect("恰好达上限的合法 UTF-8 应成功");
        assert_eq!(text, "hello 画布");
    }

    #[test]
    fn read_text_capped_rejects_oversize_body_with_limit() {
        // cap=16、响应 32 字节：流式限读在物化前拒绝；客户端断开后夹具
        // 写端报错可忽略
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 32\r\n\r\n");
            let _ = stream.write_all(b"0123456789abcdef0123456789abcdef");
        });
        let err = tauri::async_runtime::block_on(capped_read_from(
            &base_url,
            16,
            Duration::from_secs(10),
        ))
        .unwrap_err();
        assert!(matches!(err, ReadBodyError::ResponseTooLarge { limit: 16 }));
        assert_eq!(err.to_string(), "响应体超过 16 字节上限");
        assert!(std::error::Error::source(&err).is_none());
    }

    #[test]
    fn read_text_capped_classifies_body_read_timeout_with_source() {
        // 只写响应头并保持连接：总超时在响应体读取阶段触发（issue #15）
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n",
            );
            std::thread::sleep(Duration::from_secs(10));
        });
        let err = tauri::async_runtime::block_on(capped_read_from(
            &base_url,
            1024,
            Duration::from_secs(1),
        ))
        .unwrap_err();
        assert!(
            matches!(err, ReadBodyError::ReadTimeout(_)),
            "实际错误：{err:?}"
        );
        assert!(
            err.to_string().starts_with("读取响应超时："),
            "实际文案：{err}"
        );
        assert!(
            std::error::Error::source(&err).is_some(),
            "超时来源应经 source 链保留"
        );
    }

    #[test]
    fn read_text_capped_classifies_read_failure_with_source() {
        // 头声明 64 字节但只发 10 字节即断开：非超时的传输中断
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n0123456789");
        });
        let err = tauri::async_runtime::block_on(capped_read_from(
            &base_url,
            1024,
            Duration::from_secs(10),
        ))
        .unwrap_err();
        assert!(matches!(err, ReadBodyError::Read(_)), "实际错误：{err:?}");
        assert!(
            err.to_string().starts_with("读取响应失败："),
            "实际文案：{err}"
        );
        assert!(
            std::error::Error::source(&err).is_some(),
            "读取失败来源应经 source 链保留"
        );
    }

    #[test]
    fn read_text_capped_classifies_invalid_utf8_with_source() {
        let base_url = spawn_local_http(move |mut stream| {
            drain_request(&mut stream);
            let _ =
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n\xFF\xFE\xFD\xFC");
        });
        let err = tauri::async_runtime::block_on(capped_read_from(
            &base_url,
            1024,
            Duration::from_secs(10),
        ))
        .unwrap_err();
        assert!(
            matches!(err, ReadBodyError::InvalidUtf8(_)),
            "实际错误：{err:?}"
        );
        assert!(
            err.to_string().starts_with("响应不是有效 UTF-8："),
            "实际文案：{err}"
        );
        let source = std::error::Error::source(&err).expect("编码失败来源应保留");
        assert!(source.is::<std::string::FromUtf8Error>());
    }
}
