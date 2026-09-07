//! library_index 兼容迁移链的回归测试（issue #29 PR 1，§7.2 步骤 ①②③）：
//! 旧数组 → 目标 Record 的语义保全、id 键化/重发、source/createdAt/null/prop
//! 兼容改写与 legacy 数组语境的对照改写。归一化不变量与评审修复轮次见同目
//! 录 normalize_tests.rs（自本文件拆出以符合源文件 800 行上限）。

use super::testutil::{asset, by_id, group};
use super::*;
use serde_json::json;

// ---- 目标形状直通（已迁移索引不二次迁移）----

#[test]
fn record_shape_passes_through_unchanged() {
    let index = json!({
        "assets": by_id(vec![asset("la-1")]),
        "groups": by_id(vec![group("g-1", "character")]),
    });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["name"], "x");
    assert_eq!(out["groups"]["byId"]["g-1"]["kind"], "character");
    assert!(warnings.is_empty(), "干净索引不应有警告：{warnings:?}");
}

#[test]
fn non_object_root_is_rejected_shape() {
    // 调用方（read_index_capped）已拒绝非标量根；此处内核按空库收敛并告警
    let (out, warnings, _migrated) = migrate_and_normalize(json!([]));
    assert_eq!(out["assets"], json!({ "byId": {} }));
    assert_eq!(out["groups"], json!({ "byId": {} }));
    assert!(!warnings.is_empty());
}

// ---- 迁移链第 ①② 步：预检 + id 键化/重发 ----

#[test]
fn legacy_array_migrates_to_record_keyed_by_id() {
    let index = json!({
        "assets": [asset("la-1"), asset("la-2")],
        "groups": [group("g-1", "character")],
    });
    let (out, _warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["id"], "la-1");
    assert_eq!(out["assets"]["byId"]["la-2"]["id"], "la-2");
    assert_eq!(out["groups"]["byId"]["g-1"]["id"], "g-1");
}

#[test]
fn duplicate_asset_id_keeps_first_reissues_later() {
    let mut b = asset("la-1");
    b["name"] = json!("second");
    let index = json!({ "assets": [asset("la-1"), b], "groups": [] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    // 首项保留原 id
    assert_eq!(out["assets"]["byId"]["la-1"]["name"], "x");
    // 后续项重发本域未占用 id
    let ids: Vec<&str> = out["assets"]["byId"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(ids.len(), 2, "两项都应保留：{ids:?}");
    let reissued = out["assets"]["byId"]
        .as_object()
        .unwrap()
        .values()
        .find(|e| e["name"] == "second")
        .expect("重发项应在");
    assert_ne!(reissued["id"], "la-1", "重发 id 不得与首项相同");
    assert_eq!(
        reissued["id"].as_str().unwrap(),
        // 键与内嵌 id 一致
        out["assets"]["byId"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, v)| v["name"] == "second")
            .map(|(k, _)| k.as_str())
            .unwrap()
    );
    assert!(warnings.iter().any(|w| w.contains("重复")), "应警告重复 id");
}

#[test]
fn blank_or_missing_asset_id_is_reissued() {
    let mut no_id = asset("la-1");
    no_id.as_object_mut().unwrap().remove("id");
    let mut blank = asset("la-2");
    blank["id"] = json!("   ");
    let index = json!({ "assets": [no_id, blank], "groups": [] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    let by_id = out["assets"]["byId"].as_object().unwrap();
    assert_eq!(by_id.len(), 2, "两项都应保留：{by_id:?}");
    for (k, v) in by_id {
        assert!(!k.trim().is_empty(), "键不得为空白");
        assert_eq!(v["id"].as_str().unwrap(), k, "键与内嵌 id 一致");
    }
    assert!(warnings.iter().any(|w| w.contains("id")), "应警告 id 重发");
}

// ---- 迁移链第 ③ 步：source/createdAt/null/prop 兼容改写 ----

#[test]
fn legacy_missing_source_defaults_to_upload() {
    let mut a = asset("la-1");
    a.as_object_mut().unwrap().remove("source");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["source"], "upload");
    assert!(warnings.iter().any(|w| w.contains("source")));
}

#[test]
fn legacy_epoch_millis_created_at_converts_to_utc_iso() {
    let mut a = asset("la-1");
    a["createdAt"] = json!(1_700_000_000_000u64);
    let (out, _warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(
        out["assets"]["byId"]["la-1"]["createdAt"],
        "2023-11-14T22:13:20.000Z"
    );
}

#[test]
fn unconvertible_created_at_isolates_entry_without_guessing() {
    let mut a = asset("la-1");
    a["createdAt"] = json!("not-a-date");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(
        out["assets"]["byId"].as_object().unwrap().is_empty(),
        "缺失/异型时间戳不得猜测，应隔离"
    );
    assert!(warnings
        .iter()
        .any(|w| w.contains("createdAt") || w.contains("时间戳")));
}

#[test]
fn legacy_null_optional_fields_are_removed() {
    let mut a = asset("la-1");
    a["view"] = json!(null);
    a["groupId"] = json!(null);
    let (out, _warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    let e = &out["assets"]["byId"]["la-1"];
    assert!(e.get("view").is_none(), "null view 应删除");
    assert!(e.get("groupId").is_none(), "null groupId 应删除");
}

#[test]
fn legacy_prop_kind_rewritten_to_wardrobe() {
    let mut a = asset("la-1");
    a["kind"] = json!("prop");
    let (out, warnings, _migrated) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["kind"], "wardrobe");
    assert!(warnings
        .iter()
        .any(|w| w.contains("prop") || w.contains("wardrobe")));
}

// ---- legacy 数组语境的兼容改写对照（评审修复）----

/// 组的 prop kind 与资产同款迁移为 wardrobe（§7.2 prop→wardrobe）：组不被
/// 隔离，其 wardrobe 成员的 groupId 保留。
#[test]
fn legacy_prop_group_migrates_to_wardrobe_keeping_members() {
    let mut a = asset("la-1");
    a["kind"] = json!("prop"); // 资产 prop → wardrobe
    a["groupId"] = json!("g-1");
    let g = group("g-1", "prop"); // 组 prop → wardrobe
    let index = json!({ "assets": [a], "groups": [g] });
    let (out, warnings, _migrated) = migrate_and_normalize(index);
    assert_eq!(
        out["groups"]["byId"]["g-1"]["kind"], "wardrobe",
        "组 prop 应迁为 wardrobe"
    );
    assert_eq!(
        out["assets"]["byId"]["la-1"]["groupId"], "g-1",
        "成员 groupId 应保留（kind 已同步一致）"
    );
    assert!(warnings.iter().any(|w| w.contains("prop")));
}

/// 对照：旧数组条目缺失 source 字段仍确定性补 upload（不回归迁移语义；
/// 「均由本地导入产生」的已知来源仅对已发布的数组格式成立）。
#[test]
fn genuinely_missing_source_still_defaults_to_upload() {
    let mut a = asset("la-1");
    a.as_object_mut().unwrap().remove("source"); // 字段缺失
    let index = json!({ "assets": [a], "groups": [] }); // 旧数组形状（legacy 语境）
    let (out, warnings, _) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["source"], "upload");
    assert!(warnings.iter().any(|w| w.contains("source")));
}
