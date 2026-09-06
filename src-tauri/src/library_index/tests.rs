//! library_index 迁移与完整归一化内核的回归测试（issue #29 PR 1，§7.2
//! 兼容迁移链与加载归一化不变量）：旧数组 → 目标 Record 的语义保全、id
//! 键化/重发、source/createdAt/null/prop 兼容改写、读侧完整归一化与跨
//! 条目 groupId/kind 一致性。

use super::*;
use serde_json::{json, Value};

/// 合法的最小资产条目（目标形状，按需改字段）。
fn asset(id: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "character",
        "mime": "image/png",
        "relPath": format!("assets/{id}.png"),
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 合法的最小组条目。
fn group(id: &str, kind: &str) -> Value {
    json!({ "id": id, "name": "g", "kind": kind })
}

/// 目标 Record 形状的资产桶。
fn by_id(entries: Vec<Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}

// ---- 目标形状直通（已迁移索引不二次迁移）----

#[test]
fn record_shape_passes_through_unchanged() {
    let index = json!({
        "assets": by_id(vec![asset("la-1")]),
        "groups": by_id(vec![group("g-1", "character")]),
    });
    let (out, warnings) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["name"], "x");
    assert_eq!(out["groups"]["byId"]["g-1"]["kind"], "character");
    assert!(warnings.is_empty(), "干净索引不应有警告：{warnings:?}");
}

#[test]
fn non_object_root_is_rejected_shape() {
    // 调用方（read_index_capped）已拒绝非标量根；此处内核按空库收敛并告警
    let (out, warnings) = migrate_and_normalize(json!([]));
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
    let (out, _) = migrate_and_normalize(index);
    assert_eq!(out["assets"]["byId"]["la-1"]["id"], "la-1");
    assert_eq!(out["assets"]["byId"]["la-2"]["id"], "la-2");
    assert_eq!(out["groups"]["byId"]["g-1"]["id"], "g-1");
}

#[test]
fn duplicate_asset_id_keeps_first_reissues_later() {
    let mut b = asset("la-1");
    b["name"] = json!("second");
    let index = json!({ "assets": [asset("la-1"), b], "groups": [] });
    let (out, warnings) = migrate_and_normalize(index);
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
    let (out, warnings) = migrate_and_normalize(index);
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
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["source"], "upload");
    assert!(warnings.iter().any(|w| w.contains("source")));
}

#[test]
fn legacy_epoch_millis_created_at_converts_to_utc_iso() {
    let mut a = asset("la-1");
    a["createdAt"] = json!(1_700_000_000_000u64);
    let (out, _) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(
        out["assets"]["byId"]["la-1"]["createdAt"],
        "2023-11-14T22:13:20.000Z"
    );
}

#[test]
fn unconvertible_created_at_isolates_entry_without_guessing() {
    let mut a = asset("la-1");
    a["createdAt"] = json!("not-a-date");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
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
    let (out, _) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    let e = &out["assets"]["byId"]["la-1"];
    assert!(e.get("view").is_none(), "null view 应删除");
    assert!(e.get("groupId").is_none(), "null groupId 应删除");
}

#[test]
fn legacy_prop_kind_rewritten_to_wardrobe() {
    let mut a = asset("la-1");
    a["kind"] = json!("prop");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["kind"], "wardrobe");
    assert!(warnings
        .iter()
        .any(|w| w.contains("prop") || w.contains("wardrobe")));
}

// ---- 第 ④ 步：完整归一化不变量 ----

#[test]
fn name_is_trimmed_and_saved_normalized() {
    let mut a = asset("la-1");
    a["name"] = json!("  林晚  ");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["name"], "林晚");
    assert!(warnings.iter().any(|w| w.contains("name")));
}

#[test]
fn entry_with_invalid_required_name_is_isolated() {
    let mut a = asset("la-1");
    a["name"] = json!("   ");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"].as_object().unwrap().is_empty());
    assert!(warnings.iter().any(|w| w.contains("隔离")));
}

#[test]
fn unknown_kind_isolates_entry() {
    let mut a = asset("la-1");
    a["kind"] = json!("robot");
    let (out, _) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
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
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    let out_tags = out["assets"]["byId"]["la-1"]["tags"].as_array().unwrap();
    assert_eq!(out_tags.len(), 16, "超过 16 项只留前 16：{out_tags:?}");
    assert_eq!(out_tags[0], "t0");
    assert!(!warnings.is_empty());
}

#[test]
fn non_array_tags_reset_to_empty() {
    let mut a = asset("la-1");
    a["tags"] = json!("cyberpunk");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["tags"], json!([]));
    assert!(warnings.iter().any(|w| w.contains("tags")));
}

#[test]
fn invalid_view_is_stripped_with_warning() {
    let mut a = asset("la-1");
    a["view"] = json!("aerial");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert!(out["assets"]["byId"]["la-1"].get("view").is_none());
    assert!(warnings.iter().any(|w| w.contains("view")));
}

#[test]
fn valid_view_is_kept() {
    let mut a = asset("la-1");
    a["view"] = json!("front");
    let (out, _) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
    assert_eq!(out["assets"]["byId"]["la-1"]["view"], "front");
}

// ---- 跨条目：组隔离后解析 groupId + kind 一致性 ----

#[test]
fn group_id_pointing_to_missing_group_is_stripped() {
    let mut a = asset("la-1");
    a["groupId"] = json!("g-ghost");
    let (out, warnings) = migrate_and_normalize(json!({ "assets": [a], "groups": [] }));
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
    let (out, warnings) = migrate_and_normalize(index);
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
    let (out, warnings) = migrate_and_normalize(index);
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
    let (out, warnings) = migrate_and_normalize(index);
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
