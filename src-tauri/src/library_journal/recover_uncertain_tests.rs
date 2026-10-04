//! indexUncertain 闩锁回归测试（issue #389）：索引恢复后的两个收敛方向、
//! 损坏期间的保守保持与修复指引、收敛后再次损坏的重新置位、迁移挂起
//! （suspended）只读视图的非权威性（PR #413 评审 4121700018）。
//! 共享磁盘夹具复用 crate::library_fixture。

use super::recover::CleanupKind;
use super::*;
use crate::library_fixture::*;
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

/// issue #389 收敛方向② + issue #359 修订：索引恢复后不含 assetId →
/// 闩锁复位并按「删除已生效」正常收敛；隔离项身份核验一致后**折叠退役**
/// （日志退场、计数归档、单条 routine 摘要，不再标记冲突）。折叠仅在
/// 权威视图下发生、提交已被证明——事务就此闭合，索引再次损坏时**不再
/// 重新置闩**；隔离项字节保留为证据。置闩保守机制对仍驻留日志的证据
/// 条目不变（损坏期置位由下方告警指引用例覆盖）。
#[test]
fn uncertain_committed_entry_folds_and_stays_closed_across_index_damage() {
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
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "折叠为单条摘要：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(
        recovery.cleanup_pending[0].kind,
        CleanupKind::Routine,
        "清理原语缺失的折叠摘要归 routine"
    );
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "闩锁复位按已提交收敛后应折叠退场（issue #359）"
    );
    assert_eq!(
        fs::read(library.join("assets").join(".trash").join("t-x")).expect("隔离项保留"),
        b"PNG"
    );
    // 索引再次损坏：折叠条目已闭合（提交在权威视图下已证明），无条目可
    // 重新置闩；证据字节保留，归档摘要照常报告
    fs::write(library.join("library.json"), damaged_index_raw()).expect("写损坏索引");
    let rearmed = recover(&cap(&library)).expect("再次恢复应成功");
    assert!(
        !rearmed.conflicted.contains(&"la-1".to_string()),
        "闭合事务不再重新进入冲突保守态：{:?}",
        rearmed.conflicted
    );
    assert_eq!(read_journal_raw(&library), json!([]));
    assert_eq!(
        rearmed.cleanup_pending.len(),
        1,
        "归档计数驱动的摘要照常报告"
    );
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

/// 构造「可解析旧数组索引 + 迁移产物超 1 MiB」的挂起态索引：3300 条
/// 41 字符 id 的条目序列化约 1,013,124 字节（读上限内），键化迁移产物
/// 约 1,158,342 字节（越过写上限）——`read_index_normalized` 进入
/// damaged=false / suspended=true 的只读局部视图（PR #413 评审 4121700018）。
fn suspended_legacy_index() -> Value {
    let name = "x".repeat(80);
    let legacy: Vec<Value> = (0..3300)
        .map(|i| {
            let id = format!("la-{i:038}");
            json!({"id": id, "name": name, "kind": "other", "mime": "image/png",
                "relPath": format!("assets/{id}.png"), "source": "upload",
                "createdAt": "2026-01-01T00:00:00.000Z", "tags": []})
        })
        .collect();
    json!({ "assets": legacy, "groups": [] })
}

/// PR #413 评审 4121700018：迁移挂起的只读局部视图不得作为闩锁重判依据
/// ——写路径拒绝同一视图以防抹掉被隔离条目，恢复判定同样不得以其为权威；
/// 条目保持冲突保守且媒体不动，索引恢复权威（迁移可落盘）后才收敛。
#[test]
fn uncertain_entry_holds_latch_while_migration_suspended() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(&library, &suspended_legacy_index());
    let (dev, ino) = file_identity(&library.join("assets").join("la-1.png"));
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
    // 前置 sanity：本夹具确实进入迁移挂起态（否则用例失效）
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        recovery.warnings.iter().any(|w| w.contains("迁移挂起")),
        "夹具应产生迁移挂起警告：{:?}",
        recovery.warnings
    );
    assert!(
        recovery.conflicted.contains(&"la-1".to_string()),
        "挂起态只读视图非权威：应保持冲突保守"
    );
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("挂起期间不动媒体"),
        b"PNG"
    );
    let saved = read_journal_raw(&library);
    assert_eq!(
        saved[0]["indexUncertain"],
        json!(true),
        "挂起期间闩锁不得复位"
    );
    // 索引恢复权威（小体量 Record 形状、无迁移）：收敛恢复，按已提交判定
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    let converged = recover(&cap(&library)).expect("权威视图下恢复应成功");
    assert!(
        converged.conflicted.is_empty(),
        "恢复权威后应解除冲突：{:?}",
        converged.conflicted
    );
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "权威视图下闩锁复位、按已提交收敛并折叠退场（issue #359）"
    );
    // 重隔离的媒体字节保留在隔离名下（折叠只退役日志条目，不动隔离项）
    let quarantined: Vec<_> = fs::read_dir(library.join("assets").join(".trash"))
        .expect("读隔离目录")
        .map(|e| e.expect("目录项"))
        .collect();
    assert_eq!(quarantined.len(), 1, "重隔离媒体应恰好一项");
    assert_eq!(
        fs::read(quarantined[0].path()).expect("媒体字节保留在隔离名下"),
        b"PNG"
    );
    assert!(
        !library.join("assets").join("la-1.png").exists(),
        "按已提交收敛后媒体应离开活动路径"
    );
    cleanup(&root);
}
