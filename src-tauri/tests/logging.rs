//! Issue #633: parsed diagnostic records, filtering and sink failures are observable contracts.
#[path = "../src/logging.rs"]
mod logging;

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::io::{self, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

/// Captures actual formatted bytes without changing the process-global logger.
struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A real failing writer proves logging was attempted rather than filtered out or skipped.
struct BrokenSink(Arc<AtomicUsize>);
impl Write for BrokenSink {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(io::Error::from(io::ErrorKind::BrokenPipe))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Emits a fixture diagnostic code through the actual logger, including level and target metadata.
fn emit(logger: &env_logger::Logger, level: Level, target: &str) {
    logger.log(
        &Record::builder()
            .args(format_args!("code=fixture-diagnostic"))
            .level(level)
            .target(target)
            .build(),
    );
}

/// Issue #633's JSON schema and domain filter preserve a machine code without freezing ordinary prose.
#[test]
fn records_are_structured_and_filtered_by_domain_and_level() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let logger = logging::stderr_builder("warn,plotweave::store=debug")
        .target(env_logger::Target::Pipe(Box::new(Capture(bytes.clone()))))
        .build();
    emit(&logger, Level::Debug, "plotweave::store");
    emit(&logger, Level::Debug, "plotweave::prefs");
    emit(&logger, Level::Warn, "plotweave::prefs");
    emit(&logger, Level::Trace, "plotweave::store");
    let output = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    let records: Vec<serde_json::Value> = output
        .lines()
        .map(|line| serde_json::from_str(line).expect("diagnostic record must parse as JSON"))
        .collect();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["level"], "DEBUG");
    assert_eq!(records[0]["target"], "plotweave::store");
    assert_eq!(records[0]["message"], "code=fixture-diagnostic");
    assert_eq!(records[1]["level"], "WARN");
    assert_eq!(records[1]["target"], "plotweave::prefs");
}

/// The ordinary default permits warning/error diagnostics while debug remains explicitly opt-in.
#[test]
fn warning_filter_retains_failures_and_hides_debug() {
    for filter in ["warn", "plotweave::store=INVALID_LEVEL"] {
        let logger = logging::stderr_builder(filter).build();
        for (level, expected) in [
            (Level::Error, true),
            (Level::Warn, true),
            (Level::Info, false),
            (Level::Debug, false),
        ] {
            assert_eq!(
                logger.enabled(
                    &Metadata::builder()
                        .level(level)
                        .target("plotweave::store")
                        .build()
                ),
                expected
            );
        }
    }
}

/// BrokenPipe cannot turn best-effort diagnostics into an operation panic.
#[test]
fn sink_write_failure_is_non_panicking() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let logger = logging::stderr_builder("warn")
        .target(env_logger::Target::Pipe(Box::new(BrokenSink(
            attempts.clone(),
        ))))
        .build();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        emit(&logger, Level::Error, "plotweave::native_quit")
    }));
    assert!(result.is_ok());
    assert!(attempts.load(Ordering::SeqCst) > 0);
}

/// A caller-installed logger remains authoritative, including its existing global maximum level.
#[test]
fn initialization_preserves_an_existing_logger() {
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    struct Installed;
    impl Log for Installed {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            metadata.target() == "fixture::installed"
        }
        fn log(&self, record: &Record<'_>) {
            if self.enabled(record.metadata()) {
                CALLS.fetch_add(1, Ordering::SeqCst);
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Installed = Installed;
    log::set_logger(&LOGGER).unwrap();
    log::set_max_level(LevelFilter::Trace);
    logging::init();
    logging::init();
    log::debug!(target: "fixture::installed", "code=existing-logger");
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
    assert_eq!(log::max_level(), LevelFilter::Trace);
}

/// Issue #633: invalid filter syntax and an actual EPIPE cannot turn sink initialization into a panic.
#[cfg(unix)]
#[test]
fn invalid_filter_with_broken_stderr_keeps_initialization_alive() {
    if std::env::var_os("PLOTWEAVE_LOG_FILTER_CHILD").as_deref() == Some(std::ffi::OsStr::new("1"))
    {
        // SAFETY: only this isolated child replaces stderr; stdout remains available for the success marker.
        unsafe {
            let mut fds = [0; 2];
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            assert_eq!(libc::dup2(fds[1], 2), 2);
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
        logging::init();
        println!("invalid-filter-initialized");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "invalid_filter_with_broken_stderr_keeps_initialization_alive",
            "--nocapture",
        ])
        .env("PLOTWEAVE_LOG_FILTER_CHILD", "1")
        .env("RUST_LOG", "plotweave::store=INVALID_LEVEL")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("invalid-filter-initialized"));
}
