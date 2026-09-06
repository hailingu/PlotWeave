//! 迁移与归一化主体（§7.2）。拆分为独立文件以守住单文件 800 行上限；
//! 对外只暴露 [`migrate_and_normalize`]，子函数均为本模块私有。

use serde_json::{json, Map, Value};

use crate::isotime;
use crate::library_fs::validate_asset_id;
use crate::store::{is_canonical_mime, is_valid_active_asset_rel_path, new_id};

const NAME_MAX_CHARS: usize = 128;
const TAG_MAX_CHARS: usize = 64;
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

/// 把任意读出的库索引（旧数组形状或目标 Record 形状）迁移并完整归一化为
/// 目标 Record 形状 `{assets:{byId},groups:{byId}}`，返回 (归一化索引, 警告)。
/// 纯函数；异型根按空库收敛并告警（调用方 read_index_capped 已先拒绝非标量根）。
pub(crate) fn migrate_and_normalize(index: Value) -> (Value, Vec<String>) {
    let mut warnings = Vec::new();
    if !index.is_object() {
        warnings.push("资产索引根不是对象，已按空库收敛".into());
        return (empty_index(), warnings);
    }
    let raw_assets = index.get("assets").cloned().unwrap_or(Value::Null);
    let raw_groups = index.get("groups").cloned().unwrap_or(Value::Null);
    let groups = normalize_groups(raw_groups, &mut warnings);
    let assets = normalize_assets(raw_assets, &groups, &mut warnings);
    (
        json!({ "assets": { "byId": assets }, "groups": { "byId": groups } }),
        warnings,
    )
}

fn empty_index() -> Value {
    json!({ "assets": { "byId": {} }, "groups": { "byId": {} } })
}

/// 取出待迁移的条目列表：数组原样返回（每项带原始顺序），Record 取 byId 值。
/// 非数组/非对象/缺失按空处理并告警。
fn take_entries(raw: Value, bucket: &str, warnings: &mut Vec<String>) -> Vec<Value> {
    match raw {
        Value::Array(arr) => arr,
        Value::Object(mut o) => match o.remove("byId") {
            Some(Value::Object(by_id)) => by_id.into_values().collect(),
            Some(_) => {
                warnings.push(format!("资产索引 {bucket}.byId 不是对象，已按空处理"));
                Vec::new()
            }
            None => {
                warnings.push(format!("资产索引 {bucket} 缺 byId 桶，已按空处理"));
                Vec::new()
            }
        },
        Value::Null => Vec::new(),
        _ => {
            warnings.push(format!("资产索引的 {bucket} 形状非法，已按空处理"));
            Vec::new()
        }
    }
}

/// 第①②步：预检普通对象成员 + id 校验/重发 + 键化。返回 (键化后 map, 空白
/// 原 id→新 id 的可选映射)。重复 id 保留文档序首项、后续重发；空白/缺失/非
/// 第①②步：预检普通对象成员 + id 校验/重发 + 键化。返回 (键化后 map, 空白
/// 原 id→新 id 的可选映射)。重复 id 保留文档序首项、后续重发；空白/缺失/非
/// 字符串 id 重发。
fn keyify(
    raw: Value,
    bucket: &str,
    warnings: &mut Vec<String>,
) -> (Map<String, Value>, Option<String>) {
    let entries = take_entries(raw, bucket, warnings);
    let mut map = Map::new();
    let mut blank_new_id: Option<String> = None;
    let mut blank_count = 0usize;
    for entry in entries {
        let Some(mut e) = entry.as_object().cloned() else {
            warnings.push(format!("资产索引 {bucket} 含非对象成员，已隔离"));
            continue;
        };
        let id = e.get("id").and_then(Value::as_str).unwrap_or("").trim();
        let valid_id = !id.is_empty() && validate_asset_id(id).is_ok();
        let final_id = resolve_key(id, valid_id, &map, bucket, warnings);
        if !valid_id {
            blank_count += 1;
            if blank_count == 1 {
                blank_new_id = Some(final_id.clone());
            }
        }
        e.insert("id".into(), json!(final_id));
        map.insert(final_id, Value::Object(e));
    }
    let blank_map = if blank_count == 1 { blank_new_id } else { None };
    (map, blank_map)
}

/// 决定条目的最终 Record 键：合法且未占用的 id 原样保留；重复/空白/非法
/// id 重发本域未占用 id 并告警（§7.2 重复保留首项、后续重发）。
fn resolve_key(
    id: &str,
    valid_id: bool,
    map: &Map<String, Value>,
    bucket: &str,
    warnings: &mut Vec<String>,
) -> String {
    if valid_id && !map.contains_key(id) {
        return id.to_string();
    }
    if valid_id {
        warnings.push(format!("资产索引 {bucket} 含重复 id {id}，后续项重发"));
    } else {
        warnings.push(format!("资产索引 {bucket} 含空白/非法 id，已重发"));
    }
    fresh_id(map)
}

/// 生成桶内未占用的重发 id（用连字符替换前缀，保证 validate_asset_id 通过）。
fn fresh_id(map: &Map<String, Value>) -> String {
    loop {
        let cand = new_id().replace('-', "_");
        if !map.contains_key(&cand) {
            return cand;
        }
    }
}

/// 组桶归一化：键化 → 逐组完整校验（id/name/kind），非法组隔离。
fn normalize_groups(raw: Value, warnings: &mut Vec<String>) -> Map<String, Value> {
    let (map, _blank) = keyify(raw, "groups", warnings);
    let mut out = Map::new();
    for (key, g) in map {
        match normalize_group(&g, warnings) {
            Some(norm) => {
                out.insert(key, norm);
            }
            None => warnings.push(format!("已隔离非法组 {key}")),
        }
    }
    out
}

fn normalize_group(g: &Value, warnings: &mut Vec<String>) -> Option<Value> {
    let id = g.get("id").and_then(Value::as_str)?.to_string();
    let name = normalize_name(g.get("name"), &id, warnings)?;
    let kind = g.get("kind").and_then(Value::as_str)?;
    if !KINDS.contains(&kind) {
        return None;
    }
    Some(json!({ "id": id, "name": name, "kind": kind }))
}

/// 资产桶归一化：键化 → 逐条完整校验 → 跨条目 groupId/kind 一致性。
fn normalize_assets(
    raw: Value,
    groups: &Map<String, Value>,
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    let (map, _blank) = keyify(raw, "assets", warnings);
    let mut out = Map::new();
    for (key, a) in map {
        match normalize_asset(&a, warnings) {
            Some(norm) => {
                out.insert(key, norm);
            }
            None => warnings.push(format!("已隔离非法索引条目 {key}")),
        }
    }
    resolve_group_ids(&mut out, groups, warnings);
    out
}

/// 逐条 LibraryAsset 归一化：AssetRef 共享字段 + name/kind/tags/view/groupId。
fn normalize_asset(a: &Value, warnings: &mut Vec<String>) -> Option<Value> {
    let id = a.get("id").and_then(Value::as_str)?.to_string();
    let rel = a.get("relPath").and_then(Value::as_str)?;
    if !is_valid_active_asset_rel_path(rel) {
        warnings.push(format!("条目 {id} 的 relPath 越出 assets/：{rel}"));
        return None;
    }
    let mime = normalize_mime(a.get("mime"), &id, warnings)?;
    let source = normalize_source(a.get("source"), &id, warnings)?;
    let created = normalize_created_at(a.get("createdAt"), &id, warnings)?;
    let name = normalize_name(a.get("name"), &id, warnings)?;
    let kind = normalize_kind(a.get("kind"), &id, warnings)?;
    let tags = normalize_tags_field(a.get("tags"), &id, warnings);
    let view = normalize_view(a.get("view"), &id, warnings);
    let group_id = normalize_group_id(a.get("groupId"), &id, warnings);
    let mut e = json!({
        "id": id, "name": name, "kind": kind, "mime": mime, "relPath": rel,
        "source": source, "createdAt": created, "tags": tags,
    });
    if let Some(v) = view {
        e["view"] = json!(v);
    }
    if let Some(g) = group_id {
        e["groupId"] = json!(g);
    }
    Some(e)
}

fn normalize_name(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    let name = raw.and_then(Value::as_str)?;
    let t = name.trim();
    if t.is_empty() || t.chars().count() > NAME_MAX_CHARS {
        return None;
    }
    if t != name {
        warnings.push(format!("条目 {id} 的 name 已去空白"));
    }
    Some(t.to_string())
}

fn normalize_kind(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    let kind = raw.and_then(Value::as_str)?;
    if kind == "prop" {
        warnings.push(format!("条目 {id} 的 kind 由 prop 改写为 wardrobe"));
        return Some("wardrobe".into());
    }
    if KINDS.contains(&kind) {
        Some(kind.to_string())
    } else {
        None
    }
}

fn normalize_mime(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    let mime = raw.and_then(Value::as_str)?;
    let norm = mime.trim().to_ascii_lowercase();
    if !is_canonical_mime(&norm) {
        return None;
    }
    if norm != mime {
        warnings.push(format!("条目 {id} 的 mime 已规范化：{mime} → {norm}"));
    }
    Some(norm)
}

/// source：缺失确定性补 upload；显式未知值不猜测、隔离。
fn normalize_source(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    match raw {
        None | Some(Value::Null) => {
            warnings.push(format!("条目 {id} 缺失 source，确定性补为 upload"));
            Some("upload".into())
        }
        Some(Value::String(s)) if s == "upload" || s == "generated" => Some(s.clone()),
        _ => {
            warnings.push(format!("条目 {id} 的 source 未知，不猜测，隔离"));
            None
        }
    }
}

/// createdAt：规范 UTC ISO 原样保留；合法但非规范形转规范形；epoch 毫秒
/// （非负安全整数且表有效日期）转 UTC ISO；其余不猜测、隔离。
fn normalize_created_at(
    raw: Option<&Value>,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match raw {
        Some(Value::String(s)) => {
            if isotime::is_canonical_utc_timestamp(s) {
                Some(s.clone())
            } else if isotime::is_valid_iso8601(s) {
                let ms = isotime::iso8601_to_epoch_millis(s)?;
                let ms = u64::try_from(ms).ok()?;
                let norm = isotime::iso_from_ms(ms);
                warnings.push(format!("条目 {id} 的 createdAt 已规范化为 UTC：{norm}"));
                Some(norm)
            } else {
                warnings.push(format!("条目 {id} 的 createdAt 非法，不猜测，隔离"));
                None
            }
        }
        Some(Value::Number(n)) => {
            let ms = n.as_u64()?;
            if ms > i64::MAX as u64 {
                warnings.push(format!("条目 {id} 的 createdAt 超出可表示范围，隔离"));
                return None;
            }
            let iso = isotime::iso_from_ms(ms);
            warnings.push(format!("条目 {id} 的毫秒时间戳已转 UTC ISO：{iso}"));
            Some(iso)
        }
        _ => {
            warnings.push(format!("条目 {id} 缺失/异型 createdAt，不猜测，隔离"));
            None
        }
    }
}

/// tags：非数组重置 []；成员去空白、异型/空白/超长/重复删除；超 16 项留前 16。
fn normalize_tags_field(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Vec<String> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        if raw.is_some() && !raw.unwrap().is_null() {
            warnings.push(format!("条目 {id} 的 tags 非数组，已重置为空"));
        }
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let mut dirty = false;
    for t in arr {
        let Some(s) = t.as_str() else {
            dirty = true;
            continue;
        };
        let s = s.trim();
        if s.is_empty() || s.chars().count() > TAG_MAX_CHARS || out.iter().any(|x| x == s) {
            dirty = true;
            continue;
        }
        if out.len() < TAGS_MAX {
            out.push(s.to_string());
        } else {
            dirty = true;
        }
    }
    if dirty {
        warnings.push(format!("条目 {id} 的 tags 已规范化"));
    }
    out
}

fn normalize_view(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if VIEWS.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => {
            warnings.push(format!("条目 {id} 的 view 非法，已剥离"));
            None
        }
    }
}

fn normalize_group_id(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() || validate_asset_id(t).is_err() {
                warnings.push(format!("条目 {id} 的 groupId 非法，已剥离"));
                None
            } else {
                Some(t.to_string())
            }
        }
        Some(_) => {
            warnings.push(format!("条目 {id} 的 groupId 非字符串，已剥离"));
            None
        }
    }
}

/// 跨条目一致性（组隔离完成后）：groupId 指向不存在的组或组与资产 kind
/// 不同即剥离该引用并警告——活动库内始终保持同组同类。
fn resolve_group_ids(
    assets: &mut Map<String, Value>,
    groups: &Map<String, Value>,
    warnings: &mut Vec<String>,
) {
    for (key, a) in assets.iter_mut() {
        let Some(gid) = a.get("groupId").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let asset_kind = a.get("kind").and_then(Value::as_str).unwrap_or("");
        let group_kind = groups
            .get(&gid)
            .and_then(|g| g.get("kind"))
            .and_then(Value::as_str);
        match group_kind {
            Some(gk) if gk == asset_kind => {}
            Some(_) => {
                warnings.push(format!("条目 {key} 的 groupId 与组 kind 不一致，已剥离"));
                a.as_object_mut().unwrap().remove("groupId");
            }
            None => {
                warnings.push(format!("条目 {key} 的 groupId 指向不存在的组，已剥离"));
                a.as_object_mut().unwrap().remove("groupId");
            }
        }
    }
}
