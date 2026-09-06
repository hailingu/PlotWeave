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
/// 目标 Record 形状 `{assets:{byId},groups:{byId}}`，返回 (归一化索引, 警告,
/// 是否发生迁移/修复)。`migrated` 为 true 表示输入是旧数组形状或含被修复/
/// 重发的条目——调用方据此把迁移结果落盘，保证重发 id 跨读取稳定（评审
/// 修复，PR #33 第二轮：迁移只在内存不落盘会让 list 显示的 id 与后续媒体/
/// 删除命令读到的不一致）。纯函数；异型根按空库收敛并告警。
pub(crate) fn migrate_and_normalize(index: Value) -> (Value, Vec<String>, bool) {
    let mut warnings = Vec::new();
    if !index.is_object() {
        warnings.push("资产索引根不是对象，已按空库收敛".into());
        return (empty_index(), warnings, true);
    }
    // 旧数组形状即迁移信号（目标形状是 Record）；键/id 修复、字段改写、条目
    // 剥离等经 warnings 非空体现（归一化只对脏数据告警，干净 Record 无警告）。
    let is_legacy = index.get("assets").is_some_and(Value::is_array)
        || index.get("groups").is_some_and(Value::is_array);
    let (groups, blank_group_map) = normalize_groups(index.get("groups").cloned(), &mut warnings);
    let assets = normalize_assets(
        index.get("assets").cloned(),
        &groups,
        blank_group_map.as_ref(),
        &mut warnings,
    );
    let migrated = is_legacy || !warnings.is_empty();
    (
        json!({ "assets": { "byId": assets }, "groups": { "byId": groups } }),
        warnings,
        migrated,
    )
}

fn empty_index() -> Value {
    json!({ "assets": { "byId": {} }, "groups": { "byId": {} } })
}

/// 取出待迁移条目：数组每项键为 None（无权威键，按内嵌 id 键化）；Record
/// 的 byId 成员带权威键——§7.2/§11.1 共同规则要求键/id 不一致时以记录键为
/// 准。缺失桶按空处理（首启正常）；显式 null/异型桶视为脏数据，按空处理并
/// 告警——修复须可见且经 migrated 落盘，不得每次读取重复丢失（评审修复，
/// PR #33 第三轮）。
fn take_entries(
    raw: Option<Value>,
    bucket: &str,
    warnings: &mut Vec<String>,
) -> Vec<(Option<String>, Value)> {
    match raw {
        Some(Value::Array(arr)) => arr.into_iter().map(|e| (None, e)).collect(),
        Some(Value::Object(mut o)) => match o.remove("byId") {
            Some(Value::Object(by_id)) => by_id.into_iter().map(|(k, v)| (Some(k), v)).collect(),
            Some(_) => {
                warnings.push(format!("资产索引 {bucket}.byId 不是对象，已按空处理"));
                Vec::new()
            }
            None => {
                warnings.push(format!("资产索引 {bucket} 缺 byId 桶，已按空处理"));
                Vec::new()
            }
        },
        Some(Value::Null) => {
            warnings.push(format!("资产索引的 {bucket} 为 null，已按空处理"));
            Vec::new()
        }
        Some(_) => {
            warnings.push(format!("资产索引的 {bucket} 形状非法，已按空处理"));
            Vec::new()
        }
        None => Vec::new(),
    }
}

/// 第①②步：预检普通对象成员 + id 校验/重发 + 键化。返回 (键化后 map,
/// 单一空白条目的 (原始空白拼写, 重发 id) 映射)。Record 权威键优先且
/// **verbatim**（不 trim——`"g"` 与 `" g "` 是不同 opaque id，trim 会把
/// 二者坍缩、迫使一组重发并把引用错接）；键合法且未占用即以键为准、内嵌 id
/// 改写为键。数组或 Record 键不可用时按内嵌 id 键化——重复 id 保留文档序
/// 首项、后续重发；空白/缺失/非法 id 重发。多个空白条目映射歧义（§7.2 删除
/// 相关引用），返回 None。
fn keyify(
    raw: Option<Value>,
    bucket: &str,
    warnings: &mut Vec<String>,
) -> (Map<String, Value>, Option<(String, String)>) {
    let entries = take_entries(raw, bucket, warnings);
    let mut map = Map::new();
    // 单一空白条目的 (原始拼写, 重发 id)；多于一个则映射歧义置 None
    let mut blank: Option<(String, String)> = None;
    let mut blank_count = 0usize;
    for (key, entry) in entries {
        let Some(mut e) = entry.as_object().cloned() else {
            warnings.push(format!("资产索引 {bucket} 含非对象成员，已隔离"));
            continue;
        };
        // 区分「缺失/非字符串 id」（None——从未可被引用，不进空白映射）与
        // 「真实空白字符串 id」（Some——其精确拼写可被引用，评审修复，PR #33
        // 第四轮）
        let embedded_id = e.get("id").and_then(Value::as_str);
        let (final_id, blank_spelling) = assign_key(key, embedded_id, &map, bucket, warnings);
        if let Some(spelling) = blank_spelling {
            blank_count += 1;
            if blank_count == 1 {
                blank = Some((spelling, final_id.clone()));
            }
        }
        e.insert("id".into(), json!(final_id));
        map.insert(final_id, Value::Object(e));
    }
    let blank_map = if blank_count == 1 { blank } else { None };
    (map, blank_map)
}

/// 决定条目的最终 Record 键与空白重发信息。`embedded_id` 为 None 表示缺失/
/// 非字符串 id（不产生空白映射）；Some 为真实字符串 id。返回 (最终键, 若因
/// 空白字符串 id 重发则携带其原始拼写——供组桶精确匹配引用)。键 verbatim
/// 不 trim。
fn assign_key(
    key: Option<String>,
    embedded_id: Option<&str>,
    map: &Map<String, Value>,
    bucket: &str,
    warnings: &mut Vec<String>,
) -> (String, Option<String>) {
    // Record 权威键优先且原样保留（不 trim）：键合法且未占用即以键为准
    if let Some(k) = key.as_deref() {
        if !k.is_empty() && validate_asset_id(k).is_ok() && !map.contains_key(k) {
            if Some(k) != embedded_id {
                warnings.push(format!(
                    "资产索引 {bucket} 键 {k} 与内嵌 id 不一致，以键为准改写"
                ));
            }
            return (k.to_string(), None);
        }
    }
    // 缺失/非字符串 id：从未可被 groupId 引用，重发但不产生空白映射
    let Some(embedded_raw) = embedded_id else {
        warnings.push(format!("资产索引 {bucket} 缺失/非字符串 id，已重发"));
        return (fresh_id(map), None);
    };
    let embedded = embedded_raw.trim();
    let valid_id = !embedded.is_empty() && validate_asset_id(embedded).is_ok();
    if valid_id && !map.contains_key(embedded) {
        return (embedded.to_string(), None);
    }
    if valid_id {
        warnings.push(format!(
            "资产索引 {bucket} 含重复 id {embedded}，后续项重发"
        ));
        return (fresh_id(map), None);
    }
    // 空白/非法字符串 id 重发：携带原始拼写（未 trim）供组引用精确匹配
    warnings.push(format!("资产索引 {bucket} 含空白/非法 id，已重发"));
    (fresh_id(map), Some(embedded_raw.to_string()))
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

/// 组桶归一化：键化 → 逐组完整校验（id/name/kind），非法组隔离。返回
/// (归一化组 map, 单一空白组的 (原始空白拼写, 重发 id) 映射)——映射供资产
/// 侧改写精确匹配该拼写的 groupId（§7.2 仅一个空白原 id 组时建立映射）。
fn normalize_groups(
    raw: Option<Value>,
    warnings: &mut Vec<String>,
) -> (Map<String, Value>, Option<(String, String)>) {
    let (map, blank_map) = keyify(raw, "groups", warnings);
    let mut out = Map::new();
    for (key, g) in map {
        match normalize_group(&g, warnings) {
            Some(norm) => {
                out.insert(key, norm);
            }
            None => warnings.push(format!("已隔离非法组 {key}")),
        }
    }
    (out, blank_map)
}

fn normalize_group(g: &Value, warnings: &mut Vec<String>) -> Option<Value> {
    let id = g.get("id").and_then(Value::as_str)?.to_string();
    let name = normalize_name(g.get("name"), &id, warnings)?;
    // 组与资产同款 prop→wardrobe 兼容改写（§7.2 迁移链③对组同样生效），
    // 否则组被隔离导致其 wardrobe 成员丢失 groupId（语义保全破洞）。
    let kind = normalize_kind(g.get("kind"), &id, warnings)?;
    Some(json!({ "id": id, "name": name, "kind": kind }))
}

/// 资产桶归一化：键化 → 空白组映射改写原始条目的 groupId → 逐条完整校验 →
/// 跨条目 groupId/kind 一致性。空白映射必须在归一化之前作用——归一化会把
/// 空白 groupId 剥离成缺失，改写就无处可施。
fn normalize_assets(
    raw: Option<Value>,
    groups: &Map<String, Value>,
    blank_group_map: Option<&(String, String)>,
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    let (mut map, _blank) = keyify(raw, "assets", warnings);
    apply_blank_group_map(&mut map, blank_group_map, warnings);
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

/// 单一空白组映射改写（§7.2）：仅当资产 groupId **精确等于**被重发组的原
/// 空白拼写时改写为重发组 id——不同的空白拼写（如 `""` vs `" "`）是不同的
/// 值，不得错接（评审修复，PR #33 第三轮）；可确定修复的编组不丢。
fn apply_blank_group_map(
    assets: &mut Map<String, Value>,
    blank_group_map: Option<&(String, String)>,
    warnings: &mut Vec<String>,
) {
    let Some((old_blank, new_gid)) = blank_group_map else {
        return;
    };
    for (key, a) in assets.iter_mut() {
        let exact_match = a
            .get("groupId")
            .and_then(Value::as_str)
            .map(|s| s == old_blank)
            .unwrap_or(false);
        if exact_match {
            a.as_object_mut().unwrap()["groupId"] = json!(new_gid);
            warnings.push(format!(
                "条目 {key} 的空白 groupId 已改写为重发组 id {new_gid}"
            ));
        }
    }
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

/// source：仅字段**缺失**（旧数组条目）确定性补 upload——已知其均为本地导入
/// 产生；显式 null/非枚举值属未知来源，不得猜测，按 §7.2 隔离并警告（评审
/// 修复，PR #33 第四轮：显式 null 不等于缺失）。
fn normalize_source(raw: Option<&Value>, id: &str, warnings: &mut Vec<String>) -> Option<String> {
    match raw {
        None => {
            warnings.push(format!("条目 {id} 缺失 source，确定性补为 upload"));
            Some("upload".into())
        }
        Some(Value::String(s)) if s == "upload" || s == "generated" => Some(s.clone()),
        Some(_) => {
            warnings.push(format!("条目 {id} 的 source 显式非法/未知，不猜测，隔离"));
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
        // 字段缺失（None）正常按空；显式 null/非数组同为待修复脏数据，告警
        // 并经 migrated 落盘（评审修复，PR #33 第三轮）——null 不另立静默口径
        if let Some(v) = raw {
            let what = if v.is_null() { "null" } else { "非数组" };
            warnings.push(format!("条目 {id} 的 tags 为{what}，已重置为空"));
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
