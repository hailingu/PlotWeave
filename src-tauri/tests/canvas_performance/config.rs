//! Tauri 性能测量的登记规模与本机 URL 边界（issue #572）。

/// 与 canvasPerfFixture 和 Swift 性能套件一致的登记规模。
pub const SCALES: [u32; 3] = [100, 500, 1000];

/// 计算登记规模的预期边数；调用方先经 perf_url 或 SCALES 校验规模。
pub fn expected_edges(scale: u32) -> u32 {
    scale / 10 * 9 - 1
}

/// 构造本机 HTTP 性能页 URL；拒绝远端、凭据和未登记规模。
pub fn perf_url(base: &str, scale: u32) -> Result<tauri::Url, String> {
    if !SCALES.contains(&scale) {
        return Err(format!("PW_PERF_SCALE_UNSUPPORTED:{scale}"));
    }
    let mut url =
        tauri::Url::parse(base).map_err(|error| format!("PW_PERF_URL_INVALID:{error}"))?;
    let loopback = url
        .host_str()
        .map(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|address| address.is_loopback())
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if url.scheme() != "http" || !loopback || !url.username().is_empty() || url.password().is_some()
    {
        return Err("PW_PERF_URL_LOOPBACK_REQUIRED".to_string());
    }
    url.set_fragment(Some(&format!("perf:{scale}")));
    Ok(url)
}
