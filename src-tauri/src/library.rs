//! 个人资产库（docs/ui-design.md §8.1 / 数据模型 §7）：
//! 应用级 `library/` 目录跨项目复用——`library.json` 全量索引（内存过滤），
//! 媒体文件落 `library/assets/`，懒加载经 asset 协议直读。
//! 索引结构对前端自有（serde_json::Value 透传）。
//! 全部文件操作经 [`crate::library_fs`] 共享内核的受信锚定句柄执行（§7.1/§7.2
//! 信任链）：脏索引条目在读取时白名单隔离，删除经 `library/assets/` 专用根
//! 句柄逐组件 no-follow 定位——索引自身与库外路径不可达（issue #17）。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::library_fs::{
    assets_root, atomic_write_with, ensure_index_size, library_root, read_index_capped,
    validate_asset_id, write_index,
};
use crate::store::is_canonical_mime;

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

/// 供前端 convertFileSrc 拼接媒体绝对路径（阶段 2 收敛进 opaque asset URL）。
#[tauri::command]
pub fn library_dir_path(app: AppHandle) -> Result<String, String> {
    // 先经信任链确保库目录存在并校验（符号链接/异型拒绝）
    library_root(&app)?;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("library")
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "资产库路径含非法字符".to_string())
}

/// 列出全量索引（启动时一次载入，前端内存过滤，§8.1）：先按 §7.2 恢复
/// 删除日志中的未完成事务，脏索引条目由共享内核隔离，`warnings` 与
/// `cleanupPending` 随索引返回，冲突期条目标记 `conflicted` 不可用。
#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<Value, String> {
    let library = library_root(&app)?;
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

/// 删除资产命令：日志驱动的身份绑定隔离事务（§7.2）——响应携带净化
/// 诊断与 cleanupPending。移除索引项并把媒体隔离进 .trash/。
#[tauri::command]
pub fn library_delete(app: AppHandle, id: String) -> Result<Value, String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
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
    update_meta_with(&library, &id, &patch)
}

#[cfg(test)]
mod tests;
