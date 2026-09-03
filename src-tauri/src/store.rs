//! 项目持久化（docs/data-model.md v1 §10/§11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）。graph/settings/assets 以 `serde_json::Value`
//! 透传，但保存边界（§10.5）执行完整信封校验：版本、容器形状、时间戳、
//! 集标题键、AssetRef 形状——只验证不修复，异型值整次拒绝；updatedAt 由 Rust
//! 端盖戳，id 以受信路径参数覆盖。落盘走原子写（§10.2）。
//! 旧扁平格式在 load 时按第 0 步信封判型：形状特征匹配旧扁平格式才包装为
//! v0 信封交付前端（显式 schemaVersion 0 同论），丢失版本号但保持 v1 信封
//! 特征的文档按 v1 交付；显式版本号与信封形状两族矛盾的文档拒绝加载并保留
//! 原文件。v1 信封的 project 元信息逐字段宽容提取，字段级损坏不阻断加载，
//! 修复与警告归前端归一化层。节点级迁移与归一化由前端模型层（§11）完成。

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use cap_std::{ambient_authority, fs::Dir as CapDir};
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
    // None 省略键而非写 null：前端归一化把 null 当异型剥离（repaired=true），
    // 回写再写回 null 会让示例项目的列表升级循环永不收敛（P1）
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    /// 信封判型发现文件缺 schemaVersion（按形状判为 v1，§11 第 0 步）：
    /// IPC 标记由前端 repaired 检测消费（载荷额外键使规范化比较必然不等，
    /// 触发回写补盖版本号）——否则文件永久无版本，违反 §10.5/§11.1 收敛
    /// 契约；持久化输出恒为 false（保存必盖显式版本）。
    #[serde(default, skip_serializing_if = "is_false")]
    pub versionless: bool,
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
    /// ISO 8601；可含时区偏移/小数秒变体，排序须按解析后的瞬间比较。
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

/// 从 ISO 串尾部提取毫秒小数与分钟级时区偏移（Z 视为 0）；
/// 形状由 is_valid_iso8601 先行校验，此处不做防御性检查。
fn iso_suffix_parts(s: &str) -> (i64, i64) {
    let b = s.as_bytes();
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        millis = frac[..frac.len().min(3)].parse().unwrap_or(0);
        for _ in frac.len()..3 {
            millis *= 10;
        }
    }
    let offset_min = match b.get(i) {
        Some(b'+') | Some(b'-') => {
            let h: i64 = s[i + 1..i + 3].parse().unwrap_or(0);
            let m: i64 = s[i + 4..i + 6].parse().unwrap_or(0);
            let v = h * 60 + m;
            if b[i] == b'-' {
                -v
            } else {
                v
            }
        }
        _ => 0,
    };
    (millis, offset_min)
}

/// 民用日期 → 1970-01-01 起的天数（Howard Hinnant 算法，公历全程有效）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from((m + 9) % 12);
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO 8601 → Unix epoch 毫秒（项目列表排序键）：时区偏移与小数秒归一化后
/// 同一瞬间得同一键——字典序无法比较 `+10:00` 与 `Z` 之类的等价/交错写法；
/// 非法串返回 None，由调用方决定兜底次序。
fn iso8601_to_epoch_millis(s: &str) -> Option<i64> {
    if !is_valid_iso8601(s) {
        return None;
    }
    let f = parse_iso_prefix(s)?;
    let (millis, offset_min) = iso_suffix_parts(s);
    let local_secs = days_from_civil(f.year, f.month, f.day) * 86_400
        + i64::from(f.hour) * 3_600
        + i64::from(f.min) * 60
        + i64::from(f.sec);
    Some((local_secs - offset_min * 60) * 1_000 + millis)
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
            Some(t) if is_valid_iso8601(t) => {}
            _ => return Err(format!("资产 {key} 的 createdAt 不是可解析的 ISO 8601")),
        }
    }
    Ok(())
}

/// 资产路径组件的 no-follow 元数据，缺失映射为「资产文件不存在」。
fn asset_lstat(path: &std::path::Path, rel_path: &str) -> Result<fs::Metadata, String> {
    fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("资产文件不存在：{rel_path}")
        } else {
            format!("读取资产路径元数据失败（{rel_path}）：{e}")
        }
    })
}

/// Unix 组件身份 (dev, ino)。
#[cfg(unix)]
/// (dev, ino) 身份提取：std 与 cap-std 的 Metadata 分属两个同方法的
/// MetadataExt trait，以本地 trait 归一供 asset_identity 同时接受。
#[cfg(unix)]
trait IdentityExt {
    fn dev_ino(&self) -> (u64, u64);
}
#[cfg(unix)]
impl IdentityExt for fs::Metadata {
    fn dev_ino(&self) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        (self.dev(), self.ino())
    }
}
#[cfg(unix)]
impl IdentityExt for cap_std::fs::Metadata {
    fn dev_ino(&self) -> (u64, u64) {
        use cap_std::fs::MetadataExt;
        (self.dev(), self.ino())
    }
}
#[cfg(unix)]
fn asset_identity(md: &impl IdentityExt) -> (u64, u64) {
    md.dev_ino()
}

/// 打开句柄后的三方一致性复核（Unix）：重新逐组件 no-follow 并与第一遍
/// 记录的 (dev, ino) 比对，句柄元数据须与终点组件一致——校验期间终点或
/// 任一中间组件被替换（含换成符号链接或另一实体）即拒绝。
#[cfg(unix)]
fn bind_asset_handle_identity(
    root: &std::path::Path,
    comps: &[&str],
    comp_ids: &[(u64, u64)],
    file: &fs::File,
    rel_path: &str,
) -> Result<(), String> {
    let mut recheck = root.to_path_buf();
    for (i, comp) in comps.iter().enumerate() {
        recheck.push(comp);
        let md = asset_lstat(&recheck, rel_path)?;
        if md.file_type().is_symlink() {
            return Err(format!("资产路径在复验期间被替换为符号链接：{rel_path}"));
        }
        if asset_identity(&md) != comp_ids[i] {
            return Err(format!("资产路径在复验期间被替换：{rel_path}"));
        }
    }
    let fm = file
        .metadata()
        .map_err(|e| format!("读取资产句柄元数据失败（{rel_path}）：{e}"))?;
    if asset_identity(&fm) != comp_ids[comps.len() - 1] {
        return Err(format!("资产文件在复验期间被替换：{rel_path}"));
    }
    Ok(())
}

/// §10.5 保存边界——资产实路径复验（relPath 词法校验之外的文件系统事实）。
/// 当前扁平布局下项目资产根为 `projects/{id}/`（§10.1 目录化布局随 §7.1 落地
/// 后由同一函数承接）：根现存时必须是非符号链接的实际目录，随后对 relPath
/// 逐组件 `symlink_metadata` 拒绝符号链接（no-follow，§10.2 信任链），终点
/// 必须是普通文件，并以 canonical 包含关系复核未逃逸项目资产根。
/// 复验与实体绑定：打开终点文件取得句柄，句柄、逐组件 no-follow 元数据与
/// canonical 路径三方按 (dev, ino) 比对一致才通过（Unix），并把句柄返回给
/// 调用方持有至保存完成后释放。校验与落盘之间被替换的残余窗口由加载侧
/// 复验（verify_project_assets）在下次打开时隔离兜底；§10.2 的目录句柄
/// openat 解析器落地前，这是 std 能力内的最强绑定。
fn verify_asset_real_path(
    projects: &std::path::Path,
    id: &str,
    rel_path: &str,
) -> Result<fs::File, String> {
    let root = projects.join(id);
    let root_md = fs::symlink_metadata(&root)
        .map_err(|_| format!("项目资产根不存在，资产文件不存在：{rel_path}"))?;
    if root_md.file_type().is_symlink() {
        return Err(format!("项目资产根是符号链接，拒绝校验资产：{rel_path}"));
    }
    if !root_md.is_dir() {
        return Err(format!("项目资产根不是目录，资产文件不存在：{rel_path}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("解析项目资产根真实路径失败：{e}"))?;

    // 第一遍逐组件 no-follow：拒绝符号链接，中间组件须为目录，记录组件身份
    #[cfg(unix)]
    let mut comp_ids: Vec<(u64, u64)> = Vec::new();
    let comps: Vec<&str> = rel_path.split('/').collect();
    let mut cur = root.clone();
    for (i, comp) in comps.iter().enumerate() {
        cur.push(comp);
        let md = asset_lstat(&cur, rel_path)?;
        if md.file_type().is_symlink() {
            return Err(format!("资产路径含符号链接：{rel_path}"));
        }
        if i + 1 < comps.len() && !md.is_dir() {
            return Err(format!("资产路径的中间组件不是目录：{rel_path}"));
        }
        #[cfg(unix)]
        comp_ids.push(asset_identity(&md));
    }

    // 打开终点取得句柄，现场 lstat 复核非符号链接的普通文件，再与第一遍
    // 的组件身份三方绑定（Unix）
    let file = fs::File::open(&cur).map_err(|e| format!("打开资产文件失败（{rel_path}）：{e}"))?;
    let fresh = asset_lstat(&cur, rel_path)?;
    if fresh.file_type().is_symlink() {
        return Err(format!("资产路径含符号链接：{rel_path}"));
    }
    if !fresh.is_file() {
        return Err(format!("资产路径不是普通文件：{rel_path}"));
    }
    #[cfg(unix)]
    bind_asset_handle_identity(&root, &comps, &comp_ids, &file, rel_path)?;
    #[cfg(not(unix))]
    let _ = &file;

    let real = cur
        .canonicalize()
        .map_err(|e| format!("解析资产真实路径失败（{rel_path}）：{e}"))?;
    if !real.starts_with(&canonical_root) {
        return Err(format!("资产路径逃逸项目资产根：{rel_path}"));
    }
    Ok(file)
}

/// §10.5：保存前逐项复验资产 relPath 的真实路径。relPath 词法非法（§7.1）
/// 或字段形状缺失的条目交给 prepare_save 的信封诊断，此处跳过避免重复误报。
/// 返回已验证资产的打开句柄——调用方持有至保存完成后释放，期间实体不可
/// 被替换为未验证目标（句柄绑定见 verify_asset_real_path）。
fn verify_save_asset_files(
    projects: &std::path::Path,
    id: &str,
    assets: &serde_json::Value,
) -> Result<Vec<fs::File>, String> {
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
            verify_asset_real_path(projects, id, rel).map_err(|e| format!("资产 {key}：{e}"))?;
        handles.push(handle);
    }
    Ok(handles)
}

/// §7.1/§10.5 加载侧资产实路径复验内核：返回文档 assets.byId 中词法合法、
/// 但以受信资产根 no-follow 验证失败（缺失/符号链接/非普通文件/逃逸）的
/// 记录键。词法非法或形状缺失的条目不在此报告——前端形状归一化负责隔离。
fn unverifiable_asset_keys(
    dir: &std::path::Path,
    id: &str,
    assets: &serde_json::Value,
) -> Vec<String> {
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
        if verify_asset_real_path(dir, id, rel).is_err() {
            bad.push(key.clone());
        }
    }
    bad
}

/// 加载侧资产复验命令：调用方回传刚加载文档的资产索引（避免二次读盘），
/// 返回不可验证键，交前端归一化层隔离——否则下一次保存会被保存边界
/// 拒收，防抖静默吞错后用户编辑永不落盘。加载本身保持只读。
#[tauri::command]
pub fn verify_project_assets(
    app: AppHandle,
    id: String,
    assets: serde_json::Value,
) -> Result<Vec<String>, String> {
    validate_id(&id)?;
    let dir = projects_dir(&app)?;
    Ok(unverifiable_asset_keys(&dir, &id, &assets))
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

/// rename 的父目录持久性屏障（§10.2）。Unix：打开目录句柄并 sync_all。
/// Windows：std 的 `File::open` 不带目录句柄所需的 FILE_FLAG_BACKUP_
/// SEMANTICS，打开必然失败——且发生在 rename 已提交之后，会把每次成功的
/// 写落盘误报为失败（自动保存无限重试）。该平台跳过屏障而非误报。
fn sync_directory(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let d =
            fs::File::open(dir).map_err(|e| format!("打开项目目录失败（持久性屏障缺失）：{e}"))?;
        d.sync_all()
            .map_err(|e| format!("同步项目目录失败（持久性屏障缺失）：{e}"))?;
    }
    #[cfg(not(unix))]
    {
        // std 无法以目录语义打开句柄；「打开/同步失败不粉饰成功」的契约
        // 只对可实现该屏障的平台生效
        let _ = dir;
    }
    Ok(())
}

/// 原子写控制文件（§10.2）：全程相对已验证父目录的打开句柄执行（cap-std
/// openat 语义）——目标归类与 rename 前复核（现存目标为符号链接或非普通
/// 文件即拒绝，不跟随）、随机同目录名临时文件以 O_CREAT|O_EXCL 排他创建
/// （预置 `.tmp` 符号链接无法截获写入）、写入 + flush/fsync、句柄相对
/// rename 原子覆盖（cap-std 在 Windows 上以替换语义实现 rename，std::fs::
/// rename 在该平台不替换已存在目标，已建项目的每次保存都会失败）→ 父目录
/// fsync（持久性屏障，打开/同步失败向上传播、不粉饰成功）；失败尽力清理
/// 临时文件。file_name 须为单段文件名（不含路径分量）：归类、创建与
/// rename 之外的越界形态在此拒绝，不得相对句柄逃出 projects/。
fn atomic_write(dir: &std::path::Path, file_name: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    if std::path::Path::new(file_name).components().count() != 1 {
        return Err(format!("项目文件名含路径分量，拒绝：{file_name}"));
    }
    // 句柄锚定（§10.2 信任链）：归类与写入、rename 之间路径被并发进程替换
    // （含换成符号链接）时，实际 open/create/rename 仍相对本句柄解析，
    // 不退回未绑定的字符串路径
    let root = CapDir::open_ambient_dir(dir, ambient_authority())
        .map_err(|e| format!("打开项目根目录失败：{e}"))?;
    let check_target = || -> Result<(), String> {
        if let Ok(md) = root.symlink_metadata(file_name) {
            if md.file_type().is_symlink() {
                return Err("拒绝符号链接形式的项目文件".into());
            }
            if !md.file_type().is_file() {
                return Err("项目路径不是普通文件".into());
            }
        }
        Ok(())
    };
    check_target()?;
    let tmp_name = format!(".{file_name}.{}.tmp", new_id());
    let result = (|| -> Result<(), String> {
        let mut f = root
            .open_with(
                &tmp_name,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("写入项目失败：{e}"))?;
        f.sync_all().map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(f);
        // rename 前复核现存目标（§10.2）：写临时文件期间被换上的符号链接
        // 或异型条目在此拒绝，不被 rename 覆盖
        check_target()?;
        root.rename(&tmp_name, &root, file_name)
            .map_err(|e| format!("落盘项目失败：{e}"))?;
        sync_directory(dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = root.remove_file(&tmp_name);
    }
    result
}

/// serde 谓词：false 时省略键（versionless 标记仅真值跨 IPC）。
fn is_false(v: &bool) -> bool {
    !*v
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
        versionless: false,
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

/// 项目列表排序：按更新瞬间（ISO 解析为 epoch 毫秒）新→旧；加载侧宽容保留
/// 的非法/缺失时间戳无法解析，排最后，不混入有效项之间。
fn sort_metas_by_recency(metas: &mut [ProjectMeta]) {
    metas.sort_by_key(|m| std::cmp::Reverse(iso8601_to_epoch_millis(&m.updated_at)));
}

/// §10.2 控制文件信任链——现存 `projects/{id}.json` 的读取前置校验：
/// symlink_metadata 拒绝符号链接（无论指向根内或根外），要求普通文件，
/// canonical 真实路径须仍位于已验证的项目目录内。任一不满足即拒绝读取，
/// 防止把读取重定向到应用数据根之外。返回最终组件身份（Unix 为
/// (dev, ino)）供调用方在打开后绑定同一实体——校验与打开之间被替换
/// （换成符号链接或另一文件）即拒绝且不读取。
fn verify_control_file(
    dir: &std::path::Path,
    path: &std::path::Path,
) -> Result<Option<(u64, u64)>, String> {
    let md = fs::symlink_metadata(path).map_err(|e| format!("读取项目文件元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("项目文件是符号链接，拒绝读取".into());
    }
    if !md.is_file() {
        return Err("项目文件不是普通文件".into());
    }
    // 双方都取 canonical 再比对包含（dir 已 canonical 时幂等；平台差异如
    // macOS 的 /var → /private/var 不影响判定）
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("解析项目目录真实路径失败：{e}"))?;
    let real = path
        .canonicalize()
        .map_err(|e| format!("解析项目文件真实路径失败：{e}"))?;
    if !real.starts_with(&dir) {
        return Err("项目文件真实路径逃逸项目目录".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some((md.dev(), md.ino())))
    }
    #[cfg(not(unix))]
    Ok(None)
}

/// 列出全部项目，按更新时间新→旧排序。
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_dir(&app)?;
    list_project_metas(&dir)
}

/// list_projects 的可测内核（给定已验证的 projects 目录）。目录扫描逐条
/// 跳过符号链接/异型项/坏文件（单条坏数据不阻断列表），读取走
/// read_verified_file 的已验证句柄绑定——校验通过后路径被并发替换为
/// 符号链接或另一文件时，读到的仍是校验时的同一实体，否则跳过该条目。
fn list_project_metas(dir: &std::path::Path) -> Result<Vec<ProjectMeta>, String> {
    let mut metas: Vec<ProjectMeta> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("读取项目目录失败：{e}"))? {
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
        // §10.2 目录扫描：校验 + 打开 + 读取绑定同一实体，绝不跟随替换
        let Ok(text) = read_verified_file(dir, &path) else {
            continue;
        };
        if let Ok(file) = parse_file(id, &text) {
            metas.push(read_meta(id, &file));
        }
    }
    sort_metas_by_recency(&mut metas);
    Ok(metas)
}

/// project 元信息的宽容提取（§11 第 0 步）：project 容器非对象或字段异型
/// （name/description/时间戳为 null 或非字符串等）时逐字段回退缺省——可恢复
/// 的元数据损坏不拒绝整个项目，字段级修复与警告归前端归一化层（§11.1 第 3
/// 步）；id/时间戳的空值由 parse_file 就地补齐为有效值。
fn parse_project_info(v: Option<&serde_json::Value>) -> ProjectInfo {
    let get = |k: &str| v.and_then(|x| x.get(k)).and_then(|x| x.as_str());
    ProjectInfo {
        id: get("id").unwrap_or_default().to_string(),
        name: get("name").unwrap_or_default().to_string(),
        description: get("description").map(str::to_string),
        created_at: get("createdAt").unwrap_or_default().to_string(),
        updated_at: get("updatedAt").unwrap_or_default().to_string(),
    }
}

/// v1 信封的宽容解析（§11 第 0 步）：project 元信息经 parse_project_info
/// 逐字段提取；graph/settings/episodeTitles/assets 以 untyped 值原样透传
/// （缺省补空容器），容器级与逐项校验都归前端归一化层——持久化层只拒绝
/// 两族矛盾或不可判型的信封，不因字段形状损坏阻断加载。
fn parse_v1_envelope(value: &serde_json::Value) -> ProjectFile {
    let schema_version = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(1);
    ProjectFile {
        schema_version,
        versionless: false,
        project: parse_project_info(value.get("project")),
        graph: value.get("graph").cloned().unwrap_or_else(|| json!({})),
        settings: value.get("settings").cloned().unwrap_or_else(empty_object),
        episode_titles: value
            .get("episodeTitles")
            .cloned()
            .unwrap_or_else(empty_object),
        assets: value.get("assets").cloned().unwrap_or_else(empty_assets),
    }
}

/// 显式 schemaVersion 的家族一致性校验与解析（§11 第 0 步）：0 属旧扁平
/// 家族、≥1 属 v1 家族，版本号与信封形状两族矛盾即拒绝并保留原文件——
/// 否则 v1 StoryNode 会被送进旧版迁移器，且每次 v0 加载都被视为已迁移
/// 并回写，可能摧毁节点字段；显式 0 且保持扁平形状时包装为 v0 信封。
fn parse_explicit_envelope(
    id: &str,
    value: serde_json::Value,
    v1_keys: usize,
    legacy_keys: usize,
) -> Result<ProjectFile, String> {
    let Some(version) = value.get("schemaVersion").and_then(|sv| sv.as_u64()) else {
        return Err("schemaVersion 不是非负整数，无法判别文档信封（已保留原文件）".into());
    };
    if version == 0 {
        if v1_keys > 0 {
            return Err(
                "文档信封自相矛盾：schemaVersion 0 却携带 v1 专属键（已保留原文件）".into(),
            );
        }
        return Ok(wrap_legacy(id, &value));
    }
    if legacy_keys > 0 {
        return Err(
            "文档信封自相矛盾：schemaVersion ≥ 1 却携带旧扁平特征键（已保留原文件）".into(),
        );
    }
    if version > u64::from(u32::MAX) {
        // 超出 u32 的版本号无法无损载入信封：截断回退会把未来文档当作当前
        // v1 交付，保存时按 v1 回写并丢弃未知字段——拒绝加载并保留原文件
        return Err("schemaVersion 超出可表示范围（疑似未来版本），拒绝加载并保留原文件".into());
    }
    Ok(parse_v1_envelope(&value))
}

/// 无版本号信封的形状判型（§11 第 0 步）：v1 专属键（project/graph/assets）
/// 独占时赋予待修复的有效版本 1；旧扁平特征键（≥2 个且含 nodes/edges）独占
/// 时包装为 v0 信封；混合或两组特征均不足的损坏文档拒绝加载并保留原文件——
/// 绝不把保持 v1 形状的文档误包装成空 v0 图后回写摧毁原画布。
fn classify_versionless(
    id: &str,
    value: serde_json::Value,
    v1_keys: usize,
    legacy_keys: usize,
    has_legacy_list: bool,
) -> Result<ProjectFile, String> {
    if v1_keys > 0 && legacy_keys == 0 {
        let mut file = parse_v1_envelope(&value);
        file.versionless = true;
        return Ok(file);
    }
    if v1_keys == 0 && legacy_keys >= 2 && has_legacy_list {
        return Ok(wrap_legacy(id, &value));
    }
    Err("无法判别文档信封：v1 与旧扁平特征键混合或均不足（已保留原文件）".into())
}

/// 解析项目文件（§11 第 0 步信封判型）：显式 `schemaVersion` 定族并经
/// 家族一致性校验（parse_explicit_envelope），缺失时按顶层键形状特征判型
/// （classify_versionless）；两族矛盾或不可判型一律拒绝并保留原文件。
/// 缺失/异型的 project 元数据（id/时间戳等）以空串**原样透传**，不在读取
/// 侧预合成——预合成会让前端 repaired 检测看不见缺陷（载荷已是修好的
/// 值）：修复不回写、脏文件长留磁盘，且每次 list 都合成新的当前时刻把
/// 未动过的项目顶到最近列表顶端。修复与落盘归前端 §11.1 第 2 步
/// （受信 id 覆盖、时间戳回退链，随 repaired 标志回写）；列表排序把
/// 不可解析时间戳稳定排最后（sort_metas_by_recency）。
fn parse_file(id: &str, text: &str) -> Result<ProjectFile, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let v1_keys = ["project", "graph", "assets"]
        .iter()
        .filter(|k| value.get(*k).is_some())
        .count();
    let legacy_keys = ["name", "updated_at", "nodes", "edges"]
        .iter()
        .filter(|k| value.get(*k).is_some())
        .count();
    let has_legacy_list = value.get("nodes").is_some() || value.get("edges").is_some();
    Ok(match value.get("schemaVersion") {
        Some(_) => parse_explicit_envelope(id, value, v1_keys, legacy_keys)?,
        None => classify_versionless(id, value, v1_keys, legacy_keys, has_legacy_list)?,
    })
}

/// 新建空项目（空画布 v1 信封），返回其摘要。
/// 新建项目的初始 v1 文档：settings 四桶齐备（§10.5 保存边界同域）——
/// 新建文档必须无需归一化修复即可通过 create → load → save 原始链路。
fn new_project_file(id: &str, name: String, now: String) -> ProjectFile {
    ProjectFile {
        schema_version: 1,
        versionless: false,
        project: ProjectInfo {
            id: id.to_string(),
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
        settings: json!({ "characters": {}, "locations": {}, "props": {}, "documents": {} }),
        episode_titles: json!({}),
        assets: empty_assets(),
    }
}

#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&name)?;
    let id = new_id();
    // 边界校验先于任何文件名拼接（与 persist_project 同款）：id 虽为本地
    // 生成，仍以同一口径复核后才参与路径构造
    validate_id(&id)?;
    let file = new_project_file(&id, name, now_iso());
    let dir = projects_dir(&app)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    atomic_write(&dir, &format!("{id}.json"), &text)?;
    Ok(read_meta(&id, &file))
}

/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let dir = projects_dir(&app)?;
    load_project_file(&dir, &id)
}

/// load_project 的可测内核：id 是 IPC 调用方传入的不可信参数，词法校验
/// 先于任何路径拼接——嵌套路径形态的 id（如 `p-1/assets/x`）不得把
/// projects/ 内的任意 JSON 经项目通道读出（verify_control_file 只验包含
/// 关系，拦不住深度嵌套的常规文件）。读取走 read_verified_file 的已验证
/// 句柄绑定。
fn load_project_file(dir: &std::path::Path, id: &str) -> Result<ProjectFile, String> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.json"));
    if !path.exists() {
        return Err(format!("项目不存在：{id}"));
    }
    let text = read_verified_file(dir, &path).map_err(|e| format!("拒绝读取项目文件：{e}"))?;
    parse_file(id, &text).map_err(|e| format!("项目文件损坏：{e}"))
}

/// 经已验证句柄读取项目文件文本（load/list 共用内核）：verify_control_file
/// 校验后打开句柄并按 (dev, ino) 与校验时身份比对一致后才从**同一句柄**
/// 读取——校验与打开之间路径被换成符号链接/另一文件时拒绝且不读取，打开
/// 之后的路径替换不影响所读内容。目录扫描（list）与按 id 读取（load）
/// 共用此绑定，杜绝「验一个路径、读另一个实体」的 TOCTOU 窗口。
fn read_verified_file(dir: &std::path::Path, path: &std::path::Path) -> Result<String, String> {
    let verified_identity = verify_control_file(dir, path)?;
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| format!("打开项目文件失败：{e}"))?;
    #[cfg(unix)]
    if let Some((dev, ino)) = verified_identity {
        use std::os::unix::fs::MetadataExt;
        let fm = file
            .metadata()
            .map_err(|e| format!("读取项目文件句柄元数据失败：{e}"))?;
        if (fm.dev(), fm.ino()) != (dev, ino) {
            return Err("项目文件在读取前被替换，拒绝读取".into());
        }
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("读取项目文件失败：{e}"))?;
    Ok(text)
}

/// 全量保存（§10.5 保存边界）：完整信封校验先行，任一失败整次拒绝；
/// 资产 relPath 在已验证的 projects 目录下做实路径复验（no-follow +
/// canonical 包含），通过后才盖戳 updatedAt、创建临时文件并原子落盘；
/// 落盘后再复验一次——句柄只绑定打开时的 inode，不钉住路径名，保存期间
/// 被并发进程替换（unlink/重命名/换符号链接）的路径在写后复验中上浮为
/// 显式失败（文档虽已提交，篡改不得静默；下次加载复验会隔离条目兜底）。
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let dir = projects_dir(&app)?;
    persist_project(&dir, &id, doc)
}

/// save_project 的可测内核（给定已验证的 projects 目录）。id 是 IPC 调用方
/// 传入的不可信参数：词法校验先于任何路径拼接——否则 `../prefs` 式 id 可把
/// 空资产索引（复验不设防）的整份文档写到 projects/ 之外。
fn persist_project(
    dir: &std::path::Path,
    id: &str,
    doc: ProjectFile,
) -> Result<ProjectMeta, String> {
    validate_id(id)?;
    // 句柄持有至函数结束——复验过的实体覆盖整个保存决策
    let _verified_assets = verify_save_asset_files(dir, id, &doc.assets)?;
    let file = prepare_save(id, &doc)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    atomic_write(dir, &format!("{id}.json"), &text)?;
    if let Err(e) = verify_save_asset_files(dir, id, &doc.assets) {
        eprintln!("[store] 保存后资产复验失败，路径可能在保存期间被替换：{e}");
        return Err(format!(
            "保存后资产复验失败（路径可能在保存期间被替换）：{e}"
        ));
    }
    Ok(read_meta(id, &file))
}

/// 删除项目（首页卡片菜单，§3.2）：移除 `projects/{id}.json` 与项目资产
/// 目录 `projects/{id}/`（当前扁平布局的资产根，§10.1）。目录删除逐项
/// no-follow 且全程相对已打开的 projects 根目录句柄（§10.2 openat 语义，
/// cap-std）——符号链接条目只移除链接本身，绝不跟随；任一失败显式报错，
/// 不静默遗留媒体文件。
#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let dir = projects_dir(&app)?;
    delete_project_files(&dir, &id)
}

/// delete_project 的可测内核：资产目录与项目 JSON 的成对移除，幂等。
/// 顺序契约：先删资产树再删权威项目文件——树删除失败时项目仍在列表中
/// 可发现、可重试删除；反过来先删 JSON 会让失败留下不可发现的孤儿媒体。
/// 元数据读取、树删除与 unlink 均相对已打开的 projects 根目录句柄进行
/// （cap-std remove_dir_all 内部同样是逐组件 no-follow 的句柄相对实现），
/// 归类后 `projects/{id}` 被并发换成符号链接也无法把删除引到根外——链接
/// 自身按 remove_file 移除，不进入其指向的外部树。
fn delete_project_files(dir: &std::path::Path, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let root = CapDir::open_ambient_dir(dir, ambient_authority())
        .map_err(|e| format!("打开项目根目录失败：{e}"))?;
    match root.symlink_metadata(id) {
        Ok(md) if md.is_dir() => root
            .remove_dir_all(id)
            .map_err(|e| format!("删除项目资产目录失败（{id}）：{e}"))?,
        // 符号链接与普通文件同款：remove_file 只移除该目录项自身
        Ok(_) => root
            .remove_file(id)
            .map_err(|e| format!("移除项目资产路径失败（{id}）：{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取待删资产路径元数据失败（{id}）：{e}")),
    }
    match root.remove_file(format!("{id}.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除项目失败：{e}")),
    }
    Ok(())
}

/// §7.3 复制项目：整目录拷贝项目资产（当前扁平布局下 `projects/{fromId}/
/// assets` → `projects/{toId}/assets`），供 §10.5 保存边界的实路径复验在
/// 副本侧通过。源资产目录缺失视为无资产（no-op）；存在时源根必须为非
/// 符号链接的实际目录，子树逐项 no-follow——符号链接与非普通文件条目
/// 拒绝；目标目录已存在视为异常（新副本 id 刚分配）。任一失败整次报错
/// 并回滚已拷贝的目标子树，不遗留半拷贝。
#[tauri::command]
pub fn copy_project_assets(app: AppHandle, from_id: String, to_id: String) -> Result<(), String> {
    let dir = projects_dir(&app)?;
    copy_assets_tree(&dir, &from_id, &to_id)
}

/// copy_project_assets 的可测内核。全程相对已打开的 projects 根目录句柄
/// 执行（§10.2 openat 语义，cap-std）：归类、目录打开、递归与文件创建
/// 不再退回路径名拼接——源/目标子目录在元数据检查后被并发替换（含换成
/// 符号链接）时，句柄相对解析仍不逃出 projects/，越界符号链接被沙箱拒绝。
fn copy_assets_tree(dir: &std::path::Path, from_id: &str, to_id: &str) -> Result<(), String> {
    validate_id(from_id)?;
    validate_id(to_id)?;
    let root = CapDir::open_ambient_dir(dir, ambient_authority())
        .map_err(|e| format!("打开项目根目录失败：{e}"))?;
    let src_rel = format!("{from_id}/assets");
    let md = match root.symlink_metadata(&src_rel) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取源资产目录元数据失败：{e}")),
    };
    if md.file_type().is_symlink() {
        return Err("源资产目录是符号链接，拒绝复制".into());
    }
    if !md.is_dir() {
        return Err("源资产路径不是目录，拒绝复制".into());
    }
    match root.symlink_metadata(to_id) {
        Ok(_) => return Err(format!("目标资产目录已存在，拒绝复制：{to_id}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取目标资产目录元数据失败：{e}")),
    }
    // 拷贝目标是 {to}/assets：与 relPath 首段（§7.1）及实路径复验的资产根一致
    let src_dir = open_dir_bound(&root, &src_rel, &md, "源资产目录")?;
    root.create_dir_all(to_id)
        .map_err(|e| format!("创建目标项目目录失败：{e}"))?;
    let dst_root = root
        .open_dir(to_id)
        .map_err(|e| format!("打开目标项目目录失败：{e}"))?;
    dst_root
        .create_dir("assets")
        .map_err(|e| format!("创建目标资产目录失败：{e}"))?;
    let dst_assets = dst_root
        .open_dir("assets")
        .map_err(|e| format!("打开目标资产目录失败：{e}"))?;
    if let Err(e) = copy_dir_handles(&src_dir, &dst_assets) {
        // 回滚清理同款句柄相对删除（§10.2）：dst_root 被并发换成符号链接时
        // remove_dir_all 只移除链接自身，不进入其指向的外部树
        let _ = root.remove_dir_all(to_id);
        return Err(e);
    }
    Ok(())
}

/// 打开已归类为实际目录的子目录并绑定身份（§10.2）：cap-std 的 open_dir
/// 在沙箱内跟随符号链接，Unix 上以打开句柄的 (dev, ino) 与归类时身份比对
/// ——归类后被换成符号链接/另一实体即拒绝，不从被替换的目标读出；
/// 非 Unix 平台仅靠 cap-std 沙箱界。
#[allow(unused_variables)]
fn open_dir_bound<P: AsRef<std::path::Path>>(
    parent: &CapDir,
    rel: P,
    classified: &cap_std::fs::Metadata,
    label: &str,
) -> Result<CapDir, String> {
    let opened = parent
        .open_dir(&rel)
        .map_err(|e| format!("打开{label}失败：{e}"))?;
    #[cfg(unix)]
    {
        let fm = opened
            .dir_metadata()
            .map_err(|e| format!("读取{label}句柄元数据失败：{e}"))?;
        if asset_identity(&fm) != asset_identity(classified) {
            return Err(format!("{label}在归类后被替换，拒绝复制"));
        }
    }
    #[cfg(not(unix))]
    let _ = classified;
    Ok(opened)
}

/// 递归拷贝目录树（句柄相对 + 逐项 no-follow，§10.2）：目录对应创建，
/// 普通文件逐个拷贝，符号链接与异型条目拒绝——副本绝不携带根外内容。
/// 递归与创建全部相对**已打开的目录句柄**进行：中间目录被并发替换时不再
/// 按路径名重新解析。源子目录经 open_dir_bound 绑定身份；源文件绑定打开
/// 句柄（Unix：按 (dev, ino) 与归类时身份比对），从同一句柄读出；目标
/// 文件以 create_new 排他创建，预置在目标路径上的符号链接无法截获写入；
/// 目标子目录 create_dir 排他创建后立即打开，残余窗口内的替换也被 cap-std
/// 沙箱限定在 projects/ 树内。
fn copy_dir_handles(src: &CapDir, dst: &CapDir) -> Result<(), String> {
    let entries = src
        .entries()
        .map_err(|e| format!("扫描源资产目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("扫描源资产目录失败：{e}"))?;
        // DirEntry::metadata 取 lstat 语义，不跟随符号链接
        let md = entry
            .metadata()
            .map_err(|e| format!("读取源资产条目元数据失败：{e}"))?;
        let name = entry.file_name();
        let shown = name.to_string_lossy();
        let ft = md.file_type();
        if ft.is_symlink() {
            return Err(format!("源资产子树含符号链接，拒绝复制：{shown}"));
        }
        if ft.is_dir() {
            let child_src = open_dir_bound(src, &name, &md, "源资产子目录")?;
            dst.create_dir(&name)
                .map_err(|e| format!("创建目标资产子目录失败（{shown}）：{e}"))?;
            let child_dst = dst
                .open_dir(&name)
                .map_err(|e| format!("打开目标资产子目录失败（{shown}）：{e}"))?;
            copy_dir_handles(&child_src, &child_dst)?;
        } else if ft.is_file() {
            copy_file_bound(src, &name, &md, dst)?;
        } else {
            return Err(format!("源资产子树含非普通文件条目：{shown}"));
        }
    }
    Ok(())
}

/// 单文件绑定拷贝（句柄相对）：源从句柄读（身份与归类时一致），目标排他创建。
fn copy_file_bound(
    src_dir: &CapDir,
    name: &std::ffi::OsStr,
    classified: &cap_std::fs::Metadata,
    dst_dir: &CapDir,
) -> Result<(), String> {
    let shown = name.to_string_lossy();
    let mut src = src_dir
        .open(name)
        .map_err(|e| format!("打开源资产失败（{shown}）：{e}"))?;
    #[cfg(unix)]
    {
        let fm = src
            .metadata()
            .map_err(|e| format!("读取源资产句柄元数据失败（{shown}）：{e}"))?;
        if asset_identity(&fm) != asset_identity(classified) {
            return Err(format!("源资产在拷贝期间被替换，拒绝复制：{shown}"));
        }
    }
    #[cfg(not(unix))]
    let _ = classified;
    let mut dst_file = dst_dir
        .open_with(
            name,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )
        .map_err(|e| format!("创建目标资产失败（{shown}）：{e}"))?;
    std::io::copy(&mut src, &mut dst_file)
        .map(|_| ())
        .map_err(|e| format!("拷贝资产文件失败（{shown}）：{e}"))
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
    fn v1_file_missing_timestamps_pass_through_for_frontend_repair() {
        // 缺 project 时间戳的信封原样透传（空串）：Rust 侧预合成会让前端
        // repaired 检测看不见缺陷（快照已是修好的值）——修复不回写、脏文件
        // 长留，且每次 list 都合成新时刻把未动过的项目顶到最近列表顶端。
        // 前端 §11.1 第 2 步修复时间戳并按 repaired 回写落定；列表排序把
        // 不可解析时间戳稳定排最后（sort_metas_by_recency）。
        let v1 = json!({
            "schemaVersion": 1,
            "project": { "id": "p-1", "name": "旧时间" },
            "graph": { "nodes": [], "edges": [] },
            "settings": {},
            "episodeTitles": {},
            "assets": { "byId": {} },
        });
        let file = parse_file("p-1", &v1.to_string()).unwrap();
        assert!(file.project.updated_at.is_empty());
        assert!(file.project.created_at.is_empty());
    }

    #[test]
    fn legacy_flat_file_wraps_as_v0_envelope() {
        let legacy = json!({
            "name": "旧项目",
            "updated_at": 1_700_000_000_000u64,
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
    fn versionless_v1_envelope_classifies_as_v1_and_keeps_graph() {
        // 丢失版本号但保持 v1 信封特征（§11 第 0 步）：按 v1 交付归一化，
        // 绝不按旧扁平格式读取顶层 nodes/edges 装配出空画布并回写摧毁原文件
        let v1 = json!({
            "project": {
                "id": "p-1", "name": "丢版本号",
                "createdAt": "2026-08-01T00:00:00.000Z",
                "updatedAt": "2026-08-28T12:00:00.000Z",
            },
            "graph": {
                "nodes": [{ "id": "s1", "type": "scene",
                            "layout": { "position": { "x": 0, "y": 0 } },
                            "ui": { "selected": false, "expanded": true },
                            "data": { "spec": {}, "meta": { "label": "场一" } } }],
                "edges": [],
            },
            "settings": { "characters": {}, "locations": {}, "props": {}, "documents": {} },
            "episodeTitles": {},
            "assets": { "byId": {} },
        });
        let file = parse_file("p-1", &v1.to_string()).unwrap();
        assert_eq!(file.schema_version, 1);
        assert_eq!(file.graph["nodes"][0]["id"], json!("s1"));
        // 判型打 versionless IPC 标记：载荷额外键让前端 repaired 比较必然
        // 不等，回写补盖显式版本号——文件不再永久无版本（§10.5/§11.1 收敛）
        assert!(file.versionless);
        let ipc = serde_json::to_value(&file).unwrap();
        assert_eq!(ipc["versionless"], json!(true));
        // 显式版本与 v0 包装不打标记（v0 迁移本身即回写）
        let explicit = json!({
            "schemaVersion": 1,
            "project": { "id": "p-1", "name": "显式" },
            "graph": { "nodes": [], "edges": [] },
        });
        assert!(
            !parse_file("p-1", &explicit.to_string())
                .unwrap()
                .versionless
        );
        let v0 = json!({
            "name": "旧项目", "updated_at": 1_700_000_000_000u64,
            "nodes": [], "edges": [],
        });
        assert!(!parse_file("p-1", &v0.to_string()).unwrap().versionless);
    }

    #[test]
    fn mixed_or_unclassifiable_envelope_is_rejected() {
        // v1 专属键与旧扁平键并存（混合信封）、或两组特征都不满足的损坏文档：
        // 拒绝加载并保留原文件（§11 第 0 步），不得回退为空 v0 图
        let mixed = json!({
            "project": { "name": "混合信封" },
            "name": "旧名",
            "updated_at": 1_700_000_000_000u64,
            "nodes": [],
            "edges": [],
        });
        assert!(parse_file("p-1", &mixed.to_string()).is_err());
        assert!(parse_file("p-1", "{}").is_err());
        assert!(parse_file("p-1", r#"{"foo": 1}"#).is_err());
        // 单个旧扁平键不足以判型
        assert!(parse_file("p-1", r#"{"nodes": []}"#).is_err());
    }

    #[test]
    fn explicit_version_conflicting_with_envelope_family_is_rejected() {
        // 显式 schemaVersion: 0 却携带 v1 专属键（§11 第 0 步两族冲突）：
        // 若放行，前端会把 v1 StoryNode 送进旧版迁移器，且每次 v0 加载都
        // 视为已迁移并回写，可能摧毁节点字段——拒绝加载并保留原文件
        let v0_with_v1 = json!({
            "schemaVersion": 0,
            "project": { "name": "伪装旧版" },
            "graph": { "nodes": [], "edges": [] },
            "assets": { "byId": {} },
        });
        assert!(parse_file("p-1", &v0_with_v1.to_string()).is_err());
        // 反向冲突：显式 v1 信封携带旧扁平专属键（顶层 name/updated_at/nodes/edges）
        let v1_with_legacy = json!({
            "schemaVersion": 1,
            "project": { "name": "x" },
            "graph": { "nodes": [], "edges": [] },
            "name": "旧名",
            "nodes": [],
        });
        assert!(parse_file("p-1", &v1_with_legacy.to_string()).is_err());
        // 非数字版本号不可判型
        assert!(parse_file(
            "p-1",
            r#"{"schemaVersion": "1", "project": {}, "graph": {}}"#
        )
        .is_err());
    }

    #[test]
    fn explicit_v0_with_legacy_shape_wraps_as_v0_envelope() {
        // 显式 0 = 旧扁平家族：信封保持扁平形状时与无版本号路径一致包装
        let legacy = json!({
            "schemaVersion": 0,
            "name": "显式旧版",
            "updated_at": 1_700_000_000_000u64,
            "nodes": [{ "id": "a", "type": "scene", "data": {} }],
            "edges": [],
        });
        let file = parse_file("p-old", &legacy.to_string()).unwrap();
        assert_eq!(file.schema_version, 0);
        assert_eq!(file.project.name, "显式旧版");
        assert_eq!(file.graph["nodes"][0]["id"], json!("a"));
    }

    #[test]
    fn v1_file_with_recoverable_project_metadata_loads_for_frontend_repair() {
        // project 容器/字段异型不再整份拒绝（§11 第 0 步）：逐字段回退缺省，
        // 字段级修复与警告归前端归一化层（§11.1 第 3 步）——可恢复的元数据
        // 损坏不应让整个项目打不开
        let doc = json!({
            "schemaVersion": 1,
            "project": null,
            "graph": { "nodes": [], "edges": [] },
            "settings": {},
            "episodeTitles": {},
            "assets": { "byId": {} },
        });
        let file = parse_file("p-1", &doc.to_string()).unwrap();
        // id 缺省同样透传（空串）：前端以受信路径 id 覆盖并按 repaired 回写
        assert!(file.project.id.is_empty());
        assert!(file.project.name.is_empty()); // 名称缺省，前端按回退链修复

        // 字段级异型：name/description/时间戳非字符串，id 非字符串——
        // 一律回退空串透传，修复与落盘归前端归一化层
        let doc = json!({
            "schemaVersion": 1,
            "project": { "id": 7, "name": null, "description": 42, "createdAt": 5, "updatedAt": [] },
            "graph": { "nodes": [{ "id": "s1" }], "edges": [] },
        });
        let file = parse_file("p-1", &doc.to_string()).unwrap();
        assert!(file.project.id.is_empty());
        assert!(file.project.name.is_empty());
        assert_eq!(file.project.description, None);
        assert!(file.project.created_at.is_empty());
        assert!(file.project.updated_at.is_empty());
        // graph 原样透传，内容不丢
        assert_eq!(file.graph["nodes"][0]["id"], json!("s1"));
    }

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
    fn explicit_schema_version_beyond_u32_is_rejected() {
        // schemaVersion 超出 u32 可表示范围：截断回退为 1 会让未来版本文档被
        // 当作当前 v1 交付，随后保存按 v1 回写、未知字段静默丢弃——拒绝加载
        // 并保留原文件（§11 第 0 步；可表示的更大版本仍交付前端「版本过新」判定）
        let doc = json!({
            "schemaVersion": 4_294_967_296u64, // u32::MAX + 1
            "project": { "name": "未来文档" },
            "graph": { "nodes": [], "edges": [] },
        });
        assert!(parse_file("p-1", &doc.to_string()).is_err());
        // 可表示范围内的未来版本照旧放行给前端判定
        let doc = json!({
            "schemaVersion": 2,
            "project": { "name": "未来文档" },
            "graph": { "nodes": [], "edges": [] },
        });
        let file = parse_file("p-1", &doc.to_string()).unwrap();
        assert_eq!(file.schema_version, 2);
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

    #[test]
    fn project_info_none_description_is_omitted_not_null() {
        // description 缺省若序列化为 null：前端归一化把 null 当异型剥离
        // （repaired=true）→ 回写 → Rust 又写回 null——示例项目的列表升级
        // 循环永不收敛（全新启动首页加载不完、示例文件被反复重写）；
        // 缺省必须省略键，往返才收敛
        let file = new_project_file("p-1", "剧".into(), now_iso());
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains("\"description\""), "None 应省略键：{text}");
        let mut file = file;
        file.project.description = Some("简介".into());
        let text = serde_json::to_string(&file).unwrap();
        assert!(text.contains("\"description\":\"简介\""));
        // 省略键的解析往返：回到 None
        let bare = serde_json::to_string(&new_project_file("p-1", "剧".into(), now_iso())).unwrap();
        let back: ProjectFile = serde_json::from_str(&bare).unwrap();
        assert_eq!(back.project.description, None);
    }

    #[test]
    fn project_file_round_trip() {
        let file = ProjectFile {
            schema_version: 1,
            versionless: false,
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
        // 缺省 id 透传空串：前端以受信路径 id 覆盖并随 repaired 回写落定
        assert_eq!(file.project.id, "");
        assert_eq!(file.settings, json!({}));
        assert_eq!(file.assets, json!({ "byId": {} }));
    }

    /// 合法 v1 信封（保存边界校验的基线载荷）。
    fn valid_save_doc() -> ProjectFile {
        ProjectFile {
            schema_version: 1,
            versionless: false,
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

    #[test]
    fn iso8601_to_epoch_millis_normalizes_offsets_and_precision() {
        // 同一瞬间的三种合法写法必须得到同一排序键
        assert_eq!(iso8601_to_epoch_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            iso8601_to_epoch_millis("1970-01-01T08:00:00+08:00"),
            Some(0)
        );
        assert_eq!(
            iso8601_to_epoch_millis("1969-12-31T16:00:00-08:00"),
            Some(0)
        );
        // 小数秒补齐/截断到毫秒
        assert_eq!(
            iso8601_to_epoch_millis("1970-01-01T00:00:00.500Z"),
            Some(500)
        );
        assert_eq!(iso8601_to_epoch_millis("1970-01-01T00:00:00.5Z"), Some(500));
        // 非法串无排序键
        assert_eq!(iso8601_to_epoch_millis("not-a-date"), None);
        assert_eq!(iso8601_to_epoch_millis(""), None);
    }

    fn meta(id: &str, updated_at: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.into(),
            name: id.into(),
            updated_at: updated_at.into(),
            scene_count: 0,
            ending_count: 0,
        }
    }

    #[test]
    fn project_list_sorts_by_instant_not_text() {
        // 字典序把 "2026-01-01T00:00:00+10:00" 排在 "2025-12-31T20:00:00Z" 之前，
        // 但前者实为更早的瞬间（2025-12-31T14:00:00Z）——排序必须按瞬间比较，
        // 缺失/非法时间戳排最后
        let mut metas = vec![
            meta("b", "2026-01-01T00:00:00+10:00"),
            meta("a", "2025-12-31T20:00:00Z"),
            meta("c", "2025-12-31T20:00:00.500Z"),
            meta("d", "garbage"),
        ];
        sort_metas_by_recency(&mut metas);
        let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b", "d"]);
    }

    /// 唯一临时项目根：`{tmp}/pw-store-test-{new_id}/projects/`，返回 projects 目录。
    fn temp_projects_dir() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("pw-store-test-{}", new_id()))
            .join("projects");
        fs::create_dir_all(&dir).expect("创建临时 projects 目录");
        dir
    }

    fn cleanup_temp(projects: &std::path::Path) {
        if let Some(parent) = projects.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn verify_asset_real_path_accepts_regular_file_under_project_root() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("创建资产目录");
        fs::write(assets.join("a1.png"), b"png").expect("写入资产文件");
        assert!(verify_asset_real_path(&projects, "p-1", "assets/a1.png").is_ok());
        cleanup_temp(&projects);
    }

    #[test]
    fn verify_asset_real_path_rejects_missing_file_and_missing_root() {
        let projects = temp_projects_dir();
        fs::create_dir_all(projects.join("p-1").join("assets")).expect("创建资产目录");
        let err = verify_asset_real_path(&projects, "p-1", "assets/gone.png").unwrap_err();
        assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
        // 项目资产根本身缺失同样拒存（该项目从未落过资产文件）
        assert!(verify_asset_real_path(&projects, "p-2", "assets/a1.png").is_err());
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
        let err = verify_asset_real_path(&projects, "p-1", "assets/link.png").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }

    #[test]
    fn verify_save_asset_files_prefixes_asset_key_and_skips_lexical_invalid() {
        let projects = temp_projects_dir();
        // relPath 词法非法的条目交给 prepare_save 的形状诊断，实路径复验跳过不误报
        let doc_assets = json!({ "byId": { "a-bad": { "relPath": "../evil.png" } } });
        assert!(verify_save_asset_files(&projects, "p-1", &doc_assets).is_ok());

        let doc_assets = json!({ "byId": { "a1": { "relPath": "assets/a1.png" } } });
        let err = verify_save_asset_files(&projects, "p-1", &doc_assets).unwrap_err();
        assert!(err.contains("资产 a1"), "诊断缺资产键：{err}");
        cleanup_temp(&projects);
    }

    #[test]
    fn copy_assets_tree_copies_regular_files_recursively() {
        let projects = temp_projects_dir();
        let src = projects.join("p-1").join("assets");
        fs::create_dir_all(src.join("sub")).expect("建源目录");
        fs::write(src.join("a.png"), b"A").expect("写资产");
        fs::write(src.join("sub").join("b.png"), b"B").expect("写子目录资产");
        copy_assets_tree(&projects, "p-1", "p-2").expect("拷贝项目资产");
        let dst = projects.join("p-2").join("assets");
        assert_eq!(fs::read(dst.join("a.png")).expect("副本文件缺失"), b"A");
        assert_eq!(
            fs::read(dst.join("sub").join("b.png")).expect("子目录副本缺失"),
            b"B"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn copy_assets_tree_noop_without_source_and_rejects_existing_destination() {
        let projects = temp_projects_dir();
        // 源项目无资产目录：no-op 成功（无资产项目的复制路径）
        assert!(copy_assets_tree(&projects, "p-1", "p-2").is_ok());
        fs::create_dir_all(projects.join("p-1").join("assets")).expect("建源目录");
        fs::create_dir_all(projects.join("p-3")).expect("预置目标");
        let err = copy_assets_tree(&projects, "p-1", "p-3").unwrap_err();
        assert!(err.contains("目标资产目录已存在"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn copy_assets_tree_rejects_symlink_and_rolls_back_partial_copy() {
        let projects = temp_projects_dir();
        let src = projects.join("p-1").join("assets");
        fs::create_dir_all(&src).expect("建源目录");
        fs::write(src.join("a.png"), b"A").expect("写资产");
        let outside = projects.parent().expect("临时根").join("outside.png");
        fs::write(&outside, b"secret").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, src.join("link.png")).expect("建符号链接");
        let err = copy_assets_tree(&projects, "p-1", "p-2").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        // 失败回滚：不遗留半拷贝的目标目录
        assert!(fs::symlink_metadata(projects.join("p-2")).is_err());
        cleanup_temp(&projects);
    }

    #[test]
    fn delete_project_files_removes_json_and_asset_tree_idempotently() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a.png"), b"A").expect("写资产");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        delete_project_files(&projects, "p-1").expect("删除项目");
        assert!(fs::symlink_metadata(projects.join("p-1.json")).is_err());
        assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
        // 幂等：文件与目录均已缺失时再删不报错
        assert!(delete_project_files(&projects, "p-1").is_ok());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn delete_project_files_unlinks_symlinks_without_following() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        let outside_dir = projects.parent().expect("临时根").join("keep");
        fs::create_dir_all(&outside_dir).expect("建根外目录");
        fs::write(outside_dir.join("secret.png"), b"s").expect("写根外文件");
        std::os::unix::fs::symlink(&outside_dir, assets.join("link")).expect("建目录符号链接");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        delete_project_files(&projects, "p-1").expect("删除项目");
        // 链接被移除但未跟随：根外目录与文件原样保留
        assert!(fs::symlink_metadata(outside_dir.join("secret.png")).is_ok());
        assert!(fs::symlink_metadata(&outside_dir).is_ok());
        assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
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
        let keys = unverifiable_asset_keys(&projects, "p-1", &assets);
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
        let keys = unverifiable_asset_keys(&projects, "p-1", &assets);
        assert_eq!(keys, vec!["a-link".to_string()]);
        cleanup_temp(&projects);
    }
    #[test]
    fn verify_control_file_requires_regular_file() {
        let projects = temp_projects_dir();
        let file = projects.join("p-1.json");
        fs::write(&file, b"{}").expect("写项目文件");
        assert!(verify_control_file(&projects, &file).is_ok());
        // 目录占位：不是普通文件
        let dir_as_file = projects.join("p-2.json");
        fs::create_dir(&dir_as_file).expect("建目录占位");
        let err = verify_control_file(&projects, &dir_as_file).unwrap_err();
        assert!(err.contains("普通文件"), "意外诊断：{err}");
        // 缺失文件拒绝（读取前置）
        assert!(verify_control_file(&projects, &projects.join("p-3.json")).is_err());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn verify_control_file_rejects_symlinked_project_file() {
        let projects = temp_projects_dir();
        let outside = projects.parent().expect("临时根").join("evil.json");
        fs::write(&outside, b"{}").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
        let err = verify_control_file(&projects, &projects.join("p-1.json")).unwrap_err();
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
        let handle = verify_asset_real_path(&projects, "p-1", "assets/a1.png")
            .expect("复验通过应返回已打开的句柄");
        let md = handle.metadata().expect("句柄元数据可读");
        assert!(md.is_file());
        cleanup_temp(&projects);
    }
    #[cfg(unix)]
    #[test]
    fn delete_project_files_keeps_record_when_asset_tree_removal_fails() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a.png"), b"A").expect("写资产");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        // 只读化资产目录：子项删除失败（非 root 用户无法 unlink）
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&assets).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(&assets, perms).expect("只读化");
        let result = delete_project_files(&projects, "p-1");
        let mut perms = fs::metadata(&assets).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(&assets, perms);
        assert!(result.is_err(), "资产目录删除失败应显式报错");
        // 权威项目文件必须仍在：项目可发现、删除可重试，不留孤儿媒体树
        assert!(
            projects.join("p-1.json").exists(),
            "项目记录先于资产目录被删，失败后媒体成不可发现孤儿"
        );
        cleanup_temp(&projects);
    }
    #[test]
    fn persist_project_writes_envelope_and_passes_post_verify() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        let meta = persist_project(&projects, "p-1", doc).expect("保存");
        assert_eq!(meta.name, "剧");
        assert!(projects.join("p-1.json").exists(), "项目文件应落盘");
        cleanup_temp(&projects);
    }
    #[test]
    fn persist_project_rejects_untrusted_id_before_any_join() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        // 空资产索引下复验不设防：id 词法校验必须在任何路径拼接前拒绝
        let err = persist_project(&projects, "../evil", doc).unwrap_err();
        assert!(err.contains("非法"), "意外诊断：{err}");
        // 不得在 projects/ 之外创建任何文件
        assert!(
            fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
            "越界 id 不应写出 projects/"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn persist_project_replaces_existing_file_and_leaves_no_temp() {
        let projects = temp_projects_dir();
        let first = new_project_file("p-1", "一版".into(), now_iso());
        persist_project(&projects, "p-1", first).expect("首存");
        let second = new_project_file("p-1", "二版".into(), now_iso());
        persist_project(&projects, "p-1", second).expect("覆盖保存（rename 替换已存在目标）");
        let loaded = load_project_file(&projects, "p-1").expect("重读");
        assert_eq!(loaded.project.name, "二版");
        let leftovers: Vec<String> = fs::read_dir(&projects)
            .expect("扫描项目目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "遗留临时文件：{leftovers:?}");
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn persist_project_rejects_symlinked_target_without_following() {
        let projects = temp_projects_dir();
        let outside = projects.parent().expect("临时根").join("evil-target.json");
        fs::write(&outside, b"{}").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        let err = persist_project(&projects, "p-1", doc).unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        // 链接未被跟随或覆盖：根外文件原样保留，链接本身仍在
        assert_eq!(fs::read(&outside).expect("读根外文件"), b"{}".to_vec());
        assert!(fs::symlink_metadata(projects.join("p-1.json"))
            .expect("链接仍在")
            .file_type()
            .is_symlink());
        cleanup_temp(&projects);
    }

    #[test]
    fn atomic_write_rejects_path_like_file_name() {
        let projects = temp_projects_dir();
        // 句柄相对写入的最后边界：嵌套形态的文件名不得相对句柄逃出 projects/
        let err = atomic_write(&projects, "../evil.json", "{}").unwrap_err();
        assert!(err.contains("路径分量"), "意外诊断：{err}");
        assert!(
            fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
            "含路径分量的文件名不应写出 projects/"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn sync_directory_syncs_openable_directory_on_unix_like_targets() {
        let projects = temp_projects_dir();
        #[cfg(unix)]
        assert!(sync_directory(&projects).is_ok());
        #[cfg(not(unix))]
        assert!(sync_directory(&projects).is_ok());
        cleanup_temp(&projects);
    }
    #[test]
    fn load_project_file_rejects_path_like_id_before_any_join() {
        let projects = temp_projects_dir();
        // 嵌套路径形态的 id：projects/ 内的资产/私有 JSON 不得经 load_project 读出
        let err = load_project_file(&projects, "p-1/assets/private").unwrap_err();
        assert!(
            err.contains("非法") || err.contains("不存在"),
            "意外诊断：{err}"
        );
        cleanup_temp(&projects);
    }
    #[test]
    fn load_project_file_reads_envelope_from_verified_handle() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "午夜出租车".into(), now_iso());
        persist_project(&projects, "p-1", doc).expect("先保存");
        let loaded = load_project_file(&projects, "p-1").expect("从已验证句柄读取");
        assert_eq!(loaded.project.name, "午夜出租车");
        assert_eq!(loaded.schema_version, 1);
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn list_project_metas_reads_only_verified_entries() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "午夜出租车".into(), now_iso());
        persist_project(&projects, "p-1", doc).expect("先保存");
        // 指向根外文件的符号链接条目不得经列表路径读出（§10.2 信任链）
        let outside = projects.parent().expect("临时根").join("outside.json");
        fs::write(
            &outside,
            r#"{"schemaVersion":1,"project":{"id":"p-2","name":"外部","createdAt":"","updatedAt":""}}"#,
        )
        .expect("写根外文件");
        std::os::unix::fs::symlink(&outside, projects.join("p-2.json")).expect("建符号链接");
        let metas = list_project_metas(&projects).expect("列出项目");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, "p-1");
        cleanup_temp(&projects);
    }
}
