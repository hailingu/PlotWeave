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
        recovery.cleanup_pending[0].count,
        Some(500),
        "摘要应携带结构化计数（前端标题按 count 之和展示，评审 5342513010）"
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

/// 边界值自洽（评审 5346909203）：读取上限（u32::MAX）处的合法计数加
/// 一笔折叠，不得产出下次读取会判异型的值——累加结果钉在上限持续
/// 报告，而非归零使保留项失联。
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
        read_archive_raw(&library)["retainedCleanupCount"],
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

/// 归档计数脏值（u64::MAX）：累加不得 panic（debug 溢出）或回绕清零隐藏
/// 保留项——超过合理上限的计数按异型告警、按 0 重计，本轮折叠照常发生
/// 并覆写修复（评审 5346397307）。
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
        read_archive_raw(&library)["retainedCleanupCount"],
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

/// 重隔离折叠路径的写盘序（评审 5346397307）：①预 rename 映射落盘、
/// 收尾单次退役落盘、归档计数落盘——条目退役之后不得再存在重复的易
/// 失败写（第二次写失败会中断恢复，使已退役条目的折叠计数永不归档，
/// 保留项从此不可见）。以记录式故障注入统计 Rename 阶段数钉住该结构：
/// 本夹具恰为 3 次（映射 + 退役 + 归档）。
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
        renames, 3,
        "重隔离折叠路径应为 3 次原子写 rename：预 rename 映射 + 收尾退役 + 归档"
    );
    cleanup(&root);
}

/// 同趟恢复中「先折叠、后重隔离失败」的跨条目窗口（评审 5346509928）：
/// A 折叠后，B 的重隔离预 rename 映射写不得把 A 的退役持久化——B 的
/// rename 失败中断恢复后，A 仍须留在日志中供下次恢复重新折叠，计数不丢。
/// 以只读子目录让 B 的 rename 自然失败（日志中间写在 library/ 下不受影响，
/// 精确落在本评审描述的窗口）。
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
        read_archive_raw(&library)["retainedCleanupCount"],
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

/// issue #427 主证：折叠摘要携带隔离区**字节量级**——折叠归档移除日志
/// 闸门的间接背压后（issue #427 回归），`.trash` 合计大小以结构化 `bytes`
/// 与 message 量级同时进入诊断，隔离区无界增长在卷被填满前可见；统计是
/// 只读旁路，跨恢复稳定。
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
        read_archive_raw(&library)["trashBytes"],
        json!(400),
        "字节量级应与计数同源持久进归档（不做目录遍历，评审 5355629881）"
    );
    assert!(
        recovery.warnings.is_empty(),
        "字节统计是咨询性旁路，不得告警：{:?}",
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

/// 字节量级的累计口径（issue #427，评审 5355629881）：量级在折叠时从
/// 已核验的打开句柄累计并持久进归档，**不做任何目录遍历**——外来文件
/// （符号链接/子目录等非折叠项）从不计入，即使指向大文件也不膨胀量级；
/// 恢复成本不随历史删除数线性增长。
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

/// 旧格式归档缺 `trashBytes` 的兼容呈现（issue #427，评审 5355629881）：
/// 字节量级持久化落地前写入的归档只有计数——按「未知」呈现（不猜数、
/// 不为补数恢复目录遍历），不告警（告警会误停前端目录级清理指引）、
/// 不归零计数、不阻断恢复；下一次折叠覆写迁移并补全量级。
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

/// 归档 `trashBytes` 字段异型是咨询性脏数据：告警并按未知继续（不放大
/// 为全局只读，威胁模型），本轮折叠照常发生并覆写修复。
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
    assert_eq!(
        read_archive_raw(&library)["trashBytes"],
        json!(1),
        "本轮折叠应覆写修复异型字节数（0 + 1）"
    );
    assert_eq!(
        recovery.cleanup_pending[0].bytes,
        Some(1),
        "摘要按重计后的已知量级报告：{:?}",
        recovery.cleanup_pending[0]
    );
    cleanup(&root);
}

/// 字节量级与计数同源累计（issue #427）：每轮折叠把已核验隔离项的文件
/// 大小并入持久化量级，跨恢复累计、消息随现场增长更新——不依赖目录
/// 遍历（评审 5355629881）。
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
        write_journal_raw(&library, json!(entries));
    };
    round(&[(0, 100), (1, 50)]);
    let first = recover(&cap(&library)).expect("第一轮恢复应成功");
    assert_eq!(first.cleanup_pending[0].count, Some(2));
    assert_eq!(first.cleanup_pending[0].bytes, Some(150));
    assert_eq!(read_archive_raw(&library)["trashBytes"], json!(150));
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
    assert_eq!(read_archive_raw(&library)["trashBytes"], json!(400));
    assert!(
        second.cleanup_pending[0].message.contains("400 字节"),
        "消息随累计量级更新：{}",
        second.cleanup_pending[0].message
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
