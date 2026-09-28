//! 删除日志已完成条目折叠归档回归测试（issue #359）：「索引已去项 +
//! 隔离项身份核验一致 + 平台无身份绑定删除原语」的终态条目在恢复时折叠
//! 退场——恢复的逐条核验成本与 `cleanupPending` 响应大小不再随历史删除
//! 总数线性增长；折叠计数持久进旁路归档 `asset-delete-archive.json`，
//! 用户整体清理 `assets/.trash/` 后计数归零；证据类条目与非权威视图
//! 期间不折叠。共享 helper 经 `use super::recover_tests::*` 复用。

use super::recover::CleanupKind;
use super::recover_tests::*;
use super::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 构造 n 条「索引已去项 + 隔离项身份一致」的已完成条目：每个条目在
/// .trash 有真实文件，身份与磁盘一致（issue #359 验收构造；上限 500 条）。
fn foldable_journal(library: &Path, n: usize) {
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    let entries: Vec<Value> = (0..n)
        .map(|i| {
            let name = format!("assets/.trash/x-{i}");
            fs::write(library.join(&name), b"X").expect("写隔离项");
            let (dev, ino) = file_identity(&library.join(&name));
            journal_entry_json(
                &format!("x-{i}"),
                &format!("la-gone-{i}"),
                &format!("assets/la-{i}.png"),
                &name,
                dev,
                ino,
            )
        })
        .collect();
    write_journal_raw(library, json!(entries));
}

fn read_archive_raw(library: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(library.join(ARCHIVE_FILE_NAME)).expect("读归档"))
        .expect("归档 JSON")
}

/// issue #359 主证：500 条已完成条目一次恢复全部折叠退场——日志清空
/// （此后每次恢复的逐条核验成本与历史删除总量解耦），`cleanupPending`
/// 折叠为单条 routine 摘要（响应大小有界），隔离项文件全部原样保留
/// （折叠只退役日志条目，绝不按名删除隔离项）。
#[test]
fn recover_folds_bulk_verified_completed_entries() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 500);
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only);
    assert!(recovery.conflicted.is_empty());
    assert!(
        recovery.warnings.is_empty(),
        "折叠是常态收敛，不应告警：{:?}",
        recovery.warnings
    );
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "已完成条目应全部折叠退场"
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "cleanupPending 应折叠为单条摘要：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(recovery.cleanup_pending[0].kind, CleanupKind::Routine);
    assert!(
        recovery.cleanup_pending[0].message.contains("500"),
        "摘要应携带计数：{}",
        recovery.cleanup_pending[0].message
    );
    assert_eq!(
        read_archive_raw(&library)["retainedCleanupCount"],
        json!(500),
        "折叠计数应持久进归档"
    );
    for i in 0..500 {
        assert!(
            library.join(format!("assets/.trash/x-{i}")).exists(),
            "隔离项不得被按名删除（x-{i}）"
        );
    }
    // 第二次恢复：日志已空 → 无逐条核验；摘要来自持久归档计数，跨恢复稳定
    let repeated = recover(&cap(&library)).expect("再次恢复应成功");
    assert_eq!(read_journal_raw(&library), json!([]));
    assert_eq!(repeated.cleanup_pending.len(), 1, "摘要保持单条");
    assert_eq!(
        repeated.cleanup_pending[0].message, recovery.cleanup_pending[0].message,
        "归档计数驱动的摘要应跨恢复一致"
    );
    assert!(repeated.conflicted.is_empty());
    cleanup(&root);
}

/// 共享引用分支同样折叠：其他条目引用同一文件位置、原路径绑定预期
/// 身份、隔离项身份一致 → 折叠退场；共享媒体与隔离名都原样保留。
#[test]
fn recover_folds_verified_shared_reference_entry() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写共享媒体");
    // 原名与隔离名同时绑定预期身份（硬链接对偶），两条路径都指向同一 inode
    fs::hard_link(
        library.join("assets").join("la-1.png"),
        library.join("assets").join(".trash").join("t-x"),
    )
    .expect("建隔离名");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-2", "assets/la-1.png")]), "groups": by_id([]) }),
    );
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
    assert!(recovery.conflicted.is_empty());
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "共享分支已核验条目应折叠退场"
    );
    assert!(
        fs::read(library.join("assets").join("la-1.png")).expect("共享媒体") == b"PNG",
        "共享引用方的当前目录项不得被动"
    );
    assert!(
        library.join("assets").join(".trash").join("t-x").exists(),
        "隔离名保留现场"
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "折叠为单条摘要：{:?}",
        recovery.cleanup_pending
    );
    cleanup(&root);
}

/// 用户按指引整体清理 assets/.trash 后：归档计数归零、摘要消失。
#[test]
fn recover_resets_archive_count_after_trash_cleared() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 2);
    let folded = recover(&cap(&library)).expect("折叠应成功");
    assert_eq!(folded.cleanup_pending.len(), 1);
    fs::remove_dir_all(library.join("assets").join(".trash")).expect("整体清理隔离区");
    let after = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        after.cleanup_pending.is_empty(),
        "隔离区已整体清理，摘要应消失：{:?}",
        after.cleanup_pending
    );
    assert_eq!(
        read_archive_raw(&library)["retainedCleanupCount"],
        json!(0),
        "计数应归零落盘"
    );
    cleanup(&root);
}

/// 归档异型是咨询性脏数据：告警并按 0 继续（不放大为全局只读，威胁
/// 模型），本轮折叠照常发生并覆写修复归档。
#[test]
fn malformed_archive_is_advisory_and_repaired_by_next_fold() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::write(library.join(ARCHIVE_FILE_NAME), b"{not json").expect("写异型归档");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only, "归档异型不得阻断库写入");
    assert!(
        recovery.warnings.iter().any(|w| w.contains("清理归档计数")),
        "应携带归档告警：{:?}",
        recovery.warnings
    );
    assert_eq!(read_journal_raw(&library), json!([]), "折叠照常完成");
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "本轮计数为内存值 0+1：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(
        read_archive_raw(&library)["retainedCleanupCount"],
        json!(1),
        "折叠覆写应修复异型归档"
    );
    cleanup(&root);
}

/// 归档不可写（目录占位）时折叠仍完成：日志退役不因咨询性计数回滚，
/// 落盘失败只告警（fail-soft，不粉饰）。
#[test]
fn unwritable_archive_keeps_fold_fail_soft() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::create_dir_all(library.join(ARCHIVE_FILE_NAME)).expect("目录占位归档路径");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "日志退役不得因归档失败回滚"
    );
    assert!(
        recovery
            .warnings
            .iter()
            .any(|w| w.contains("清理归档计数落盘失败")),
        "应携带落盘失败告警：{:?}",
        recovery.warnings
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "本轮摘要按内存计数报告：{:?}",
        recovery.cleanup_pending
    );
    cleanup(&root);
}

/// 连续删除不积累日志：每次删除入口先恢复（折叠上一笔已完成条目），
/// 守卫读到的投影恒为个位数——真实可达删除次数内不会触达写拒绝或
/// 只读告警态（issue #359 验收：硬墙仅对崩溃窗口积压与证据条目保留）。
#[test]
fn repeated_deletes_keep_journal_bounded() {
    let (library, root) = temp_fixture();
    let ids = ["la-1", "la-2", "la-3"];
    for id in &ids {
        fs::write(library.join("assets").join(format!("{id}.png")), b"PNG").expect("写媒体");
    }
    write_index_raw(
        &library,
        &json!({ "assets": by_id(ids.iter().map(|id| entry(id, &format!("assets/{id}.png")))), "groups": by_id([]) }),
    );
    for id in &ids {
        delete_asset_transacted(&cap(&library), id, &mut |_| {})
            .unwrap_or_else(|e| panic!("删除 {id} 应成功：{e}"));
    }
    let final_recovery = recover(&cap(&library)).expect("收尾恢复应成功");
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "删除序列完成后日志应回到空"
    );
    assert_eq!(
        read_archive_raw(&library)["retainedCleanupCount"],
        json!(3),
        "三笔折叠计数累计"
    );
    assert_eq!(final_recovery.cleanup_pending.len(), 1);
    cleanup(&root);
}
