//! Binding tests use a counted synthetic decrypt callback; no OS keychain or real key is accessed.
use super::*;

/// Mismatch or ambiguity must fail before decrypt, independent of model command family.
#[test]
fn mismatched_or_missing_configuration_never_opens_a_key() {
    let text = r#"{"providers":[{"id":"custom","baseUrl":"https://provider.example/v1","keyEnc":"opaque"}]}"#;
    for requested in [
        "https://other.example/v1",
        "http://localhost:8080/v1",
        "https://provider.example:8443/v1",
        "https://provider.example/other",
        "https://provider.example/v1?q=1",
    ] {
        assert!(from_text(text, "custom", requested, || panic!("must not decrypt")).is_err());
    }
    for invalid in [
        "{}",
        "[]",
        "bad-json",
        r#"{"providers":[{"id":"custom"}]}"#,
        r#"{"providers":[{"id":"custom","baseUrl":"https://provider.example/v1"},{"id":"custom","baseUrl":"https://provider.example/v1"}]}"#,
    ] {
        assert!(
            from_text(invalid, "custom", "https://provider.example/v1", || panic!(
                "must not decrypt"
            ))
            .is_err()
        );
    }
}

/// Configured custom HTTPS and explicit loopback HTTP remain supported; the trusted spelling wins.
#[test]
fn canonical_equivalence_preserves_configured_target_and_secret() {
    for (configured, requested) in [
        (
            "https://Custom.example:443/v1///",
            "https://custom.example/v1",
        ),
        (
            "http://localhost:8080/custom",
            "http://localhost:8080/custom/",
        ),
        ("http://127.0.0.1:80/v1", "http://127.0.0.1/v1"),
        ("http://[::1]:8080/v1", "http://[::1]:8080/v1"),
    ] {
        let text = serde_json::json!({"providers":[{"id":"custom","baseUrl":configured,"keyEnc":"opaque"}]}).to_string();
        let value = from_text(&text, "custom", requested, || Ok("synthetic".into())).unwrap();
        assert_eq!(value.base_url, configured);
        assert_eq!(value.key, "synthetic");
    }
}
