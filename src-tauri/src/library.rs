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
    assets_root, atomic_write_with, library_root, read_index_capped, remove_asset_file,
    validate_asset_id, INDEX_FILE_NAME,
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

/// 列出全量索引（启动时一次载入，前端内存过滤，§8.1）：脏索引条目已由
/// 共享内核隔离，非法条目以 `warnings` 清单随索引返回。
#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<Value, String> {
    let library = library_root(&app)?;
    let (mut index, warnings) = read_index_capped(&library)?;
    index["warnings"] = json!(warnings);
    Ok(index)
}

/// 导入资产内核（句柄域）：mime 信任边界（trim + 小写后必须规范形）、媒体
/// 经 `library/assets/` 专用根句柄原子落盘（新 id，库自包含），索引净化
/// 读取后追加并落盘，返回新条目。
fn put_asset_with(
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
    let assets = assets_root(library)?;
    let (mut index, _) = read_index_capped(library)?;
    let id = format!("la-{:x}-{}", now_ms(), bytes.len());
    let file_name = format!("{}.{}", id, ext_for(name, &mime));
    atomic_write_with(&assets, &file_name, |dst| {
        std::io::Write::write_all(dst, bytes).map(|_| ())
    })?;
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
    write_index(library, &index)?;
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

/// 索引原子落盘：全程相对库根锚定句柄，复用 store 的 §10.2 替换语义原子
/// 写内核（排他临时文件 + rename 前复核 + 持久性屏障），不按路径名重解析；
/// 调用方传入的索引应为净化后视图。
fn write_index(library: &cap_std::fs::Dir, index: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(index).map_err(|e| format!("序列化索引失败：{e}"))?;
    crate::store::atomic_write(library, INDEX_FILE_NAME, &text)
}

/// 删除资产内核（句柄域）：先在净化后索引中定位条目（隔离条目不可达）→
/// 媒体文件经 `library/assets/` 专用根句柄逐组件 no-follow 删除（越界/
/// 符号链接拒绝、缺失幂等）→ 原子更新索引。先删文件后改索引：索引落盘
/// 失败只留下一次可重试的悬挂条目，不会留下索引已删而文件仍在的孤儿。
fn delete_asset_with(library: &cap_std::fs::Dir, id: &str) -> Result<(), String> {
    let (mut index, _) = read_index_capped(library)?;
    let assets = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let pos = assets
        .iter()
        .position(|a| a.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    let rel = assets[pos]
        .get("relPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    remove_asset_file(library, &rel)?;
    assets.remove(pos);
    write_index(library, &index)
}

/// 删除资产命令：移除索引项并删除媒体文件。
#[tauri::command]
pub fn library_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
    delete_asset_with(&library, &id)
}

/// 更新条目元信息（改名/分类/视角/标签/编组）；id 与媒体文件不变。
#[tauri::command]
pub fn library_update_meta(app: AppHandle, id: String, patch: Value) -> Result<Value, String> {
    validate_asset_id(&id)?;
    validate_meta_patch(&patch)?;
    let tags = normalize_tags(patch.get("tags"));

    let library = library_root(&app)?;
    let (mut index, _) = read_index_capped(&library)?;
    let assets = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let entry = assets
        .iter_mut()
        .find(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str()))
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
    write_index(&library, &index)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::new_id;
    use cap_std::ambient_authority;
    use cap_std::fs::Dir as CapDir;
    use serde_json::json;
    use std::fs;
    use std::io::Write as _;
    use std::path::{Path, PathBuf};

    /// 测试内核的受信句柄：对临时目录做环境打开（等价生产端锚定句柄）。
    fn cap(p: &Path) -> CapDir {
        CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
    }

    /// 唯一临时根：`{tmp}/pw-library-test-{new_id}/` 下含 `library/assets/`；
    /// 返回 (library, root)——root 供库外受害者文件与清理。
    fn temp_fixture() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("pw-library-test-{}", new_id()));
        fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
        (root.join("library"), root)
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    /// 直接按字节写脏索引（绕过写入内核，模拟手工修改/损坏的 library.json）。
    fn write_index_raw(library: &Path, index: &Value) {
        let mut f = fs::File::create(library.join("library.json")).expect("创建索引文件");
        f.write_all(serde_json::to_string(index).expect("序列化").as_bytes())
            .expect("写入索引");
    }

    /// 最小索引条目（relPath 按需投毒）。
    fn entry(id: &str, rel: &str) -> Value {
        json!({
            "id": id,
            "name": "x",
            "kind": "other",
            "mime": "image/png",
            "relPath": rel,
        })
    }

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

    // ---- 脏索引安全回归（issue #17 阶段 1：场景 1-3 + 符号链接 + 隔离）----

    /// 场景 1：relPath = "library.json" 通过旧 `!contains("..")` 检查，可删除
    /// 全库索引——修复后条目被隔离，索引文件必须幸存。
    #[test]
    fn delete_refuses_poisoned_index_self_target() {
        let (library, root) = temp_fixture();
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "library.json")], "groups": [] }),
        );
        let err = delete_asset_with(&cap(&library), "la-1").expect_err("脏条目应拒绝删除");
        assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
        assert!(
            fs::metadata(library.join("library.json")).is_ok(),
            "索引自身不得被删除"
        );
        cleanup(&root);
    }

    /// 场景 2：绝对路径 relPath 借 `Path::join` 整体替换基路径，旧实现可删除
    /// 应用沙箱外任意文件——修复后条目被隔离，库外受害者文件必须幸存。
    #[test]
    fn delete_refuses_absolute_rel_path_outside_library() {
        let (library, root) = temp_fixture();
        let victim = root.join("victim.png");
        fs::write(&victim, b"VICTIM").expect("写库外受害者文件");
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", victim.to_str().unwrap())], "groups": [] }),
        );
        let err = delete_asset_with(&cap(&library), "la-1").expect_err("绝对路径应拒绝");
        assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
        assert_eq!(fs::read(&victim).expect("受害者文件必须幸存"), b"VICTIM");
        cleanup(&root);
    }

    /// 场景 3：不含 `..` 的相对名（如 "settings.json"）旧实现可删除库根下
    /// assets/ 之外的任意文件——修复后词法校验要求首段 assets，条目被隔离。
    #[test]
    fn delete_refuses_relative_name_outside_assets() {
        let (library, root) = temp_fixture();
        fs::write(library.join("settings.json"), b"{}").expect("写库根非资产文件");
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "settings.json")], "groups": [] }),
        );
        let err = delete_asset_with(&cap(&library), "la-1").expect_err("assets/ 外相对名应拒绝");
        assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
        assert_eq!(
            fs::read(library.join("settings.json")).expect("库内非资产文件必须幸存"),
            b"{}"
        );
        assert!(
            fs::metadata(library.join("library.json")).is_ok(),
            "索引自身必须幸存"
        );
        cleanup(&root);
    }

    /// 中间组件为符号链接：旧实现路径解析逃逸出 assets/——修复后逐组件
    /// no-follow 绑定打开，链外目标文件必须幸存。
    #[cfg(unix)]
    #[test]
    fn delete_refuses_symlinked_parent_component() {
        let (library, root) = temp_fixture();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).expect("建链外目录");
        fs::write(outside.join("g.png"), b"G").expect("写链外目标文件");
        std::os::unix::fs::symlink(&outside, library.join("assets").join("sub"))
            .expect("建符号链接目录");
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "assets/sub/g.png")], "groups": [] }),
        );
        let err = delete_asset_with(&cap(&library), "la-1").expect_err("符号链接中间组件应拒绝");
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        assert_eq!(
            fs::read(outside.join("g.png")).expect("链外目标文件必须幸存"),
            b"G"
        );
        cleanup(&root);
    }

    /// 终点被换成目录：归类为非普通文件即拒绝，不得误删。
    #[test]
    fn delete_refuses_non_file_target() {
        let (library, root) = temp_fixture();
        fs::create_dir_all(library.join("assets").join("la-1.png")).expect("把目标换成目录");
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
        );
        let err = delete_asset_with(&cap(&library), "la-1").expect_err("非普通文件目标应拒绝");
        assert!(err.contains("不是普通文件"), "意外诊断：{err}");
        assert!(
            fs::metadata(library.join("assets").join("la-1.png")).is_ok(),
            "目标目录必须幸存"
        );
        cleanup(&root);
    }

    /// 绿路径：合法条目删除媒体文件并原子更新索引；文件缺失幂等成功。
    #[test]
    fn delete_removes_media_updates_index_and_is_idempotent_on_missing_file() {
        let (library, root) = temp_fixture();
        fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体文件");
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
        );
        delete_asset_with(&cap(&library), "la-1").expect("删除应成功");
        assert!(
            fs::metadata(library.join("assets").join("la-1.png")).is_err(),
            "媒体文件应被删除"
        );
        let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
        assert!(!raw.contains("la-1"), "索引条目应被移除：{raw}");
        // 媒体已不存在的合法条目：再次删除幂等成功
        write_index_raw(
            &library,
            &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
        );
        delete_asset_with(&cap(&library), "la-1").expect("缺失媒体应幂等成功");
        cleanup(&root);
    }

    /// 索引读取逐条目白名单：非法条目隔离出内存索引并逐条携带警告。
    #[test]
    fn read_index_quarantines_illegal_entries_with_warnings() {
        let (library, root) = temp_fixture();
        write_index_raw(
            &library,
            &json!({
                "assets": [
                    entry("la-ok", "assets/ok.png"),
                    entry("la-bad", "../escape.png"),
                    entry("la-abs", "/etc/passwd"),
                    entry("bad id", "assets/x.png"),
                    { "id": "la-nomime", "relPath": "assets/x.png", "mime": "not a mime" },
                ],
                "groups": [],
            }),
        );
        let (index, warnings) = crate::library_fs::read_index_capped(&cap(&library))
            .expect("含非法条目的索引应可读（条目级隔离，不整册拒绝）");
        let ids: Vec<&str> = index["assets"]
            .as_array()
            .expect("assets 数组")
            .iter()
            .filter_map(|a| a.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["la-ok"], "仅合法条目可进内存索引");
        assert_eq!(warnings.len(), 4, "每条非法条目一条警告：{warnings:?}");
        cleanup(&root);
    }

    /// 索引读取大小上限：超过 1 MiB 上限在物化前显式拒绝。
    #[test]
    fn read_index_enforces_size_cap() {
        let (library, root) = temp_fixture();
        let pad = "a".repeat(1024 * 1024 + 1);
        write_index_raw(&library, &json!({ "assets": [], "groups": [], "pad": pad }));
        let err = crate::library_fs::read_index_capped(&cap(&library)).expect_err("超限索引应拒绝");
        assert!(err.contains("上限"), "意外诊断：{err}");
        cleanup(&root);
    }

    /// 索引缺失回退默认空索引（首启/被清理后库仍可用）。
    #[test]
    fn read_index_missing_falls_back_to_default() {
        let (library, root) = temp_fixture();
        let (index, warnings) =
            crate::library_fs::read_index_capped(&cap(&library)).expect("缺失索引应回退默认");
        assert_eq!(index["assets"].as_array().map(Vec::len), Some(0));
        assert!(warnings.is_empty());
        cleanup(&root);
    }

    /// 导入绿路径：媒体原子落盘 assets/、索引追加新条目、mime 规范化。
    #[test]
    fn put_writes_media_and_appends_entry() {
        let (library, root) = temp_fixture();
        let e = put_asset_with(&cap(&library), "立绘.png", "image/png", "character", b"PNG")
            .expect("导入应成功");
        assert!(e["id"].as_str().unwrap_or_default().starts_with("la-"));
        let rel = e["relPath"].as_str().unwrap_or_default();
        assert!(
            rel.starts_with("assets/la-") && rel.ends_with(".png"),
            "relPath：{rel}"
        );
        assert_eq!(e["mime"].as_str(), Some("image/png"));
        let file = library
            .join("assets")
            .join(rel.strip_prefix("assets/").expect("前缀"));
        assert_eq!(fs::read(&file).expect("媒体文件"), b"PNG");
        let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
        assert!(
            raw.contains(e["id"].as_str().unwrap_or_default()),
            "索引应含新条目"
        );
        cleanup(&root);
    }

    /// 导入 mime 信任边界：非规范形式在写盘前拒绝。
    #[test]
    fn put_rejects_non_canonical_mime() {
        let (library, root) = temp_fixture();
        let err = put_asset_with(&cap(&library), "a.png", "not a mime", "other", b"A")
            .expect_err("非法 mime 应拒绝");
        assert!(err.contains("mime"), "意外诊断：{err}");
        let files = fs::read_dir(library.join("assets"))
            .expect("读资产目录")
            .count();
        assert_eq!(files, 0, "拒绝导入不得留下媒体文件");
        cleanup(&root);
    }
}
