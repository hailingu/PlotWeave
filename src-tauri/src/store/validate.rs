//! 保存边界校验与资产实路径复验（数据模型 §10.5/§7.1）：信封形状
//! 只验证不修复、异型值整次拒绝；relPath 实路径以受信根锚定句柄逐组件
//! no-follow 复验（加载侧与保存侧共用内核）；prepare_save 在任何
//! 落盘动作之前完成全部校验并盖戳 updatedAt。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::{is_canonical_utc_timestamp, is_valid_iso8601, now_iso};
use crate::store::persist::{asset_identity, asset_stat, open_dir_bound, projects_dir};
use crate::store::types::{sanitize_name, validate_id, ProjectFile, ProjectInfo};
/// 当前支持的文档版本（§3）。
const CURRENT_SCHEMA_VERSION: u32 = 1;
/// RFC 9110 tchar 且排除 `*`（索引不保存通配媒体类型，§7.1）。
fn is_mime_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}
/// 规范 MIME 形式（§7.1）：已去首尾空白、已小写、恰好两个具体 token 以 `/` 分隔。
pub(crate) fn is_canonical_mime(s: &str) -> bool {
    if s != s.trim() || s != s.to_ascii_lowercase() {
        return false;
    }
    let mut parts = s.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(t), Some(st), None) => is_mime_token(t) && is_mime_token(st),
        _ => false,
    }
}
/// 词法 relPath（§7.1）：纯相对路径（正斜杠分隔，拒绝绝对路径/盘符/反斜杠），
/// 解析目标必须位于项目资产子目录内——首段固定 `assets`，组件不含空段/`.`/`..`。
pub(crate) fn is_valid_asset_rel_path(p: &str) -> bool {
    if p.is_empty() || p != p.trim() {
        return false;
    }
    if p.starts_with('/') || p.contains('\\') {
        return false;
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return false;
    }
    let mut comps = p.split('/');
    if comps.next() != Some("assets") {
        return false;
    }
    let mut rest = 0;
    for c in comps {
        if c.is_empty() || c == "." || c == ".." {
            return false;
        }
        rest += 1;
    }
    rest > 0
}
/// 规范集号键（§11.1 第 3 步同域）：无前导零的十进制正整数，且在安全整数范围。
fn is_canonical_episode_key(k: &str) -> bool {
    if k.is_empty() || !k.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if k.len() > 1 && k.starts_with('0') {
        return false;
    }
    match k.parse::<u64>() {
        Ok(v) => (1..=9_007_199_254_740_991).contains(&v),
        Err(_) => false,
    }
}
fn validate_save_graph(graph: &serde_json::Value) -> Result<(), String> {
    let g = graph.as_object().ok_or("graph 必须是普通对象")?;
    if !matches!(g.get("nodes"), Some(v) if v.is_array()) {
        return Err("graph.nodes 必须是数组".into());
    }
    if !matches!(g.get("edges"), Some(v) if v.is_array()) {
        return Err("graph.edges 必须是数组".into());
    }
    if let Some(vp) = g.get("viewport") {
        let vp = vp.as_object().ok_or("graph.viewport 必须是普通对象")?;
        let finite = |k: &str| vp.get(k).and_then(|v| v.as_f64()).filter(|f| f.is_finite());
        if finite("x").is_none() || finite("y").is_none() {
            return Err("graph.viewport 的 x/y 必须是有限数值".into());
        }
        if !matches!(finite("zoom"), Some(z) if z > 0.0) {
            return Err("graph.viewport.zoom 必须是正有限数".into());
        }
    }
    Ok(())
}
fn validate_save_settings(settings: &serde_json::Value) -> Result<(), String> {
    let s = settings.as_object().ok_or("settings 必须是普通对象")?;
    // 四桶必须齐备且均为普通对象（§10.5 持久化信任边界）：缺桶落盘后下次
    // 加载被归一化为空 Record，既有内容永久丢失——不能只校验碰巧在场的桶
    for bucket in ["characters", "locations", "props", "documents"] {
        match s.get(bucket) {
            Some(v) if v.is_object() => {}
            Some(_) => return Err(format!("settings.{bucket} 必须是普通对象")),
            None => {
                return Err(format!(
                    "settings.{bucket} 缺失，拒绝保存（缺桶会在下次加载被归一化为空）"
                ));
            }
        }
    }
    Ok(())
}
fn validate_save_episode_titles(titles: &serde_json::Value) -> Result<(), String> {
    let t = titles.as_object().ok_or("episodeTitles 必须是普通对象")?;
    for (k, v) in t {
        if !is_canonical_episode_key(k) {
            return Err(format!("episodeTitles 键 {k:?} 不是规范十进制正整数"));
        }
        let Some(title) = v.as_str() else {
            return Err(format!("episodeTitles[{k:?}] 的值必须是字符串"));
        };
        // 值域与 set_episode_title 同域（落盘前 trim、去空白后非空）：
        // 空白/带空白标题若放行，下次加载被 trim/删除并触发修复回写——
        // 保存边界接受过的文档不得重开即变
        if title.trim() != title || title.trim().is_empty() {
            return Err(format!("episodeTitles[{k:?}] 的标题须为去空白后的非空串"));
        }
    }
    Ok(())
}
/// §7.1 完整 AssetRef 形状 + Record 键/id 一致性 + 规范形式（MIME/时间戳）。
/// 保存边界不替调用方修复：非规范值直接拒绝，避免内存与落盘分叉。
fn validate_save_assets(assets: &serde_json::Value) -> Result<(), String> {
    let a = assets.as_object().ok_or("assets 必须是普通对象")?;
    let by_id = a
        .get("byId")
        .and_then(|v| v.as_object())
        .ok_or("assets.byId 必须是普通对象")?;
    for (key, entry) in by_id {
        let e = entry
            .as_object()
            .ok_or_else(|| format!("资产 {key} 必须是普通对象"))?;
        let get_str = |f: &str| e.get(f).and_then(|v| v.as_str());
        match get_str("id") {
            // 空白 id（§8.1 共同值域 trim 口径，键与内嵌 id 一致时同论）在
            // 加载侧会被空白键重发改写身份并重连引用——保存边界接受的
            // 数据重开即变 id，按非规范值整次拒绝
            Some(eid) if !eid.trim().is_empty() && eid == key => {}
            _ => return Err(format!("资产 {key} 的内嵌 id 空白或与 Record 键不一致")),
        }
        match get_str("relPath") {
            Some(p) if is_valid_asset_rel_path(p) => {}
            _ => return Err(format!("资产 {key} 的 relPath 非法或越出资产子目录")),
        }
        match get_str("mime") {
            Some(m) if is_canonical_mime(m) => {}
            _ => return Err(format!("资产 {key} 的 mime 非规范形式")),
        }
        match get_str("source") {
            Some("upload") | Some("generated") => {}
            _ => return Err(format!("资产 {key} 的 source 非法")),
        }
        match get_str("createdAt") {
            Some(t) if is_canonical_utc_timestamp(t) => {}
            _ => {
                return Err(format!(
                    "资产 {key} 的 createdAt 不是规范 UTC 时间戳（toISOString 形）"
                ))
            }
        }
    }
    Ok(())
}
/// §10.5 保存边界——资产实路径复验（relPath 词法校验之外的文件系统事实）。
/// 当前扁平布局下项目资产根为 `projects/{id}/`（§10.1 目录化布局随 §7.1 落地
/// 后由同一函数承接）：全程相对 projects_dir 返回的**受信根锚定句柄**解析
/// （§10.2 openat 语义，cap-std 沙箱保证不逃出 projects/，canonical 路径比对
/// 不再需要——路径名比对在校验期间被整体替换的 projects/ 上会验到替换树）。
/// 项目资产根现存时必须是非符号链接的实际目录（open_dir_bound 身份绑定），
/// 随后对 relPath 逐组件 `symlink_metadata` 拒绝符号链接（no-follow）、中间
/// 组件须为目录（逐级 open_dir_bound 绑定身份），终点必须是普通文件且打开
/// 句柄按 (dev, ino) 与归类实体一致（Unix）——校验与打开之间被替换（含换成
/// 符号链接或另一实体）即拒绝，句柄返回给调用方持有至保存完成后释放。
/// 校验与落盘之间被替换的残余窗口由加载侧复验（verify_project_assets）在
/// 下次打开时隔离兜底。
pub(crate) fn verify_asset_real_path(
    root: &CapDir,
    id: &str,
    rel_path: &str,
) -> Result<cap_std::fs::File, String> {
    let root_md = root
        .symlink_metadata(id)
        .map_err(|_| format!("项目资产根不存在，资产文件不存在：{rel_path}"))?;
    if root_md.file_type().is_symlink() {
        return Err(format!("项目资产根是符号链接，拒绝校验资产：{rel_path}"));
    }
    if !root_md.is_dir() {
        return Err(format!("项目资产根不是目录，资产文件不存在：{rel_path}"));
    }
    let mut dir = open_dir_bound(root, id, &root_md, "项目资产根")?;
    let comps: Vec<&str> = rel_path.split('/').collect();
    let Some((last, parents)) = comps.split_last() else {
        return Err(format!("资产路径为空：{rel_path}"));
    };
    for comp in parents {
        let md = asset_stat(&dir, comp, rel_path)?;
        if md.file_type().is_symlink() {
            return Err(format!("资产路径含符号链接：{rel_path}"));
        }
        if !md.is_dir() {
            return Err(format!("资产路径的中间组件不是目录：{rel_path}"));
        }
        dir = open_dir_bound(&dir, comp, &md, "资产中间目录")?;
    }
    let md = asset_stat(&dir, last, rel_path)?;
    if md.file_type().is_symlink() {
        return Err(format!("资产路径含符号链接：{rel_path}"));
    }
    if !md.is_file() {
        return Err(format!("资产路径不是普通文件：{rel_path}"));
    }
    let file = dir
        .open(last)
        .map_err(|e| format!("打开资产文件失败（{rel_path}）：{e}"))?;
    #[cfg(unix)]
    {
        let fm = file
            .metadata()
            .map_err(|e| format!("读取资产句柄元数据失败（{rel_path}）：{e}"))?;
        if asset_identity(&fm) != asset_identity(&md) {
            return Err(format!("资产文件在校验期间被替换：{rel_path}"));
        }
    }
    Ok(file)
}
/// §10.5：保存前逐项复验资产 relPath 的真实路径。relPath 词法非法（§7.1）
/// 或字段形状缺失的条目交给 prepare_save 的信封诊断，此处跳过避免重复误报。
/// 返回已验证资产的打开句柄——调用方持有至保存完成后释放，期间实体不可
/// 被替换为未验证目标（句柄绑定见 verify_asset_real_path）。
pub(crate) fn verify_save_asset_files(
    root: &CapDir,
    id: &str,
    assets: &serde_json::Value,
) -> Result<Vec<cap_std::fs::File>, String> {
    let mut handles = Vec::new();
    let Some(by_id) = assets.get("byId").and_then(|v| v.as_object()) else {
        return Ok(handles);
    };
    for (key, entry) in by_id {
        let Some(rel) = entry.get("relPath").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_valid_asset_rel_path(rel) {
            continue;
        }
        let handle =
            verify_asset_real_path(root, id, rel).map_err(|e| format!("资产 {key}：{e}"))?;
        handles.push(handle);
    }
    Ok(handles)
}
/// §7.1/§10.5 加载侧资产实路径复验内核：返回文档 assets.byId 中词法合法、
/// 但以受信资产根 no-follow 验证失败（缺失/符号链接/非普通文件/逃逸）的
/// 记录键。词法非法或形状缺失的条目不在此报告——前端形状归一化负责隔离。
fn unverifiable_asset_keys(root: &CapDir, id: &str, assets: &serde_json::Value) -> Vec<String> {
    let mut bad = Vec::new();
    let Some(by_id) = assets.get("byId").and_then(|v| v.as_object()) else {
        return bad;
    };
    for (key, entry) in by_id {
        let Some(rel) = entry.get("relPath").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_valid_asset_rel_path(rel) {
            continue;
        }
        if verify_asset_real_path(root, id, rel).is_err() {
            bad.push(key.clone());
        }
    }
    bad
}
/// 加载侧资产复验命令：调用方回传刚加载文档的资产索引（避免二次读盘），
/// 返回不可验证键，交前端归一化层隔离——否则下一次保存会被保存边界
/// 拒收，防抖静默吞错后用户编辑永不落盘。加载本身保持只读；复验相对
/// projects_dir 的受信根锚定句柄执行。
#[tauri::command]
pub fn verify_project_assets(
    app: AppHandle,
    id: String,
    assets: serde_json::Value,
) -> Result<Vec<String>, String> {
    validate_id(&id)?;
    let root = projects_dir(&app)?;
    Ok(unverifiable_asset_keys(&root, &id, &assets))
}
/// save_project 的信封校验与规范化（§10.5）：在创建临时文件、生成保存时间
/// 或更新索引之前完成——任一校验失败整次拒绝，不得静默剥离。全部通过后
/// 以受信路径参数覆盖 id，并由 Rust 为本次尝试只取一次系统时间无条件盖戳
/// updatedAt（不信任旧值、未来值或前端时钟）。
pub(crate) fn prepare_save(id: &str, doc: &ProjectFile) -> Result<ProjectFile, String> {
    if doc.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "文档版本不受支持（schemaVersion {}），拒绝保存",
            doc.schema_version
        ));
    }
    let name = sanitize_name(&doc.project.name)?;
    if let Some(d) = &doc.project.description {
        if !d.is_string() {
            return Err("project.description 非字符串，拒绝保存".into());
        }
    }
    if !is_valid_iso8601(&doc.project.created_at) {
        return Err("project.createdAt 不是可解析的 ISO 8601 时间戳".into());
    }
    if !is_valid_iso8601(&doc.project.updated_at) {
        return Err("project.updatedAt 不是可解析的 ISO 8601 时间戳".into());
    }
    validate_save_graph(&doc.graph)?;
    validate_save_settings(&doc.settings)?;
    validate_save_episode_titles(&doc.episode_titles)?;
    validate_save_assets(&doc.assets)?;
    Ok(ProjectFile {
        schema_version: doc.schema_version,
        versionless: false,
        project: ProjectInfo {
            id: id.to_string(),
            name,
            description: doc.project.description.clone(),
            created_at: doc.project.created_at.clone(),
            updated_at: now_iso(),
        },
        graph: doc.graph.clone(),
        settings: doc.settings.clone(),
        episode_titles: doc.episode_titles.clone(),
        assets: doc.assets.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
    use crate::store::types::new_project_file;
    use serde_json::json;
    use std::fs;

    #[test]
    fn save_rejects_missing_settings_buckets() {
        // 缺桶落盘后下次加载被归一化为空 Record，既有 characters/locations/
        // props/documents 永久丢失——持久化信任边界（§10.5）要求四桶齐备且
        // 均为普通对象，而不是只校验碰巧在场的桶
        let mut doc = valid_save_doc();
        doc.settings = json!({});
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.settings = json!({ "characters": {}, "locations": {}, "props": {} });
        let err = prepare_save("p-1", &doc).unwrap_err();
        assert!(err.contains("documents"), "错误应指名缺失的桶：{err}");
        // 四桶齐备才放行
        assert!(prepare_save("p-1", &valid_save_doc()).is_ok());
    }

    #[test]
    fn save_rejects_unsupported_schema_version() {
        // schemaVersion 999 落盘后下次加载按未来版本拒绝（§11.1 第 0 步）；
        // 保存边界必须先行拦截
        let mut doc = valid_save_doc();
        doc.schema_version = 999;
        assert!(prepare_save("p-1", &doc).is_err());
        doc.schema_version = 0;
        assert!(prepare_save("p-1", &doc).is_err());
    }

    #[test]
    fn save_rejects_alien_top_level_containers() {
        // graph: null 之类的载荷若落盘，下次加载会被归一化重置为空图，
        // 把无法判型的损坏静默变成内容丢失（§10.5）——保存边界整次拒绝
        let mut doc = valid_save_doc();
        doc.graph = json!(null);
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.graph = json!({ "nodes": {}, "edges": [] });
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.settings = json!([]);
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.settings = json!({ "characters": [] });
        assert!(prepare_save("p-1", &doc).is_err());
        // 数组型标题表落盘后下次加载被重置为 {}，标题静默丢失
        let mut doc = valid_save_doc();
        doc.episode_titles = json!(["第一集"]);
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.assets = json!({ "byId": [] });
        assert!(prepare_save("p-1", &doc).is_err());
    }

    #[test]
    fn save_rejects_bad_project_metadata_and_viewport() {
        let mut doc = valid_save_doc();
        doc.project.created_at = "not-a-date".into();
        assert!(prepare_save("p-1", &doc).is_err());
        // updatedAt 虽被无条件覆盖，异型值仍拒绝（信封形状先行）
        let mut doc = valid_save_doc();
        doc.project.updated_at = String::new();
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.graph = json!({ "nodes": [], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 0 } });
        assert!(prepare_save("p-1", &doc).is_err());
        let mut doc = valid_save_doc();
        doc.graph =
            json!({ "nodes": [], "edges": [], "viewport": { "x": "0", "y": 0, "zoom": 1 } });
        assert!(prepare_save("p-1", &doc).is_err());
    }

    #[test]
    fn save_rejects_non_canonical_episode_title_keys() {
        // "01"/"1e0" 与规范键折叠到同一集号，转换时按遍历序静默覆盖（§11.1 第 3 步）
        for bad in ["01", "1e0", " 1", "0", "-1", "9007199254740992"] {
            let mut doc = valid_save_doc();
            doc.episode_titles = json!({ bad: "标题" });
            assert!(prepare_save("p-1", &doc).is_err(), "应拒绝键 {bad:?}");
        }
        let mut doc = valid_save_doc();
        doc.episode_titles = json!({ "1": 42 });
        assert!(prepare_save("p-1", &doc).is_err());
        // 值域与 set_episode_title 同域（落盘前 trim、去空白后非空）：空白/
        // 带空白标题若放行，下次加载被 trim/删除并触发修复回写——保存边界
        // 接受过的文档不得重开即变
        for bad_title in ["   ", " 开局 ", ""] {
            let mut doc = valid_save_doc();
            doc.episode_titles = json!({ "1": bad_title });
            assert!(
                prepare_save("p-1", &doc).is_err(),
                "应拒绝标题 {bad_title:?}"
            );
        }
    }

    #[test]
    fn save_rejects_bad_asset_entries() {
        let good = json!({
            "id": "a1", "relPath": "assets/pic.png", "mime": "image/png",
            "source": "upload", "createdAt": "2026-08-01T00:00:00.000Z",
        });
        let with_asset = |entry: serde_json::Value, key: &str| {
            let mut doc = valid_save_doc();
            doc.assets = json!({ "byId": { key: entry } });
            doc
        };
        // 基线合法
        assert!(prepare_save("p-1", &with_asset(good.clone(), "a1")).is_ok());
        // Record 键与内嵌 id 不一致（分裂身份）
        assert!(prepare_save("p-1", &with_asset(good.clone(), "a2")).is_err());
        // 空白 id（§8.1 共同值域 trim 口径）：键与内嵌 id 一致但纯空白——
        // 加载侧归一化会按空白键重发改写身份并重连引用，保存边界接受的
        // 数据重开即变 id，须整次拒绝
        let mut blank = good.clone();
        blank["id"] = json!("   ");
        assert!(prepare_save("p-1", &with_asset(blank, "   ")).is_err());
        // relPath 越出资产子目录
        for bad_path in [
            "../secret",
            "assets/../../etc/passwd",
            "/abs/path",
            "library.json",
            "assets/",
            "",
        ] {
            let mut e = good.clone();
            e["relPath"] = json!(bad_path);
            assert!(
                prepare_save("p-1", &with_asset(e, "a1")).is_err(),
                "应拒绝 {bad_path:?}"
            );
        }
        // MIME 非规范形式（大写/带空白/通配/缺 subtype）
        for bad_mime in [
            "IMAGE/PNG",
            " image/png",
            "image/*",
            "image",
            "image/png; q=1",
        ] {
            let mut e = good.clone();
            e["mime"] = json!(bad_mime);
            assert!(
                prepare_save("p-1", &with_asset(e, "a1")).is_err(),
                "应拒绝 {bad_mime:?}"
            );
        }
        let mut e = good.clone();
        e["source"] = json!("unknown");
        assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
        let mut e = good.clone();
        e["createdAt"] = json!("2026-08-01");
        assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
        let mut e = good.clone();
        e["createdAt"] = json!(null);
        assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
    }

    #[test]
    fn save_overrides_id_and_stamps_updated_at() {
        // 调用方自报 id 不落盘：无条件以受信路径参数覆盖（§10.5）
        let doc = valid_save_doc();
        let out = prepare_save("p-1", &doc).unwrap();
        assert_eq!(out.project.id, "p-1");
        // updatedAt 由 Rust 保存边界无条件盖戳，不信任调用方携带的旧值/未来值
        assert_ne!(out.project.updated_at, "2026-08-28T12:00:00.000Z");
        assert!(is_valid_iso8601(&out.project.updated_at));
        // createdAt/name 保留（name 为规范化值）
        assert_eq!(out.project.created_at, "2026-08-01T00:00:00.000Z");
        assert_eq!(out.project.name, "午夜出租车");
    }

    #[test]
    fn validate_save_assets_requires_canonical_utc_timestamps() {
        let entry = |ts: &str| {
            json!({ "byId": { "a-1": { "id": "a-1", "relPath": "assets/a1.png",
            "mime": "image/png", "source": "upload", "createdAt": ts } } })
        };
        // 偏移/缺毫秒的合法 ISO 加载会规范化重写触发修复回写，保存只收规范形
        for bad in ["2026-08-01T08:00:00+08:00", "2026-08-01T08:00:00Z"] {
            let err = validate_save_assets(&entry(bad)).unwrap_err();
            assert!(err.contains("createdAt"), "{bad} 意外诊断：{err}");
        }
        assert!(validate_save_assets(&entry("2026-08-01T00:00:00.000Z")).is_ok());
    }

    #[test]
    fn prepare_save_rejects_non_string_description() {
        let mut doc = valid_save_doc();
        doc.project.description = Some(json!(42));
        let err = prepare_save("p-1", &doc).unwrap_err();
        assert!(err.contains("description"), "意外诊断：{err}");
    }

    #[test]
    fn save_ipc_explicit_null_description_preserved_and_rejected() {
        // 显式 null 不得被 serde 折叠为 None：那会让保存边界看不见非字符串
        // 值而静默省略键——既有描述被无声抹掉
        let mut payload = serde_json::to_value(valid_save_doc()).unwrap();
        payload["project"]["description"] = serde_json::Value::Null;
        let file: ProjectFile = serde_json::from_value(payload).expect("反序列化");
        assert_eq!(file.project.description, Some(serde_json::Value::Null));
        let err = prepare_save("p-1", &file).unwrap_err();
        assert!(err.contains("description"), "意外诊断：{err}");
    }

    #[test]
    fn verify_asset_real_path_accepts_regular_file_under_project_root() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("创建资产目录");
        fs::write(assets.join("a1.png"), b"png").expect("写入资产文件");
        assert!(verify_asset_real_path(&cap(&projects), "p-1", "assets/a1.png").is_ok());
        cleanup_temp(&projects);
    }

    #[test]
    fn verify_asset_real_path_rejects_missing_file_and_missing_root() {
        let projects = temp_projects_dir();
        fs::create_dir_all(projects.join("p-1").join("assets")).expect("创建资产目录");
        let err = verify_asset_real_path(&cap(&projects), "p-1", "assets/gone.png").unwrap_err();
        assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
        // 项目资产根本身缺失同样拒存（该项目从未落过资产文件）
        assert!(verify_asset_real_path(&cap(&projects), "p-2", "assets/a1.png").is_err());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn verify_asset_real_path_rejects_symlink_escape() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("创建资产目录");
        let outside = projects.parent().expect("临时根").join("secret.png");
        fs::write(&outside, b"secret").expect("写入根外文件");
        std::os::unix::fs::symlink(&outside, assets.join("link.png")).expect("建立符号链接");
        let err = verify_asset_real_path(&cap(&projects), "p-1", "assets/link.png").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }

    #[test]
    fn verify_asset_real_path_returns_open_handle_of_verified_file() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a1.png"), b"png").expect("写资产文件");
        // 复验绑定打开句柄：调用方（save_project）持有至保存完成才释放
        let handle = verify_asset_real_path(&cap(&projects), "p-1", "assets/a1.png")
            .expect("复验通过应返回已打开的句柄");
        let md = handle.metadata().expect("句柄元数据可读");
        assert!(md.is_file());
        cleanup_temp(&projects);
    }

    #[test]
    fn verify_save_asset_files_prefixes_asset_key_and_skips_lexical_invalid() {
        let projects = temp_projects_dir();
        // relPath 词法非法的条目交给 prepare_save 的形状诊断，实路径复验跳过不误报
        let doc_assets = json!({ "byId": { "a-bad": { "relPath": "../evil.png" } } });
        assert!(verify_save_asset_files(&cap(&projects), "p-1", &doc_assets).is_ok());

        let doc_assets = json!({ "byId": { "a1": { "relPath": "assets/a1.png" } } });
        let err = verify_save_asset_files(&cap(&projects), "p-1", &doc_assets).unwrap_err();
        assert!(err.contains("资产 a1"), "诊断缺资产键：{err}");
        cleanup_temp(&projects);
    }

    #[test]
    fn unverifiable_asset_keys_reports_real_path_failures_only() {
        let projects = temp_projects_dir();
        let assets_dir = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets_dir).expect("建资产目录");
        fs::write(assets_dir.join("ok.png"), b"x").expect("写正常资产");
        // 词法非法/形状缺失条目不在此报告：前端形状归一化负责隔离
        let assets = json!({ "byId": {
            "a-ok": { "relPath": "assets/ok.png" },
            "a-miss": { "relPath": "assets/gone.png" },
            "a-bad": { "relPath": "../evil.png" },
            "a-noshape": {},
        }});
        let keys = unverifiable_asset_keys(&cap(&projects), "p-1", &assets);
        assert_eq!(keys, vec!["a-miss".to_string()]);
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn unverifiable_asset_keys_reports_symlinked_entries() {
        let projects = temp_projects_dir();
        let assets_dir = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets_dir).expect("建资产目录");
        let outside = projects.parent().expect("临时根").join("outside.png");
        fs::write(&outside, b"s").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, assets_dir.join("link.png")).expect("建符号链接");
        let assets = json!({ "byId": { "a-link": { "relPath": "assets/link.png" } } });
        let keys = unverifiable_asset_keys(&cap(&projects), "p-1", &assets);
        assert_eq!(keys, vec!["a-link".to_string()]);
        cleanup_temp(&projects);
    }

    #[test]
    fn new_project_document_carries_all_settings_buckets() {
        // create_project 产出的初始文档必须四桶齐备——否则 create → load →
        // save 的原始链路在保存边界被拒（§10.5），只能依赖前端归一化碰巧修复
        let file = new_project_file("p-x", "新剧".into(), "2026-08-31T00:00:00.000Z".into());
        let s = file.settings.as_object().unwrap();
        for bucket in ["characters", "locations", "props", "documents"] {
            assert!(
                s.get(bucket).is_some_and(|v| v.is_object()),
                "缺桶 {bucket}"
            );
        }
        assert!(prepare_save("p-x", &file).is_ok());
    }
}
