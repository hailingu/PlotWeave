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

/// 取出待迁移条目：数组每项键为 None（无权威键，按内嵌 id 键化）；Record
/// 的 byId 成员带权威键——§7.2/§11.1 共同规则要求键/id 不一致时以记录键为
/// 准。真实空库由「索引文件缺失」覆盖（read_index_normalized 的 None 分支
/// 直接回退默认空索引、不经本函数）；文件**存在**但桶缺失属异型——按空处理
/// 并告警、经 migrated 落盘，不得每次读取重复（评审修复，PR #33 第十一轮）；
/// 显式 null/异型桶同口径（第三轮）。
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
        None => {
            warnings.push(format!("资产索引缺失 {bucket} 桶，已按空处理"));
            Vec::new()
        }
    }
}

/// 第①②步：预检普通对象成员 + id 校验/重发 + 键化。返回 (键化后 map,
/// 单一空白条目的 (原始空白拼写, 重发 id) 映射)。Record 权威键优先且
/// **verbatim**（不 trim——`"g"` 与 `" g "` 是不同 opaque id，trim 会把
/// 二者坍缩、迫使一组重发并把引用错接）；键合法且未占用即以键为准、内嵌 id
/// 改写为键。数组或 Record 键不可用时按内嵌 id 键化——重复 id 保留文档序
/// 首项、后续重发；空白/缺失/非法 id 重发。空白映射逐拼写追踪：仅**同一
/// 拼写**出现多个空白条目时该拼写映射歧义（§7.2「多个同值空白组」），不同
/// 拼写各自确定（评审修复，PR #33 第五轮）。`allow_reissue=false`（只读
/// 告警态）时重发路径退化为隔离——只读态不落盘，随机重发 id 会跨读漂移。
fn keyify(
    raw: Option<Value>,
    bucket: &str,
    allow_reissue: bool,
    warnings: &mut Vec<String>,
) -> (
    Map<String, Value>,
    std::collections::HashMap<String, String>,
) {
    let entries = take_entries(raw, bucket, warnings);
    // 第一遍：预留全部合法权威键（评审修复，PR #33 第五轮）——否则无效键
    // 条目的内嵌 id 可抢占后面才出现的权威键，真实资产被重新键化、媒体/删除
    // 按 id 操作时会作用到错误资产
    let mut reserved: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (key, _) in &entries {
        if let Some(k) = key.as_deref() {
            if !k.is_empty() && validate_asset_id(k).is_ok() {
                reserved.insert(k.to_string());
            }
        }
    }
    let mut map = Map::new();
    // 空白拼写 → (重发 id, 同拼写出现次数)；仅出现一次的拼写映射确定
    let mut blank_spells: std::collections::HashMap<String, (String, usize)> =
        std::collections::HashMap::new();
    for (key, entry) in entries {
        let Some(mut e) = entry.as_object().cloned() else {
            warnings.push(format!("资产索引 {bucket} 含非对象成员，已隔离"));
            continue;
        };
        // 区分「缺失/非字符串 id」（None——从未可被引用，不进空白映射）与
        // 「真实空白字符串 id」（Some——其精确拼写可被引用，评审修复，PR #33
        // 第四轮）
        let embedded_id = e.get("id").and_then(Value::as_str);
        let assigned = assign_key(
            key,
            embedded_id,
            &map,
            &reserved,
            bucket,
            allow_reissue,
            warnings,
        );
        let Some((final_id, blank_spelling)) = assigned else {
            // 只读态重发退化：条目隔离，不暴露跨读漂移的新身份
            continue;
        };
        if let Some(spelling) = blank_spelling {
            match blank_spells.get_mut(&spelling) {
                Some((_, n)) => *n += 1,
                None => {
                    blank_spells.insert(spelling, (final_id.clone(), 1));
                }
            }
        }
        e.insert("id".into(), json!(final_id));
        map.insert(final_id, Value::Object(e));
    }
    let blank_map: std::collections::HashMap<String, String> = blank_spells
        .into_iter()
        .filter(|(_, (_, n))| *n == 1)
        .map(|(spelling, (id, _))| (spelling, id))
        .collect();
    (map, blank_map)
}

/// 决定条目的最终 Record 键与空白重发信息。`embedded_id` 为 None 表示缺失/
/// 非字符串 id（不产生空白映射）；Some 为真实字符串 id。返回 (最终键, 若因
/// 空白字符串 id 重发则携带其原始拼写——供组桶精确匹配引用)。键 verbatim
/// 不 trim；回退 id 不得占用预留权威键。返回的旧拼写映射候选：非法权威键
/// 携带其原始拼写（键是 Record 的引用权威，条目归位后引用按旧键改写，评审
/// 修复 PR #33 第六轮）；数组条目（无键）仅在空白内嵌 id 重发时携带该拼写。
/// `allow_reissue=false`（只读告警态）时凡需重发 id 的路径返回 None——调用
/// 方隔离该条目，不产生跨读漂移的新身份。
fn assign_key(
    key: Option<String>,
    embedded_id: Option<&str>,
    map: &Map<String, Value>,
    reserved: &std::collections::HashSet<String>,
    bucket: &str,
    allow_reissue: bool,
    warnings: &mut Vec<String>,
) -> Option<(String, Option<String>)> {
    // Record 权威键优先且原样保留（不 trim）：键合法且未被先前条目占用即
    // 以键为准——合法权威键彼此唯一（JSON 对象键去重），预留集只约束回退
    if let Some(k) = key.as_deref() {
        if !k.is_empty() && validate_asset_id(k).is_ok() && !map.contains_key(k) {
            if Some(k) != embedded_id {
                warnings.push(format!(
                    "资产索引 {bucket} 键 {k} 与内嵌 id 不一致，以键为准改写"
                ));
            }
            return Some((k.to_string(), None));
        }
    }
    // 非法权威键的原始拼写是引用解析权威：映射到条目最终归位 id；数组条目
    // （键缺失）此候选为 None。空串键同为非法键、其拼写可被 groupId 精确
    // 引用，一并入映射（评审修复，PR #33 第八轮：非空过滤会漏掉 "" 键）
    let key_spelling = key.filter(|k| validate_asset_id(k).is_err());
    let Some(embedded_raw) = embedded_id else {
        if !allow_reissue {
            warnings.push(format!(
                "资产索引 {bucket} 缺失/非字符串 id，只读态不产生新身份，条目已隔离"
            ));
            return None;
        }
        warnings.push(format!("资产索引 {bucket} 缺失/非字符串 id，已重发"));
        return Some((fresh_id(map, reserved), key_spelling));
    };
    assign_from_embedded(
        embedded_raw,
        key_spelling,
        map,
        reserved,
        bucket,
        allow_reissue,
        warnings,
    )
}

/// 内嵌 id 分支（评审修复，PR #33 第十三轮拆出降复杂度）：verbatim 不
/// trim——带空白填充的非空字符串（" la-1 "）不得 trim 成合法 id 抢占真实
/// 条目；与预留权威键冲突或重复即重发；空白/非法 id 重发并携带原始拼写。
/// 只读态凡需重发一律隔离（诊断与实际行为一致，不先声称「已重发」）。
fn assign_from_embedded(
    embedded_raw: &str,
    key_spelling: Option<String>,
    map: &Map<String, Value>,
    reserved: &std::collections::HashSet<String>,
    bucket: &str,
    allow_reissue: bool,
    warnings: &mut Vec<String>,
) -> Option<(String, Option<String>)> {
    let valid_id = !embedded_raw.is_empty() && validate_asset_id(embedded_raw).is_ok();
    if valid_id && !map.contains_key(embedded_raw) && !reserved.contains(embedded_raw) {
        // 非法键归位为内嵌 id 是确定性修复（评审修复，PR #33 第十六轮）：
        // 须警告并经 migrated 落盘——静默归键会让修复每次读取重复发生
        if let Some(spelling) = &key_spelling {
            warnings.push(format!(
                "资产索引 {bucket} 非法键 {spelling} 已归位为内嵌 id {embedded_raw}"
            ));
        }
        return Some((embedded_raw.to_string(), key_spelling));
    }
    let why = if !valid_id {
        "含空白/非法 id"
    } else if reserved.contains(embedded_raw) {
        "内嵌 id 与权威键冲突"
    } else {
        "含重复 id"
    };
    if !allow_reissue {
        warnings.push(format!(
            "资产索引 {bucket} {why}（{embedded_raw}），只读态不产生新身份，条目已隔离"
        ));
        return None;
    }
    warnings.push(format!("资产索引 {bucket} {why}（{embedded_raw}），已重发"));
    let spelling = key_spelling.or_else(|| (!valid_id).then(|| embedded_raw.to_string()));
    Some((fresh_id(map, reserved), spelling))
}

/// 生成桶内未占用的重发 id（用连字符替换前缀，保证 validate_asset_id 通过；
/// 同时避开已占用键与预留权威键）。
fn fresh_id(map: &Map<String, Value>, reserved: &std::collections::HashSet<String>) -> String {
    loop {
        let cand = new_id().replace('-', "_");
        if !map.contains_key(&cand) && !reserved.contains(&cand) {
            return cand;
        }
    }
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
    let (map, blank_map) = keyify(raw, "groups", allow_reissue, warnings);
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
    let kind = normalize_kind(a.get("kind"), &id, warnings)?;
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
            let ms = n.as_u64()?;
            if ms > i64::MAX as u64 {
                warnings.push(format!("条目 {id} 的 createdAt 超出可表示范围，隔离"));
                return None;
            }
            let iso = isotime::iso_from_ms(ms as i64);
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
