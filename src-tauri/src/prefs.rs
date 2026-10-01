//! 应用设置与 Provider 密钥（docs/ui-design.md §8.2 修订）。
//!
//! - 设置本体（provider 配置 / 默认模型 / 加密 key）存应用数据目录
//!   `settings.json`，结构对前端自有，以 `serde_json::Value` 透传，
//!   仅做大小与文件名校验。
//! - 读取语义（issue #120）：仅文件缺失（首次启动）返回空对象；损坏、
//!   超限或其余读取失败一律 Err——未知原配置不得降级为默认值后被
//!   全量保存覆盖。内容读取经 cap+1 流式限读（issue #147），超限在
//!   物化全文件前拒绝。
//! - 读取边界（issue #391）：与保存路径同一套文件系统边界——读取入口
//!   同样锚定应用数据根句柄（canonicalize + open_ambient_dir），对
//!   `settings.json` 先做 no-follow 归类（符号链接与非普通文件在打开前
//!   拒绝，FIFO 不会阻塞 blocking 池线程），打开后做身份绑定（Unix 按
//!   (dev, ino) 与归类元数据比对，非 Unix 打开后复核归类），与图库
//!   journal 读取及 store 控制文件信任链语义一致。
//! - 保存（issue #121）复用受信目录句柄下的控制文件原子写：随机排他
//!   临时文件、文件同步、改名与 Unix 父目录同步全部成功后才返回成功；
//!   数据目录的创建（读取与保存入口）经 `store::create_dir_all_durable`
//!   先同步新目录条目的各级宿主（Unix），首启读取与首次保存创建的
//!   条目均与内容同为持久。
//! - API key 不入钥匙串：经 `seal` 模块 AES-256-GCM 加密（绑定本机），
//!   密文随 provider 配置落 `settings.json`（`keyEnc` 字段）；
//!   明文只在加密/请求的进程内存中出现，不落盘、不回显。
//!   历史钥匙串数据保留只读回退，不再写入。

use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};

use cap_std::fs::Dir as CapDir;
use tauri::{AppHandle, Manager};

use crate::http_util::ProxyError;

/// 对话请求超时（120s）：非流式补全耗时可能长于普通 API（长回复、慢
/// 模型），但不长于图像生成（imagegen 取 300s）——落 issue #15 验收
/// 基线"不低于 120s"，防 provider 网关不回包/慢速滴流时命令无限挂起。
const CHAT_REQUEST_TIMEOUT_SECS: u64 = 120;

/// 对话响应体读取上限（16 MiB）：chat completions 主响应为纯 JSON 文本
/// （无 base64 图像膨胀），约为 imagegen 上限（64 MiB）的 1/4——容纳
/// 超长回复与工具调用数组的 JSON 开销仍有余量，超大响应经流式限读在
/// 物化前被拒（issue #15）。
const CHAT_RESPONSE_BODY_MAX_BYTES: usize = 16 * 1024 * 1024;

/// 钥匙串服务名（应用标识）。
const KEYCHAIN_SERVICE: &str = "com.plotweave.app";

/// 设置文件大小上限（1 MiB），防异常输入撑爆读写。
const PREFS_MAX_BYTES: usize = 1024 * 1024;

/// 设置文件名（应用数据目录下的相对名，读取与保存入口共用）。
const SETTINGS_FILE_NAME: &str = "settings.json";

/// 设置受限读取的错误分野（issue #147）：超限是硬拒绝（与读取失败不同
/// 诊断、不回退），IO/UTF-8 失败原样携带供调用方按 issue #120 语义分类
/// ——UTF-8 失败映射为 io InvalidData，与 fs::read_to_string 同分类。
/// no-follow 归类拒绝与归类后身份比对失败（issue #391）各自独立成变体：
/// 二者都不是 NotFound，不得落入首启空对象语义。
#[derive(Debug)]
enum PrefsReadError {
    Io(io::Error),
    TooLarge,
    /// 条目是符号链接或非普通文件（FIFO/目录等）——在打开前拒绝。
    NotRegularFile,
    /// 归类与打开之间条目被替换（Unix 身份比对失败/非 Unix 复核失败）。
    Replaced,
}

/// 设置文本的受限读取内核（复用 library_fs::read_index_text_capped 的
/// cap+1 流式限读方式，issue #147）：最多物化 PREFS_MAX_BYTES+1 字节，
/// 超限在有限读取后拒绝，不先读入全文件再判断长度。
fn capped_prefs_text(reader: impl io::Read) -> Result<String, PrefsReadError> {
    let mut bytes = Vec::new();
    reader
        .take((PREFS_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(PrefsReadError::Io)?;
    if bytes.len() > PREFS_MAX_BYTES {
        return Err(PrefsReadError::TooLarge);
    }
    String::from_utf8(bytes)
        .map_err(|e| PrefsReadError::Io(io::Error::new(io::ErrorKind::InvalidData, e)))
}

/// 设置文件的受限读取入口（issue #391 读取边界）：相对锚定句柄先做
/// no-follow 归类——符号链接与非普通文件（FIFO/目录等）在打开前拒绝，
/// 不跟随、不阻塞；再打开并做身份绑定（Unix 按 (dev, ino) 与归类元数据
/// 比对，与 store::persist::read_verified_file 同法；非 Unix 无身份可比，
/// 打开后重走归类复核）；内容读取经 cap+1 限读内核。NotFound 原样上抛
/// 供调用方区分首启语义。
fn read_prefs_text_capped(root: &CapDir) -> Result<String, PrefsReadError> {
    let md = root
        .symlink_metadata(SETTINGS_FILE_NAME)
        .map_err(PrefsReadError::Io)?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(PrefsReadError::NotRegularFile);
    }
    let file = root.open(SETTINGS_FILE_NAME).map_err(PrefsReadError::Io)?;
    #[cfg(unix)]
    {
        let fm = file.metadata().map_err(PrefsReadError::Io)?;
        if crate::store::asset_identity(&fm) != crate::store::asset_identity(&md) {
            return Err(PrefsReadError::Replaced);
        }
    }
    // 非 Unix 无 (dev, ino) 可比：打开后重走 no-follow 归类复核（与
    // store::persist::read_verified_file 同法），换成符号链接/异型即拒绝
    #[cfg(not(unix))]
    {
        let recheck = root
            .symlink_metadata(SETTINGS_FILE_NAME)
            .map_err(PrefsReadError::Io)?;
        if recheck.file_type().is_symlink() || !recheck.is_file() {
            return Err(PrefsReadError::Replaced);
        }
        match file.metadata() {
            Ok(fm) if fm.is_file() => {}
            _ => return Err(PrefsReadError::Replaced),
        }
    }
    capped_prefs_text(file)
}

/// 确保数据目录存在且新建条目各级宿主已同步（§10.2，Unix）：读取与
/// 保存入口共用同一持久化创建内核——首启读取路径也会创建数据目录，
/// 多级缺失（干净轮廓、嵌套 XDG_DATA_HOME）时若不同步，随后的保存
/// 仅兜底同步直接父目录，更上层条目仍未落盘（PR #201 第二轮评审）。
fn ensure_data_dir(dir: &Path) -> Result<(), String> {
    crate::store::create_dir_all_durable(dir).map_err(|e| format!("创建数据目录失败：{e}"))
}

/// 定位并持久化确保应用数据目录（读取与保存入口共用的第一步）。
fn prefs_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    ensure_data_dir(&dir)?;
    Ok(dir)
}

/// 锚定设置根的受信句柄（读/写共用的文件系统边界，issue #391）：读取与
/// 保存入口对 `settings.json` 的归类、打开、读取/原子写均相对该句柄执行，
/// 不按路径名重解析。
fn open_prefs_root(dir: &Path) -> Result<CapDir, String> {
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("解析设置目录真实路径失败：{e}"))?;
    CapDir::open_ambient_dir(&dir, cap_std::ambient_authority())
        .map_err(|e| format!("打开设置目录失败：{e}"))
}

/// 读取设置内核（issue #120）：文件不存在 = 首次启动，返回空对象；
/// 其余读取失败（权限/IO 异常）与损坏、超限一律 Err 上抛——把未知
/// 原配置降级为空对象，会被前端默认值经全量保存覆盖原文件。
/// 读取经 cap+1 流式限读（issue #147）；读取边界为锚定句柄下的
/// no-follow 归类 + 身份绑定（issue #391）：符号链接/非普通文件与
/// 归类后被替换均拒绝，不落入首启语义。
fn read_prefs_in(dir: &Path) -> Result<serde_json::Value, String> {
    let root = open_prefs_root(dir)?;
    let text = match read_prefs_text_capped(&root) {
        Ok(text) => text,
        Err(PrefsReadError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({}))
        }
        Err(PrefsReadError::Io(e)) => return Err(format!("读取设置失败：{e}")),
        Err(PrefsReadError::TooLarge) => {
            return Err(format!(
                "设置文件过大（超过 1 MiB 上限）。{}",
                prefs_recovery_hint(dir)
            ))
        }
        Err(PrefsReadError::NotRegularFile) => {
            return Err("设置文件是符号链接或非普通文件，拒绝读取".into())
        }
        Err(PrefsReadError::Replaced) => return Err("设置文件在读取前被替换，拒绝读取".into()),
    };
    serde_json::from_str(&text).map_err(|e| format!("设置文件损坏：{e}"))
}

/// 读取应用设置；仅文件不存在（首次启动）返回空对象，其余失败上抛。
#[tauri::command]
pub async fn load_prefs(app: AppHandle) -> Result<serde_json::Value, String> {
    crate::blocking::run("load_prefs", move || {
        let dir = prefs_data_dir(&app)?;
        read_prefs_in(&dir)
    })
    .await
}

/// 全量保存应用设置：校验大小后在受信应用根下执行 §10.2 原子写与持久性屏障。
#[tauri::command]
pub async fn save_prefs(app: AppHandle, prefs: serde_json::Value) -> Result<(), String> {
    crate::blocking::run("save_prefs", move || {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
        save_prefs_in(&dir, prefs)
    })
    .await
}

/// 设置文件（settings.json）的损坏备份规格（issue #390）：与图库索引同款
/// 内核——覆盖前判定既有文件是否为健康 JSON 对象，损坏（含合法 JSON 但
/// 非对象、非法 UTF-8）则按原字节摘要耐久备份 `settings-corrupt-<sha256>.bak`
/// 后才放行覆盖，使 keyEnc 密文等不可重建数据可事后取证；备份异常阻止
/// 本次保存（fail-closed）。成功加载之后的编辑会话期间文件被外部破坏是
/// 本保护的残余窗口（加载期由 issue #120 的 ready 门控承接）。
const SETTINGS_BACKUP: crate::store::DamagedFileBackup = crate::store::DamagedFileBackup {
    file_name: SETTINGS_FILE_NAME,
    backup_prefix: "settings-corrupt-",
    max_bytes: PREFS_MAX_BYTES,
    source_label: "设置文件",
    backup_label: "设置文件",
};

/// #435：失败出口提供保留原件的人工重建指引；路径仅用于展示，不参与 I/O。
fn prefs_recovery_hint(dir: &Path) -> String {
    format!(
        "设置文件位于「{}」。如需重建设置，请先退出应用并自行备份该文件；\
         确认无需保留原配置后，可移走或删除该文件。重新打开应用会使用默认设置，\
         原 provider 配置及 API key 需重新填写后保存。",
        dir.join(SETTINGS_FILE_NAME).display()
    )
}

/// 设置保存的文件系统边界：先持久化创建数据目录（§10.2 条目宿主屏障，
/// Unix），再经与读取入口共用的 `open_prefs_root` 锚定句柄（issue #391），
/// 后续创建、替换与同步均相对该句柄执行；序列化超限时不触盘。写盘前
/// 取设置写互斥（见 [`settings_write_guard`]），与旧密文迁移写回串行，
/// 并在锁内先完成损坏原件备份（issue #390，见 [`SETTINGS_BACKUP`]）。
fn save_prefs_in(dir: &Path, prefs: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| format!("序列化失败：{e}"))?;
    if text.len() > PREFS_MAX_BYTES {
        return Err("设置内容过大".into());
    }
    ensure_data_dir(dir)?;
    let root = open_prefs_root(dir)?;
    let _guard = settings_write_guard();
    crate::store::backup_damaged_file(&root, &SETTINGS_BACKUP)
        .map_err(|e| format!("备份损坏设置原件失败：{e}。{}", prefs_recovery_hint(dir)))?;
    crate::store::atomic_write(&root, SETTINGS_FILE_NAME, &text)
        .map_err(|e| format!("保存设置失败：{e}"))
}

/// 设置文件写互斥：save_prefs 全量写与 key_migration 就地迁移写共用，
/// 串行化本进程内 settings.json 的两条写路径（前端保存经 save_prefs
/// 命令同在本进程），消除「迁移基于旧快照覆盖并发保存」的编辑丢失
/// 窗口（issue #392）。中毒恢复论证（rust-standard 锁策略）：磁盘一致
/// 性由 §10.2 原子写协议独立保证，本锁仅序列化读-改-写顺序，恢复继续
/// 不破坏文件系统一致性。
fn settings_write_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    crate::lock::recover_guard(LOCK.lock(), "settings-write")
}

#[cfg(test)]
mod backup_tests;

#[cfg(test)]
mod save_tests;

#[cfg(all(test, unix))]
mod read_boundary_tests;

#[cfg(test)]
mod transport_tests;

mod key_migration;

#[cfg(test)]
mod key_migration_tests;

/// provider id 约束：钥匙串账号安全字符集。
fn validate_provider_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法 provider id：{id}"))
    }
}

/// 加密 provider API key：返回 envelope 密文（v2：迭代派生 + provider
/// AAD 绑定，issue #392），由前端随 settings.json 落盘。明文只在本次
/// 调用的进程内存中出现，不落盘、不回显、不入钥匙串。
#[tauri::command]
pub async fn set_provider_key(provider_id: String, key: String) -> Result<String, String> {
    crate::blocking::run("set_provider_key", move || {
        validate_provider_id(&provider_id)?;
        if key.trim().is_empty() {
            return Err("API key 不能为空".into());
        }
        crate::seal::seal_for(&provider_id, key.trim())
    })
    .await
}

/// 从设置文本解析并解密 provider 的 `keyEnc` 密文：None = 无可用密文
///（损坏 JSON/条目缺失，落入钥匙串只读回退）；Some(Err) = 密文在场但
/// 解不开（原样上抛，不降级回退）。旧版 `pw1:` 密文在成功解开后触发
/// 就地迁移重封装（issue #392，best-effort）。
fn open_key_from_text(
    root: &CapDir,
    text: &str,
    provider_id: &str,
) -> Option<Result<String, String>> {
    let envelope = serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("providers")
        .and_then(|p| p.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(provider_id))
        })
        .and_then(|p| p.get("keyEnc"))
        .and_then(|x| x.as_str())?
        .to_string();
    let secret = match crate::seal::open_for(provider_id, &envelope) {
        Ok(secret) => secret,
        Err(e) => return Some(Err(e)),
    };
    if crate::seal::is_legacy_envelope(&envelope) {
        key_migration::migrate_legacy_envelope(root, provider_id, &envelope, &secret);
    }
    Some(Ok(secret))
}

/// 解析 provider 当前可用的 key：优先 settings.json 的 `keyEnc` 密文；
/// 密文缺失时只读回退历史钥匙串数据（不再写入钥匙串）。
/// crate 内共享：图像生成代理（imagegen）与对话代理（llm_chat）同域。
/// 同步阻塞访问（目录确保、文件读取、密文解析，可能触发机器标识子进程
/// 或历史钥匙串）：调用方必须把它作为完整同步工作交由阻塞调度
/// （issue #279），不得在异步工作线程上直调。
pub(crate) fn provider_secret(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    validate_provider_id(provider_id)?;
    let dir = prefs_data_dir(app)?;
    let root = open_prefs_root(&dir)?;
    // 信任边界：与 load_prefs 同一读取边界（锚定句柄 + no-follow 归类 +
    // 身份绑定，issue #391）与大小上限（cap+1 限读，issue #147）——超限
    // 硬拒绝；读取失败（含缺失/UTF-8 失败/异型条目拒绝/替换拒绝）维持
    // 原语义落入钥匙串只读回退——被拒绝的条目无法携带 keyEnc
    match read_prefs_text_capped(&root) {
        Ok(text) => {
            if let Some(outcome) = open_key_from_text(&root, &text, provider_id) {
                return outcome;
            }
        }
        Err(PrefsReadError::TooLarge) => return Err("设置文件过大，拒绝读取密文".into()),
        Err(PrefsReadError::Io(_)) => {}
        Err(PrefsReadError::NotRegularFile) | Err(PrefsReadError::Replaced) => {}
    }
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider_id)
        .map_err(|e| format!("钥匙串不可用：{e}"))?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err("未配置 API key，请在设置页填写".to_string()),
        Err(e) => Err(format!("读取 key 失败：{e}")),
    }
}

/// 对话命令的凭据阶段（issue #279）：`provider_secret` 是完整同步工作
/// （数据目录确保、cap+1 受限读取、密文解析、必要时机器标识子进程与
/// 历史钥匙串回退），经既有 `blocking::run` 交由阻塞线程池——不在首次
/// await 前占用异步工作线程。领域错误原样上浮；密钥留在后端；HTTP
/// 只在凭据成功后由 chat_completion 发出。`load` 由调用方注入：生产
/// 绑定 provider_secret，测试注入受控延迟以验证兄弟任务响应性。
async fn chat_credential(
    load: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    crate::blocking::run("llm_chat", load).await
}

/// 对话补全传输内核（不含 AppHandle 与密文解析，便于对接本地 HTTP
/// 夹具做行为测试）：构造带超时的客户端、发送 OpenAI 兼容补全请求、
/// 响应体流式限读后提取 choices[0].message。`timeout_secs` 由调用方
/// 注入——生产为 CHAT_REQUEST_TIMEOUT_SECS；测试注入短超时以驱动
/// 慢速/挂起响应路径，不必等待真实上限。
async fn chat_completion(
    base_url: &str,
    model: &str,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
    key: &str,
    timeout_secs: u64,
) -> Result<serde_json::Value, ProxyError> {
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
    if let Some(tools) = tools {
        if tools.is_array() && !tools.as_array().is_none_or(|t| t.is_empty()) {
            body["tools"] = tools;
            body["tool_choice"] = serde_json::json!("auto");
        }
    }
    let response = crate::provider_transport::post_json(
        base_url,
        "chat/completions",
        key,
        &body,
        timeout_secs,
    )
    .await?;
    let status = response.status();
    // issue #149：状态摘录脱敏需要本次请求 URL——read_text_capped 消费
    // response 前先取出
    let response_url = response.url().clone();
    // 限读错误经 Body 透传（#45 首片类型）：文案与来源链原样保留
    let text = crate::http_util::read_text_capped(response, CHAT_RESPONSE_BODY_MAX_BYTES)
        .await
        .map_err(ProxyError::Body)?;
    if !status.is_success() {
        // 网关/代理回显请求 URL 或密钥时展示不泄露（issue #149）
        let head = crate::http_util::redact_status_head(&text, key, &response_url);
        return Err(ProxyError::Status {
            context: "服务返回".into(),
            code: status,
            head,
        });
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ProxyError::InvalidJson {
            context: "响应不是有效 JSON".into(),
            source: e,
        })?;
    parsed
        .pointer("/choices/0/message")
        .cloned()
        .filter(|m| m.is_object())
        .ok_or(ProxyError::InvalidResponse {
            detail: "服务未返回回复内容".into(),
        })
}

/// LLM 对话代理（§6/数据模型 §12.2）：key 的密文存 settings.json，
/// 请求前在 Rust 内存中解密——明文不出后端；前端只传 provider 配置、
/// 消息列表与可选工具表。OpenAI 兼容 chat completions，非流式；
/// 返回 choices[0].message 原文（content 字符串 + 可选 tool_calls 数组）。
/// 凭据读取经 chat_credential 离开异步工作线程（issue #279）：同步的
/// 目录确保/受限读取/密文解析/钥匙串回退占用阻塞线程池，HTTP 只在其
/// 完成后发出。
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    provider_id: String,
    base_url: String,
    model: String,
    messages: serde_json::Value,
    tools: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    validate_provider_id(&provider_id)?;
    if model.trim().is_empty() {
        return Err("未选择模型".into());
    }
    let key = chat_credential(move || provider_secret(&app, &provider_id)).await?;
    chat_completion(
        &base_url,
        &model,
        messages,
        tools,
        &key,
        CHAT_REQUEST_TIMEOUT_SECS,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
