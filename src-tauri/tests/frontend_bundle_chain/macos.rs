//! 前端 bundle → IPC → Rust 命令 → 真实落盘 的全链路回归（issue #551）。
//! 与 invoke_responsiveness（Rust 侧构造 InvokeRequest 派发）方向相反：本
//! 用例起真实 Wry，经自注册 `pw-bundle://` scheme 从磁盘服务 `dist/` 真实
//! 构建产物（`is_local_url` 将已注册自定义 scheme 视为本地 origin，页面因此
//! 走与生产一致的本地 IPC 通道），断言三段链路：
//!
//! 1. 真实 bundle 生产启动链：首页 `tauriList` 空库播种——`list_projects`
//!    → `load_project`（预期 not found）→ `save_project` 落盘种子文档；
//! 2. 磁盘事实：`projects/sample-*.json` 由前端发起的调用真实写入；
//! 3. 页面 JS 显式驱动：经 `__TAURI_INTERNALS__.invoke`（与
//!    `@tauri-apps/api/core` invoke 同一传输层）执行 create/load/save/list
//!    往返并断言落盘与列表一致。
//!
//! 任一侧 IPC 参数形态漂移（如保存文档字段重命名不同步）都会使播种或保存
//! 失败进而令本用例失败。`dist/` 缺失时提示跳过（本地路由检查不强制先构建
//! 前端；CI 先 `npm run build` 保证用例必跑）。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::http::{Response, Uri};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewWindow};

#[path = "../invoke_responsiveness/cleanup.rs"]
mod cleanup;

use cleanup::OwnedAppDataDir;

const HOST_TIMEOUT: Duration = Duration::from_secs(180);
const EVAL_TIMEOUT: Duration = Duration::from_secs(15);
const STEP_TIMEOUT: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 测试专用 bundle scheme：不与 tauri/ipc/pwmedia 生产 scheme 冲突。
const BUNDLE_SCHEME: &str = "pw-bundle";
const BUNDLE_INDEX_URL: &str = "pw-bundle://localhost/index.html";

/// 阶段一探针：真实 bundle 是否完成生产启动并渲染出种子项目卡片；
/// 同时留痕 root 子元素数与 IPC 内部注入状态，超时诊断可区分
/// 「bundle 未执行」「执行但 IPC 失败」「渲染但列表为空」。
const HOME_PROBE_SCRIPT: &str = r#"JSON.stringify({
  cards: document.querySelectorAll('.project-card').length,
  root: (document.getElementById('root') || { childElementCount: -1 }).childElementCount,
  internals: typeof window.__TAURI_INTERNALS__
})"#;

/// 阶段三命令链：页面 JS 经 `__TAURI_INTERNALS__.invoke`（生产传输层，
/// macOS 上 fetch `http://ipc.localhost`，失败自动回退 postMessage）执行
/// create → load → save（改名）→ list 往返；结果写入全局变量供宿主轮询。
const CHAIN_SCRIPT: &str = r#"
window.__pwChainResult = null;
(async () => {
  const describe = (error) =>
    error instanceof Error ? error.message
      : typeof error === 'string' ? error : JSON.stringify(error);
  const fail = (step, error) => {
    window.__pwChainResult = { ok: false, step, error: describe(error) };
  };
  try {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    if (typeof invoke !== 'function') {
      fail('internals', 'PW_CHAIN_INTERNALS_MISSING');
      return;
    }
    const created = await invoke('create_project', { name: '链路用例' });
    if (created === null || typeof created !== 'object' || typeof created.id !== 'string') {
      fail('create_project', `id 缺失：${JSON.stringify(created)}`);
      return;
    }
    const doc = await invoke('load_project', { id: created.id });
    doc.project.name = '链路改名';
    await invoke('save_project', { id: created.id, doc });
    const listed = await invoke('list_projects', {});
    const entry = Array.isArray(listed) ? listed.find((item) => item.id === created.id) : null;
    if (!entry || entry.name !== '链路改名') {
      fail('list_projects', `列表缺新名：${JSON.stringify(listed)}`);
      return;
    }
    window.__pwChainResult = { ok: true, id: created.id };
  } catch (error) {
    fail('invoke', error);
  }
})();
'PW_CHAIN_STARTED'
"#;

const CHAIN_RESULT_SCRIPT: &str = "JSON.stringify(window.__pwChainResult ?? null)";

/// 子进程主体：真实 Wry + 真实 dist 产物 + 生产命令注册，跑完三段链路
/// 后返回退出码；建窗/断言失败由 RAII 守卫兜底清理本次应用目录。
pub fn run_child() -> i32 {
    let dist = dist_root();
    if !dist.join("index.html").is_file() {
        println!(
            "PW-CHAIN-SKIP dist 产物缺失：{}（先 npm run build 再跑本用例）",
            dist.display()
        );
        return 0;
    }
    let dist = Arc::new(dist);
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.plotweave.bundle-chain-{}", std::process::id());
    context.config_mut().app.windows.clear();
    let serving = Arc::clone(&dist);
    let app = plotweave_lib::app_builder()
        .register_uri_scheme_protocol(BUNDLE_SCHEME, move |_ctx, request| {
            serve_bundle(&serving, request.uri())
        })
        .build(context)
        .unwrap();
    let dir = app.path().app_data_dir().unwrap();
    // RAII 守卫（issue #277）：断言失败展开栈时仍清理本次新建目录。
    let mut owned_dir = OwnedAppDataDir::create_new(dir.clone());
    let started = Arc::new(AtomicBool::new(false));
    let status = Arc::new(AtomicI32::new(5));
    install_watchdog(app.handle().clone(), Arc::clone(&status));
    let page_app = app.handle().clone();
    let page_status = Arc::clone(&status);
    tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External(BUNDLE_INDEX_URL.parse().unwrap()),
    )
    .visible(false)
    .on_page_load(move |window, payload| {
        if !matches!(payload.event(), PageLoadEvent::Finished)
            || started.swap(true, Ordering::SeqCst)
        {
            return;
        }
        // 回调契约是 Fn（可能多次触发）：worker 独占的数据在 spawn 前
        // 克隆，不把捕获值按值移出闭包。
        let worker_app = page_app.clone();
        let worker_status = Arc::clone(&page_status);
        let worker_dir = dir.clone();
        std::thread::spawn(
            move || match run_chain_checks(&window, &worker_app, &worker_dir) {
                Ok(line) => {
                    println!("{line}");
                    worker_status.store(0, Ordering::SeqCst);
                    worker_app.exit(0);
                }
                Err(error) => fail(&worker_app, &worker_status, &error),
            },
        );
    })
    .build()
    .unwrap();
    let _ = app.run_return(|_, _| {});
    owned_dir.remove_now();
    let code = status.load(Ordering::SeqCst);
    if code == 5 {
        eprintln!("PW-CHAIN-ERROR host=tauri error=PW_CHAIN_RUN_INCOMPLETE");
    }
    code
}

/// 宿主级看门狗：事件循环意外卡死（页面不加载、worker 不返回）时以
/// 独立退出码终止，避免测试进程无限挂起。
fn install_watchdog(app: AppHandle, status: Arc<AtomicI32>) {
    std::thread::spawn(move || {
        std::thread::sleep(HOST_TIMEOUT);
        if status.load(Ordering::SeqCst) == 5 {
            eprintln!("PW-CHAIN-ERROR host=tauri error=PW_CHAIN_HOST_TIMEOUT");
            status.store(4, Ordering::SeqCst);
            app.exit(4);
        }
    });
}

/// 失败出口：单行诊断（保留 stderr 摘要可读）+ 非零退出。
fn fail(app: &AppHandle, status: &AtomicI32, error: &str) {
    let single_line = error.replace(['\r', '\n'], " ");
    eprintln!("PW-CHAIN-ERROR host=tauri error={single_line}");
    status.store(1, Ordering::SeqCst);
    app.exit(1);
}

/// 三段链路断言：真实渲染 → 真实播种落盘 → 页面侧显式命令往返。
fn run_chain_checks(window: &WebviewWindow, app: &AppHandle, dir: &Path) -> Result<String, String> {
    let cards = wait_home_rendered(window, app)?;
    assert_seed_persisted(dir)?;
    let id = run_page_chain(window, app, dir)?;
    Ok(format!("PW-CHAIN-OK host=tauri cards={cards} saved={id}"))
}

/// 阶段一：轮询首页 DOM，直到真实 bundle 渲染出两张种子项目卡片；
/// 超时返回最后一次探针快照以定位断链层级。
fn wait_home_rendered(window: &WebviewWindow, app: &AppHandle) -> Result<u64, String> {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let probe_result = evaluate(window, app, HOME_PROBE_SCRIPT.to_string())?;
        if let Ok(probe) = decode_payload(&probe_result) {
            if let Some(cards) = probe["cards"].as_u64().filter(|count| *count >= 2) {
                return Ok(cards);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "PW_CHAIN_HOME_TIMEOUT 首页未渲染真实项目卡片：{probe_result}"
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 阶段二：种子项目文档必须由前端发起的保存链真实落盘（名称以磁盘
/// 为准），空文件/缺文件/错名都视为链路断裂。
fn assert_seed_persisted(dir: &Path) -> Result<(), String> {
    for (id, name) in [
        ("sample-wu-ye-chu-zu-che", "午夜出租车"),
        ("sample-du-shi-qi-yuan", "都市奇缘"),
    ] {
        let stored = read_stored_project(dir, id)?;
        let actual = stored["project"]["name"].as_str();
        if actual != Some(name) {
            return Err(format!(
                "PW_CHAIN_SEED_MISMATCH {id} 落盘名称为 {actual:?}，预期 {name:?}"
            ));
        }
    }
    Ok(())
}

/// 阶段三：注入命令链脚本并轮询结果，再以磁盘独立复核保存事实。
fn run_page_chain(window: &WebviewWindow, app: &AppHandle, dir: &Path) -> Result<String, String> {
    let started = decode_payload(&evaluate(window, app, CHAIN_SCRIPT.to_string())?)?;
    if started != Value::String("PW_CHAIN_STARTED".into()) {
        return Err(format!("PW_CHAIN_SCRIPT_START_FAILED:{started}"));
    }
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let payload = evaluate(window, app, CHAIN_RESULT_SCRIPT.to_string())?;
        let result = decode_payload(&payload)?;
        if !result.is_null() {
            return interpret_chain_result(&result, dir);
        }
        if Instant::now() >= deadline {
            return Err("PW_CHAIN_INVOKE_TIMEOUT 页面侧命令链未完成".to_string());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 解析 eval 回调载荷。wry（macOS）把脚本结果经 NSJSONSerialization
/// 序列化后回传，实测存在两种字符串形态：单一表达式脚本回 JSON 编码串
/// （内层 JSON.stringify 结果被双重编码），多语句脚本的字符串完成值回
/// 裸串；对象/数字/null 则直接是合法 JSON，回调无值时为空串。本函数
/// 统一还原为语义值：空串视为 null（结果未就绪，继续轮询），合法 JSON
/// 原样返回，字符串载荷再解一层内层 JSON、解不开即按普通字符串载荷。
fn decode_payload(payload: &str) -> Result<Value, String> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::String(inner)) => {
            Ok(serde_json::from_str(&inner).unwrap_or_else(|_| Value::String(inner.clone())))
        }
        Ok(other) => Ok(other),
        Err(_) => Ok(Value::String(trimmed.to_string())),
    }
}

/// 解读页面命令链结果：失败原样上浮（含步骤名），成功则返回项目 id。
fn interpret_chain_result(result: &Value, dir: &Path) -> Result<String, String> {
    if !result["ok"].as_bool().unwrap_or(false) {
        return Err(format!(
            "PW_CHAIN_PAGE_FAILED step={} error={}",
            result["step"], result["error"]
        ));
    }
    let id = result["id"]
        .as_str()
        .ok_or_else(|| "PW_CHAIN_ID_MISSING".to_string())?;
    let stored = read_stored_project(dir, id)?;
    if stored["project"]["name"].as_str() != Some("链路改名") {
        return Err(format!(
            "PW_CHAIN_DISK_MISMATCH {id} 落盘名称为 {:?}，预期 链路改名",
            stored["project"]["name"].as_str()
        ));
    }
    Ok(id.to_string())
}

/// 读取并解析项目落盘 JSON；读盘/解析失败均视为链路断裂。
fn read_stored_project(dir: &Path, id: &str) -> Result<Value, String> {
    let path = dir.join(format!("projects/{id}.json"));
    let bytes =
        fs::read(&path).map_err(|error| format!("PW_CHAIN_DISK_READ_FAILED {id}：{error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("PW_CHAIN_DISK_PARSE_FAILED {id}：{error}"))
}

/// 在页面执行脚本并取回返回值（canvas_performance 同款：主线程派发 +
/// eval 回调通道），不阻塞原生主线程。
fn evaluate(window: &WebviewWindow, app: &AppHandle, script: String) -> Result<String, String> {
    let (send, receive) = mpsc::channel();
    let window = window.clone();
    app.run_on_main_thread(move || {
        let callback_send = send.clone();
        if let Err(error) = window.eval_with_callback(script, move |payload| {
            let _ = callback_send.send(Ok(payload));
        }) {
            let _ = send.send(Err(format!("PW_CHAIN_EVAL_DISPATCH:{error}")));
        }
    })
    .map_err(|error| format!("PW_CHAIN_MAIN_THREAD_DISPATCH:{error}"))?;
    receive
        .recv_timeout(EVAL_TIMEOUT)
        .map_err(|error| format!("PW_CHAIN_EVAL_TIMEOUT:{error}"))?
}

/// 从磁盘服务 dist 产物：拒绝任何非常规路径组件（防穿越），入口路径
/// 回落 index.html；文件缺失返回 404 而非 panic。
fn serve_bundle(dist: &Path, uri: &Uri) -> Response<Vec<u8>> {
    let decoded = percent_decode(uri.path());
    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let candidate = Path::new(relative);
    if candidate
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return bundle_response(403, "text/plain; charset=utf-8", b"forbidden".to_vec());
    }
    match fs::read(dist.join(candidate)) {
        Ok(body) => bundle_response(200, content_type(candidate), body),
        Err(_) => bundle_response(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

/// 构造指定状态码与内容类型的响应体。
fn bundle_response(status: u16, content_type: &'static str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .body(body)
        .unwrap()
}

/// 按扩展名给出 MIME；`text/javascript` 是 WKWebView 对 module 脚本的
/// 硬性要求，缺失会静默不执行 bundle。
fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// 最小百分号解码（%XX）；非法序列按原样保留，仅服务于磁盘路径还原。
fn percent_decode(raw: &str) -> String {
    fn hex_value(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// dist 真实构建产物根目录：编译期锁定的 src-tauri 上层（仓库根/dist），
/// 运行期从任何工作目录发起都用绝对路径。
fn dist_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist")
}
