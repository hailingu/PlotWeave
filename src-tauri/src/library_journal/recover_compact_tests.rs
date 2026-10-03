//! 删除日志折叠回归（issue #359、#421）：终态条目退役与计数/字节量级
//! 同文件提交，响应及恢复成本有界；整体清理归零，证据和非权威态不折叠。
//! 折叠场景复用 recover_tests，原始磁盘输入复用 crate::library_fixture。

use super::recover::CleanupKind;
use super::recover_tests::*;
use super::*;
use crate::library_fixture::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 读取对象日志内累计值，验证条目退役与计数/字节量级同文件提交。
fn read_totals_raw(library: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(library.join(JOURNAL_FILE_NAME)).expect("读日志"))
        .expect("日志 JSON")
}

/// issue #359 主证：500 条事务折叠成单条摘要、日志条目清空；
/// 隔离项原样保留，恢复及响应成本与历史删除数解耦。
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
        recovery.cleanup_pending[0].count,
        Some(500),
        "摘要应携带结构化计数（前端标题按 count 之和展示，评审 5342513010）"
    );
    assert_eq!(
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(500),
        "折叠计数应与日志条目同文件持久化"
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
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(0),
        "计数应归零落盘"
    );
    cleanup(&root);
}

/// 评审 5346909203：上限计数再折叠后仍可读取并持续报告，不回绕归零。
#[test]
fn archive_count_at_bound_stays_reportable_after_further_fold() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":4294967295}"#,
    )
    .expect("写读取上限处的合法计数");
    let first = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(read_journal_raw(&library), json!([]), "折叠照常完成");
    assert_eq!(
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(4294967295u64),
        "写入侧不得越出读取上限（自产值不得被自己判异型）"
    );
    assert_eq!(
        first.cleanup_pending[0].count,
        Some(4294967295),
        "摘要报告钉在上限的计数：{:?}",
        first.cleanup_pending
    );
    let second = recover(&cap(&library)).expect("再次恢复应成功");
    assert!(
        second
            .cleanup_pending
            .iter()
            .any(|p| p.kind == CleanupKind::Routine),
        "上限处的保留项不得在下次恢复归零失联：{:?}",
        second.cleanup_pending
    );
    assert!(
        !second.warnings.iter().any(|w| w.contains("清理归档计数")),
        "自产计数不得触发归档告警：{:?}",
        second.warnings
    );
    cleanup(&root);
}

/// 旧归档异型只告警并按 0 继续；本轮折叠将修复值迁移进新日志。
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
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(1),
        "新日志应持久化修复后的旧归档计数"
    );
    cleanup(&root);
}

/// 旧归档目录异型只作咨询性告警；迁移仍把折叠计数写入新日志。
#[test]
fn malformed_legacy_archive_does_not_block_journal_migration() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::create_dir_all(library.join(ARCHIVE_FILE_NAME)).expect("目录占位归档路径");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only, "咨询性旧归档异型不得进入日志只读态");
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "旧归档目录异型不得阻断日志退役"
    );
    assert!(
        recovery
            .warnings
            .iter()
            .any(|w| w.contains("清理归档计数是符号链接或非普通文件")),
        "应携带旧归档异型告警：{:?}",
        recovery.warnings
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "本轮摘要按新日志计数报告：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(read_totals_raw(&library)["retainedCleanupCount"], json!(1));
    let repeated = recover(&cap(&library)).expect("再次恢复应成功");
    assert!(repeated.warnings.is_empty(), "迁移后不再消费旧归档");
    assert_eq!(repeated.cleanup_pending[0].count, Some(1));
    cleanup(&root);
}

/// 评审 5346397307：超限旧计数告警后按 0 重计，不溢出或回绕隐藏保留项。
#[test]
fn absurd_archive_count_is_rejected_not_overflowed() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":18446744073709551615}"#,
    )
    .expect("写脏归档");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only, "脏计数不得阻断库写入");
    assert!(
        recovery.warnings.iter().any(|w| w.contains("清理归档计数")),
        "应携带归档告警：{:?}",
        recovery.warnings
    );
    assert_eq!(read_journal_raw(&library), json!([]), "折叠照常完成");
    assert_eq!(
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(1),
        "本轮折叠应覆写修复脏计数（0 + 1，不回绕）"
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "摘要按重计后的 1 报告：{:?}",
        recovery.cleanup_pending
    );
    assert!(
        recovery.cleanup_pending[0].message.contains("1 个"),
        "摘要计数不得回绕：{}",
        recovery.cleanup_pending[0].message
    );
    cleanup(&root);
}

/// 重隔离写盘序（issue #421）：预 rename 映射与联合收尾共两次原子写；
/// 退役和计数不得分别落盘。记录实际 Rename 阶段验证该协议。
#[cfg(unix)]
#[test]
fn requarantine_fold_writes_journal_once_after_retirement() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
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
    let injection = crate::store::atomic_write_faults::Injection::new(None, None);
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    let renames = injection
        .stages()
        .into_iter()
        .filter(|s| matches!(s, crate::store::atomic_write_faults::Stage::Rename))
        .count();
    drop(injection);
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "折叠应照常报告摘要：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(
        renames, 2,
        "重隔离折叠路径应为 2 次原子写 rename：预 rename 映射 + 退役/计数联合收尾"
    );
    cleanup(&root);
}

/// 评审 5346509928：后条目的重隔离 rename 失败，先折叠条目仍驻留日志。
/// 只读子目录只阻止媒体 rename，重试必须完整累计两条并保留隔离媒体。
#[cfg(unix)]
#[test]
fn earlier_fold_survives_later_requarantine_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join("sub")).expect("建子目录");
    // A：媒体在原位（committed + 隔离项缺失 → 重隔离 → 折叠）
    fs::write(library.join("assets").join("la-a.png"), b"A").expect("写 A 媒体");
    // B：媒体在原位但父目录将被去写权限（重隔离的 rename 失败）
    fs::write(library.join("assets").join("sub").join("la-b.png"), b"B").expect("写 B 媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    let (adev, aino) = file_identity(&library.join("assets").join("la-a.png"));
    let (bdev, bino) = file_identity(&library.join("assets").join("sub").join("la-b.png"));
    write_journal_raw(
        &library,
        json!([
            journal_entry_json(
                "t-a",
                "la-a",
                "assets/la-a.png",
                "assets/.trash/t-a",
                adev,
                aino
            ),
            journal_entry_json(
                "t-b",
                "la-b",
                "assets/sub/la-b.png",
                "assets/.trash/t-b",
                bdev,
                bino
            ),
        ]),
    );
    fs::set_permissions(
        library.join("assets").join("sub"),
        fs::Permissions::from_mode(0o500),
    )
    .expect("子目录去写权限");
    let err = recover(&cap(&library)).expect_err("B 的重隔离 rename 应失败");
    assert!(err.to_string().contains("重隔离失败"), "意外诊断：{err}");
    // 关键判别：A 的条目不得被 B 的中间写从日志冲掉
    let mid = read_journal_raw(&library);
    assert!(
        mid.to_string().contains("la-a"),
        "先前折叠条目的退役不得被中途写持久化：{mid}"
    );
    // 恢复写权限后重试：两笔都折叠收敛，隔离项与计数都不丢
    fs::set_permissions(
        library.join("assets").join("sub"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("恢复子目录写权限");
    let recovery = recover(&cap(&library)).expect("重试恢复应成功");
    assert_eq!(read_journal_raw(&library), json!([]), "两笔均应折叠退场");
    assert_eq!(
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(2),
        "两笔折叠计数都不丢"
    );
    assert_eq!(recovery.cleanup_pending.len(), 1);
    assert_eq!(
        recovery.cleanup_pending[0].count,
        Some(2),
        "摘要结构化计数应为 2：{:?}",
        recovery.cleanup_pending
    );
    let trash_files: Vec<_> = fs::read_dir(library.join("assets").join(".trash"))
        .expect("读隔离目录")
        .map(|e| e.expect("目录项"))
        .collect();
    assert_eq!(trash_files.len(), 2, "A 与 B 的隔离项都应保留");
    cleanup(&root);
}

/// issue #427 主证：摘要在结构化 bytes 与消息中报告字节量级；
/// 计数和量级同源持久进日志，跨恢复稳定且不改动隔离媒体。
#[test]
fn folded_summary_carries_trash_byte_magnitude() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    // 三个已完成条目，隔离文件大小分别为 100/250/50 字节（合计 400）
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    let entries: Vec<Value> = [100usize, 250, 50]
        .into_iter()
        .enumerate()
        .map(|(i, size)| {
            let name = format!("assets/.trash/x-{i}");
            fs::write(library.join(&name), vec![b'X'; size]).expect("写隔离项");
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
    write_journal_raw(&library, json!(entries));
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(recovery.cleanup_pending.len(), 1);
    assert_eq!(recovery.cleanup_pending[0].count, Some(3));
    assert_eq!(
        recovery.cleanup_pending[0].bytes,
        Some(400),
        "摘要应携带隔离区合计字节（结构化，issue #427）"
    );
    assert!(
        recovery.cleanup_pending[0].message.contains("400 字节"),
        "message 应携带字节量级：{}",
        recovery.cleanup_pending[0].message
    );
    assert_eq!(
        read_totals_raw(&library)["trashBytes"],
        json!(400),
        "字节量级应与计数同源持久进日志（不做目录遍历，评审 5355629881）"
    );
    assert!(
        recovery.warnings.is_empty(),
        "合法咨询性字节数不得告警：{:?}",
        recovery.warnings
    );
    // 累计零副作用：隔离项原样保留（不按名删除、不动字节）
    for i in 0..3 {
        assert!(
            library.join(format!("assets/.trash/x-{i}")).exists(),
            "隔离项不得被统计改动（x-{i}）"
        );
    }
    // 跨恢复稳定：持久化的计数与量级跨恢复一致（无需再次扫描现场）
    let repeated = recover(&cap(&library)).expect("再次恢复应成功");
    assert_eq!(
        repeated.cleanup_pending[0].message, recovery.cleanup_pending[0].message,
        "量级随归档计数同源，跨恢复一致"
    );
    assert_eq!(repeated.cleanup_pending[0].bytes, Some(400));
    cleanup(&root);
}

/// issue #427、评审 5355629881：只累计已核验句柄字节，不遍历隔离区；
/// 外来符号链接/子目录不膨胀量级，恢复成本不随历史删除数增长。
#[cfg(unix)]
#[test]
fn foreign_trash_entries_do_not_inflate_byte_magnitude() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    // 唯一计入项：120 字节普通文件（带已完成日志条目，身份与磁盘一致）
    fs::write(library.join("assets/.trash/x-0"), vec![b'X'; 120]).expect("写隔离项");
    let (dev, ino) = file_identity(&library.join("assets/.trash/x-0"));
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "x-0",
            "la-gone-0",
            "assets/la-0.png",
            "assets/.trash/x-0",
            dev,
            ino
        )]),
    );
    // 干扰项：指向 2 MiB 外部文件的符号链接；含 80 字节文件的子目录
    let big = library.join("big-outside.bin");
    fs::write(&big, vec![b'B'; 2 * 1024 * 1024]).expect("写外部大文件");
    std::os::unix::fs::symlink(&big, library.join("assets/.trash/link-out"))
        .expect("建干扰符号链接");
    fs::create_dir_all(library.join("assets/.trash/sub")).expect("建干扰子目录");
    fs::write(library.join("assets/.trash/sub/inner"), vec![b'S'; 80]).expect("写子目录文件");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(
        recovery.cleanup_pending[0].bytes,
        Some(120),
        "只累计已核验折叠项的文件大小，外来文件从不计入：{:?}",
        recovery.cleanup_pending[0]
    );
    assert!(
        recovery.warnings.is_empty(),
        "干扰项只影响统计口径，不得告警：{:?}",
        recovery.warnings
    );
    cleanup(&root);
}

/// issue #427、评审 5355629881：旧归档缺字节数时保持未知、不告警；
/// 迁移不能遍历补数、归零历史计数或阻断恢复。
#[test]
fn legacy_archive_without_bytes_reports_unknown_magnitude() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets/.trash/x-0"), b"X").expect("写隔离项");
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":1}"#,
    )
    .expect("写旧格式归档计数");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only, "兼容呈现不得阻断恢复");
    assert!(
        recovery.warnings.is_empty(),
        "旧格式不是脏数据，不得告警（会误停前端清理指引）：{:?}",
        recovery.warnings
    );
    assert_eq!(
        recovery.cleanup_pending.len(),
        1,
        "摘要仍按归档计数出现：{:?}",
        recovery.cleanup_pending
    );
    assert_eq!(recovery.cleanup_pending[0].count, Some(1));
    assert_eq!(
        recovery.cleanup_pending[0].bytes, None,
        "缺失的量级按未知呈现，不猜数、不遍历补数"
    );
    assert!(
        recovery.cleanup_pending[0].message.contains("大小未知"),
        "message 应明示量级未知而非静默缺省：{}",
        recovery.cleanup_pending[0].message
    );
    cleanup(&root);
}

/// 旧归档字节字段异型只告警、保持未知；折叠把修复值迁移进新日志。
#[test]
fn invalid_trash_bytes_field_is_advisory() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    foldable_journal(&library, 1);
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":2,"trashBytes":"big"}"#,
    )
    .expect("写异型字节数归档");
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(!recovery.read_only, "异型字节数不得阻断库写入");
    assert!(
        recovery
            .warnings
            .iter()
            .any(|w| w.contains("清理归档字节数异型")),
        "应携带字节数异型告警：{:?}",
        recovery.warnings
    );
    assert_eq!(read_journal_raw(&library), json!([]), "折叠照常完成");
    // 评审 5355849137：计数 2 的历史份额不可知，折叠不得把总量重新标注为
    // 仅新增字节——脏值按未知重计并跨折叠保持，覆写后字段缺省（非脏值）
    assert_eq!(
        read_totals_raw(&library).get("trashBytes"),
        None,
        "覆写应清除异型字节数（按未知缺省，而非伪已知）：{}",
        read_totals_raw(&library)
    );
    assert_eq!(
        recovery.cleanup_pending[0].count,
        Some(3),
        "计数照常累计（2 + 1）：{:?}",
        recovery.cleanup_pending[0]
    );
    assert_eq!(
        recovery.cleanup_pending[0].bytes, None,
        "历史份额未知的总量保持未知，不猜数"
    );
    assert!(
        recovery.cleanup_pending[0].message.contains("大小未知"),
        "message 应明示量级未知：{}",
        recovery.cleanup_pending[0].message
    );
    cleanup(&root);
}

/// 评审 5355849137：历史字节未知跨迁移、折叠保持，不伪报为仅新增字节；
/// 整体清理归零后重新可知，计数始终照常累计。
#[test]
fn legacy_archive_keeps_unknown_bytes_until_trash_cleared() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    // 升级前已累计 2500 项（历史字节不可知）
    foldable_journal(&library, 1);
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":2500}"#,
    )
    .expect("写旧格式归档");
    let folded = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(folded.cleanup_pending[0].count, Some(2501));
    assert_eq!(
        folded.cleanup_pending[0].bytes, None,
        "未知的历史份额不得被仅新增字节改写为已知"
    );
    assert!(folded.cleanup_pending[0].message.contains("大小未知"));
    let archived = read_totals_raw(&library);
    assert_eq!(archived["retainedCleanupCount"], json!(2501));
    assert_eq!(
        archived.get("trashBytes"),
        None,
        "归档不得持久化伪已知量级：{archived}"
    );
    // 再折叠一笔：未知保持，不得随时间「自愈」为部分值
    foldable_journal(&library, 1);
    let again = recover(&cap(&library)).expect("再次恢复应成功");
    assert_eq!(again.cleanup_pending[0].count, Some(2502));
    assert_eq!(again.cleanup_pending[0].bytes, None);
    // 用户整体清理后归零重置为已知，此后折叠从零累计
    fs::remove_dir_all(library.join("assets").join(".trash")).expect("整体清理隔离区");
    let zeroed = recover(&cap(&library)).expect("归零恢复应成功");
    assert!(zeroed.cleanup_pending.is_empty(), "计数归零、摘要消失");
    assert_eq!(
        read_totals_raw(&library)["trashBytes"],
        json!(0),
        "归零把量级重置为已知 0"
    );
    foldable_journal(&library, 1);
    let fresh = recover(&cap(&library)).expect("清理后折叠应成功");
    assert_eq!(
        fresh.cleanup_pending[0].bytes,
        Some(1),
        "整体清理后的折叠从零重新可知：{:?}",
        fresh.cleanup_pending[0]
    );
    cleanup(&root);
}

/// issue #427、评审 5355629881：两轮折叠同源累计计数与字节，
/// 消息随量级增长更新，不遍历历史隔离项。
#[test]
fn fold_accumulates_byte_magnitude_across_recoveries() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    // 第一轮：两个已完成条目（100 + 50 字节）
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    let round = |names: &[(usize, usize)]| {
        let entries: Vec<Value> = names
            .iter()
            .map(|&(i, size)| {
                let name = format!("assets/.trash/x-{i}");
                fs::write(library.join(&name), vec![b'X'; size]).expect("写隔离项");
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
        replace_journal_entries(&library, json!(entries));
    };
    round(&[(0, 100), (1, 50)]);
    let first = recover(&cap(&library)).expect("第一轮恢复应成功");
    assert_eq!(first.cleanup_pending[0].count, Some(2));
    assert_eq!(first.cleanup_pending[0].bytes, Some(150));
    assert_eq!(read_totals_raw(&library)["trashBytes"], json!(150));
    // 第二轮：新增一个 250 字节已完成条目
    round(&[(2, 250)]);
    let second = recover(&cap(&library)).expect("第二轮恢复应成功");
    assert_eq!(second.cleanup_pending[0].count, Some(3));
    assert_eq!(
        second.cleanup_pending[0].bytes,
        Some(400),
        "量级应跨恢复累计（150 + 250）：{:?}",
        second.cleanup_pending[0]
    );
    assert_eq!(read_totals_raw(&library)["trashBytes"], json!(400));
    assert!(
        second.cleanup_pending[0].message.contains("400 字节"),
        "消息随累计量级更新：{}",
        second.cleanup_pending[0].message
    );
    cleanup(&root);
}

/// issue #359：连续删除先恢复上一笔，条目投影有界、计数持续累计；
/// 大小守卫仅对崩溃积压与证据条目保留。
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
        read_totals_raw(&library)["retainedCleanupCount"],
        json!(3),
        "三笔折叠计数累计"
    );
    assert_eq!(final_recovery.cleanup_pending.len(), 1);
    cleanup(&root);
}
