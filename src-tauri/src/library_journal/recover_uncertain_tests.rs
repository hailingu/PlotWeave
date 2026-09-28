//! indexUncertain 闩锁回归测试（issue #389）：索引恢复后的两个收敛方向、
//! 损坏期间的保守保持与修复指引、收敛后再次损坏的重新置位。
//! 共享 helper 经 `use super::recover_tests::*` 复用（tests.rs 同款惯例）。

use super::recover::CleanupKind;
use super::recover_tests::*;
use super::*;
use serde_json::{json, Value};
use std::fs;

/// 已置位 indexUncertain 的日志条目（模拟损坏期间被 hold 置位后的落盘形态）。
fn uncertain_entry_json(
    id: &str,
    asset_id: &str,
    rel: &str,
    trash: &str,
    dev: u64,
    ino: u64,
) -> Value {
    let mut e = journal_entry_json(id, asset_id, rel, trash, dev, ino);
    e["indexUncertain"] = json!(true);
    e
}

/// 语法损坏的索引原件：完整条目 la-other + 损坏条目 bad，局部视图不含
/// 测试目标 assetId（issue #389 复现「日志有条目、事务未提交、索引损坏」）。
fn damaged_index_raw() -> String {
    format!(
        r#"{{"assets":{{"byId":{{"other":{},"bad":BROKEN}}}},"groups":{{"byId":{{}}}}}}"#,
        entry("la-other", "assets/la-other.png")
    )
}

/// issue #389 收敛方向①：索引恢复为可解析权威视图且仍含 assetId →
/// indexUncertain 闩锁复位，按「索引仍引用」分支回迁媒体并退役条目，
/// 资产不再永久 conflicted。
#[test]
fn uncertain_entry_restores_media_after_index_repaired() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join(".trash").join("t-x"), b"PNG").expect("写隔离项");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    let (dev, ino) = file_identity(&library.join("assets").join(".trash").join("t-x"));
    write_journal_raw(
        &library,
        json!([uncertain_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            dev,
            ino
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        recovery.conflicted.is_empty(),
        "索引已恢复且仍引用：不应继续冲突：{:?}",
        recovery.conflicted
    );
    assert_eq!(read_journal_raw(&library), json!([]), "回迁收敛应清除日志");
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("媒体应回迁原路径"),
        b"PNG"
    );
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_err(),
        "隔离名应随回迁释放"
    );
    cleanup(&root);
}

/// issue #389 收敛方向②：索引恢复后不含 assetId → 闩锁复位并按「删除已
/// 生效」正常收敛（隔离项保留待清理 + routine cleanupPending，不再标记
/// 冲突）；索引再次损坏且局部视图缺该 id 时按损坏规则重新置位——保守
/// 方向不随收敛路径丢失。
#[test]
fn uncertain_entry_converges_committed_then_rearms_when_index_damages_again() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join(".trash").join("t-x"), b"PNG").expect("写隔离项");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    let (dev, ino) = file_identity(&library.join("assets").join(".trash").join("t-x"));
    write_journal_raw(
        &library,
        json!([uncertain_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            dev,
            ino
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        recovery.conflicted.is_empty(),
        "已提交收敛不应标记冲突：{:?}",
        recovery.conflicted
    );
    assert_eq!(recovery.cleanup_pending.len(), 1, "一个隔离项仅报告一次");
    assert_eq!(
        recovery.cleanup_pending[0].kind,
        CleanupKind::Routine,
        "清理原语缺失的保留项归 routine"
    );
    let saved = read_journal_raw(&library);
    assert_eq!(
        saved.as_array().expect("日志").len(),
        1,
        "清理不可用应保留日志"
    );
    assert!(
        saved[0].get("indexUncertain").is_none(),
        "闩锁应复位（false 不序列化）"
    );
    assert_eq!(
        fs::read(library.join("assets").join(".trash").join("t-x")).expect("隔离项保留"),
        b"PNG"
    );
    // 索引再次损坏且局部视图缺该 id：重新置位并回到冲突保守态
    fs::write(library.join("library.json"), damaged_index_raw()).expect("写损坏索引");
    let rearmed = recover(&cap(&library)).expect("再次恢复应成功");
    assert!(
        rearmed.conflicted.contains(&"la-1".to_string()),
        "损坏期间应重新进入保守态"
    );
    let saved = read_journal_raw(&library);
    assert_eq!(saved[0]["indexUncertain"], json!(true), "闩锁应重新置位");
    assert_eq!(
        fs::read(library.join("assets").join(".trash").join("t-x")).expect("媒体不动"),
        b"PNG"
    );
    cleanup(&root);
}

/// issue #389 保守侧：索引仍处损坏态时闩锁保持冲突保守、媒体与日志保留，
/// 告警须携带可执行修复指引（指明修复 library.json，修复后自动重新判定）。
#[test]
fn uncertain_entry_warning_carries_repair_guidance_while_index_damaged() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    fs::write(library.join("library.json"), damaged_index_raw()).expect("写损坏索引");
    let (dev, ino) = file_identity(&library.join("assets").join("la-1.png"));
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            dev,
            ino
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        recovery.conflicted.contains(&"la-1".to_string()),
        "损坏期间应保持冲突保守"
    );
    assert!(
        recovery.warnings.iter().any(|w| w.contains("library.json")),
        "告警应指明修复 library.json 的可执行指引：{:?}",
        recovery.warnings
    );
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("损坏期间不动媒体"),
        b"PNG"
    );
    let saved = read_journal_raw(&library);
    assert_eq!(
        saved[0]["indexUncertain"],
        json!(true),
        "损坏期间置位并耐久"
    );
    cleanup(&root);
}
