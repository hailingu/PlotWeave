//! 真实 Tauri/Wry 宿主的一轮性能测量：页面就绪、脚本交互、内存与证据输出。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::cleanup::OwnedAppDataDir;
use crate::{config, memory, report};

const HOST_TIMEOUT: Duration = Duration::from_secs(120);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_TIMEOUT: Duration = Duration::from_secs(100);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const NAVIGATION_CLOCK: &str = "window.__pwPerfNavigationAt = performance.now();";
const RESULT_POLL_SCRIPT: &str = "window.__pwPerfEvaluation ?? null";
const READY_SCRIPT: &str = r#"
window.__pwPerfEvaluation = null;
(async () => {
  try {
    const navigationAt = window.__pwPerfNavigationAt;
    if (!Number.isFinite(navigationAt)) throw new Error('PW_PERF_NAVIGATION_CLOCK_MISSING');
    const expectedNodes = __PW_NODES__;
    const expectedEdges = __PW_EDGES__;
    const deadline = performance.now() + 90000;
    let counts = 'n/a';
    while (performance.now() < deadline) {
      const nodes = document.querySelectorAll('.react-flow__node').length;
      const edges = document.querySelectorAll('.react-flow__edge').length;
      counts = `${nodes}/${edges}`;
      if (nodes === expectedNodes && edges === expectedEdges) {
        if (typeof window.__pwRunCanvasPerf !== 'function') throw new Error('PW_PERF_RUNNER_MISSING');
        const mountToNodesMs = performance.now() - navigationAt;
        await new Promise(resolve => setTimeout(resolve, 300));
        window.__pwPerfEvaluation = { ok: true, mountToNodesMs };
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`PW_PERF_FIXTURE_TIMEOUT:${counts}`);
  } catch (error) {
    window.__pwPerfEvaluation = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
})();
'PW_PERF_STARTED'
"#;
const MEASURE_SCRIPT: &str = r#"
window.__pwPerfEvaluation = null;
(async () => {
  try {
    if (typeof window.__pwRunCanvasPerf !== 'function') throw new Error('PW_PERF_RUNNER_MISSING');
    const report = await window.__pwRunCanvasPerf();
    window.__pwPerfEvaluation = { ok: true, report };
  } catch (error) {
    window.__pwPerfEvaluation = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
})();
'PW_PERF_STARTED'
"#;

/// 在独立应用身份和数据根中执行一个规模，返回可传给进程的退出码。
pub fn run_child(scale: u32) -> i32 {
    let url = match config::perf_url(
        &std::env::var("PLOTWEAVE_CANVAS_PERF_URL").unwrap_or_default(),
        scale,
    ) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("PW-PERF-ERROR host=tauri scale={scale} error={error}");
            return 1;
        }
    };
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.plotweave.canvas-perf-{}", std::process::id());
    context.config_mut().app.windows.clear();
    let app = plotweave_lib::app_builder().build(context).unwrap();
    let dir = app.path().app_data_dir().unwrap();
    let mut owned_dir = OwnedAppDataDir::create_new(dir);
    let baseline = memory::web_content_pids();
    let started = Arc::new(AtomicBool::new(false));
    let status = Arc::new(AtomicI32::new(5));
    let page_status = status.clone();
    let page_app = app.handle().clone();
    WebviewWindow::builder(&app, "canvas-perf", tauri::WebviewUrl::External(url))
        .title("PlotWeave canvas performance")
        .inner_size(1280.0, 860.0)
        .center()
        .always_on_top(true)
        .visible(true)
        .focused(true)
        .initialization_script(NAVIGATION_CLOCK)
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished)
                || started.swap(true, Ordering::SeqCst)
            {
                return;
            }
            let worker_app = page_app.clone();
            let worker_status = page_status.clone();
            let worker_baseline = baseline.clone();
            std::thread::spawn(move || {
                measure(window, worker_app, worker_baseline, scale, worker_status)
            });
        })
        .build()
        .unwrap();
    let timeout_app = app.handle().clone();
    let timeout_status = status.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HOST_TIMEOUT);
        timeout_status.store(4, Ordering::SeqCst);
        eprintln!("PW-PERF-ERROR host=tauri scale={scale} error=PW_PERF_HOST_TIMEOUT");
        timeout_app.exit(4);
    });
    let _ = app.run_return(|_, _| {});
    owned_dir.remove_now();
    let code = status.load(Ordering::SeqCst);
    if code == 5 {
        eprintln!("PW-PERF-ERROR host=tauri scale={scale} error=PW_PERF_RUN_INCOMPLETE");
    }
    code
}

fn measure(
    window: WebviewWindow,
    app: AppHandle,
    baseline: HashSet<i32>,
    scale: u32,
    status: Arc<AtomicI32>,
) {
    match measure_result(&window, &app, &baseline, scale) {
        Ok(line) => {
            println!("{line}");
            status.store(0, Ordering::SeqCst);
            app.exit(0);
        }
        Err(error) => fail(&app, scale, &status, &error),
    }
}

fn measure_result(
    window: &WebviewWindow,
    app: &AppHandle,
    baseline: &HashSet<i32>,
    scale: u32,
) -> Result<String, String> {
    let ready_script = READY_SCRIPT
        .replace("__PW_NODES__", &scale.to_string())
        .replace("__PW_EDGES__", &config::expected_edges(scale).to_string());
    let ready = run_async_script(window, app, &ready_script)?;
    let mount_ms = ready["mountToNodesMs"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| "PW_PERF_MOUNT_INVALID".to_string())?;
    let tracked = memory::page_web_content_pids(baseline)?;
    let before = memory::sample(&tracked)?;
    let envelope = run_async_script(window, app, MEASURE_SCRIPT)?;
    let after = memory::sample(&tracked)?;
    report::evidence_line(
        scale,
        mount_ms,
        &envelope["report"],
        &before.description(),
        &after.description(),
    )
}

fn run_async_script(
    window: &WebviewWindow,
    app: &AppHandle,
    script: &str,
) -> Result<Value, String> {
    let started = evaluate(window, app, script.to_string())?;
    if started.trim().is_empty() {
        return Err("PW_PERF_EVALUATION_EMPTY".to_string());
    }
    poll_result(window, app)
}

fn poll_result(window: &WebviewWindow, app: &AppHandle) -> Result<Value, String> {
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        let payload = evaluate(window, app, RESULT_POLL_SCRIPT.to_string())?;
        if payload.trim().is_empty() {
            return Err("PW_PERF_EVALUATION_EMPTY".to_string());
        }
        if payload != "null" {
            return report::parse_envelope(&payload);
        }
        if Instant::now() >= deadline {
            return Err("PW_PERF_HOST_POLL_TIMEOUT".to_string());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn evaluate(window: &WebviewWindow, app: &AppHandle, script: String) -> Result<String, String> {
    let (send, receive) = mpsc::channel();
    let window = window.clone();
    app.run_on_main_thread(move || {
        let callback_send = send.clone();
        if let Err(error) = window.eval_with_callback(script, move |payload| {
            let _ = callback_send.send(Ok(payload));
        }) {
            let _ = send.send(Err(format!("PW_PERF_EVAL_DISPATCH:{error}")));
        }
    })
    .map_err(|error| format!("PW_PERF_MAIN_THREAD_DISPATCH:{error}"))?;
    receive
        .recv_timeout(EVAL_TIMEOUT)
        .map_err(|error| format!("PW_PERF_EVAL_TIMEOUT:{error}"))?
}

fn fail(app: &AppHandle, scale: u32, status: &AtomicI32, error: &str) {
    let single_line = error.replace(['\r', '\n'], " ");
    eprintln!("PW-PERF-ERROR host=tauri scale={scale} error={single_line}");
    status.store(1, Ordering::SeqCst);
    app.exit(1);
}
