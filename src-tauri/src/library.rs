//! 个人资产库（docs/ui-design.md §8.1 / 数据模型 §7）：
//! 应用级 `library/` 目录跨项目复用——`library.json` 全量索引（内存过滤），
//! 媒体文件落 `library/assets/`，展示经 `pwmedia` 自定义协议按 id 懒加载
//! （§7.1 opaque asset URL，issue #26）。
//! 索引结构对前端自有（serde_json::Value 透传）。
//! 全部文件操作经 [`crate::library_fs`] 共享内核的受信锚定句柄执行（§7.1/§7.2
//! 信任链）：脏索引条目在读取时白名单隔离，删除经 `library/assets/` 专用根
//! 句柄逐组件 no-follow 定位——索引自身与库外路径不可达（issue #17）。

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
    let mut recovery = crate::library_journal::recover(&library)?;
    let (mut index, mut warnings) = read_index_capped(&library)?;
    warnings.append(&mut recovery.warnings);
    for id in &recovery.conflicted {
        if let Some(arr) = index["assets"].as_array_mut() {
            if let Some(e) = arr
                .iter_mut()
                .find(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                e["conflicted"] = json!(true);
            }
        }
        warnings.push(format!("资产 {id} 处于删除事务冲突期，暂不可用"));
    }
    index["warnings"] = json!(warnings);
    index["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(index)
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
        "view": null,
        "mime": mime,
        "relPath": format!("assets/{file_name}"),
        "tags": [],
        "groupId": null,
        "createdAt": now_ms(),
    });
    index["assets"]
        .as_array_mut()
        .ok_or("资产索引结构损坏")?
        .push(entry.clone());
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

/// 校验元信息补丁：字段白名单 + name/kind/view 取值合法性（S3776 拆分）。
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
    if let Some(n) = patch.get("name").and_then(|v| v.as_str()) {
        validate_name(n)?;
    }
    if let Some(k) = patch.get("kind").and_then(|v| v.as_str()) {
        validate_kind(k)?;
    }
    if let Some(s) = patch.get("view").and_then(|v| v.as_str()) {
        if !VIEWS.contains(&s) {
            return Err(format!("未知视角：{s}"));
        }
    }
    Ok(())
}

/// 应用 groupId 补丁：null/空白归 null；≤64 字符 trim 后写入。
fn apply_group_id(entry: &mut Value, g: &Value) -> Result<(), String> {
    match g {
        Value::Null => entry["groupId"] = json!(null),
        Value::String(s) if s.trim().is_empty() => entry["groupId"] = json!(null),
        Value::String(s) if s.len() <= 64 => entry["groupId"] = json!(s.trim()),
        _ => return Err("groupId 必须是 ≤64 字符的字符串或 null".into()),
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
    let (index, _) = read_index_capped(library)?;
    let entry = index["assets"]
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|a| a.get("id").and_then(Value::as_str) == Some(id))
        })
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

/// 媒体字节读取内核（句柄域，锁由调用方持有）：[`resolve_media_entry_with`]
/// 解析后复用 [`crate::assets::open_library_asset`] 的句柄链定位——最终
/// 组件 no-follow 拒绝符号链接、确认普通文件并按 (dev, ino) 身份绑定后
/// 受限读取（≤ ASSET_MAX_BYTES）。
pub(crate) fn media_bytes_with(
    library: &cap_std::fs::Dir,
    id: &str,
) -> Result<(String, Vec<u8>), String> {
    let (rel, mime) = resolve_media_entry_with(library, id)?;
    let file = crate::assets::open_library_asset(library, &rel)?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take((ASSET_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取资产 {id} 媒体失败：{e}"))?;
    if bytes.len() > ASSET_MAX_BYTES {
        return Err(format!("资产 {id} 的媒体超过 20 MiB 上限"));
    }
    Ok((mime, bytes))
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

/// `pwmedia` 协议处理器（lib.rs 注册；在 spawn_blocking 线程执行）：解析
/// 请求 → 锁内按当前日志/索引解析 id → 句柄链读字节 → 响应。§7.1 每次
/// 请求重新解析，目录项在列表后被替换也无法越出资产根。
pub(crate) fn handle_media_request(
    app: &AppHandle,
    uri: &tauri::http::Uri,
) -> tauri::http::Response<Vec<u8>> {
    let result = parse_media_uri(uri).and_then(|id| {
        let library = library_root(app)?;
        let _op = library_op_lock();
        let _file_lock = library_file_lock(&library)?;
        media_bytes_with(&library, &id)
    });
    media_http_response(result)
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

/// 更新元信息内核（句柄域）：净化读取 → 定位条目 → 应用补丁 → 原子写回；
/// 返回条目随写回携带净化诊断（评审修复，仅在非空时附加）。
fn update_meta_with(library: &cap_std::fs::Dir, id: &str, patch: &Value) -> Result<Value, String> {
    let tags = normalize_tags(patch.get("tags"));
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    let (mut index, mut warnings) = read_index_capped(library)?;
    warnings.extend(recovery.warnings);
    let assets = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let entry = assets
        .iter_mut()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    if let Some(n) = patch.get("name").and_then(|v| v.as_str()) {
        entry["name"] = json!(n.trim());
    }
    if let Some(k) = patch.get("kind").and_then(|v| v.as_str()) {
        entry["kind"] = json!(k);
    }
    if let Some(v) = patch.get("view") {
        entry["view"] = v.clone();
    }
    if patch.get("tags").is_some() {
        entry["tags"] = json!(tags);
    }
    if let Some(g) = patch.get("groupId") {
        apply_group_id(entry, g)?;
    }
    let mut updated = entry.clone();
    write_index(library, &index)?;
    if !warnings.is_empty() {
        updated["warnings"] = json!(warnings);
    }
    updated["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(updated)
}

/// 更新条目元信息（改名/分类/视角/标签/编组）；id 与媒体文件不变。
#[tauri::command]
pub fn library_update_meta(app: AppHandle, id: String, patch: Value) -> Result<Value, String> {
    validate_asset_id(&id)?;
    validate_meta_patch(&patch)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    update_meta_with(&library, &id, &patch)
}

#[cfg(test)]
mod tests;
