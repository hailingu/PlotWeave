//! Tauri 同夹具性能测量的纯合同回归；真实 Wry 测量由 canvas_performance 显式启用。

#[path = "canvas_performance/attribution.rs"]
mod attribution;
#[path = "canvas_performance/config.rs"]
mod config;
#[path = "canvas_performance/report.rs"]
mod report;

use serde_json::{json, Value};

fn frames(samples: u64) -> Value {
    json!({
        "samples": samples,
        "avgMs": 17.0,
        "p50Ms": 17.0,
        "p95Ms": 18.0,
        "maxMs": 20.0,
        "over16Ms": samples,
        "over33Ms": 0
    })
}

fn valid_report(scale: u32) -> Value {
    let kinds = ["drag", "pan", "zoom", "panel"];
    let phases: Vec<Value> = kinds
        .into_iter()
        .map(|kind| json!({"kind": kind, "wallMs": 500.0, "frames": frames(30)}))
        .collect();
    json!({
        "version": 1,
        "nodeCount": scale,
        "edgeCount": scale / 10 * 9 - 1,
        "visibleNodeCount": 18,
        "viewport": {"width": 1280, "height": 860, "devicePixelRatio": 2},
        "phases": phases,
        "total": frames(263),
        "effects": {"draggedNodeMovedPx": 240.0, "panTranslatePx": 560.0, "zoomTravel": 0.4},
        "longTasks": null,
        "durationMs": 3600.0
    })
}

#[test]
fn perf_url_registers_every_supported_scale_and_script_options_match_swift() {
    for scale in config::SCALES {
        let url = config::perf_url("http://127.0.0.1:4173/native-canvas.html", scale).unwrap();
        assert_eq!(
            url.as_str(),
            format!("http://127.0.0.1:4173/native-canvas.html#perf:{scale}")
        );
        assert_eq!(config::expected_edges(scale), scale / 10 * 9 - 1);
    }
    assert_eq!(
        config::script_options(),
        json!({
            "dragRounds": 2, "dragSteps": 20,
            "panRounds": 2, "panSteps": 20,
            "zoomRounds": 2, "zoomSteps": 16,
            "stepMs": 14, "settleMs": 250
        })
    );
}

#[test]
fn perf_url_rejects_unregistered_scales_and_non_loopback_hosts() {
    for base in [
        "https://example.com/native-canvas.html",
        "file:///tmp/native-canvas.html",
        "not a url",
    ] {
        assert!(config::perf_url(base, 100).is_err(), "accepted {base}");
    }
    assert!(config::perf_url("http://127.0.0.1:4173/native-canvas.html", 200).is_err());
}

#[test]
fn report_validation_rejects_wrong_fixture_and_incomplete_interaction() {
    let mut wrong_scale = valid_report(100);
    wrong_scale["nodeCount"] = json!(9);
    assert!(report::validate_report(&wrong_scale, 100).is_err());

    let mut missing_phase = valid_report(100);
    missing_phase["phases"].as_array_mut().unwrap().pop();
    assert!(report::validate_report(&missing_phase, 100).is_err());

    let mut no_effect = valid_report(100);
    no_effect["effects"]["draggedNodeMovedPx"] = json!(0);
    assert!(report::validate_report(&no_effect, 100).is_err());
}

#[test]
fn evaluation_envelope_requires_nonempty_success_payload() {
    assert!(report::parse_envelope("").is_err());
    assert!(report::parse_envelope("null").is_err());
    let error =
        report::parse_envelope(r#"{"ok":false,"error":"PW_PERF_TARGET_MISSING"}"#).unwrap_err();
    assert!(error.contains("PW_PERF_TARGET_MISSING"));
    let success = report::parse_envelope(r#"{"ok":true,"mountToNodesMs":12.5}"#).unwrap();
    assert_eq!(success["mountToNodesMs"], json!(12.5));
}

#[test]
fn evidence_line_preserves_the_versioned_pw_perf_machine_contract() {
    let line = report::evidence_line(100, 12.5, &valid_report(100), "app=1MB", "app=2MB").unwrap();
    for token in [
        "PW-PERF host=tauri mode=common-web scale=100",
        "mountToNodes=12ms",
        "viewport=1280x860@2",
        "total[samples=263",
        "drag[",
        "pan[",
        "zoom[",
        "panel[",
        "mem[app=1MB -> app=2MB]",
    ] {
        assert!(line.contains(token), "missing {token}: {line}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn memory_attribution_accepts_only_one_new_web_content_process() {
    use std::collections::HashSet;

    let baseline = HashSet::from([10, 11]);
    let one = attribution::new_page_pids(&baseline, &HashSet::from([10, 11, 12])).unwrap();
    assert_eq!(one, HashSet::from([12]));
    assert!(attribution::new_page_pids(&baseline, &baseline).is_err());
    assert!(attribution::new_page_pids(&baseline, &HashSet::from([10, 11, 12, 13])).is_err());
}
