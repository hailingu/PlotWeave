//! 库索引的键化迁移内核（§7.2 迁移链①②，issue #39 自 normalize.rs 拆出）：
//! 旧数组/Record 桶 → 权威键优先的键化 map，含 id 校验/重发、单一空白拼写
//! 映射与只读告警态的重发退化（不产生跨读漂移的新身份）。归一化编排见
//! normalize.rs（同目录兄弟模块）。

use serde_json::{json, Map, Value};

use crate::library_fs::validate_asset_id;
use crate::store::new_id;

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
pub(super) fn keyify(
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
