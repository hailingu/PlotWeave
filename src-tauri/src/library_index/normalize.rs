//! 迁移与归一化主体（§7.2）。键化迁移内核（迁移链①②的桶键化与 id
//! 重发）在同目录 keys.rs（issue #39 拆分）；本文件保留迁移编排与完整
//! 归一化（§7.2 迁移链③④），对外只暴露 [`migrate_and_normalize`] 族。

use serde_json::{json, Map, Value};

use crate::isotime;
use crate::library_fs::validate_asset_id;
use crate::store::{is_canonical_mime, is_valid_active_asset_rel_path};

use super::keys::keyify;

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
/// 修复，PR #33 第二轮）。纯函数；异型根按空库收敛并告警。
pub(crate) fn migrate_and_normalize(index: Value) -> (Value, Vec<String>, bool) {
    migrate_inner(index, true)
}

/// 只读告警态变体（评审修复，PR #33 第七轮）：journal 异型时读取不落盘，
/// `new_id()` 重发的 id 会跨读漂移——`allow_reissue=false` 凡需重发 id 的
/// 条目一律隔离并警告（不暴露不稳定身份）；mime/createdAt 等字段级确定性
/// 修复跨读一致，照常生效。
pub(crate) fn migrate_and_normalize_readonly(index: Value) -> (Value, Vec<String>, bool) {
    migrate_inner(index, false)
}

fn migrate_inner(index: Value, allow_reissue: bool) -> (Value, Vec<String>, bool) {
    let mut warnings = Vec::new();
    if !index.is_object() {
        warnings.push("资产索引根不是对象，已按空库收敛".into());
        return (empty_index(), warnings, true);
    }
    // 旧数组形状即迁移信号（目标形状是 Record）；键/id 修复、字段改写、条目
    // 剥离等经 warnings 非空体现（归一化只对脏数据告警，干净 Record 无警告）。
    let is_legacy = index.get("assets").is_some_and(Value::is_array)
        || index.get("groups").is_some_and(Value::is_array);
    let (groups, blank_group_map) =
        normalize_groups(index.get("groups").cloned(), allow_reissue, &mut warnings);
    let assets = normalize_assets(
        index.get("assets").cloned(),
        &groups,
        &blank_group_map,
        allow_reissue,
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

/// 组写命令的完整形状校验（§7.2 库写边界）：非 legacy 语境（目标 Record
/// 形状），id 合法 + name 去空白 1–128 + kind 严格属于声明联合；非法即
/// 整条拒绝（不猜测、不修复）。供 `upsert_library_group` 使用。
pub(crate) fn validate_group_for_write(g: &Value) -> Result<Value, String> {
    let Some(obj) = g.as_object() else {
        return Err("组必须是对象".into());
    };
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or("组缺 id 字段")?;
    validate_asset_id(id).map_err(|_| format!("组 id 非法：{id}"))?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or("组缺 name 字段")?;
    let name_trimmed = name.trim();
    if name_trimmed.is_empty() || name_trimmed.chars().count() > NAME_MAX_CHARS {
        return Err(format!("组名去空白后须为 1–{NAME_MAX_CHARS} 字符"));
    }
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("组缺 kind 字段")?;
    if !KINDS.contains(&kind) {
        return Err(format!("未知组 kind：{kind}"));
    }
    Ok(json!({ "id": id, "name": name_trimmed, "kind": kind }))
}

/// 组桶归一化：键化 → 逐组完整校验（id/name/kind），非法组隔离。返回
/// (归一化组 map, 空白拼写→重发 id 映射)——映射供资产侧改写精确匹配该拼写
/// 的 groupId（§7.2：仅同一拼写的空白组唯一时映射确定，同值重复即歧义）。
fn normalize_groups(
    raw: Option<Value>,
    allow_reissue: bool,
    warnings: &mut Vec<String>,
) -> (
    Map<String, Value>,
    std::collections::HashMap<String, String>,
) {
    let (map, blank_map) = keyify(raw.clone(), "groups", allow_reissue, warnings);
    // 桶形状（旧数组 = 兼容迁移语境）传到条目级——prop→wardrobe 迁移仅对旧
    // 数组条目成立（评审修复，PR #33 第十八轮）
    let legacy_bucket = raw.as_ref().is_some_and(Value::is_array);
    let mut out = Map::new();
    for (key, g) in map {
        match normalize_group(&g, legacy_bucket, warnings) {
            Some(norm) => {
                out.insert(key, norm);
            }
            None => warnings.push(format!("已隔离非法组 {key}")),
        }
    }
    (out, blank_map)
}

fn normalize_group(g: &Value, legacy_entry: bool, warnings: &mut Vec<String>) -> Option<Value> {
    let id = g.get("id").and_then(Value::as_str)?.to_string();
    let name = normalize_name(g.get("name"), &id, warnings)?;
    // 组与资产同款 prop→wardrobe 兼容改写（§7.2 迁移链③对组同样生效，
    // 仅限旧数组桶），否则组被隔离导致其 wardrobe 成员丢失 groupId（语义
    // 保全破洞）。
    let kind = normalize_kind(g.get("kind"), legacy_entry, &id, warnings)?;
    Some(json!({ "id": id, "name": name, "kind": kind }))
}

/// 资产桶归一化：键化 → 空白组映射改写原始条目的 groupId → 逐条完整校验 →
/// 跨条目 groupId/kind 一致性。空白映射必须在归一化之前作用——归一化会把
/// 空白 groupId 剥离成缺失，改写就无处可施。桶形状（旧数组 = 兼容迁移语境）
/// 传到条目级——`source` 缺失补 upload 仅对旧数组条目成立（评审修复，PR #33
/// 第八轮）。
fn normalize_assets(
    raw: Option<Value>,
    groups: &Map<String, Value>,
    blank_group_map: &std::collections::HashMap<String, String>,
    allow_reissue: bool,
    warnings: &mut Vec<String>,
) -> Map<String, Value> {
    let legacy_bucket = raw.as_ref().is_some_and(Value::is_array);
    let (mut map, _blank) = keyify(raw, "assets", allow_reissue, warnings);
    apply_blank_group_map(&mut map, blank_group_map, warnings);
    let mut out = Map::new();
    for (key, a) in map {
        match normalize_asset(&a, legacy_bucket, warnings) {
            Some(norm) => {
                out.insert(key, norm);
            }
            None => warnings.push(format!("已隔离非法索引条目 {key}")),
        }
    }
    resolve_group_ids(&mut out, groups, warnings);
    out
}

/// 空白组映射改写（§7.2）：仅当资产 groupId **精确等于**某被重发组的原空白
/// 拼写时改写为该组的重发 id——不同空白拼写（如 `""` vs `" "`）是不同的值，
/// 不得错接（评审修复，PR #33 第三/五轮）；歧义拼写不在映射中，相关
/// groupId 由归一化剥离并警告；可确定修复的编组不丢。
fn apply_blank_group_map(
    assets: &mut Map<String, Value>,
    blank_group_map: &std::collections::HashMap<String, String>,
    warnings: &mut Vec<String>,
) {
    if blank_group_map.is_empty() {
        return;
    }
    for (key, a) in assets.iter_mut() {
        let matched = a
            .get("groupId")
            .and_then(Value::as_str)
            .and_then(|s| blank_group_map.get(s))
            .cloned();
        if let Some(new_gid) = matched {
            a.as_object_mut().unwrap()["groupId"] = json!(new_gid);
            warnings.push(format!(
                "条目 {key} 的空白 groupId 已改写为重发组 id {new_gid}"
            ));
        }
    }
}

/// 逐条 LibraryAsset 归一化：AssetRef 共享字段 + name/kind/tags/view/groupId。
/// `legacy_entry` 表示条目来自旧数组桶（兼容迁移语境）——仅此语境下缺失
/// source 可确定性补 upload。
fn normalize_asset(a: &Value, legacy_entry: bool, warnings: &mut Vec<String>) -> Option<Value> {
    let id = a.get("id").and_then(Value::as_str)?.to_string();
    let rel = a.get("relPath").and_then(Value::as_str)?;
    if !is_valid_active_asset_rel_path(rel) {
        warnings.push(format!("条目 {id} 的 relPath 越出 assets/：{rel}"));
        return None;
    }
    let mime = normalize_mime(a.get("mime"), &id, warnings)?;
    let source = normalize_source(a.get("source"), legacy_entry, &id, warnings)?;
    let created = normalize_created_at(a.get("createdAt"), legacy_entry, &id, warnings)?;
    let name = normalize_name(a.get("name"), &id, warnings)?;
    let kind = normalize_kind(a.get("kind"), legacy_entry, &id, warnings)?;
    let tags = normalize_tags_field(a.get("tags"), legacy_entry, &id, warnings);
    let view = normalize_view(a.get("view"), legacy_entry, &id, warnings);
    let group_id = normalize_group_id(a.get("groupId"), legacy_entry, &id, warnings);
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

/// kind：prop → wardrobe 是 §7.2 兼容迁移条款——**仅限旧数组条目**（「现实
/// 剧组服化道同属一个部门」仅对历史存量成立）；目标 Record 形状下 prop 不
/// 在声明 kind 联合内，与其他非法 kind 同款隔离（评审修复，PR #33 第十八轮：
/// 与 source/view/groupId/createdAt 的形状限定同口径）。
fn normalize_kind(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let kind = raw.and_then(Value::as_str)?;
    if kind == "prop" {
        if legacy_entry {
            warnings.push(format!("条目 {id} 的 kind 由 prop 改写为 wardrobe"));
            return Some("wardrobe".into());
        }
        warnings.push(format!(
            "条目 {id} 的 kind 为 prop（目标形状，不在声明联合内），隔离"
        ));
        return None;
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

/// source：仅**旧数组条目**字段缺失时确定性补 upload——「当前库资产均由
/// 本地导入产生」是 §7.2 兼容迁移条款，只对已发布的数组格式成立；目标
/// Record 形状缺 source 是必填 AssetRef 字段缺失，隔离不猜测；显式 null/
/// 非枚举值属未知来源，同样隔离（评审修复，PR #33 第四/八轮）。
fn normalize_source(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match raw {
        None if legacy_entry => {
            warnings.push(format!("条目 {id} 缺失 source，确定性补为 upload"));
            Some("upload".into())
        }
        None => {
            warnings.push(format!(
                "条目 {id} 缺失必填 source（目标形状），不猜测，隔离"
            ));
            None
        }
        Some(Value::String(s)) if s == "upload" || s == "generated" => Some(s.clone()),
        Some(_) => {
            warnings.push(format!("条目 {id} 的 source 显式非法/未知，不猜测，隔离"));
            None
        }
    }
}

/// createdAt：规范 UTC ISO 原样保留；合法但非规范形转规范形；epoch 毫秒
/// （非负安全整数且表有效日期）转 UTC ISO——**仅限旧数组条目**（兼容迁移
/// 条款；目标形状下数字是必填字段异型，与 source/view/groupId 同口径隔离，
/// 评审修复，PR #33 第十二轮）；其余不猜测、隔离。规范化结果复验规范形——
/// 偏移/大毫秒可跨出四位数年域，产生 5 位年的表示落盘即不可读（第六轮）。
fn normalize_created_at(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match raw {
        Some(Value::String(s)) => {
            if isotime::is_canonical_utc_timestamp(s) {
                Some(s.clone())
            } else if isotime::is_valid_iso8601(s) {
                // 合法但非规范形：经毫秒往返规范化为规范 UTC 形——负瞬间
                // （1970 前）同样规范化保留，不得因符号被隔离（评审修复，
                // PR #33 第八轮）
                let Some(ms) = isotime::iso8601_to_epoch_millis(s) else {
                    warnings.push(format!("条目 {id} 的 createdAt 无法转 UTC 瞬间，隔离"));
                    return None;
                };
                let norm = isotime::iso_from_ms(ms);
                if !isotime::is_canonical_utc_timestamp(&norm) {
                    warnings.push(format!(
                        "条目 {id} 的 createdAt 规范化后越出四位数年域（{norm}），隔离"
                    ));
                    return None;
                }
                warnings.push(format!("条目 {id} 的 createdAt 已规范化为 UTC：{norm}"));
                Some(norm)
            } else {
                warnings.push(format!("条目 {id} 的 createdAt 非法，不猜测，隔离"));
                None
            }
        }
        Some(Value::Number(n)) if legacy_entry => {
            // 按值域而非内部表示校验（评审修复，PR #33 第十九轮）：
            // `1700000000000.0`/`17e11` 是同一合法值的浮点/指数 JSON 拼写，
            // serde_json 存为浮点导致 as_u64() 返回 None——接受有限、整数、
            // 非负、范围内的一切拼写，不得因拼写差异静默隔离
            let Some(f) = n.as_f64() else {
                warnings.push(format!("条目 {id} 的 createdAt 非数值，不猜测，隔离"));
                return None;
            };
            if !f.is_finite() || f.fract() != 0.0 || f < 0.0 || f > i64::MAX as f64 {
                warnings.push(format!(
                    "条目 {id} 的 createdAt 数字越出可表示范围或非整数，不猜测，隔离"
                ));
                return None;
            }
            let ms = f as i64;
            let iso = isotime::iso_from_ms(ms);
            if !isotime::is_canonical_utc_timestamp(&iso) {
                warnings.push(format!(
                    "条目 {id} 的 createdAt 越出四位数年域（{iso}），隔离"
                ));
                return None;
            }
            warnings.push(format!("条目 {id} 的毫秒时间戳已转 UTC ISO：{iso}"));
            Some(iso)
        }
        Some(Value::Number(_)) => {
            warnings.push(format!(
                "条目 {id} 的 createdAt 为数字（目标形状），不猜测，隔离"
            ));
            None
        }
        _ => {
            warnings.push(format!("条目 {id} 缺失/异型 createdAt，不猜测，隔离"));
            None
        }
    }
}

/// tags：非数组重置 []；成员去空白、异型/空白/超长/重复删除；超 16 项留
/// 前 16。目标 Record 形状缺失 tags（必填字段）同为待修复脏数据——告警并
/// 经 migrated 落盘（评审修复，PR #33 第十五轮）；legacy 数组条目缺失保持
/// 兼容语境静默按空。
fn normalize_tags_field(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        if let Some(v) = raw {
            let what = if v.is_null() { "null" } else { "非数组" };
            warnings.push(format!("条目 {id} 的 tags 为{what}，已重置为空"));
        } else if !legacy_entry {
            warnings.push(format!("条目 {id} 缺失 tags（目标形状），已重置为空"));
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
        // 去空白本身也是修复——差异必须可见并经 migrated 落盘（评审修复，
        // PR #33 第十轮：静默 trim 会让修复每次读取重复发生）
        if s != t {
            dirty = true;
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

fn normalize_view(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match raw {
        None => None,
        // null 是旧数组可选字段的「未标注」表示法——兼容迁移静默删除；目标
        // Record 形状下 null 是非法值，走警告路径（评审修复，PR #33 第九轮）
        Some(Value::Null) if legacy_entry => None,
        Some(Value::Null) => {
            warnings.push(format!("条目 {id} 的 view 为显式 null（目标形状），已剥离"));
            None
        }
        Some(Value::String(s)) if VIEWS.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => {
            warnings.push(format!("条目 {id} 的 view 非法，已剥离"));
            None
        }
    }
}

/// groupId 引用（评审修复，PR #33 第九轮）：ID 不透明——**不 trim**，非空
/// 值必须 verbatim 过 id 值域（`" g "` 不得 trim 成 `"g"` 错接进组）；空白
/// 引用若被空白映射改写早在条目级归一化之前完成，此处剩余的空白/非法引用
/// 一律剥离并警告。
fn normalize_group_id(
    raw: Option<&Value>,
    legacy_entry: bool,
    id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match raw {
        None => None,
        // null 是旧数组可选字段的「未编组」表示法——兼容迁移静默删除；目标
        // Record 形状下 null 是非法值，走警告路径（评审修复，PR #33 第十轮）
        Some(Value::Null) if legacy_entry => None,
        Some(Value::Null) => {
            warnings.push(format!(
                "条目 {id} 的 groupId 为显式 null（目标形状），已剥离"
            ));
            None
        }
        Some(Value::String(s)) => {
            if validate_asset_id(s).is_ok() {
                Some(s.clone())
            } else if s.trim().is_empty() {
                warnings.push(format!("条目 {id} 的空白 groupId 无映射，已剥离"));
                None
            } else {
                warnings.push(format!("条目 {id} 的 groupId 非法，已剥离"));
                None
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
