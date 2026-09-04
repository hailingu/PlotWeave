//! 出站 HTTP 代理共享助手：`imagegen` 与 `prefs::llm_chat` 两个面向
//! provider 的代理共用的响应体流式限读内核（issue #15）。
//!
//! provider 响应属外部输入（信任边界）：异常/恶意 provider 的超大响应
//! 必须在物化前被拒——分块流式累加、超限立即中止且不落半截。限读内核
//! 单一真源，避免两份实现漂移。

/// 分块累加内核：超限立即中止且不落半截（可单测的纯函数）。
pub(crate) fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if buf.len() + chunk.len() > cap {
        return Err(format!("响应体超过 {cap} 字节上限"));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// 有上限地流式读取响应体为 UTF-8 文本（非流式 JSON 主响应）。
pub(crate) async fn read_text_capped(
    response: reqwest::Response,
    cap: usize,
) -> Result<String, String> {
    let mut resp = response;
    let mut buf = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?
    {
        append_capped(&mut buf, &chunk, cap)?;
    }
    String::from_utf8(buf).map_err(|e| format!("响应不是有效 UTF-8：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_capped_rejects_oversize_without_partial_write() {
        let mut buf = vec![1u8, 2, 3];
        assert!(append_capped(&mut buf, &[4, 5], 10).is_ok());
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
        // 超限即拒：缓冲保持原状，不落半截
        assert!(append_capped(&mut buf, &[6, 7, 8, 9, 10, 11], 10).is_err());
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_capped_accepts_total_exactly_at_cap() {
        let mut buf = vec![0u8; 8];
        assert!(append_capped(&mut buf, &[9, 10], 10).is_ok());
        assert_eq!(buf.len(), 10);
    }
}
