//! 项目持久化（docs/data-model.md v1 §10/§11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）。graph/settings/assets 以 `serde_json::Value`
//! 透传，但保存边界（§10.5）执行完整信封校验：版本、容器形状、时间戳、
//! 集标题键、AssetRef 形状——只验证不修复，异型值整次拒绝；updatedAt 由 Rust
//! 端盖戳，id 以受信路径参数覆盖。落盘走原子写（§10.2）。
//! 旧扁平格式（无 schemaVersion）在 load 时包装为 v0 信封交付前端，节点级
//! 迁移与归一化由前端模型层（§11）完成。

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

/// 项目元信息：id/name + ISO 8601 创建与更新时间（§3）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
}

/// 项目文件：ProjectDocument 信封。graph/settings/episodeTitles/assets
/// 以 `serde_json::Value` 透传；缺省字段按空对象兜底（旧文件兼容）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    #[serde(default, rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default)]
    pub project: ProjectInfo,
    #[serde(default)]
    pub graph: serde_json::Value,
    #[serde(default = "empty_object")]
    pub settings: serde_json::Value,
    #[serde(default = "empty_object", rename = "episodeTitles")]
    pub episode_titles: serde_json::Value,
    #[serde(default = "empty_assets")]
    pub assets: serde_json::Value,
}

/// 项目摘要：首页海报卡的展示模型；统计从 graph 派生，不落镜像字段。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    /// ISO 8601；字典序即时间序，排序无需解析。
    pub updated_at: String,
    pub scene_count: u64,
    pub ending_count: u64,
}

/// 项目名约束：非空、去空白后 ≤ 64 字符。
pub fn sanitize_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    if name.chars().count() > 64 {
        return Err("项目名过长（≤ 64 字符）".into());
    }
    Ok(name.to_string())
}

/// id 约束：文件名安全字符集，防路径穿越。
pub fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法项目 id：{id}"))
    }
}

/// 新 id：时间戳毫秒 + 进程内计数，保证同毫秒不碰撞。
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("p-{ms:x}-{seq:x}")
}

/// epoch 毫秒 → ISO 8601（UTC，civil-from-days 算法，无外部依赖）。
fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    iso_from_ms(ms)
}

/// 当前支持的文档版本（§3）。
const CURRENT_SCHEMA_VERSION: u32 = 1;

/// ISO 8601 固定前缀 `YYYY-MM-DDTHH:MM:SS` 的解析结果。
struct IsoFields {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
}

/// 解析固定前缀的形状（长度、数字位、分隔符）；形状不符返回 None。
fn parse_iso_prefix(s: &str) -> Option<IsoFields> {
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    for i in [0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !b[i].is_ascii_digit() {
            return None;
        }
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| s[from..to].parse::<u32>().unwrap_or(u32::MAX);
    Some(IsoFields {
        year: num(0, 4) as i64,
        month: num(5, 7),
        day: num(8, 10),
        hour: num(11, 13),
        min: num(14, 16),
        sec: num(17, 19),
    })
}

/// 月份天数；month 越界返回 0，由调用方的范围检查一并拒绝。
fn days_in_month(year: i64, month: u32) -> u32 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    }
}

/// 各字段取值范围（含闰年月份天数）。
fn iso_fields_in_range(f: &IsoFields) -> bool {
    (1..=12).contains(&f.month)
        && f.hour <= 23
        && f.min <= 59
        && f.sec <= 59
        && f.day >= 1
        && f.day <= days_in_month(f.year, f.month)
}

/// 校验 `±HH:MM` 时区偏移：从符号位起恰好消费剩余 6 字节。
fn zone_offset_valid(s: &str, i: usize) -> bool {
    let b = s.as_bytes();
    if b.len() != i + 6 || b[i + 3] != b':' {
        return false;
    }
    for j in [i + 1, i + 2, i + 4, i + 5] {
        if !b[j].is_ascii_digit() {
            return false;
        }
    }
    let off_h = s[i + 1..i + 3].parse::<u32>().unwrap_or(u32::MAX);
    let off_m = s[i + 4..i + 6].parse::<u32>().unwrap_or(u32::MAX);
    off_h <= 23 && off_m <= 59
}

/// 校验可选小数秒与结尾时区（`Z` 或 `±HH:MM`），从第 19 字节起消费到串尾。
fn iso_suffix_valid(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    match b.get(i) {
        Some(b'Z') => i + 1 == b.len(),
        Some(b'+') | Some(b'-') => zone_offset_valid(s, i),
        _ => false,
    }
}

/// ISO 8601 校验（保存边界）：`YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`，
/// 含各字段取值范围与闰年规则——反序列化不校验字符串内容，边界自行把关。
fn is_valid_iso8601(s: &str) -> bool {
    match parse_iso_prefix(s) {
        Some(f) => iso_fields_in_range(&f) && iso_suffix_valid(s),
        None => false,
    }
}

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
fn is_canonical_mime(s: &str) -> bool {
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
fn is_valid_asset_rel_path(p: &str) -> bool {
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
    for bucket in ["characters", "locations", "props", "documents"] {
        // 数组同为 JSON 对象之外的合法形态，必须由 as_object 显式排除（§11.1 第 2 步同域）
        if let Some(v) = s.get(bucket) {
            if !v.is_object() {
                return Err(format!("settings.{bucket} 必须是普通对象"));
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
        if !v.is_string() {
            return Err(format!("episodeTitles[{k:?}] 的值必须是字符串"));
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
            Some(eid) if !eid.is_empty() && eid == key => {}
            _ => return Err(format!("资产 {key} 的 Record 键与内嵌 id 不一致")),
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
            Some(t) if is_valid_iso8601(t) => {}
            _ => return Err(format!("资产 {key} 的 createdAt 不是可解析的 ISO 8601")),
        }
    }
    Ok(())
}

/// save_project 的信封校验与规范化（§10.5）：在创建临时文件、生成保存时间
/// 或更新索引之前完成——任一校验失败整次拒绝，不得静默剥离。全部通过后
/// 以受信路径参数覆盖 id，并由 Rust 为本次尝试只取一次系统时间无条件盖戳
/// updatedAt（不信任旧值、未来值或前端时钟）。
fn prepare_save(id: &str, doc: &ProjectFile) -> Result<ProjectFile, String> {
    if doc.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "文档版本不受支持（schemaVersion {}），拒绝保存",
            doc.schema_version
        ));
    }
    let name = sanitize_name(&doc.project.name)?;
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

/// 原子写控制文件（§10.2）：同目录随机名临时文件排他创建（避免预置 `.tmp`
/// 符号链接截获）→ 写入 + flush/fsync → rename 原子覆盖 → 父目录 fsync；
/// 失败尽力清理临时文件。现存目标为符号链接或非普通文件时拒绝，不跟随。
fn atomic_write(dir: &std::path::Path, path: &std::path::Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    if let Ok(md) = fs::symlink_metadata(path) {
        if md.file_type().is_symlink() {
            return Err("拒绝符号链接形式的项目文件".into());
        }
        if !md.file_type().is_file() {
            return Err("项目路径不是普通文件".into());
        }
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("项目路径不含有效文件名")?;
    let tmp = dir.join(format!(".{file_name}.{}.tmp", new_id()));
    let result = (|| -> Result<(), String> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("写入项目失败：{e}"))?;
        f.sync_all().map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(f);
        fs::rename(&tmp, path).map_err(|e| format!("落盘项目失败：{e}"))?;
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// settings 等对象字段缺省值：空对象（而非 Null），前端归一化兜底。
fn empty_object() -> serde_json::Value {
    json!({})
}

fn empty_assets() -> serde_json::Value {
    json!({ "byId": {} })
}

/// 项目根目录（§10.2 信任链）：canonicalize 应用数据根并逐级复核包含关系，
/// `projects/` 为符号链接或 canonical 路径越出受信根时拒绝整个对应操作。
fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    fs::create_dir_all(&root).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("解析应用数据目录真实路径失败：{e}"))?;
    let dir = root.join("projects");
    if !dir.exists() {
        fs::create_dir(&dir).map_err(|e| format!("创建项目目录失败：{e}"))?;
    }
    let md = fs::symlink_metadata(&dir).map_err(|e| format!("读取项目目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("拒绝符号链接形式的项目目录".into());
    }
    if !md.is_dir() {
        return Err("项目目录路径不是目录".into());
    }
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("解析项目目录真实路径失败：{e}"))?;
    if !dir.starts_with(&root) {
        return Err("项目目录逃逸应用数据根".into());
    }
    Ok(dir)
}

fn project_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(projects_dir(app)?.join(format!("{id}.json")))
}

/// 从画布 graph 派生统计：场数 = scene 节点数；结局数 = 无剧情流出边的
/// 场景数（分支剧情的叶子场景即结局）。attach 下挂边（索引卡 → 分镜卡，
/// 垂直派生从属）不算出边——挂了分镜的场景仍是叶子结局。
/// v1 文档边带显式 data.kind；v0 运行态边按 sourceHandle/className 判别。
pub fn graph_stats(graph: &serde_json::Value) -> (u64, u64) {
    let empty: Vec<serde_json::Value> = Vec::new();
    let nodes = graph
        .get("nodes")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let edges = graph
        .get("edges")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let scene_ids: HashSet<&str> = nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("scene"))
        .filter_map(|n| n.get("id").and_then(|i| i.as_str()))
        .collect();
    let is_attach = |e: &serde_json::Value| {
        e.pointer("/data/kind").and_then(|k| k.as_str()) == Some("attach")
            || e.get("sourceHandle").and_then(|h| h.as_str()) == Some("shots")
            || e.get("className").and_then(|c| c.as_str()) == Some("pw-edge-attach")
    };
    let mut has_outgoing: HashSet<&str> = HashSet::new();
    for e in edges {
        if is_attach(e) {
            continue;
        }
        if let Some(src) = e.get("source").and_then(|s| s.as_str()) {
            has_outgoing.insert(src);
        }
    }
    let endings = scene_ids
        .iter()
        .filter(|id| !has_outgoing.contains(*id))
        .count() as u64;
    (scene_ids.len() as u64, endings)
}

fn read_meta(id: &str, file: &ProjectFile) -> ProjectMeta {
    let (scene_count, ending_count) = graph_stats(&file.graph);
    ProjectMeta {
        id: id.to_string(),
        name: file.project.name.clone(),
        updated_at: file.project.updated_at.clone(),
        scene_count,
        ending_count,
    }
}

/// 旧扁平格式（无 schemaVersion）→ v0 信封：节点/边上移 graph，
/// epoch 毫秒时间戳转 ISO；节点级字段迁移由前端模型层完成（§11.1）。
fn wrap_legacy(id: &str, v: &serde_json::Value) -> ProjectFile {
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("未命名")
        .to_string();
    let updated_at = v
        .get("updated_at")
        .and_then(|x| x.as_u64())
        .map(iso_from_ms)
        .unwrap_or_default();
    ProjectFile {
        schema_version: 0,
        project: ProjectInfo {
            id: id.to_string(),
            name,
            description: None,
            created_at: String::new(),
            updated_at,
        },
        graph: json!({
            "nodes": v.get("nodes").cloned().unwrap_or(json!([])),
            "edges": v.get("edges").cloned().unwrap_or(json!([])),
            // 旧格式从未持久化视口：保持缺省（前端打开时 fitView），不伪造原点
        }),
        settings: v.get("settings").cloned().unwrap_or_else(|| json!({})),
        episode_titles: v.get("episodeTitles").cloned().unwrap_or_else(|| json!({})),
        assets: empty_assets(),
    }
}

/// 列出全部项目，按更新时间新→旧排序。
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_dir(&app)?;
    let mut metas: Vec<ProjectMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取项目目录失败：{e}"))? {
        let path = entry.map_err(|e| format!("遍历项目目录失败：{e}"))?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(file) = parse_file(id, &text) {
            metas.push(read_meta(id, &file));
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

/// 解析项目文件：v1 信封直接反序列化（缺省字段兜底）；
/// 无 schemaVersion 的旧扁平格式包装为 v0 信封。
/// 缺失的时间戳就地修复为有效 ISO（serde 默认空串）——否则前端
/// new Date('') 抛 RangeError 会清空整个首页列表。
fn parse_file(id: &str, text: &str) -> Result<ProjectFile, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let mut file = if value.get("schemaVersion").is_some() {
        let mut file: ProjectFile = serde_json::from_value(value)?;
        if file.project.id.is_empty() {
            file.project.id = id.to_string();
        }
        file
    } else {
        wrap_legacy(id, &value)
    };
    if file.project.updated_at.is_empty() {
        file.project.updated_at = if file.project.created_at.is_empty() {
            now_iso()
        } else {
            file.project.created_at.clone()
        };
    }
    if file.project.created_at.is_empty() {
        file.project.created_at = file.project.updated_at.clone();
    }
    Ok(file)
}

/// 新建空项目（空画布 v1 信封），返回其摘要。
#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&name)?;
    let id = new_id();
    let now = now_iso();
    let file = ProjectFile {
        schema_version: 1,
        project: ProjectInfo {
            id: id.clone(),
            name,
            description: None,
            created_at: now.clone(),
            updated_at: now,
        },
        graph: json!({
            "nodes": [],
            "edges": [],
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
        }),
        settings: json!({ "characters": {}, "locations": {}, "props": {} }),
        episode_titles: json!({}),
        assets: empty_assets(),
    };
    let path = project_path(&app, &id)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    let dir = projects_dir(&app)?;
    atomic_write(&dir, &path, &text)?;
    Ok(read_meta(&id, &file))
}

/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let path = project_path(&app, &id)?;
    let text = fs::read_to_string(path).map_err(|_| format!("项目不存在：{id}"))?;
    parse_file(&id, &text).map_err(|e| format!("项目文件损坏：{e}"))
}

/// 全量保存（§10.5 保存边界）：完整信封校验先行，任一失败整次拒绝；
/// 通过后以受信路径参数覆盖 id、Rust 端无条件盖戳 updatedAt，再原子落盘。
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let file = prepare_save(&id, &doc)?;
    let path = project_path(&app, &id)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    let dir = projects_dir(&app)?;
    atomic_write(&dir, &path, &text)?;
    Ok(read_meta(&id, &file))
}

/// 删除项目（首页卡片菜单，§3.2）。
#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let path = project_path(&app, &id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除项目失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn name_rules() {
        assert!(sanitize_name("  ").is_err());
        assert!(sanitize_name("").is_err());
        assert_eq!(sanitize_name("  午夜出租车 ").unwrap(), "午夜出租车");
        let long = "剧".repeat(65);
        assert!(sanitize_name(&long).is_err());
        assert!(sanitize_name(&"剧".repeat(64)).is_ok());
    }

    #[test]
    fn id_rules() {
        assert!(validate_id("p-18f-0").is_ok());
        assert!(validate_id("sample_wu_ye").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a b").is_err());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn iso_from_ms_marks_known_instants() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        // 闰日边界：2024-02-29T00:00:00Z = 1_709_164_800_000
        assert_eq!(iso_from_ms(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn graph_stats_ignores_attach_edges_for_endings() {
        let nodes = json!([
            { "id": "s1", "type": "scene", "data": {} },
            { "id": "s2", "type": "scene", "data": {} },
            { "id": "sh", "type": "shot", "data": {} },
        ]);
        // s1 只下挂分镜（attach 派生边）：仍是叶子结局；s2 无任何出边同为结局
        let attach_only = json!({
            "nodes": nodes,
            "edges": [
                { "id": "e1", "source": "s1", "target": "sh",
                  "sourceHandle": "shots", "className": "pw-edge-attach" },
            ],
        });
        assert_eq!(graph_stats(&attach_only), (2, 2));

        // s1 有剧情流出边 → 非结局（v1 形态：kind 显式存于 data.kind）
        let with_sequence = json!({
            "nodes": nodes,
            "edges": [
                { "id": "e1", "source": "s1", "target": "sh",
                  "sourceHandle": "shots", "data": { "kind": "attach" } },
                { "id": "e2", "source": "s1", "target": "s2", "data": { "kind": "sequence" } },
            ],
        });
        assert_eq!(graph_stats(&with_sequence), (2, 1));
    }

    #[test]
    fn new_ids_never_collide_in_same_millisecond() {
        assert_ne!(new_id(), new_id());
    }

    #[test]
    fn stats_count_scenes_and_leaf_endings() {
        let graph = json!({
            "nodes": [
                { "id": "s1", "type": "scene" },
                { "id": "d1", "type": "dialogue" },
                { "id": "s2", "type": "scene" },
                { "id": "s3", "type": "scene" },
            ],
            "edges": [
                { "source": "s1", "target": "d1" },
                { "source": "d1", "target": "s2" },
            ],
        });
        assert_eq!(graph_stats(&graph), (3, 2)); // s2/s3 无出边 = 结局
    }

    #[test]
    fn stats_on_malformed_graph_fall_back_to_zero() {
        assert_eq!(graph_stats(&json!(null)), (0, 0));
        assert_eq!(graph_stats(&json!({ "nodes": "oops" })), (0, 0));
    }

    #[test]
    fn v1_file_missing_timestamps_gets_repaired() {
        // 缺 project 时间戳的信封（serde 默认空串）：读取即修复为有效 ISO，
        // 否则前端 new Date('').toISOString() 抛 RangeError，首页列表被清空
        let v1 = json!({
            "schemaVersion": 1,
            "project": { "id": "p-1", "name": "旧时间" },
            "graph": { "nodes": [], "edges": [] },
            "settings": {},
            "episodeTitles": {},
            "assets": { "byId": {} },
        });
        let file = parse_file("p-1", &v1.to_string()).unwrap();
        assert!(!file.project.updated_at.is_empty());
        assert!(!file.project.created_at.is_empty());
    }

    #[test]
    fn legacy_flat_file_wraps_as_v0_envelope() {
        let legacy = json!({
            "name": "旧项目",
            "updated_at": 1_700_000_000_000_i64,
            "nodes": [{ "id": "a", "type": "scene", "data": {} }],
            "edges": [],
            "settings": { "characters": [], "locations": [] },
            "episodeTitles": { "1": "开端" },
        });
        let file = parse_file("p-old", &legacy.to_string()).unwrap();
        assert_eq!(file.schema_version, 0);
        assert_eq!(file.project.id, "p-old");
        assert_eq!(file.project.name, "旧项目");
        assert_eq!(file.project.updated_at, "2023-11-14T22:13:20.000Z");
        assert_eq!(file.graph["nodes"][0]["id"], json!("a"));
        // 旧格式无视口：信封不伪造，前端打开时 fitView
        assert!(file.graph.get("viewport").is_none());
        assert_eq!(file.episode_titles, json!({ "1": "开端" }));
    }

    #[test]
    fn project_file_round_trip() {
        let file = ProjectFile {
            schema_version: 1,
            project: ProjectInfo {
                id: "p-1".into(),
                name: "午夜出租车".into(),
                description: None,
                created_at: "2026-08-01T00:00:00.000Z".into(),
                updated_at: "2026-08-28T12:00:00.000Z".into(),
            },
            graph: json!({
                "nodes": [{ "id": "a", "type": "scene", "layout": { "position": { "x": 0, "y": 0 } },
                            "ui": { "selected": false, "expanded": true },
                            "data": { "spec": {}, "meta": { "label": "场一" } } }],
                "edges": [],
                "viewport": { "x": 0, "y": 0, "zoom": 1 },
            }),
            settings: json!({ "characters": {}, "locations": {}, "props": {} }),
            episode_titles: json!({ "1": "开端" }),
            assets: json!({ "byId": {} }),
        };
        let text = serde_json::to_string(&file).unwrap();
        let back: ProjectFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.project.name, "午夜出租车");
        // 信封键名为 camelCase（前端契约）
        assert!(text.contains("schemaVersion"));
        assert!(text.contains("createdAt"));
        assert!(text.contains("episodeTitles"));
        assert_eq!(back.episode_titles, json!({ "1": "开端" }));
        // 统计从 graph 派生
        assert_eq!(graph_stats(&back.graph), (1, 1));
    }

    #[test]
    fn v1_envelope_with_missing_buckets_defaults_empty() {
        let sparse = json!({
            "schemaVersion": 1,
            "project": { "name": "稀疏文档" },
            "graph": { "nodes": [], "edges": [] },
        });
        let file = parse_file("p-1", &sparse.to_string()).unwrap();
        assert_eq!(file.schema_version, 1);
        assert_eq!(file.project.id, "p-1"); // 缺省时以文件名回填
        assert_eq!(file.settings, json!({}));
        assert_eq!(file.assets, json!({ "byId": {} }));
    }

    /// 合法 v1 信封（保存边界校验的基线载荷）。
    fn valid_save_doc() -> ProjectFile {
        ProjectFile {
            schema_version: 1,
            project: ProjectInfo {
                id: "p-self-reported".into(),
                name: "午夜出租车".into(),
                description: None,
                created_at: "2026-08-01T00:00:00.000Z".into(),
                updated_at: "2026-08-28T12:00:00.000Z".into(),
            },
            graph: json!({
                "nodes": [], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 1 },
            }),
            settings: json!({
                "characters": {}, "locations": {}, "props": {}, "documents": {},
            }),
            episode_titles: json!({ "1": "开端" }),
            assets: json!({ "byId": {} }),
        }
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
    fn iso8601_accepts_z_and_offset_forms() {
        assert!(is_valid_iso8601("2026-08-31T06:27:27.000Z"));
        assert!(is_valid_iso8601("2026-08-31T06:27:27Z"));
        assert!(is_valid_iso8601("2026-08-31T14:27:27+08:00"));
        assert!(is_valid_iso8601("2024-02-29T00:00:00.000Z")); // 闰日
        for bad in [
            "",
            "2026-08-31",               // 缺时间
            "2026-08-31T06:27:27",      // 缺时区
            "2026-13-01T00:00:00.000Z", // 月份越界
            "2026-08-32T00:00:00.000Z", // 日期越界
            "2023-02-29T00:00:00.000Z", // 非闰年 2/29
            "2026-08-31T25:00:00.000Z", // 小时越界
            "2026-08-31T06:27:27.",     // 小数秒无数字
            "2026-08-31T06:27:27+0800", // 偏移缺冒号
            "not-a-date",
        ] {
            assert!(!is_valid_iso8601(bad), "应拒绝 {bad:?}");
        }
    }
}
