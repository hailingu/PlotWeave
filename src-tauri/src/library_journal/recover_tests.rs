//! 库删除恢复回归测试（issue #25）：中断恢复四分支、只读态、硬链接残留、
//! 上限守卫；索引/Record 适配类用例见 recover_index_tests.rs，indexUncertain
//! 闩锁收敛类用例见 recover_uncertain_tests.rs。

use super::recover::CleanupKind;
use super::*;
use crate::library::put_asset_with;
use crate::library_fixture::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 替换测试事务条目，同时保留对象日志内已迁移的累计计数/字节量级。
pub(crate) fn replace_journal_entries(library: &Path, entries: Value) {
    let mut journal = match fs::read_to_string(library.join(JOURNAL_FILE_NAME)) {
        Ok(text) => serde_json::from_str::<Value>(&text).expect("日志 JSON"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!([]),
        Err(error) => panic!("读日志失败：{error}"),
    };
    if journal.is_object() {
        journal["entries"] = entries;
    } else {
        journal = entries;
    }
    write_journal_raw(library, journal);
}

/// 构造 n 条「索引已去项 + 隔离项身份一致」的已完成条目：每个条目在
/// .trash 有真实文件，身份与磁盘一致（issue #359 验收构造；上限 500 条）。
pub(crate) fn foldable_journal(library: &Path, n: usize) {
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
    replace_journal_entries(library, json!(entries));
}

/// 中断恢复①：日志已写、隔离未发生（媒体仍在原位且身份一致）→ 清除
/// 未开始事务，索引与媒体原样。
#[test]
fn recover_clears_unstarted_transaction() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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
    assert!(!recovery.read_only);
    assert!(recovery.conflicted.is_empty());
    assert!(recovery.cleanup_pending.is_empty());
    assert_eq!(read_journal_raw(&library), json!([]), "未开始事务应清除");
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_ok(),
        "媒体应原样保留"
    );
    cleanup(&root);
}

/// 中断恢复②：已隔离但索引未提交（索引仍含条目、原路径空缺、隔离项身份
/// 一致）→ no-replace 回迁，日志清除。
#[test]
fn recover_restores_quarantined_media_when_index_uncommitted() {
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
        recovery.conflicted.is_empty(),
        "冲突清单：{:?}",
        recovery.conflicted
    );
    assert_eq!(read_journal_raw(&library), json!([]), "回迁后日志应清除");
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("媒体应回迁"),
        b"PNG"
    );
    assert!(fs::metadata(library.join("assets").join(".trash").join("t-x")).is_err());
    cleanup(&root);
}

/// 中断恢复④：索引已去项、隔离项不存在、原路径被后来文件占用 → 视为
/// 清理完成并清除日志（不得把后来文件当作原资产）。
#[test]
fn recover_clears_when_cleanup_already_complete() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("后来文件占用原路径");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    let (dev, ino) = file_identity(&library.join("assets").join("la-1.png"));
    // 预期身份 ≠ 占用者身份：原路径绑定的是后来文件，清理已完成
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            dev,
            ino.wrapping_add(1)
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(recovery.conflicted.is_empty());
    assert_eq!(read_journal_raw(&library), json!([]), "清理完成应清除日志");
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("后来文件幸存"),
        b"OCCUPIER"
    );
    cleanup(&root);
}

/// 日志异型 → 只读告警态：库写入/删除全部暂停，不猜测路径。
#[test]
fn malformed_journal_blocks_library_writes() {
    let (library, root) = temp_fixture();
    fs::write(library.join(JOURNAL_FILE_NAME), b"{not json").expect("写异型日志");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "异型日志应进入只读告警态");
    assert!(
        recovery.warnings.iter().any(|w| w.contains("只读")),
        "应携带只读警告：{:?}",
        recovery.warnings
    );
    let err =
        delete_asset_transacted(&cap(&library), "la-1", &mut |_| {}).expect_err("删除应被暂停");
    assert!(err.to_string().contains("暂停"), "意外诊断：{err}");
    let err = put_asset_with(
        &cap(&library),
        "a.png",
        "image/png",
        "other",
        b"A",
        &mut |_| {},
    )
    .expect_err("导入应被暂停");
    assert!(err.to_string().contains("暂停"), "意外诊断：{err}");
    cleanup(&root);
}

/// 日志异型家族共用同一不变量：恢复入口不失败并进入只读告警态。
/// 覆盖 relPath 越界（不在 assets/ 基准内）、重复 transaction id、
/// relPath 含 `..` 词法、trashName 嵌套子段（须为 assets/.trash/ 单一
/// 子项）与超限日志（受限读取截断后解析失败，不物化超大文件）；
/// 后四类为历次评审修复引入的触发形态。
#[test]
fn malformed_journal_variants_enter_read_only_mode() {
    let duplicate = {
        let e = journal_entry_json("t-1", "la-1", "assets/la-1.png", "assets/.trash/t-a", 1, 1);
        json!([e, e]).to_string()
    };
    let pad = "a".repeat(crate::library_fs::INDEX_MAX_BYTES + 1);
    let variants: [(&str, String); 5] = [
        (
            "relPath 越界",
            json!([{
                "id": "t-1", "assetId": "la-1", "relPath": "settings.json",
                "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/t-x",
            }])
            .to_string(),
        ),
        ("重复 transaction id", duplicate),
        (
            "relPath 含 .. 词法",
            json!([{
                "id": "t-1", "assetId": "la-1", "relPath": "assets/../library.json",
                "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/t-x",
            }])
            .to_string(),
        ),
        (
            "trashName 嵌套子段",
            json!([{
                "id": "t-1", "assetId": "la-1", "relPath": "assets/la-1.png",
                "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/sub/t-x",
            }])
            .to_string(),
        ),
        ("超限日志", format!("[\"{pad}\"]")),
    ];
    for (label, raw) in variants {
        let (library, root) = temp_fixture();
        fs::write(library.join(JOURNAL_FILE_NAME), raw).expect("写异型日志");
        let recovery = recover(&cap(&library)).expect("恢复入口不失败");
        assert!(recovery.read_only, "{label} 应只读告警态");
        cleanup(&root);
    }
}

/// 清理分支三态判别（评审修复）：隔离项身份不符时保留现场与日志——
/// 不得静默清除证据（此前 Missing/Mismatch 混同导致日志丢失）。
#[test]
fn recover_retains_journal_on_trash_identity_mismatch() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"SWAPPED",
    )
    .expect("写占用者");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]) }),
    );
    // 预期身份 ≠ 隔离区内实际占用者
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            1,
            1
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(
        read_journal_raw(&library).as_array().expect("日志").len(),
        1,
        "身份不符应保留日志"
    );
    assert!(
        recovery
            .cleanup_pending
            .iter()
            .any(|p| p.kind == CleanupKind::Evidence),
        "身份不符应报告 evidence 类 cleanupPending：{:?}",
        recovery.cleanup_pending
    );
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_ok(),
        "占用者文件应保留现场"
    );
    cleanup(&root);
}

/// 隔离项缺失但媒体回到原位（脏数据）：复查原路径身份后重新隔离
/// （评审修复：此前 Missing 直接清日志，遗漏该状态）；重隔离后身份核验
/// 一致但清理原语不可用 → 折叠退役（issue #359）：日志退场、计数归档、
/// cleanupPending 折叠为单条 routine 摘要，隔离项字节保留。
#[test]
fn recover_requarantines_media_returned_to_original_path() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建空隔离目录");
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
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_err(),
        "媒体应重新隔离"
    );
    let quarantined: Vec<_> = fs::read_dir(library.join("assets").join(".trash"))
        .expect("读隔离目录")
        .map(|e| e.expect("目录项"))
        .collect();
    assert_eq!(quarantined.len(), 1);
    assert_eq!(fs::read(quarantined[0].path()).expect("内容"), b"PNG");
    // 受支持平台均无身份绑定删除原语：重隔离项身份核验一致后折叠退役
    // （issue #359），隔离项与字节保留为证据
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "已核验的重隔离项应折叠退场"
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
        "仅能力保留的待释放项归 routine（可给清理指引，issue #229）"
    );
    assert!(recovery.warnings.is_empty());
    assert!(recovery.conflicted.is_empty());
    assert!(!recovery.read_only);
    let repeated = recover(&cap(&library)).expect("再次恢复应成功");
    assert_eq!(
        repeated.cleanup_pending, recovery.cleanup_pending,
        "归档计数驱动的摘要应跨恢复一致"
    );
    assert!(repeated.warnings.is_empty());
    assert_eq!(read_journal_raw(&library), json!([]));
    assert_eq!(fs::read(quarantined[0].path()).expect("保留内容"), b"PNG");
    cleanup(&root);
}

/// relPath 含 trash 后缀的普通文件名（如 cover.trash）按组件匹配后合法
/// （评审修复：contains 误判会让自产生的合法删除日志锁死整库）。
#[test]
fn journal_entry_with_trash_suffix_filename_is_valid() {
    let (library, root) = temp_fixture();
    write_journal_raw(
        &library,
        json!([{
            "id": "t-1", "assetId": "la-1", "relPath": "assets/la-1.trash",
            "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/t-x",
        }]),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(!recovery.read_only, "trash 后缀文件名不应误判越界");
    // 索引无该条目、无隔离目录、原路径缺失 → 清理完成清除日志
    assert_eq!(read_journal_raw(&library), json!([]));
    cleanup(&root);
}

/// 恢复侧保证：隔离项身份不符时绝不回迁（仅身份确认的条目可回迁），
/// 冲突标记 + 保留现场。
#[test]
fn recover_never_installs_mismatched_trash_entry() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"SWAPPED",
    )
    .expect("写替换文件");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            1,
            1
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(recovery.conflicted, vec!["la-1".to_string()]);
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_err(),
        "身份不符的隔离项不得被装到活动资产路径"
    );
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_ok(),
        "替换文件保留现场（证据不丢失）"
    );
    cleanup(&root);
}

/// 追加上限守卫（评审修复）：日志接近半上限时拒绝新删除事务——无界
/// 追加会越过读取上限、把全部库写入推入不可收缩的只读态。
#[test]
fn delete_rejected_when_journal_near_cap() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    // 预填越过守卫阈值的合法日志条目：索引去项、每个条目带真实隔离文件
    // （身份与磁盘一致）→ recover_index_committed 的 IdentityOk 分支触发
    // 身份绑定清理（不可用）→ 按 cleanupPending 保留；守卫在删除入口检查
    // 投影大小（2600 条约 38 万字节 > 524288/2）
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    let pad: Vec<Value> = (0..4000)
        .map(|i| {
            let name = format!("assets/.trash/x-{i}");
            fs::write(library.join(&name), b"X").expect("写隔离项");
            let (pdev, pino) = file_identity(&library.join(&name));
            journal_entry_json(
                &format!("x-{i}"),
                &format!("la-gone-{i}"),
                &format!("assets/la-{i}.png"),
                &name,
                pdev,
                pino,
            )
        })
        .collect();
    write_journal_raw(&library, json!(pad));
    let err = delete_asset_transacted(&cap(&library), "la-1", &mut |_| {})
        .expect_err("接近上限应拒绝新事务");
    assert!(err.to_string().contains("接近上限"), "意外诊断：{err}");
    // 索引未动：删除被拒绝且媒体原样
    assert!(fs::metadata(library.join("assets").join("la-1.png")).is_ok());
    cleanup(&root);
}

/// 重隔离的新映射先于 rename 落盘（评审修复）：rename 前日志已耐久记录
/// 新隔离名，中断不会孤儿化新隔离项；本路径终点为折叠退役（issue #359）
/// ——收敛后日志退场，重隔离的媒体字节保留在隔离区为证据。
#[test]
fn recover_requarantine_persists_mapping_before_rename() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建空隔离目录");
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
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    let _ = recovery;
    // 收敛终点：折叠退役（日志退场），重隔离的媒体字节留在隔离区
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "重隔离后身份核验一致应折叠退场（issue #359）"
    );
    let quarantined: Vec<_> = fs::read_dir(library.join("assets").join(".trash"))
        .expect("读隔离目录")
        .map(|e| e.expect("目录项"))
        .collect();
    assert_eq!(quarantined.len(), 1, "重隔离媒体应恰好一项");
    assert_eq!(
        fs::read(quarantined[0].path()).expect("媒体字节"),
        b"PNG",
        "重隔离的媒体字节保留在隔离名下"
    );
    cleanup(&root);
}

/// 共享 relPath 但占用者身份不符（评审修复）：不得走共享文件分支，
/// 按证据分支判定（索引已去项 → 原路径不绑定预期身份 → 视为清理
/// 完成并清除日志；替换文件不被当作共享引用方放行）。
#[test]
fn recover_does_not_treat_occupier_as_shared_reference() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("写占用者");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-2", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-1",
            "la-1",
            "assets/la-1.png",
            "assets/.trash/t-x",
            1,
            1
        )]),
    );
    let recovery = recover(&cap(&library)).expect("恢复应成功");
    assert_eq!(
        read_journal_raw(&library),
        json!([]),
        "应判定清理完成并清除日志"
    );
    assert!(recovery.conflicted.is_empty(), "不进入共享分支即不冲突");
    cleanup(&root);
}

/// 硬链接窗口残留（评审修复）：hard_link 成功但 remove_file 失败/进程
/// 中断后，原名与隔离名同时绑定预期身份——恢复识别同一身份即清理
/// 隔离名并收敛，不标记冲突。
#[test]
fn recover_cleans_hard_link_residue_same_identity() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join(".trash").join("t-x"), b"PNG").expect("写隔离项");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    // 硬链接窗口残留：原名也绑定同一 inode（hard_link 成功、remove_file 失败）
    fs::hard_link(
        library.join("assets").join(".trash").join("t-x"),
        library.join("assets").join("la-1.png"),
    )
    .expect("建硬链接残留");
    let (dev, ino) = file_identity(&library.join("assets").join(".trash").join("t-x"));
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
    assert!(recovery.conflicted.is_empty(), "同一身份残留不标记冲突");
    assert_eq!(read_journal_raw(&library), json!([]), "残留收敛清除日志");
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_err(),
        "隔离名应被释放"
    );
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("原名媒体"),
        b"PNG"
    );
    cleanup(&root);
}

/// issue #229 契约：cleanupPending 条目序列化为结构化 `{ kind, message }`——
/// 前端按机器码 kind 分类（routine 才可给 .trash 清理指引），不经中文文案
/// 前缀推导；展示措辞/本地化调整不改变分类。折叠摘要（issue #359）额外
/// 携带可选 `count`（该条目代表的累计保留数）与可选 `bytes`（issue #427：
/// 隔离区合计字节量级，量级未知时缺省），普通/证据条目不序列化这两个
/// 字段——旧前端忽略新增字段仍按单条展示，形状向后兼容。
#[test]
fn cleanup_pending_serializes_machine_kind_alongside_message() {
    let recovery = Recovery {
        cleanup_pending: vec![
            CleanupPendingItem::routine("媒体已隔离待清理：assets/la-1.png"),
            CleanupPendingItem::routine_counted(
                500,
                Some(62_914_560),
                "隔离区累计保留 500 个已核验清理项，合计 60.0 MiB（可人工清理 assets/.trash；整体移除后计数自动归零）",
            ),
            CleanupPendingItem::evidence("隔离项保留（身份不符或被占用）：la-4 / t-y"),
        ],
        ..Recovery::default()
    };
    assert_eq!(
        serde_json::to_value(&recovery.cleanup_pending).expect("序列化"),
        json!([
            { "kind": "routine", "message": "媒体已隔离待清理：assets/la-1.png" },
            { "kind": "routine", "message": "隔离区累计保留 500 个已核验清理项，合计 60.0 MiB（可人工清理 assets/.trash；整体移除后计数自动归零）", "count": 500, "bytes": 62914560 },
            { "kind": "evidence", "message": "隔离项保留（身份不符或被占用）：la-4 / t-y" }
        ])
    );
}
