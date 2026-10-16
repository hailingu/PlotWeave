//! 页面 evaluation 与 CanvasPerfScriptResult 的边界校验和 PW-PERF 证据格式。

use serde_json::Value;

use crate::config;

/// 解析 Wry 序列化的 evaluation 信封；空载荷和页面错误均显式失败。
pub fn parse_envelope(payload: &str) -> Result<Value, String> {
    if payload.trim().is_empty() {
        return Err("PW_PERF_EVALUATION_EMPTY".to_string());
    }
    let value: Value = serde_json::from_str(payload)
        .map_err(|error| format!("PW_PERF_EVALUATION_INVALID:{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "PW_PERF_ENVELOPE_NOT_OBJECT".to_string())?;
    if object.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value);
    }
    let detail = object
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("PW_PERF_EVALUATION_FAILED");
    Err(detail.to_string())
}

/// 校验报告确实来自目标夹具且四阶段交互产生了可观察效果。
pub fn validate_report(report: &Value, scale: u32) -> Result<(), String> {
    if report["version"].as_u64() != Some(1) {
        return Err("PW_PERF_REPORT_VERSION".to_string());
    }
    if report["nodeCount"].as_u64() != Some(u64::from(scale))
        || report["edgeCount"].as_u64() != Some(u64::from(config::expected_edges(scale)))
    {
        return Err("PW_PERF_REPORT_FIXTURE_MISMATCH".to_string());
    }
    if report["visibleNodeCount"].as_u64().unwrap_or(0) == 0 {
        return Err("PW_PERF_REPORT_NOT_VISIBLE".to_string());
    }
    validate_viewport(&report["viewport"])?;
    validate_phases(&report["phases"])?;
    validate_frames(&report["total"])?;
    for effect in ["draggedNodeMovedPx", "panTranslatePx", "zoomTravel"] {
        if report["effects"][effect].as_f64().unwrap_or(0.0) <= 0.0 {
            return Err(format!("PW_PERF_EFFECT_MISSING:{effect}"));
        }
    }
    Ok(())
}

/// 输出与 Swift 证据行同口径的 Tauri common-web 机器可读记录。
pub fn evidence_line(
    scale: u32,
    mount_ms: f64,
    report: &Value,
    before: &str,
    after: &str,
) -> Result<String, String> {
    validate_report(report, scale)?;
    let viewport = &report["viewport"];
    let mut phases = String::new();
    for phase in report["phases"].as_array().unwrap_or(&Vec::new()) {
        let kind = phase["kind"].as_str().unwrap_or("unknown");
        let frames = &phase["frames"];
        phases.push_str(&format!(
            "{kind}[p50={} p95={} max={} over16={} over33={}] ",
            ms(&frames["p50Ms"]),
            ms(&frames["p95Ms"]),
            ms(&frames["maxMs"]),
            integer(&frames["over16Ms"]),
            integer(&frames["over33Ms"])
        ));
    }
    let total = &report["total"];
    let long_tasks = long_tasks_text(&report["longTasks"]);
    Ok(format!(
        "PW-PERF host=tauri mode=common-web scale={scale} mountToNodes={:.0}ms visible={} viewport={}x{}@{} total[samples={} p50={} p95={} max={} over16={}] {}longTasks={} mem[{} -> {}]",
        mount_ms,
        integer(&report["visibleNodeCount"]),
        number(&viewport["width"]),
        number(&viewport["height"]),
        number(&viewport["devicePixelRatio"]),
        integer(&total["samples"]),
        ms(&total["p50Ms"]),
        ms(&total["p95Ms"]),
        ms(&total["maxMs"]),
        integer(&total["over16Ms"]),
        phases,
        long_tasks,
        before,
        after
    ))
}

fn validate_viewport(viewport: &Value) -> Result<(), String> {
    for field in ["width", "height", "devicePixelRatio"] {
        if viewport[field].as_f64().unwrap_or(0.0) <= 0.0 {
            return Err(format!("PW_PERF_VIEWPORT_INVALID:{field}"));
        }
    }
    Ok(())
}

fn validate_phases(phases: &Value) -> Result<(), String> {
    let phases = phases
        .as_array()
        .ok_or_else(|| "PW_PERF_PHASES_INVALID".to_string())?;
    let expected = ["drag", "pan", "zoom", "panel"];
    if phases.len() != expected.len() {
        return Err("PW_PERF_PHASES_INCOMPLETE".to_string());
    }
    for (phase, kind) in phases.iter().zip(expected) {
        if phase["kind"].as_str() != Some(kind) {
            return Err("PW_PERF_PHASE_ORDER".to_string());
        }
        validate_frames(&phase["frames"]).map_err(|error| format!("{error}:{kind}"))?;
    }
    Ok(())
}

fn validate_frames(frames: &Value) -> Result<(), String> {
    let samples = frames["samples"].as_u64();
    if samples.is_none() || samples == Some(0) {
        return Err("PW_PERF_FRAMES_MISSING".to_string());
    }
    for field in ["p50Ms", "p95Ms"] {
        if frames[field].as_f64().is_none() {
            return Err(format!("PW_PERF_FRAME_STAT_INVALID:{field}"));
        }
    }
    for field in ["maxMs", "over16Ms", "over33Ms"] {
        if frames[field].as_f64().is_none() {
            return Err(format!("PW_PERF_FRAME_STAT_INVALID:{field}"));
        }
    }
    Ok(())
}

fn ms(value: &Value) -> String {
    value
        .as_f64()
        .map(|number| format!("{number:.1}"))
        .unwrap_or_else(|| "n/a".to_string())
}

fn integer(value: &Value) -> String {
    value
        .as_u64()
        .map(|number| number.to_string())
        .unwrap_or_else(|| "n/a".to_string())
}

fn number(value: &Value) -> String {
    value
        .as_f64()
        .map(|number| number.to_string())
        .unwrap_or_else(|| "n/a".to_string())
}

fn long_tasks_text(value: &Value) -> String {
    if value.is_null() {
        return "null".to_string();
    }
    format!(
        "[samples={} max={}]",
        integer(&value["samples"]),
        ms(&value["maxMs"])
    )
}
