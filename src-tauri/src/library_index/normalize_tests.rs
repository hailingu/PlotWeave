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

// ---- 评审修复（PR #33 第五轮）：键预留、逐拼写空白映射、只读态 ----

/// 权威键先于回退 id 预留（评审修复）：无效键条目的内嵌 id 不得抢占后面才
/// 出现的合法权威键——否则真实资产被重新键化，媒体/删除按 id 会作用到错误
/// 资产。
#[test]
fn fallback_embedded_id_cannot_claim_reserved_authoritative_key() {
    let mut imposter = asset("la-1");
    imposter["name"] = json!("imposter"); // 无效键 "!"，内嵌 id la-1
    let mut real = asset("la-1");
    real["name"] = json!("real"); // 权威键 la-1
    let index = json!({
        "assets": { "byId": { "!": imposter, "la-1": real } },
        "groups": { "byId": {} },
    });
    let (out, warnings, _) = migrate_and_normalize(index);
    let by_id = out["assets"]["byId"].as_object().unwrap();
    assert_eq!(
        by_id["la-1"]["name"], "real",
        "权威键 la-1 必须归真实资产：{by_id:?}"
    );
    assert_eq!(by_id.len(), 2, "imposter 条目应重发保留：{by_id:?}");
    assert!(
        warnings.iter().any(|w| w.contains("重发")),
        "抢占失败应告警重发：{warnings:?}"
    );
}

/// 空白映射逐拼写追踪（评审修复）：不同空白拼写（"" 与 " "）各自唯一确定，
/// 不得因「存在多个空白组」而全局丢弃——§7.2 歧义仅指「多个同值空白组」。
#[test]
fn distinct_blank_spellings_each_keep_their_mapping() {
    let mut g_empty = group("g-a", "character");
    g_empty["id"] = json!(""); // 空串组
    let mut g_space = group("g-b", "character");
    g_space["id"] = json!(" "); // 单空格组
    let mut a1 = asset("la-1");
    a1["groupId"] = json!(""); // 引用空串组
    let mut a2 = asset("la-2");
    a2["groupId"] = json!(" "); // 引用单空格组
    let index = json!({ "assets": [a1, a2], "groups": [g_empty, g_space] });
    let (out, _w, _m) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    assert_eq!(groups.len(), 2, "两组都应重发保留");
    let gid1 = out["assets"]["byId"]["la-1"]["groupId"].as_str().unwrap();
    let gid2 = out["assets"]["byId"]["la-2"]["groupId"].as_str().unwrap();
    assert!(
        groups.contains_key(gid1) && groups.contains_key(gid2),
        "两个确定性映射都应改写成功：{gid1} / {gid2}"
    );
    assert_ne!(gid1, gid2, "不同拼写各自映射到自己的组，不得混同");
}

// ---- 评审修复（PR #33 第六轮）：跨年溢出隔离、空白键引用改写 ----

/// 合法偏移时间戳规范化后越出四位数年域（评审修复）：`9999-12-31T23:59:59
/// -23:59` 的 UTC 瞬间落在 10000 年，规范化表示为 5 位年、非规范形——不得
/// 落盘为下次读取必拒的不可读中间表示，应隔离原条目。
#[test]
fn offset_timestamp_crossing_year_boundary_is_isolated() {
    let mut a = asset("la-1");
    a["createdAt"] = json!("9999-12-31T23:59:59-23:59");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "溢出年域的时间戳应隔离条目"
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("createdAt") || w.contains("时间戳")),
        "应警告时间戳无法规范化：{warnings:?}"
    );
}

/// 毫秒时间戳超规范年域同样隔离（评审修复）：大毫秒值经 iso_from_ms 产生
/// 5 位年表示，落盘即不可读。
#[test]
fn epoch_millis_beyond_year_9999_is_isolated() {
    let mut a = asset("la-1");
    a["createdAt"] = json!(253_402_300_800_000u64); // 10000-03-01T00:00:00Z
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, _, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "超年域毫秒时间戳应隔离条目"
    );
}

/// 空白 Record 键的引用改写（评审修复）：`groups.byId[" "] = { id: "g-old" }`
/// 的权威键非法被拒、条目按内嵌 id 归位，但引用空白键的 groupId 需按
/// 「旧键拼写 → 归位 id」映射改写——键是 Record 的引用权威，不得剥离。
#[test]
fn blank_record_key_creates_remap_for_referencing_assets() {
    let g = group("g-old", "character");
    let mut a = asset("la-1");
    a["groupId"] = json!(" "); // 引用空白键
    let index = json!({
        "assets": [a],
        "groups": { "byId": { " ": g } },
    });
    let (out, _w, _m) = migrate_and_normalize(index);
    let groups = out["groups"]["byId"].as_object().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups["g-old"]["id"], "g-old", "组按内嵌 id 归位");
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"], "g-old",
        "引用空白键的 groupId 应改写为归位组 id，不得剥离"
    );
}

// ---- 评审修复（PR #33 第七轮）：只读态不产生新身份 ----

/// 只读态重发退化为隔离（评审修复）：journal 异型（只读告警态）下读取不
/// 落盘，`new_id()` 重发的 id 跨读漂移——只读模式凡需重发 id 的条目一律
/// 隔离并警告，不暴露不稳定身份；字段级确定性修复不受影响。
#[test]
fn readonly_mode_isolates_instead_of_reissuing_ids() {
    let mut blank = asset("la-1");
    blank["id"] = json!("  "); // 空白 id，可落盘路径会重发保留
    let index = json!({ "assets": [blank], "groups": [] });
    // 对照：可落盘路径重发保留
    let (out, _, _) = migrate_and_normalize(index.clone());
    assert_eq!(out["assets"]["byId"].as_object().unwrap().len(), 1);
    // 只读模式：隔离不重发
    let (out, warnings, _) = migrate_and_normalize_readonly(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "只读态不得产生重发身份：{}",
        out["assets"]
    );
    assert!(warnings.iter().any(|w| w.contains("只读")));
}

/// 只读模式下确定性修复照常（对照）：合法 id 条目的 mime 规范化保留——
/// 跨读结果一致，无漂移。
#[test]
fn readonly_mode_keeps_deterministic_field_repairs() {
    let mut a = asset("la-1");
    a["mime"] = json!(" Image/PNG ");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize_readonly(index);
    assert_eq!(
        out["assets"]["byId"]["la-1"]["mime"].as_str(),
        Some("image/png"),
        "确定性 mime 修复应保留"
    );
    assert!(warnings.iter().any(|w| w.contains("mime")));
}

// ---- 评审修复（PR #33 第八轮）：空串键映射、source 形状限定、pre-epoch ----

/// 空串 Record 键同样进映射（评审修复）：`groups.byId[""] = { id: "g-old" }`
/// 的空串键非法被拒、组按内嵌 id 归位，引用空串键的 groupId 需按「"" →
/// 归位 id」映射改写——空串是可精确匹配的拼写，不得被非空过滤排除。
#[test]
fn empty_string_record_key_creates_remap_for_referencing_assets() {
    let g = group("g-old", "character");
    let mut a = asset("la-1");
    a["groupId"] = json!(""); // 引用空串键
    let index = json!({
        "assets": [a],
        "groups": { "byId": { "": g } },
    });
    let (out, _w, _m) = migrate_and_normalize(index);
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"], "g-old",
        "引用空串键的 groupId 应改写为归位组 id，不得剥离"
    );
}

/// source 补 upload 仅限旧数组条目（评审修复）：「当前库资产均由本地导入
/// 产生」是兼容迁移条款、只对已发布的数组格式成立；已是目标 Record 形状的
/// 条目缺 source 是必填 AssetRef 字段缺失，必须隔离而非猜测补 upload。
#[test]
fn record_entry_missing_source_is_isolated_not_defaulted() {
    let mut a = asset("la-1");
    a.as_object_mut().unwrap().remove("source");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "目标形状缺 source 应隔离"
    );
    assert!(warnings.iter().any(|w| w.contains("source")));
}

/// pre-epoch 合法时间戳规范化而非隔离（评审修复）：`1960-01-01T00:00:00Z`
/// 是合法非规范形（负瞬间），不得因负毫秒转 u64 失败被隔离——等价规范形
/// `.000Z` 被直接接受，同值不同格式不得不同命运。
#[test]
fn pre_epoch_timestamp_normalizes_instead_of_isolating() {
    let mut a = asset("la-1");
    a["createdAt"] = json!("1960-01-01T00:00:00Z");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, _, _) = migrate_and_normalize(index);
    assert_eq!(
        out["assets"]["byId"]["la-1"]["createdAt"], "1960-01-01T00:00:00.000Z",
        "pre-epoch 合法时间戳应规范化保留"
    );
}

// ---- 评审修复（PR #33 第九轮）：引用不 trim、null view 形状限定、写前复验 ----

/// 非空 groupId 不得 trim 规范化（评审修复）：ID 不透明，`groupId: " g "`
/// 与组键 `g` 是不同的值——trim 后接入是把资产静默错接进组；非法引用应
/// 剥离，或仅经精确旧键映射改写。
#[test]
fn nonblank_group_id_is_not_trimmed_into_a_group() {
    let g = group("g", "character");
    let mut a = asset("la-1");
    a["groupId"] = json!(" g "); // 脏引用，与组键 g 不同值
    let index = json!({ "assets": [a], "groups": { "byId": { "g": g } } });
    let (out, warnings, _m) = migrate_and_normalize(index);
    let a = &out["assets"]["byId"]["la-1"];
    assert!(
        a.get("groupId").is_none() || a["groupId"] != json!("g"),
        "脏引用不得 trim 错接进组 g：{}",
        a
    );
    assert!(warnings.iter().any(|w| w.contains("groupId")));
}

/// 目标 Record 条目的显式 `view: null` 是非法值（评审修复）：null 删除是
/// 旧数组兼容迁移语义——目标形状下走非法 view 警告路径，修复可见且经
/// migrated 落盘；对照 legacy 数组 null 静默删除。
#[test]
fn record_null_view_warns_while_legacy_null_is_silent_removal() {
    // 目标形状：null → 警告剥离
    let mut a = asset("la-1");
    a["view"] = json!(null);
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert!(out["assets"]["byId"]["la-1"].get("view").is_none());
    assert!(
        warnings.iter().any(|w| w.contains("view")),
        "目标形状显式 null view 应警告：{warnings:?}"
    );
    assert!(migrated);
    // 对照：legacy 数组 null → 兼容迁移静默删除
    let mut b = asset("la-1");
    b["view"] = json!(null);
    let legacy = json!({ "assets": [b], "groups": [] });
    let (out, warnings, _) = migrate_and_normalize(legacy);
    assert!(out["assets"]["byId"]["la-1"].get("view").is_none());
    assert!(
        !warnings.iter().any(|w| w.contains("view")),
        "legacy null 删除是确定性兼容改写，不告警：{warnings:?}"
    );
}

// ---- 评审修复（PR #33 第十轮）：tags trim 修复可见、null groupId 形状限定 ----

/// tags 成员 trim 产生的修复须可见（评审修复）：`[" hero "]` → `["hero"]`
/// 是确定性修复——警告并经 migrated 落盘，不得静默改写后每次读取重复。
#[test]
fn trimmed_tag_marks_repair_dirty() {
    let mut a = asset("la-1");
    a["tags"] = json!([" hero "]);
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!(["hero"]));
    assert!(
        warnings.iter().any(|w| w.contains("tags")),
        "trim 修复应告警：{warnings:?}"
    );
    assert!(migrated, "trim 修复应置 migrated 落盘");
}

/// 目标 Record 条目显式 `groupId: null` 走警告路径（评审修复）：与 view null
/// 同口径——null 删除是旧数组兼容迁移语义；目标形状下警告剥离并落盘。
#[test]
fn record_null_group_id_warns_while_legacy_null_is_silent_removal() {
    // 目标形状：null → 警告剥离
    let mut a = asset("la-1");
    a["groupId"] = json!(null);
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert!(out["assets"]["byId"]["la-1"].get("groupId").is_none());
    assert!(
        warnings.iter().any(|w| w.contains("groupId")),
        "目标形状显式 null groupId 应警告：{warnings:?}"
    );
    assert!(migrated);
    // 对照：legacy 数组 null → 兼容迁移静默删除
    let mut b = asset("la-1");
    b["groupId"] = json!(null);
    let legacy = json!({ "assets": [b], "groups": [] });
    let (out, warnings, _) = migrate_and_normalize(legacy);
    assert!(out["assets"]["byId"]["la-1"].get("groupId").is_none());
    assert!(
        !warnings.iter().any(|w| w.contains("groupId")),
        "legacy null 删除是确定性兼容改写，不告警：{warnings:?}"
    );
}

// ---- 评审修复（PR #33 第十一轮）：embedded id verbatim、缺失桶告警 ----

/// 内嵌 id verbatim（评审修复）：旧数组条目 `" la-1 "` 带空白即非法重发，
/// 不得 trim 成 `la-1` 抢占真实条目——ID 不透明，trim 规范化只适用于契约
/// 明确允许的字段。
#[test]
fn padded_embedded_id_is_reissued_not_trimmed() {
    let mut padded = asset(" la-1 ");
    padded["name"] = json!("padded");
    let real = asset("la-1");
    let index = json!({ "assets": [padded, real], "groups": [] });
    let (out, warnings, _m) = migrate_and_normalize(index);
    let by_id = out["assets"]["byId"].as_object().unwrap();
    assert_eq!(
        by_id["la-1"]["name"], "x",
        "真实 la-1 不得被抢占：{by_id:?}"
    );
    assert_eq!(by_id.len(), 2, "带空白条目应重发保留：{by_id:?}");
    assert!(
        by_id.values().any(|e| e["name"] == "padded"),
        "带空白条目应重发保留"
    );
    assert!(warnings.iter().any(|w| w.contains("id")));
}

/// 已有索引文件缺失 assets/groups 桶须告警并落盘（评审修复）：真实空库由
/// 「索引文件缺失」覆盖；文件存在但桶缺失是异型，静默合成会每次读取重复。
#[test]
fn omitted_bucket_in_existing_file_warns_and_marks_migrated() {
    let index = json!({ "assets": { "byId": { "la-1": asset("la-1") } } }); // 缺 groups
    let (_out, warnings, migrated) = migrate_and_normalize(index);
    assert!(
        warnings.iter().any(|w| w.contains("groups")),
        "缺失桶应告警：{warnings:?}"
    );
    assert!(migrated, "缺失桶修复应落盘");
}

// ---- 评审修复（PR #33 第十二轮）：数字时间戳限定 legacy ----

/// 目标 Record 条目数字 createdAt 隔离（评审修复）：epoch 毫秒转换是兼容
/// 迁移条款、只对旧数组条目成立；目标形状下数字是必填字段异型，与 source
/// 缺失、view null、groupId null 同口径——隔离不猜测。
#[test]
fn record_numeric_created_at_is_isolated_not_converted() {
    let mut a = asset("la-1");
    a["createdAt"] = json!(1_700_000_000_000u64);
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "目标形状数字时间戳应隔离"
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("createdAt") || w.contains("时间戳")),
        "应警告异型时间戳：{warnings:?}"
    );
}

// ---- 评审修复（PR #33 第十五轮）：目标形状缺失 tags 为可见修复 ----

/// 目标 Record 条目缺失 tags（必填字段）为待修复脏数据（评审修复）：确定性
/// 重置为 [] 须告警并经 migrated 落盘——静默合成会让修复每次读取重复，且
/// 后续无关写入会把合成值当原始值提交；legacy 数组条目保持静默按空。
#[test]
fn record_missing_tags_warns_while_legacy_missing_is_silent() {
    // 目标形状：缺失 tags → 警告 + migrated
    let mut a = asset("la-1");
    a.as_object_mut().unwrap().remove("tags");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!([]));
    assert!(
        warnings.iter().any(|w| w.contains("tags")),
        "目标形状缺失 tags 应警告：{warnings:?}"
    );
    assert!(migrated, "缺失 tags 修复应落盘");
    // 对照：legacy 数组缺失 tags → 静默按空（兼容迁移语境）
    let mut b = asset("la-1");
    b.as_object_mut().unwrap().remove("tags");
    let legacy = json!({ "assets": [b], "groups": [] });
    let (out, warnings, _) = migrate_and_normalize(legacy);
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!([]));
    assert!(
        !warnings.iter().any(|w| w.contains("tags")),
        "legacy 缺失 tags 是兼容语境静默按空：{warnings:?}"
    );
}
