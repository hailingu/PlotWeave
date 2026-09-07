//! library_index 完整归一化不变量与评审修复轮次的回归测试（issue #29 PR 1
//! 及 PR #33 各评审轮次）：name/kind/tags/view/groupId 校验与跨条目组一致
//! 性、Record 键权威/空白映射逐拼写/verbatim、null 桶与字段形状限定、跨年
//! 溢出与 pre-epoch、只读态不产生新身份、缺失桶告警。迁移链基础测试见同目
//! 录 tests.rs；自其拆出以符合源文件 800 行上限。

use super::testutil::{asset, group};
use super::*;
use serde_json::{json, Value};

// ---- 第 ④ 步：完整归一化不变量 ----

#[test]
fn name_is_trimmed_and_saved_normalized() {
    let mut a = asset("la-1");
    a["name"] = json!("  林晚  ");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["name"], "林晚");
    assert!(warnings.iter().any(|w| w.contains("name")));
}

#[test]
fn entry_with_invalid_required_name_is_isolated() {
    let mut a = asset("la-1");
    a["name"] = json!("   ");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"].as_object().unwrap().is_empty());
    assert!(warnings.iter().any(|w| w.contains("隔离")));
}

#[test]
fn unknown_kind_isolates_entry() {
    let mut a = asset("la-1");
    a["kind"] = json!("robot");
    let (out, _warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"].as_object().unwrap().is_empty());
}

#[test]
fn tags_normalized_deduped_capped_at_16() {
    let mut a = asset("la-1");
    let mut tags: Vec<Value> = (0..20).map(|i| json!(format!("t{i}"))).collect();
    tags.push(json!("t0")); // 重复
    tags.push(json!("  ")); // 空白
    tags.push(json!(123)); // 异型
    a["tags"] = json!(tags);
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    let out_tags = out["assets"]["byId"]["la-1"]["tags"].as_array().unwrap();
    assert_eq!(out_tags.len(), 16, "超过 16 项只留前 16：{out_tags:?}");
    assert_eq!(out_tags[0], "t0");
    assert!(!warnings.is_empty());
}

#[test]
fn non_array_tags_reset_to_empty() {
    let mut a = asset("la-1");
    a["tags"] = json!("cyberpunk");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!([]));
    assert!(warnings.iter().any(|w| w.contains("tags")));
}

#[test]
fn invalid_view_is_stripped_with_warning() {
    let mut a = asset("la-1");
    a["view"] = json!("aerial");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"]["la-1"].get("view").is_none());
    assert!(warnings.iter().any(|w| w.contains("view")));
}

#[test]
fn valid_view_is_kept() {
    let mut a = asset("la-1");
    a["view"] = json!("front");
    let (out, _warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["view"], "front");
}

// ---- 跨条目：组隔离后解析 groupId + kind 一致性 ----

#[test]
fn group_id_pointing_to_missing_group_is_stripped() {
    let mut a = asset("la-1");
    a["groupId"] = json!("g-ghost");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"]["la-1"].get("groupId").is_none());
    assert!(warnings.iter().any(|w| w.contains("groupId")));
}

#[test]
fn group_id_with_kind_mismatch_is_stripped() {
    let mut a = asset("la-1"); // kind character
    a["groupId"] = json!("g-1");
    let index = json!({
        "assets": [a],
        "groups": [group("g-1", "location")], // kind 不一致
    });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert!(out["assets"]["byId"]["la-1"].get("groupId").is_none());
    assert!(warnings
        .iter()
        .any(|w| w.contains("kind") || w.contains("groupId")));
}

#[test]
fn group_id_with_matching_kind_is_kept() {
    let mut a = asset("la-1");
    a["groupId"] = json!("g-1");
    let index = json!({
        "assets": [a],
        "groups": [group("g-1", "character")],
    });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["groupId"], "g-1");
    assert!(warnings.is_empty(), "合法编组不应警告：{warnings:?}");
}

#[test]
fn invalid_group_entry_is_isolated_then_member_group_id_stripped() {
    let mut bad_group = group("g-1", "character");
    bad_group["name"] = json!("  "); // 非法 name → 组隔离
    let mut a = asset("la-1");
    a["groupId"] = json!("g-1");
    let index = json!({ "assets": [a], "groups": [bad_group] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert!(
        out["groups"]["byId"].as_object().unwrap().is_empty(),
        "组应被隔离"
    );
    assert!(
        out["assets"]["byId"]["la-1"].get("groupId").is_none(),
        "组隔离后 groupId 悬空应剥离"
    );
    assert!(!warnings.is_empty());
}

// ---- 评审修复（PR #33 第二轮）：Record 键权威、空白组映射、组 prop kind ----

/// Record 键权威（§7.2 / §11.1 共同规则）：已迁移 Record 的键与内嵌 id 不
/// 一致时以记录键为准改写值内 id——键是引用解析的权威，改写保住既有引用。
#[test]
fn record_key_wins_over_mismatched_embedded_id() {
    let mut a = asset("la-2"); // 内嵌 id 与键不一致
    a["name"] = json!("kept");
    let index = json!({
        "assets": { "byId": { "la-1": a } }, // 键 la-1，内嵌 id la-2
        "groups": { "byId": {} },
    });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    let by_id = out["assets"]["byId"].as_object().unwrap();
    assert!(by_id.contains_key("la-1"), "权威键 la-1 应保留：{by_id:?}");
    assert_eq!(by_id["la-1"]["id"], "la-1", "内嵌 id 应以键为准改写");
    assert!(!by_id.contains_key("la-2"), "不得按内嵌 id 重新键化");
    assert!(
        warnings.iter().any(|w| w.contains("id")),
        "应警告键/id 不一致"
    );
}

/// 组 Record 键/id 不一致同样以键为准，引用原键的资产 groupId 不丢。
#[test]
fn group_record_key_wins_and_member_reference_survives() {
    let mut g = group("g-2", "character"); // 内嵌 id 与键不一致
    g["name"] = json!("林晚");
    let mut a = asset("la-1");
    a["groupId"] = json!("g-1"); // 引用权威键 g-1
    let index = json!({
        "assets": { "byId": { "la-1": a } },
        "groups": { "byId": { "g-1": g } }, // 键 g-1，内嵌 id g-2
    });
    let (out, _warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(
        out["groups"]["byId"]["g-1"]["id"], "g-1",
        "组内嵌 id 以键为准"
    );
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"], "g-1",
        "引用权威键的 groupId 应保留"
    );
}

/// 单一空白 id 组的映射传入资产侧（§7.2）：资产 groupId 精确匹配该空白值
/// 时改写为重发后的组 id，编组不丢。
#[test]
fn single_blank_group_mapping_rewrites_matching_group_id() {
    let mut g = group("g-x", "character");
    g["id"] = json!("   "); // 空白组 id
    let mut a = asset("la-1");
    a["groupId"] = json!("   "); // 精确匹配该空白值
    let index = json!({ "assets": [a], "groups": [g] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    assert_eq!(groups.len(), 1, "空白组应重发保留");
    let new_gid = groups.keys().next().unwrap();
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"].as_str().unwrap(),
        new_gid.as_str(),
        "空白 groupId 应改写为重发组 id"
    );
    assert!(warnings.iter().any(|w| w.contains("id")));
}

/// 多个同值空白组映射歧义（§7.2）：删除相关 groupId 并警告，不猜测。
#[test]
fn multiple_blank_groups_drop_ambiguous_group_id() {
    let mut g1 = group("g-x", "character");
    g1["id"] = json!("  ");
    let mut g2 = group("g-y", "character");
    g2["id"] = json!("  ");
    let mut a = asset("la-1");
    a["groupId"] = json!("  "); // 同值空白，映射歧义
    let index = json!({ "assets": [a], "groups": [g1, g2] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(out["groups"]["byId"].as_object().unwrap().len(), 2);
    assert!(
        out["assets"]["byId"]["la-1"].get("groupId").is_none(),
        "歧义空白 groupId 应删除"
    );
    assert!(warnings
        .iter()
        .any(|w| w.contains("歧义") || w.contains("groupId")));
}

// ---- 评审修复（PR #33 第三轮）：键 verbatim、空白精确匹配、null 桶/标签 ----

/// Record 键 verbatim 不 trim（评审修复）：键合法即原样保留为权威键，不做
/// 任何规范化改写；含空格等非法字符的键按非法 id 重发（含空格本就不满足
/// validate_asset_id 的 alnum/-/_ 值域）。合法但易混淆的键保持 distinct——
/// 不坍缩、不互相改接。
#[test]
fn record_keys_kept_verbatim_and_distinct() {
    let mut g1 = group("g1", "character");
    g1["id"] = json!("g1");
    let mut g2 = group("G1", "location");
    g2["id"] = json!("G1");
    let index = json!({
        "assets": { "byId": {} },
        "groups": { "byId": { "g1": g1, "G1": g2 } },
    });
    let (out, _, _migrated) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    // 两个合法键原样保留、互不坍缩；内嵌 id 以键为准
    assert_eq!(groups["g1"]["kind"], "character", "键 g1 原样保留");
    assert_eq!(groups["G1"]["kind"], "location", "键 G1 不被改写到 g1");
}

/// 含空白等非法字符的 Record 键不可作权威键：键非法时回退按合法内嵌 id
/// 归位（verbatim 不等于放行非法键，也不丢弃合法内嵌 id）。
#[test]
fn record_key_with_illegal_chars_falls_back_to_embedded_id() {
    let mut g = group("g", "character");
    g["id"] = json!("g");
    let index = json!({
        "assets": { "byId": {} },
        "groups": { "byId": { " g ": g } }, // 键含空格，非法
    });
    let (out, _, _migrated) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    assert!(!groups.contains_key(" g "), "非法键不得 verbatim 保留");
    assert_eq!(groups["g"]["id"], "g", "回退按合法内嵌 id 归位");
}

/// 空白组映射只改写精确匹配原空白拼写的 groupId（评审修复）：一个旧 id 为
/// `" "` 的组被重发时，不相关资产的 `groupId: ""`（不同的空白拼写）不得被
/// 错接到该组。
#[test]
fn blank_group_mapping_matches_exact_spelling_only() {
    let mut g = group("g-x", "character");
    g["id"] = json!(" "); // 原空白拼写是单个空格
    let mut a_match = asset("la-1");
    a_match["groupId"] = json!(" "); // 精确匹配 → 改写
    let mut a_other = asset("la-2");
    a_other["groupId"] = json!(""); // 不同空白拼写（空串）→ 不得改写
    let index = json!({ "assets": [a_match, a_other], "groups": [g] });
    let (out, _, _migrated) = migrate_and_normalize(index);
    let new_gid = out["groups"]["byId"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"].as_str().unwrap(),
        new_gid,
        "精确匹配的空白 groupId 应改写"
    );
    assert!(
        out["assets"]["byId"]["la-2"].get("groupId").is_none()
            || out["assets"]["byId"]["la-2"]["groupId"] != json!(new_gid),
        "不同空白拼写的 groupId 不得错接到重发组"
    );
}

/// null 桶视为需修复的脏数据（评审修复）：`assets: null` 不得静默按空——应
/// 警告并置 migrated，让修复落盘、诊断可见，而非每次读取重复丢失。
#[test]
fn null_bucket_warns_and_marks_migrated() {
    let index = json!({ "assets": null, "groups": { "byId": {} } });
    let (_out, warnings, migrated) = migrate_and_normalize(index);
    assert!(
        warnings.iter().any(|w| w.contains("assets")),
        "null 桶应警告：{warnings:?}"
    );
    assert!(migrated, "null 桶修复应置 migrated 以落盘");
}

/// null tags 视为非数组修复（评审修复）：目标 Record 条目 `tags: null` 重置
/// 为 [] 时应警告并置 migrated（与其他非数组 tags 同口径），不静默重复修复。
#[test]
fn null_tags_warn_and_mark_migrated() {
    let mut a = asset("la-1");
    a["tags"] = json!(null);
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!([]));
    assert!(
        warnings.iter().any(|w| w.contains("tags")),
        "null tags 应警告：{warnings:?}"
    );
    assert!(migrated, "null tags 修复应置 migrated");
}

// ---- 评审修复（PR #33 第四轮）：缺 id 组不入映射、source null 拒绝 ----

/// 缺失/非字符串 id 的组不进空白映射（评审修复）：缺失 id 的组从未被任何
/// `groupId` 引用过，其重发不应建立空白映射改写无关资产。仅真实存在的空白
/// 字符串 id 才建立映射。
#[test]
fn missing_id_group_does_not_create_blank_mapping() {
    let mut g = group("g-x", "character");
    g.as_object_mut().unwrap().remove("id"); // 缺失 id（非空白字符串）
    let mut a = asset("la-1");
    a["groupId"] = json!(""); // 无关资产的空白 groupId
    let index = json!({ "assets": [a], "groups": [g] });
    let (out, _w, _m) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    assert_eq!(groups.len(), 1, "缺 id 组仍应重发保留");
    // 缺 id 组不建立映射：无关资产的空白 groupId 不得被改接到该组
    let gid = out["assets"]["byId"]["la-1"].get("groupId");
    assert!(
        gid.is_none() || !groups.contains_key(gid.unwrap().as_str().unwrap_or("")),
        "缺 id 组不得建立空白映射错接无关资产"
    );
}

/// 显式 `source: null` 拒绝隔离而非补 upload（评审修复）：仅真正缺失的
/// source 有已知 upload 来源可补；显式非枚举值（含 null）属未知来源，不得
/// 猜测，按 §7.2 隔离并警告。
#[test]
fn explicit_null_source_is_isolated_not_defaulted() {
    let mut a = asset("la-1");
    a["source"] = json!(null); // 显式 null，非缺失
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "显式 null source 应隔离不补 upload"
    );
    assert!(
        warnings.iter().any(|w| w.contains("source")),
        "应警告 source 未知：{warnings:?}"
    );
}
