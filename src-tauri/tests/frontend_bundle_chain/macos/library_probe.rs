use super::{decode_payload, evaluate, AppHandle, Duration, Instant, Path, Value, WebviewWindow};
use sha2::{Digest, Sha256};

/// Measures actual File import over the production Tauri bridge, then checks persisted bytes independently.
pub(super) fn run(window: &WebviewWindow, app: &AppHandle, dir: &Path) -> Result<(), String> {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("missing repository")?;
    let script =
        std::fs::read_to_string(repository.join("native/macos/build/library-import-probe.js"))
            .map_err(|e| e.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    evaluate(window, app, format!("{script}; 'PW_LIBRARY_PROBE_READY'"))?;
    evaluate(window, app, "window.__pwLibraryResult = null; PlotWeaveLibraryProbe.verifyFailureRecovery().then(() => window.__pwLibraryResult = {ok: true}, error => window.__pwLibraryResult = {error: String(error)}); 'started'".into())?;
    let recovery = wait(window, app)?;
    if recovery["ok"] != true {
        return Err(format!("commit failure recovery failed: {recovery}"));
    }
    let files = match std::fs::read_dir(dir.join("library/assets")) {
        Ok(files) => files.count(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.to_string()),
    };
    if files != 0 {
        return Err("failed upload left media files".into());
    }
    for size in [10, 20] {
        evaluate(
            window,
            app,
            format!(
                r#"
            window.__pwLibraryResult = null;
            PlotWeaveLibraryProbe.measure({size}).then(
              result => window.__pwLibraryResult = {{ok: result}},
              error => window.__pwLibraryResult = {{error: String(error)}}
            ); 'started'
        "#
            ),
        )?;
        let result = wait(window, app)?;
        if !result["error"].is_null() {
            return Err(format!("library probe failed: {}", result["error"]));
        }
        let result = &result["ok"];
        let relative = result["asset"]["relPath"]
            .as_str()
            .ok_or("missing asset path")?;
        let bytes = std::fs::read(dir.join("library").join(relative)).map_err(|e| e.to_string())?;
        if Some(bytes.len() as u64) != result["bytes"].as_u64()
            || Some(
                Sha256::digest(&bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
                    .as_str(),
            ) != result["sha256"].as_str()
        {
            return Err("library probe media bytes differ".into());
        }
        if result["ticks"].as_u64().unwrap_or(0) <= 1
            || result["maxTimerGapMs"].as_f64().unwrap_or(f64::INFINITY) >= 1000.0
        {
            return Err(format!(
                "library probe responsiveness budget exceeded: {result}"
            ));
        }
        println!("PW-LIBRARY-PROBE host=tauri result={result}");
    }
    Ok(())
}

/// A bounded poll observes the asynchronous page operation without blocking its event loop.
fn wait(window: &WebviewWindow, app: &AppHandle) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let result = decode_payload(&evaluate(
            window,
            app,
            "JSON.stringify(window.__pwLibraryResult)".into(),
        )?)?;
        if !result.is_null() {
            return Ok(result);
        }
        if Instant::now() >= deadline {
            return Err("library probe timeout".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
