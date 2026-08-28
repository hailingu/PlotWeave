//! 个人资产库（docs/ui-design.md §8.1 / 数据模型 §7）：
//! 应用级 `library/` 目录跨项目复用——`library.json` 全量索引（内存过滤），
//! 媒体文件落 `library/assets/`，懒加载经 asset 协议直读。
//! 索引结构对前端自有（serde_json::Value 透传），仅校验大小与字段安全。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager};

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

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("library");
    fs::create_dir_all(&dir).map_err(|e| format!("创建资产库目录失败：{e}"))?;
    Ok(dir)
}

fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = library_dir(app)?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建资产目录失败：{e}"))?;
    Ok(dir)
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_dir(app)?.join("library.json"))
}

/// 供前端 convertFileSrc 拼接媒体绝对路径。
#[tauri::command]
pub fn library_dir_path(app: AppHandle) -> Result<String, String> {
    library_dir(&app)?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "资产库路径含非法字符".to_string())
}

fn default_index() -> serde_json::Value {
    json!({ "assets": [], "groups": [] })
}

fn read_index(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = index_path(app)?;
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("资产索引损坏：{e}")),
        Err(_) => Ok(default_index()),
    }
}

fn write_index(app: &AppHandle, index: &serde_json::Value) -> Result<(), String> {
    let path = index_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(index).map_err(|e| format!("序列化索引失败：{e}"))?;
    fs::write(&tmp, text).map_err(|e| format!("写入索引失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("落盘索引失败：{e}"))
}

/// id 约束：文件名安全字符集（同项目 id 规则）。
fn validate_asset_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法资产 id：{id}"))
    }
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

fn normalize_tags(raw: Option<&serde_json::Value>) -> Vec<String> {
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
fn ext_for(name: &str, mime: &str) -> String {
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

/// 列出全量索引（启动时一次载入，前端内存过滤，§8.1）。
#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<serde_json::Value, String> {
    read_index(&app)
}

/// 导入资产：媒体拷入 assets/（新 id，库自包含），索引追加并返回新条目。
#[tauri::command]
pub fn library_put(
    app: AppHandle,
    name: String,
    mime: String,
    kind: String,
    bytes: Vec<u8>,
) -> Result<serde_json::Value, String> {
    validate_name(&name)?;
    validate_kind(&kind)?;
    if bytes.is_empty() {
        return Err("文件内容为空".into());
    }
    if bytes.len() > ASSET_MAX_BYTES {
        return Err("文件超过 20 MiB 上限".into());
    }
    let id = format!("la-{:x}-{}", now_ms(), bytes.len());
    let file_name = format!("{}.{}", id, ext_for(&name, &mime));
    let target = assets_dir(&app)?.join(&file_name);
    fs::write(&target, &bytes).map_err(|e| format!("写入资产文件失败：{e}"))?;

    let mut index = read_index(&app)?;
    let entry = json!({
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
    write_index(&app, &index)?;
    Ok(entry)
}

/// 校验元信息补丁：字段白名单 + name/kind/view 取值合法性（S3776 拆分）。
fn validate_meta_patch(patch: &serde_json::Value) -> Result<(), String> {
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
fn apply_group_id(entry: &mut serde_json::Value, g: &serde_json::Value) -> Result<(), String> {
    match g {
        serde_json::Value::Null => entry["groupId"] = json!(null),
        serde_json::Value::String(s) if s.trim().is_empty() => entry["groupId"] = json!(null),
        serde_json::Value::String(s) if s.len() <= 64 => entry["groupId"] = json!(s.trim()),
        _ => return Err("groupId 必须是 ≤64 字符的字符串或 null".into()),
    }
    Ok(())
}

/// 更新条目元信息（改名/分类/视角/标签/编组）；id 与媒体文件不变。
#[tauri::command]
pub fn library_update_meta(
    app: AppHandle,
    id: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    validate_asset_id(&id)?;
    validate_meta_patch(&patch)?;
    let tags = normalize_tags(patch.get("tags"));

    let mut index = read_index(&app)?;
    let assets = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let entry = assets
        .iter_mut()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
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
    let updated = entry.clone();
    write_index(&app, &index)?;
    Ok(updated)
}

/// 删除资产：移除索引项并删除媒体文件（文件缺失不报错，幂等）。
#[tauri::command]
pub fn library_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_asset_id(&id)?;
    let mut index = read_index(&app)?;
    let assets = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let before = assets.len();
    let removed: Vec<serde_json::Value> = assets
        .iter()
        .filter(|a| a.get("id").and_then(|v| v.as_str()) != Some(id.as_str()))
        .cloned()
        .collect();
    if removed.len() == before {
        return Err(format!("资产不存在：{id}"));
    }
    let rel = index["assets"]
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                .and_then(|a| a.get("relPath"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    index["assets"] = json!(removed);
    write_index(&app, &index)?;
    // 媒体文件按索引 relPath 清理；越界路径（含 ..）直接拒绝
    if !rel.is_empty() && !rel.contains("..") {
        let path = library_dir(&app)?.join(&rel);
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_id_rules() {
        assert!(validate_asset_id("la-18f-1024").is_ok());
        assert!(validate_asset_id("").is_err());
        assert!(validate_asset_id("../evil").is_err());
    }

    #[test]
    fn name_and_kind_rules() {
        assert!(validate_name("女主·林晚 三视图").is_ok());
        assert!(validate_name("   ").is_err());
        assert!(validate_kind("wardrobe").is_ok());
        assert!(validate_kind("prop").is_err());
    }

    #[test]
    fn ext_mapping_prefers_name_and_falls_back_to_mime() {
        assert_eq!(ext_for("立绘.PNG", "image/png"), "png");
        assert_eq!(ext_for("noext", "image/webp"), "webp");
        assert_eq!(ext_for("noext", "application/x-unknown"), "bin");
        assert_eq!(ext_for("bad.<script>", "image/png"), "png");
    }
}
