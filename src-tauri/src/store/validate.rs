//! 保存边界校验与资产实路径复验（数据模型 §10.5/§7.1）：信封形状
//! 只验证不修复、异型值整次拒绝；relPath 实路径以受信根锚定句柄逐组件
//! no-follow 复验（加载侧与保存侧共用内核）；prepare_save 在任何
//! 落盘动作之前完成全部校验并盖戳 updatedAt。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::{is_canonical_utc_timestamp, is_valid_iso8601, now_iso};
#[cfg(unix)]
use crate::store::persist::asset_identity;
use crate::store::persist::{asset_stat, open_dir_bound, projects_dir};
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
/// 活动索引 relPath 词法（§7.1/§7.2）：在基础词法之上排除保留隔离目录
/// `assets/.trash/` 组件——隔离区是删除事务的私有命名空间，永不进入
/// AssetRef、媒体 URL 或活动索引（issue #25）。
pub(crate) fn is_valid_active_asset_rel_path(p: &str) -> bool {
    is_valid_asset_rel_path(p) && !p.split('/').any(|c| c == ".trash")
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
    // AI 批次计数（§12.2 提交身份）：只接受非负安全整数——异型/负数/超安全
    // 整数落盘后会被加载归一化清零，已应用的批次计数丢失，恢复对账把已落盘
    // 的执行卡误判为待执行
    if let Some(revision) = g.get("aiRevision") {
        if revision.as_u64().is_none_or(|v| v > 9_007_199_254_740_991) {
            return Err("graph.aiRevision 必须是非负安全整数".into());
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
mod tests;
