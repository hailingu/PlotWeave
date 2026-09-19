//! 通过生产命令注册和真实文件锁，验证 IPC 返回、主线程心跳以及实际持久化结果。

use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse};
use tauri::{AppHandle, Manager};

const WAIT: Duration = Duration::from_secs(10);
const HOLD: Duration = Duration::from_millis(400);
const RESPONSIVE: Duration = Duration::from_millis(150);

/// 在主线程建立真实运行时；测试线程只经主线程队列触发 invoke。
pub fn run() {
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.plotweave.invoke-test-{}", std::process::id());
    context.config_mut().app.windows.clear();
    let app = plotweave_lib::app_builder().build(context).unwrap();
    let dir = app.path().app_data_dir().unwrap();
    assert!(!dir.exists(), "测试目录必须是新的");
    fs::create_dir_all(&dir).unwrap();
    tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .visible(false)
    .build()
    .unwrap();
    let (done, result) = mpsc::channel();
    let test_dir = dir.clone();
    let mut started = false;
    app.run_return(move |app, event| {
        if matches!(event, tauri::RunEvent::Ready) && !started {
            started = true;
            let app = app.clone();
            let done = done.clone();
            let dir = test_dir.clone();
            std::thread::spawn(move || {
                let testing = app.clone();
                let result = std::thread::spawn(move || check_commands(&testing, &dir)).join();
                done.send(result).unwrap();
                app.exit(0);
            });
        }
    });
    fs::remove_dir_all(dir).unwrap();
    if let Err(panic) = result.recv_timeout(WAIT).unwrap() {
        std::panic::resume_unwind(panic);
    }
}

/// 分发生产 handler，独立记录回调耗时和异步结果；接收器不阻塞原生主线程。
fn dispatch(app: &AppHandle, command: &str, body: Value) -> (Receiver<Duration>, Receiver<Value>) {
    let window = app.get_webview_window("main").unwrap();
    let webview: &tauri::Webview = window.as_ref();
    let webview = webview.clone();
    let request = tauri::webview::InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: app.config().build.dev_url.clone().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: app.invoke_key().into(),
    };
    let (timed, timing) = mpsc::channel();
    let (respond, response) = mpsc::channel();
    app.run_on_main_thread(move || {
        let start = Instant::now();
        webview.on_message(
            request,
            Box::new(move |_, _, reply, _, _| {
                let result = match reply {
                    InvokeResponse::Ok(body) => json!({"ok": body.deserialize::<Value>().unwrap()}),
                    InvokeResponse::Err(error) => json!({"error": error.0}),
                };
                respond.send(result).unwrap();
            }),
        );
        timed.send(start.elapsed()).unwrap();
    })
    .unwrap();
    (timing, response)
}

/// 等待单次 IPC 完成，保留成功和失败两类 wire 结果供断言。
fn invoke(app: &AppHandle, command: &str, body: Value) -> Value {
    let (timing, response) = dispatch(app, command, body);
    let result = response.recv_timeout(WAIT).unwrap();
    timing.recv_timeout(WAIT).unwrap();
    result
}

/// 成功结果必须真实到达，不能把错误 JSON 当成通过的空数据。
fn success(app: &AppHandle, command: &str, body: Value) -> Value {
    let result = invoke(app, command, body);
    assert!(result.get("error").is_none(), "{command}: {result}");
    result["ok"].clone()
}

/// 与库事务相同的 flock 文件；独立句柄释放之前内核必须等待。
fn hold_library(dir: &Path) -> File {
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("library/.library-op.lock"))
        .unwrap();
    // SAFETY: fd 来自本作用域存活的 File；LOCK_EX 无指针参数。
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    lock
}

/// 受控锁竞争下记录主线程 invoke 占用与心跳延迟；先验证结果，再检查延迟。
fn contended(app: &AppHandle, dir: &Path, command: &str, body: Value) -> (Value, bool) {
    let lock = hold_library(dir);
    let release = std::thread::spawn(move || {
        std::thread::sleep(HOLD);
        drop(lock);
    });
    let (timing, response) = dispatch(app, command, body);
    std::thread::sleep(Duration::from_millis(30));
    let early = response.try_recv().ok();
    let (beat, heartbeat) = mpsc::channel();
    let scheduled = Instant::now();
    app.run_on_main_thread(move || beat.send(scheduled.elapsed()).unwrap())
        .unwrap();
    let latency = heartbeat.recv_timeout(WAIT).unwrap();
    let result = early
        .clone()
        .unwrap_or_else(|| response.recv_timeout(WAIT).unwrap());
    let dispatch_time = timing.recv_timeout(WAIT).unwrap();
    release.join().unwrap();
    assert!(early.is_none(), "等待文件锁的命令不得提前完成");
    assert!(result.get("error").is_none(), "{command}: {result}");
    println!("{command}: invoke={dispatch_time:?}, heartbeat={latency:?}, lock={HOLD:?}");
    (
        result["ok"].clone(),
        dispatch_time < RESPONSIVE && latency < RESPONSIVE,
    )
}

/// 库写入、媒体解析竞争同一文件锁；读回磁盘证明调度后事务仍完整完成。
fn check_commands(app: &AppHandle, dir: &Path) {
    success(app, "list_library_assets", json!({}));
    let (asset, imported) = contended(
        app,
        dir,
        "import_library_asset",
        json!({
            "name": "fixture.png", "mime": "image/png", "kind": "reference", "bytes": [1, 2, 3]
        }),
    );
    let id = &asset["id"];
    let (_, resolved) = contended(
        app,
        dir,
        "get_asset_media_url",
        json!({
            "scope": {"kind": "library"}, "assetId": id
        }),
    );
    let (updated, saved) = contended(
        app,
        dir,
        "update_library_asset",
        json!({
            "id": id, "patch": {"name": "after.png"}
        }),
    );
    assert_eq!(updated["name"], "after.png");
    let stored: Value =
        serde_json::from_slice(&fs::read(dir.join("library/library.json")).unwrap()).unwrap();
    assert_eq!(
        stored["assets"]["byId"][id.as_str().unwrap()]["name"],
        "after.png"
    );
    check_project_saves(app, dir);
    check_project_assets(app, id);
    check_library_overlap(app, dir, id);
    check_other_persistence(app, id);
    assert!(
        imported && resolved && saved,
        "阻塞文件锁等待不得占用 invoke 主线程"
    );
}

/// 两个并发补丁与媒体校验竞争库锁后，独立字段必须同时保留，诊断序号互异。
fn check_library_overlap(app: &AppHandle, dir: &Path, id: &Value) {
    let lock = hold_library(dir);
    let release = std::thread::spawn(move || {
        std::thread::sleep(HOLD);
        drop(lock);
    });
    let (first_time, first) = dispatch(
        app,
        "update_library_asset",
        json!({"id": id, "patch": {"name": "merged"}}),
    );
    let (second_time, second) = dispatch(
        app,
        "update_library_asset",
        json!({"id": id, "patch": {"tags": ["kept"]}}),
    );
    let (media_time, media) = dispatch(
        app,
        "get_asset_media_url",
        json!({"scope": {"kind": "library"}, "assetId": id}),
    );
    let first = first.recv_timeout(WAIT).unwrap();
    let second = second.recv_timeout(WAIT).unwrap();
    assert!(media.recv_timeout(WAIT).unwrap()["ok"].is_string());
    for time in [first_time, second_time, media_time] {
        assert!(time.recv_timeout(WAIT).unwrap() < RESPONSIVE);
    }
    release.join().unwrap();
    assert!(first["ok"]["diagnosticsRevision"].is_string());
    assert!(second["ok"]["diagnosticsRevision"].is_string());
    assert_ne!(
        first["ok"]["diagnosticsRevision"],
        second["ok"]["diagnosticsRevision"]
    );
    let stored = success(app, "list_library_assets", json!({}));
    let entry = &stored["assets"]["byId"][id.as_str().unwrap()];
    assert_eq!(entry["name"], "merged");
    assert_eq!(entry["tags"], json!(["kept"]));
}

/// 实际资产导入、预检、复制和删除经异步命令仍维护完整的自包含文件链。
fn check_project_assets(app: &AppHandle, library_id: &Value) {
    let project = success(app, "create_project", json!({"name": "assets"}));
    let id = &project["id"];
    let asset = success(
        app,
        "import_project_asset_from_library",
        json!({"id": id, "libraryAssetId": library_id}),
    );
    let normalized = success(
        app,
        "validate_project_asset",
        json!({"id": id, "asset": asset}),
    );
    assert_eq!(normalized["id"], asset["id"]);
    let url = success(
        app,
        "get_asset_media_url",
        json!({"scope": {"kind": "project", "projectId": id}, "assetId": asset["id"]}),
    );
    assert!(url.as_str().unwrap().starts_with("pwmedia:"));
    let assets = json!({"byId": {asset["id"].as_str().unwrap(): asset}});
    assert_eq!(
        success(
            app,
            "verify_project_assets",
            json!({"id": id, "assets": assets})
        ),
        json!([])
    );
    let copy = success(app, "create_project", json!({"name": "copy"}));
    success(
        app,
        "copy_project_assets",
        json!({"fromId": id, "toId": copy["id"]}),
    );
    assert_eq!(
        success(
            app,
            "verify_project_assets",
            json!({"id": copy["id"], "assets": assets})
        ),
        json!([])
    );
    for target in [id, &copy["id"]] {
        success(app, "delete_project", json!({"id": target}));
        assert!(invoke(app, "load_project", json!({"id": target}))["error"].is_string());
    }
}

/// 会话、设置、组及删除入口的 IPC 形状不变，失败仍显式返回领域诊断。
fn check_other_persistence(app: &AppHandle, asset_id: &Value) {
    let projects = success(app, "list_projects", json!({}));
    let id = &projects[0]["id"];
    let session = json!({"schemaVersion": 1, "entries": []});
    success(
        app,
        "save_ai_session",
        json!({"id": id, "session": session}),
    );
    assert_eq!(
        success(app, "load_ai_session", json!({"id": id}))["session"],
        session
    );
    let prefs = json!({"providers": [], "defaultChat": null});
    success(app, "save_prefs", json!({"prefs": prefs}));
    assert_eq!(success(app, "load_prefs", json!({})), prefs);
    assert!(invoke(
        app,
        "set_provider_key",
        json!({"providerId": "", "key": ""})
    )["error"]
        .is_string());
    let group = json!({"id": "lg-fixture", "name": "fixture", "kind": "reference"});
    assert_eq!(
        success(app, "upsert_library_group", json!({"group": group}))["id"],
        "lg-fixture"
    );
    success(app, "delete_library_group", json!({"id": "lg-fixture"}));
    success(app, "delete_library_asset", json!({"id": asset_id}));
    let listed = success(app, "list_library_assets", json!({}));
    assert!(listed["assets"]["byId"].as_object().unwrap().is_empty());
    assert!(listed["groups"]["byId"].as_object().unwrap().is_empty());
}

/// 保存依赖链和失败重试必须跨 IPC 与磁盘一致；无效保存不得覆盖既有内容。
fn check_project_saves(app: &AppHandle, dir: &Path) {
    let project = success(app, "create_project", json!({"name": "before"}));
    let id = &project["id"];
    let mut doc = success(app, "load_project", json!({"id": id}));
    for name in ["first", "second"] {
        doc["project"]["name"] = json!(name);
        success(app, "save_project", json!({"id": id, "doc": doc}));
    }
    doc["project"]["name"] = json!("");
    assert!(invoke(app, "save_project", json!({"id": id, "doc": doc}))["error"].is_string());
    let stored: Value = serde_json::from_slice(
        &fs::read(dir.join(format!("projects/{}.json", id.as_str().unwrap()))).unwrap(),
    )
    .unwrap();
    assert_eq!(stored["project"]["name"], "second");
    doc["project"]["name"] = json!("retry");
    success(app, "save_project", json!({"id": id, "doc": doc}));
    let loaded = success(app, "load_project", json!({"id": id}));
    assert_eq!(loaded["project"]["name"], "retry");
}
