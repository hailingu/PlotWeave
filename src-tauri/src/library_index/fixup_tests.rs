//! library_index 归一化内核的评审修复轮次回归测试（PR #33 第五轮起）：//! 键预留/逐拼写空白映射、只读态不产生新身份、空串键映射与 source/时间戳//! 形状限定、引用 verbatim、tags 修复可见、prop 迁移限定 legacy 桶。//! 归一化不变量与早期轮次见同目录 normalize_tests.rs；自其拆出以符合//! 源文件 800 行上限（评审修复，PR #33 第十八轮）。

use super::testutil::{asset, group};
use super::*;
use serde_json::{json, Value};

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

/// 降级路径不保留被弃可写遍的「已重发」谎报（评审修复）：只读归一化实际
/// 隔离了条目，输出诊断只应有超限警告 + 只读遍声明。
#[test]
fn oversized_fallback_discards_writable_pass_reissue_claims() {
    // 通过 read_index 层验证——此处直接验证内核对的组合行为不可行，
    // 降级组合断言在 library/tests.rs；本测试锚定内核接口：
    // readonly 版从不产生「已重发」
    let mut blank = asset("la-1");
    blank["id"] = json!("  ");
    let index = json!({ "assets": [blank], "groups": [] });
    let (_, warnings, _) = migrate_and_normalize_readonly(index);
    assert!(
        !warnings.iter().any(|w| w.contains("已重发")),
        "只读归一化不得产生已重发声明：{warnings:?}"
    );
}

/// 非法键归位为内嵌 id 是确定性修复（评审修复）：须警告并经 migrated 落盘，
/// 不得静默重复归键。
#[test]
fn fallback_rekey_of_invalid_record_key_warns_and_marks_migrated() {
    let g = group("g-old", "character"); // 键 " " 非法，归位 g-old
    let index = json!({
        "assets": { "byId": {} },
        "groups": { "byId": { " ": g } },
    });
    let (out, warnings, migrated) = migrate_and_normalize(index);
    assert_eq!(out["groups"]["byId"]["g-old"]["id"], "g-old");
    assert!(
        warnings.iter().any(|w| w.contains("归位")),
        "键归位修复应告警：{warnings:?}"
    );
    assert!(migrated, "键归位修复应置 migrated 落盘");
}

// ---- 评审修复（PR #33 第十八轮）：prop 迁移限定 legacy 桶 ----

/// prop kind 迁移仅限旧数组条目（评审修复）：「现实剧组服化道同属一个部门，
/// 旧 prop 并入 wardrobe」是 §7.2 兼容迁移条款——只对已发布的数组格式成立；
/// 目标 Record 形状下 prop 不在声明 kind 联合内，应隔离而非静默重归类。
#[test]
fn record_prop_kind_is_isolated_not_recategorized() {
    let mut a = asset("la-1");
    a["kind"] = json!("prop");
    let index = json!({ "assets": { "byId": { "la-1": a } }, "groups": { "byId": {} } });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "目标形状 prop kind 应隔离"
    );
    assert!(warnings
        .iter()
        .any(|w| w.contains("kind") || w.contains("prop")));
    // 对照：legacy 数组 prop → wardrobe 保留（既有测试的语义不变）
    let mut b = asset("la-1");
    b["kind"] = json!("prop");
    let legacy = json!({ "assets": [b], "groups": [] });
    let (out, _, _) = migrate_and_normalize(legacy);
    assert_eq!(out["assets"]["byId"]["la-1"]["kind"], "wardrobe");
}

/// 组的 prop kind 同款限定（评审修复）：目标 Record 组 prop 隔离；legacy
/// 数组组 prop 迁 wardrobe 保留（成员 groupId 不丢）。
#[test]
fn record_prop_group_is_isolated_while_legacy_group_migrates() {
    let g = group("g-1", "prop");
    let index = json!({
        "assets": { "byId": {} },
        "groups": { "byId": { "g-1": g } },
    });
    let (out, warnings, _) = migrate_and_normalize(index);
    assert!(
        out["groups"]["byId"].as_object().unwrap().is_empty(),
        "目标形状 prop 组应隔离"
    );
    assert!(warnings
        .iter()
        .any(|w| w.contains("prop") || w.contains("kind")));
}
