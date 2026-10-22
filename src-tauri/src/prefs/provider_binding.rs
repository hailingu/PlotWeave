//! Persisted provider identity binds both first-hop destination and the transient secret (#653).

/// Backend-only values deliberately have no serialization or Debug implementation.
pub(crate) struct ProviderCredential {
    /// Destination comes from the settings snapshot that supplied the envelope.
    pub(crate) base_url: String,
    /// Plaintext exists only during the request and never returns over IPC.
    pub(crate) key: String,
}

/// Validate a unique configured destination before any decrypt/keychain callback can run.
pub(super) fn from_text(
    text: &str,
    provider_id: &str,
    requested: &str,
    load_key: impl FnOnce() -> Result<String, String>,
) -> Result<ProviderCredential, String> {
    let prefs: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| "设置文件损坏，无法确认 provider 服务配置".to_string())?;
    let mut entries = prefs
        .get("providers")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter(|v| v.get("id").and_then(|v| v.as_str()) == Some(provider_id));
    let entry = entries
        .next()
        .ok_or("缺少 provider 服务配置，请重新保存设置")?;
    if entries.next().is_some() {
        return Err("provider 服务配置重复，请重新保存设置".into());
    }
    let configured = entry
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .ok_or("缺少 provider 服务地址，请重新保存设置")?;
    let canonical =
        |base: &str| crate::provider_transport::endpoint_url(base, "").map_err(|e| e.to_string());
    if canonical(configured)? != canonical(requested)? {
        return Err("服务地址与已保存的 provider 配置不一致，请重新加载设置".into());
    }
    Ok(ProviderCredential {
        base_url: configured.to_string(),
        key: load_key()?,
    })
}

#[cfg(test)]
mod tests;
