//! 个人资产库（docs/ui-design.md §8.1 / 数据模型 §7）：
//! 应用级 `library/` 目录跨项目复用——`library.json` 全量索引（内存过滤），
//! 媒体文件落 `library/assets/`，展示经 `pwmedia` 自定义协议按 id 懒加载
//! （§7.1 opaque asset URL，issue #26）。
//! 索引结构对前端自有（serde_json::Value 透传）。
//! 全部文件操作经 [`crate::library_fs`] 共享内核的受信锚定句柄执行（§7.1/§7.2
//! 信任链）：脏索引条目在读取时白名单隔离，删除经 `library/assets/` 专用根
//! 句柄逐组件 no-follow 定位——索引自身与库外路径不可达（issue #17）。

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::library_fs::{
    assets_root, atomic_write_with, ensure_index_size, library_root, read_index_capped,
    validate_asset_id, write_index,
};
use crate::library_journal::{library_file_lock, library_op_lock};
use crate::store::is_canonical_mime;
use crate::store::is_valid_active_asset_rel_path;

/// 单文件上限 20 MiB：资产库放参考图/氛围图，防异常输入撑爆磁盘与 IPC。
const ASSET_MAX_BYTES: usize = 20 * 1024 * 1024;
const NAME_MAX_CHARS: usize = 128;
const TAGS_MAX: usize = 16;
/// 单个 tag 去空白后的字符上限（与 §7.2 归一化内核同域）。
const TAG_MAX_CHARS: usize = 64;

const KINDS: [&str; 6] = [
    "character",
    "location",
    "wardrobe",
    "colorlight",
    "reference",
    "other",
];
const VIEWS: [&str; 8] = [
    "front",
    "side",
    "back",
    "three_quarter",
    "top",
    "expression",
    "turnout",
    "other",
];

/// 列出全量索引（启动时一次载入，前端内存过滤，§8.1）：先按 §7.2 恢复
/// 删除日志中的未完成事务，脏索引条目由共享内核隔离，`warnings` 与
/// `cleanupPending` 随索引返回，冲突期条目标记 `conflicted` 不可用。
#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    let (mut index, warnings) = list_assets_with(&library)?;
    index["warnings"] = json!(warnings);
    Ok(index)
}

/// 列表读取内核（句柄域，`library_list` 与测试共用）：先恢复删除日志，
/// 再按只读态分流读取——日志异型（只读告警态）用不落盘读取，索引保持
/// 原始字节（评审修复，PR #33 第五轮：只读态下迁移落盘会改写索引）；迁移
/// 警告与冲突期标记随结果返回。
pub(crate) fn list_assets_with(library: &cap_std::fs::Dir) -> Result<(Value, Vec<String>), String> {
    let mut recovery = crate::library_journal::recover(library)?;
    let (mut index, mut warnings) = if recovery.read_only {
        let (idx, w) = crate::library_fs::read_index_normalized_readonly(library)?;
        (idx, w)
    } else {
        read_index_capped(library)?
    };
    warnings.append(&mut recovery.warnings);
    for id in &recovery.conflicted {
        if let Some(e) = index["assets"]["byId"].get_mut(id) {
            e["conflicted"] = json!(true);
        }
        warnings.push(format!("资产 {id} 处于删除事务冲突期，暂不可用"));
    }
    index["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok((index, warnings))
}

/// 导入资产内核（句柄域）：mime 信任边界（trim + 小写后必须规范形）、媒体
/// 经 `library/assets/` 专用根句柄原子落盘（新 id，库自包含），索引净化
/// 读取后追加并落盘，返回新条目。
pub(crate) fn put_asset_with(
    library: &cap_std::fs::Dir,
    name: &str,
    mime: &str,
    kind: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    validate_name(name)?;
    validate_kind(kind)?;
    let mime = mime.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(format!("非法 mime：{mime}"));
    }
    if bytes.is_empty() {
        return Err("文件内容为空".into());
    }
    if bytes.len() > ASSET_MAX_BYTES {
        return Err("文件超过 20 MiB 上限".into());
    }
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    let assets = assets_root(library)?;
    let (mut index, mut warnings) = read_index_capped(library)?;
    warnings.extend(recovery.warnings);
    let cleanup_pending = recovery.cleanup_pending;
    let id = format!("la-{:x}-{}", now_ms(), bytes.len());
    let file_name = format!("{}.{}", id, ext_for(name, &mime));
    let mut entry = json!({
        "id": id,
        "name": name.trim(),
        "kind": kind,
        "mime": mime,
        "relPath": format!("assets/{file_name}"),
        "source": "upload",
        "createdAt": crate::isotime::now_iso(),
        "tags": [],
    });
    index["assets"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?
        .insert(id.clone(), entry.clone());
    // 媒体落盘前先校验候选索引大小（评审修复）：超限在物化前拒绝，
    // 不留下索引写不回去的孤儿媒体文件
    ensure_index_size(&index)?;
    atomic_write_with(&assets, &file_name, |dst| {
        std::io::Write::write_all(dst, bytes).map(|_| ())
    })?;
    write_index(library, &index)?;
    // 净化诊断随响应可见（评审修复）：脏索引变脏后直接导入时，被隔离
    // 条目/规范化修复不得随"落盘即净化"静默发生；仅在非空时附加，保持
    // 常态响应形状纯净
    if !warnings.is_empty() {
        entry["warnings"] = json!(warnings);
    }
    entry["cleanupPending"] = json!(cleanup_pending);
    Ok(entry)
}

/// 导入资产命令：媒体拷入 assets/（新 id，库自包含），索引追加并返回新条目。
#[tauri::command]
pub fn library_put(
    app: AppHandle,
    name: String,
    mime: String,
    kind: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    put_asset_with(&library, &name, &mime, &kind, &bytes)
}

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("资产名不能为空".into());
    }
    if trimmed.chars().count() > NAME_MAX_CHARS {
        return Err("资产名过长".into());
    }
    Ok(())
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("未知资产分类：{kind}"))
    }
}

fn normalize_tags(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .take(TAGS_MAX)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// mime → 扩展名（未知类型回退 bin，文件名扩展优先）。
pub(crate) fn ext_for(name: &str, mime: &str) -> String {
    if let Some(dot) = name.rfind('.') {
        let ext = &name[dot + 1..];
        let ok =
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric());
        if ok {
            return ext.to_ascii_lowercase();
        }
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => "bin",
    }
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 校验元信息补丁（§7.2）：字段白名单；字段**一旦出现**即做运行时类型和
/// 值域校验——非字符串的 name/kind/view、tags 的异型/空白/超长/重复成员与
/// 超 16 项一律拒绝整次命令，不得静默跳过校验、截断或留待读取归一化剥离
/// （评审修复，PR #33 第十轮）。
fn validate_meta_patch(patch: &Value) -> Result<(), String> {
    if !patch.is_object() {
        return Err("patch 必须是对象".into());
    }
    const EDITABLE: [&str; 5] = ["name", "kind", "view", "tags", "groupId"];
    for key in patch.as_object().unwrap().keys() {
        if !EDITABLE.contains(&key.as_str()) {
            return Err(format!("不可修改的字段：{key}"));
        }
    }
    if let Some(v) = patch.get("name") {
        let Some(n) = v.as_str() else {
            return Err("name 必须是字符串".into());
        };
        validate_name(n)?;
    }
    if let Some(v) = patch.get("kind") {
        let Some(k) = v.as_str() else {
            return Err("kind 必须是字符串".into());
        };
        validate_kind(k)?;
    }
    if let Some(v) = patch.get("view") {
        if !v.is_null() {
            let Some(s) = v.as_str() else {
                return Err("view 必须是字符串或 null".into());
            };
            if !VIEWS.contains(&s) {
                return Err(format!("未知视角：{s}"));
            }
        }
    }
    if let Some(v) = patch.get("tags") {
        validate_tags_patch(v)?;
    }
    Ok(())
}

/// tags 补丁值域（§7.2「tags 须在输入时满足数组、成员和值域规则」）：数组、
/// 成员去空白后 1–64 字符且规范化后唯一、至多 16 项。
fn validate_tags_patch(v: &Value) -> Result<(), String> {
    let Some(arr) = v.as_array() else {
        return Err("tags 必须是数组".into());
    };
    let mut seen: Vec<String> = Vec::new();
    for t in arr {
        let Some(s) = t.as_str() else {
            return Err("tags 成员必须是字符串".into());
        };
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err("tags 成员去空白后不能为空".into());
        }
        if trimmed.chars().count() > TAG_MAX_CHARS {
            return Err(format!("tags 成员超长（>{} 字符）", TAG_MAX_CHARS));
        }
        if seen.iter().any(|x| x == trimmed) {
            return Err(format!("tags 成员重复：{trimmed}"));
        }
        seen.push(trimmed.to_string());
    }
    if seen.len() > TAGS_MAX {
        return Err(format!("tags 最多 {} 项", TAGS_MAX));
    }
    Ok(())
}

/// 应用 groupId 补丁（§7.2）：null/空白是唯一清除标记，落盘删除可选字段；
/// 非空值必须 **verbatim** 过 id 值域——`" g "` 不得 trim 成 `"g"` 错接进组
/// g（评审修复，PR #33 第十一轮：ID 不透明，trim 只适用于契约允许的字段）；
/// 其他异型值拒绝。
fn apply_group_id(entry: &mut Value, g: &Value) -> Result<(), String> {
    match g {
        Value::Null => {
            entry.as_object_mut().unwrap().remove("groupId");
        }
        Value::String(s) if s.trim().is_empty() => {
            entry.as_object_mut().unwrap().remove("groupId");
        }
        Value::String(s) if validate_asset_id(s).is_ok() => entry["groupId"] = json!(s),
        _ => return Err("groupId 必须是合法 id 字符串或 null".into()),
    }
    Ok(())
}

// ---- opaque asset URL 媒体协议（§7.1/§10.2，issue #26）：relPath 与本机
// 绝对路径仅留在 Rust 侧，前端只获得含 scope + assetId 的 opaque URL，
// `pwmedia` 自定义协议处理器在每次请求时按当前净化索引重新解析 id 并经
// 句柄链读取字节（lib.rs 注册同名协议）。

/// opaque asset URL 的自定义协议名（lib.rs 注册同名协议处理器）。
pub(crate) const MEDIA_SCHEME: &str = "pwmedia";

/// scope 白名单（§7.1 命令表）：仅接受 `{"kind":"library"}` 精确形状——
/// 目录/路径字符串永远不可作为 scope 进入媒体管线；项目 scope 的 opaque
/// 协议迁移另行落地（仍走 project_asset_path 实路径复验），显式拒绝。
fn validate_media_scope(scope: &Value) -> Result<(), String> {
    let exact = scope
        .as_object()
        .is_some_and(|o| o.len() == 1 && o.get("kind").and_then(Value::as_str) == Some("library"));
    if exact {
        Ok(())
    } else {
        Err("媒体 URL scope 仅支持 {{ kind: 'library' }}".into())
    }
}

/// opaque asset URL（前端可直接挂到 img/src 的完整 URL）：Windows/Android
/// 走 `http://{scheme}.localhost`，其余平台走原生自定义 scheme（与 Tauri
/// convertFileSrc 的平台分野一致）。URL 只由逻辑段与 assetId 构成，不含
/// 任何本机路径。
pub(crate) fn opaque_media_url(asset_id: &str) -> String {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let url = format!("http://{MEDIA_SCHEME}.localhost/library/{asset_id}");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let url = format!("{MEDIA_SCHEME}://localhost/library/{asset_id}");
    url
}

/// 协议请求解析：仅接受 `/library/{assetId}` 单段形式。assetId 不做百分号
/// 解码——合法 id 字符集（[`crate::library_fs::validate_asset_id`]）不含
/// `%`，编码/双段/异 scope 形式天然拒绝。
fn parse_media_uri(uri: &tauri::http::Uri) -> Result<String, String> {
    let path = uri.path();
    let rest = path
        .strip_prefix("/library/")
        .ok_or_else(|| format!("媒体请求路径非法：{path}"))?;
    if rest.is_empty() || rest.contains('/') {
        return Err(format!("媒体请求路径非法：{path}"));
    }
    validate_asset_id(rest)?;
    Ok(rest.to_string())
}

/// id → (relPath, mime) 解析内核（句柄域，锁由调用方持有；每次请求重新
/// 执行）：恢复流程复核冲突期 → 净化索引按 id 定位 → relPath 词法复核。
/// 媒体字节读取与 URL 早反馈共用。
fn resolve_media_entry_with(
    library: &cap_std::fs::Dir,
    id: &str,
) -> Result<(String, String), String> {
    validate_asset_id(id)?;
    let recovery = crate::library_journal::recover(library)?;
    if recovery.conflicted.iter().any(|c| c == id) {
        return Err(format!("资产 {id} 处于删除事务冲突期，媒体不可用"));
    }
    // 只读告警态用不落盘读取（评审修复，PR #33 第五轮）：媒体读取本身不受限，
    // 但不得在只读态把迁移结果写回 library.json
    let (index, _) = if recovery.read_only {
        let (idx, w) = crate::library_fs::read_index_normalized_readonly(library)?;
        (idx, w)
    } else {
        read_index_capped(library)?
    };
    // 迁移/恢复诊断进结构化本机日志（评审修复，PR #33 第十一轮）：媒体请求
    // 只回 200/404、响应无法携带 warnings；迁移落盘后这些隔离/改写诊断若被
    // 丢弃，后续 list 读到的是已干净文件，诊断永久丢失——不落盘规则「失败
    // 不得隐匿」同样适用于修复可见性
    for w in &recovery.warnings {
        eprintln!("[library] 库媒体请求伴随迁移/恢复诊断：{w}");
    }
    let entry = index["assets"]["byId"]
        .get(id)
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    let rel = entry
        .get("relPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("资产 {id} 的 relPath 缺失"))?;
    if !is_valid_active_asset_rel_path(rel) {
        return Err(format!("资产 {id} 的 relPath 非法：{rel}"));
    }
    let mime = entry
        .get("mime")
        .and_then(Value::as_str)
        .filter(|m| is_canonical_mime(m))
        .unwrap_or("application/octet-stream")
        .to_string();
    Ok((rel.to_string(), mime))
}

/// 锁内打开媒体句柄（句柄域，锁由调用方持有）：[`resolve_media_entry_with`]
/// 解析后复用 [`crate::assets::open_library_asset`] 的句柄链定位——最终
/// 组件 no-follow 拒绝符号链接、确认普通文件并按 (dev, ino) 身份绑定。
/// 锁的作用域到打开即结束：字节读取在锁外消费已绑定句柄（评审修复，PR
/// #32 第三轮——最多 20 MiB 的 I/O 不得串行化并发缩略图请求、不得把
/// 导入/元信息/删除排在读取全程之后）。
pub(crate) fn open_media_with(
    library: &cap_std::fs::Dir,
    id: &str,
) -> Result<(String, cap_std::fs::File), String> {
    let (rel, mime) = resolve_media_entry_with(library, id)?;
    let file = crate::assets::open_library_asset(library, &rel)?;
    Ok((mime, file))
}

/// 并发媒体读取上限（评审修复，PR #32 第四轮）：多个近 20 MiB 大图同时
/// 进入视口时，每个并发读取各自分配缓冲，N×20 MiB 的瞬时峰值可能拖垮
/// 进程——读取并发数收敛到 4；许可随响应体存活到交付（见
/// [`MediaDelivery`]），故在交付完成前峰值 ≤ 4×20 MiB。交付后字节归
/// webview 所有，其消费内存不在 Rust 侧观测范围（Tauri 同步协议 API 无
/// 交付完成信号，此为文档化边界）；库写入/删除/元信息不受影响（闸门只
/// 作用于媒体字节读取）。
const MEDIA_READ_CONCURRENCY: usize = 4;

/// 并发媒体读取闸门：Mutex + Condvar 的计数信号量（同步 spawn_blocking
/// 上下文，不用 tokio::sync::Semaphore）。许可随 [`MediaReadPermit`] drop
/// 释放。
pub(crate) struct MediaReadGate {
    max: usize,
    held: Mutex<usize>,
    available: Condvar,
}

static MEDIA_READ_GATE: OnceLock<MediaReadGate> = OnceLock::new();

/// 释放许可：归还计数并唤醒一个等待者。
impl Drop for MediaReadPermit<'_> {
    fn drop(&mut self) {
        let mut held = self.0.held.lock().expect("媒体读取闸门被污染");
        *held -= 1;
        self.0.available.notify_one();
    }
}

/// 一个并发媒体读取许可；drop 时归还。
pub(crate) struct MediaReadPermit<'a>(&'a MediaReadGate);

impl MediaReadGate {
    fn new(max: usize) -> Self {
        Self {
            max,
            held: Mutex::new(0),
            available: Condvar::new(),
        }
    }

    fn gate() -> &'static MediaReadGate {
        MEDIA_READ_GATE.get_or_init(|| MediaReadGate::new(MEDIA_READ_CONCURRENCY))
    }

    /// 尝试获取许可：满额即返回 None（仅测试：确定性验证上限语义）。
    #[cfg(test)]
    fn try_acquire(&self) -> Option<MediaReadPermit<'_>> {
        let mut held = self.held.lock().expect("媒体读取闸门被污染");
        if *held >= self.max {
            return None;
        }
        *held += 1;
        Some(MediaReadPermit(self))
    }

    /// 阻塞获取许可：满额时等待释放。
    fn acquire(&self) -> MediaReadPermit<'_> {
        let mut held = self.held.lock().expect("媒体读取闸门被污染");
        while *held >= self.max {
            held = self.available.wait(held).expect("媒体读取闸门被污染");
        }
        *held += 1;
        MediaReadPermit(self)
    }
}

/// 锁外的受限字节读取（≤ ASSET_MAX_BYTES）：消费 [`open_media_with`] 返回
/// 的已身份绑定句柄，读取并发经 `gate` 收敛（见 [`MEDIA_READ_CONCURRENCY`]）。
/// 成功时把并发许可随结果交还调用方：许可必须存活到响应交付之后（见
/// [`MediaDelivery`]），否则等待中的读者会在先前响应体仍待交付时分配新
/// 缓冲，峰值契约不成立；失败时许可就地释放。POSIX 语义下已打开句柄的
/// 内容读取稳定——删除事务的隔离 rename 不影响该句柄，故无需持锁。
pub(crate) fn read_media_capped_in<'g>(
    gate: &'g MediaReadGate,
    id: &str,
    mime: String,
    file: cap_std::fs::File,
) -> Result<(String, Vec<u8>, MediaReadPermit<'g>), String> {
    use std::io::Read;
    let permit = gate.acquire();
    let mut bytes = Vec::new();
    file.take((ASSET_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取资产 {id} 媒体失败：{e}"))?;
    if bytes.len() > ASSET_MAX_BYTES {
        return Err(format!("资产 {id} 的媒体超过 20 MiB 上限"));
    }
    Ok((mime, bytes, permit))
}

/// [`read_media_capped_in`] 的全局闸门入口：许可存活到调用方交付（见
/// [`MediaDelivery`]），成功时随结果返回。
pub(crate) fn read_media_capped(
    id: &str,
    mime: String,
    file: cap_std::fs::File,
) -> Result<(String, Vec<u8>, MediaReadPermit<'static>), String> {
    read_media_capped_in(MediaReadGate::gate(), id, mime, file)
}

/// 404 的后端诊断文本（评审修复，复用 store 的 eprintln 结构化诊断约定，
/// 见 store/commands.rs）：webview 只收非敏感 404 固定文案，原始原因带
/// `[library]` 标签进本机诊断日志——脏数据/文件缺失与普通失败可区分，
/// 失败不得隐匿（AGENTS.md 不得隐匿失败硬性规则）。
fn media_failure_diagnostic(err: &str) -> String {
    format!("[library] 库媒体请求失败：{err}")
}

/// 响应映射（句柄域测试与协议处理器共用）：命中 → 200 + 索引 mime；
/// 任何失败 → 404 纯文本——不区分错误种类，避免向 webview 泄露盘面细节。
fn media_http_response(
    result: Result<(String, Vec<u8>), String>,
) -> tauri::http::Response<Vec<u8>> {
    const NOT_FOUND: &str = "媒体不可用";
    match result {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, mime)
            .body(bytes)
            .expect("固定形状的媒体响应构造不可能失败"),
        Err(_) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header(
                tauri::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )
            .body(NOT_FOUND.as_bytes().to_vec())
            .expect("固定形状的错误响应构造不可能失败"),
    }
}

/// 待交付的媒体响应（评审修复，PR #32 第五轮）：响应体与并发许可绑定，
/// 调用方（lib.rs 的 `pwmedia` 协议闭包）必须先解构出二者、调用
/// `responder.respond(response)` 后再让 `permit` 出界释放——许可持有到
/// 交付完成，等待中的读者才不会在先前响应体仍待交付/消费时分配新缓冲，
/// 4×20 MiB 峰值契约才成立。404 路径无许可（`permit: None`）。
pub(crate) struct MediaDelivery {
    pub(crate) response: tauri::http::Response<Vec<u8>>,
    pub(crate) permit: Option<MediaReadPermit<'static>>,
}

/// `pwmedia` 协议处理器（lib.rs 注册；在 spawn_blocking 线程执行）：解析
/// 请求 → 锁内按当前日志/索引解析 id → 句柄链读字节 → 响应。§7.1 每次
/// 请求重新解析，目录项在列表后被替换也无法越出资产根。失败向 webview
/// 折叠为非敏感 404，原始原因经 [`media_failure_diagnostic`] 进本机日志。
/// 返回 [`MediaDelivery`]：调用方在 `responder.respond` 之后再释放许可
/// （评审修复，PR #32 第五轮——许可生命周期覆盖到响应交付）。
pub(crate) fn handle_media_request(app: &AppHandle, uri: &tauri::http::Uri) -> MediaDelivery {
    let result = parse_media_uri(uri).and_then(|id| {
        let library = library_root(app)?;
        // 锁内：恢复复核 + 净化索引解析 + 身份绑定打开；锁随打开结束
        let opened = {
            let _op = library_op_lock();
            let _file_lock = library_file_lock(&library)?;
            open_media_with(&library, &id)
        };
        // 锁外：消费已绑定句柄读取字节（评审修复，PR #32 第三轮）；成功
        // 时许可随结果返回，交由 MediaDelivery 持有到交付之后
        opened.and_then(|(mime, file)| read_media_capped(&id, mime, file))
    });
    if let Err(e) = &result {
        eprintln!("{}", media_failure_diagnostic(e));
    }
    match result {
        Ok((mime, bytes, permit)) => MediaDelivery {
            response: media_http_response(Ok((mime, bytes))),
            permit: Some(permit),
        },
        Err(e) => MediaDelivery {
            response: media_http_response(Err(e)),
            permit: None,
        },
    }
}

/// opaque asset URL 解析命令（§7.1 命令表 get_asset_media_url）：scope +
/// assetId 入参，返回前端可直接使用的 opaque URL；本机路径与 relPath 不出
/// Rust。此处仅做锁内早反馈（冲突期/存在性复核），权威校验在协议处理器的
/// 每次媒体请求内（issue #26）。
#[tauri::command]
pub fn get_asset_media_url(
    app: AppHandle,
    scope: Value,
    asset_id: String,
) -> Result<String, String> {
    validate_media_scope(&scope)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    resolve_media_entry_with(&library, &asset_id)?;
    Ok(opaque_media_url(&asset_id))
}

/// 删除资产命令：日志驱动的身份绑定隔离事务（§7.2）——响应携带净化
/// 诊断与 cleanupPending。移除索引项并把媒体隔离进 .trash/。
#[tauri::command]
pub fn library_delete(app: AppHandle, id: String) -> Result<Value, String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    crate::library_journal::delete_asset_transacted(&library, &id)
}

/// 更新元信息内核（句柄域）：补丁值域校验（§7.2 在内核强制——绕过命令
/// 层的原始 IPC 同样不得绕过）→ 净化读取 → 定位条目 → 应用补丁 → 复验
/// 合并结果 → 原子写回；返回条目随写回携带净化诊断（仅在非空时附加）。
fn update_meta_with(library: &cap_std::fs::Dir, id: &str, patch: &Value) -> Result<Value, String> {
    validate_meta_patch(patch)?;
    let tags = normalize_tags(patch.get("tags"));
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    let (mut index, mut warnings) = read_index_capped(library)?;
    warnings.extend(recovery.warnings);
    let assets = index["assets"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?;
    let entry = assets
        .get_mut(id)
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    if let Some(n) = patch.get("name").and_then(|v| v.as_str()) {
        entry["name"] = json!(n.trim());
    }
    if let Some(k) = patch.get("kind").and_then(|v| v.as_str()) {
        entry["kind"] = json!(k);
    }
    if let Some(v) = patch.get("view") {
        // §7.2：view: null 是唯一清除标记，落盘删除可选字段
        if v.is_null() {
            entry.as_object_mut().unwrap().remove("view");
        } else {
            entry["view"] = v.clone();
        }
    }
    if patch.get("tags").is_some() {
        entry["tags"] = json!(tags);
    }
    if let Some(g) = patch.get("groupId") {
        apply_group_id(entry, g)?;
    }
    // 复验完整合并结果（§7.2）：groupId 存在性与「资产和组 kind 一致」——
    // 改 kind 或换编组后的条目若与当前组冲突，整次命令拒绝且不写盘，不得
    // 让成功的元信息编辑在下次读取时被归一化静默抹掉编组（评审修复，PR #33
    // 第九轮）
    let merged = entry.clone();
    if let Some(gid) = merged.get("groupId").and_then(Value::as_str) {
        let group_kind = index["groups"]["byId"]
            .get(gid)
            .and_then(|g| g.get("kind"))
            .and_then(Value::as_str);
        let entry_kind = merged.get("kind").and_then(Value::as_str);
        if group_kind.is_none() || group_kind != entry_kind {
            return Err(format!(
                "资产 {id} 的编组 {gid} 不存在或与资产 kind 不一致，拒绝更新"
            ));
        }
    }
    let mut updated = merged;
    write_index(library, &index)?;
    if !warnings.is_empty() {
        updated["warnings"] = json!(warnings);
    }
    updated["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(updated)
}

/// 更新条目元信息（改名/分类/视角/标签/编组）；id 与媒体文件不变。补丁
/// 值域校验在内核 update_meta_with 内强制（命令层与原始 IPC 同一口径）。
#[tauri::command]
pub fn library_update_meta(app: AppHandle, id: String, patch: Value) -> Result<Value, String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    update_meta_with(&library, &id, &patch)
}

#[cfg(test)]
mod media_protocol_tests;
#[cfg(test)]
mod tests;
