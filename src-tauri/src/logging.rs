//! Tauri owns stderr logging; libraries only emit records through the log facade (issue #633).
use env_logger::Builder;
use std::io::Write;

/// Installs the host sink once without replacing an embedding application's existing logger.
pub(crate) fn init() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".to_owned());
    let invalid_filter = !valid_filter(&filter);
    let _ = stderr_builder(&filter).try_init();
    if invalid_filter {
        log::warn!(target: "plotweave::logging", "code=invalid-log-filter");
    }
}

/// Builds the domain/level-filtered sink; issue #633 records carry level, target and message fields.
pub(crate) fn stderr_builder(filter: &str) -> Builder {
    let mut builder = Builder::new();
    builder
        .parse_filters(if valid_filter(filter) { filter } else { "warn" })
        .format(|buffer, record| {
            writeln!(
                buffer,
                "{}",
                serde_json::json!({
                    "level": record.level().as_str(),
                    "target": record.target(),
                    "message": record.args().to_string(),
                })
            )
        });
    builder
}

/// Validate without env_filter's compatibility stderr warnings, which can panic when stderr is a broken pipe.
fn valid_filter(filter: &str) -> bool {
    env_filter::Builder::new().try_parse(filter).is_ok()
}
