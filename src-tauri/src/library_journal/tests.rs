//! 删除事务与恢复内核回归测试（issue #25 验收：任一步骤中断按日志恢复
//! 一致、冲突期条目隔离、cleanupPending 可见、日志异型只读态）。
//! 平台注记：受支持平台均无身份绑定删除原语（评审修复：/proc/self/fd
//! unlink 返回 EPERM）——统一按契约保留隔离项 + cleanupPending。

use super::*;
use crate::library::put_asset_with;
use crate::library_fs::read_index_capped;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

fn new_id_for_test() -> String {
    new_id()
}

fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

/// 临时库夹具：{tmp}/pw-journal-test-<id>/library/{assets,.trash 可选}
fn temp_fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-journal-test-{}", new_id_for_test()));
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
    (root.join("library"), root)
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 写合法索引条目（id/relPath/mime 过净化白名单）。
fn entry(id: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "other",
        "mime": "image/png",
        "relPath": rel,
    })
}

fn write_index_raw(library: &Path, index: &Value) {
    fs::write(
        library.join("library.json"),
        serde_json::to_string(index).expect("序列化"),
    )
    .expect("写索引");
}

/// 直接落盘一条日志（含从磁盘文件读取的真实身份）。
fn write_journal_raw(library: &Path, entries: Value) {
    fs::write(
        library.join(JOURNAL_FILE_NAME),
        serde_json::to_string(&entries).expect("序列化"),
    )
    .expect("写日志");
}

fn file_identity(p: &Path) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(p).expect("读文件元数据");
        (m.dev(), m.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        (0, 0)
    }
}

/// 日志条目 JSON（从给定身份字段构造）。
fn journal_entry_json(
    id: &str,
    asset_id: &str,
    rel: &str,
    trash: &str,
    dev: u64,
    ino: u64,
) -> Value {
    json!({
        "id": id,
        "assetId": asset_id,
        "relPath": rel,
        "identity": { "dev": dev, "ino": ino },
        "trashName": trash,
    })
}

fn read_journal_raw(library: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(library.join(JOURNAL_FILE_NAME)).expect("读回日志"))
        .expect("日志 JSON")
}

// ---- 事务主体 ----

/// 删除提交去项索引并把媒体隔离进 .trash/：原路径清空；日志按平台能力
/// 收敛（Linux 清理完成移除日志项；其他平台保留 + cleanupPending）。
#[test]
fn delete_commits_index_and_quarantines_media() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    let out = delete_asset_transacted(&cap(&library), "la-1").expect("删除应成功");
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_err(),
        "原路径应清空"
    );
    let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
    assert!(!raw.contains("\"la-1\""), "索引应去项：{raw}");
    // 隔离区内容与原媒体一致
    let trash = library.join("assets").join(".trash");
    let quarantined: Vec<_> = fs::read_dir(&trash)
        .expect("读隔离目录")
        .map(|e| e.expect("目录项"))
        .collect();
    assert_eq!(quarantined.len(), 1, "媒体应隔离进 .trash");
    assert_eq!(
        fs::read(quarantined[0].path()).expect("读隔离项"),
        b"PNG",
        "隔离内容应与原媒体一致"
    );
    let raw_index = read_index_capped(&cap(&library)).expect("索引仍可读").0;
    // 平台能力差异：Linux 身份绑定清理完成移除日志项；其他平台保留现场
    if cfg!(target_os = "linux") {
        assert_eq!(
            read_journal_raw(&library),
            json!([]),
            "清理完成后日志应清空"
        );
        assert!(out["cleanupPending"]
            .as_array()
            .expect("pending")
            .is_empty());
    } else {
        let journal = read_journal_raw(&library);
        assert_eq!(
            journal.as_array().expect("日志数组").len(),
            1,
            "清理不可用应保留日志"
        );
        assert!(
            !out["cleanupPending"]
                .as_array()
                .expect("pending")
                .is_empty(),
            "保留现场应报告 cleanupPending"
        );
    }
    let _ = raw_index;
    cleanup(&root);
}

/// 中断恢复①：日志已写、隔离未发生（媒体仍在原位且身份一致）→ 清除
/// 未开始事务，索引与媒体原样。
#[test]
fn recover_clears_unstarted_transaction() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
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
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
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

/// 中断恢复③（冲突期）：索引仍含条目、隔离项身份一致、但原路径被后来
/// 文件占用 → 保留日志与隔离项，条目标记冲突不可用；后来文件不受影响。
#[test]
fn recover_marks_conflict_when_original_occupied() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"ORIGINAL",
    )
    .expect("写隔离项");
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("后来文件占用原路径");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
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
    assert_eq!(
        recovery.conflicted,
        vec!["la-1".to_string()],
        "应标记冲突不可用"
    );
    assert_eq!(
        read_journal_raw(&library).as_array().expect("日志").len(),
        1,
        "日志应保留"
    );
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("后来文件不得被覆盖"),
        b"OCCUPIER"
    );
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_ok(),
        "隔离项应保留"
    );
    // 列表侧：冲突条目标记 + 警告随索引返回
    let (index, warnings) = read_index_capped(&cap(&library)).expect("索引可读");
    assert!(warnings.is_empty());
    let _ = index;
    cleanup(&root);
}

/// 中断恢复④：索引已去项、隔离项不存在、原路径被后来文件占用 → 视为
/// 清理完成并清除日志（不得把后来文件当作原资产）。
#[test]
fn recover_clears_when_cleanup_already_complete() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("后来文件占用原路径");
    write_index_raw(&library, &json!({ "assets": [], "groups": [] }));
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

/// 冲突期条目不得为导入提供复制源（§7.2）。
#[test]
fn import_refuses_conflicted_asset() {
    let (library, root) = temp_fixture();
    let projects = root.join("projects");
    fs::create_dir_all(&projects).expect("建项目目录");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目控制文件");
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"ORIGINAL",
    )
    .expect("写隔离项");
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("后来文件");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
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
    let err =
        crate::assets::import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect_err("冲突期条目应拒绝导入");
    assert!(err.contains("冲突期"), "意外诊断：{err}");
    cleanup(&root);
}

/// 日志异型 → 只读告警态：库写入/删除全部暂停，不猜测路径。
#[test]
fn malformed_journal_blocks_library_writes() {
    let (library, root) = temp_fixture();
    fs::write(library.join(JOURNAL_FILE_NAME), b"{not json").expect("写异型日志");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "异型日志应进入只读告警态");
    assert!(
        recovery.warnings.iter().any(|w| w.contains("只读")),
        "应携带只读警告：{:?}",
        recovery.warnings
    );
    let err = delete_asset_transacted(&cap(&library), "la-1").expect_err("删除应被暂停");
    assert!(err.contains("暂停"), "意外诊断：{err}");
    let err = put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A")
        .expect_err("导入应被暂停");
    assert!(err.contains("暂停"), "意外诊断：{err}");
    cleanup(&root);
}

/// 日志路径越界（relPath 不在 assets/ 基准内）同样进入只读态。
#[test]
fn journal_entry_with_escaping_path_blocks_writes() {
    let (library, root) = temp_fixture();
    write_journal_raw(
        &library,
        json!([{
            "id": "t-1", "assetId": "la-1", "relPath": "settings.json",
            "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/t-x",
        }]),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "越界路径应只读告警态");
    cleanup(&root);
}

/// 重复 transaction id → 只读告警态。
#[test]
fn journal_with_duplicate_ids_blocks_writes() {
    let (library, root) = temp_fixture();
    let e = journal_entry_json("t-1", "la-1", "assets/la-1.png", "assets/.trash/t-a", 1, 1);
    write_journal_raw(&library, json!([e, e]));
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "重复 id 应只读告警态");
    cleanup(&root);
}

/// 共享引用恢复：其他条目已引用同一文件位置 → 不动原名，仅清理隔离项
/// （不可用平台保留 cleanupPending），日志随之收敛。
#[test]
fn recover_shared_reference_keeps_current_entry() {
    let (library, root) = temp_fixture();
    // la-1 删除中，但 la-2 仍引用同一文件位置（索引已含 la-2、不含 la-1）
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写共享媒体");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-2", "assets/la-1.png")], "groups": [] }),
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
    // 共享引用在位：媒体不得被移动或删除
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_ok(),
        "共享媒体不得被动"
    );
    // 无隔离目录（隔离项未生成）→ 日志清除
    assert_eq!(read_journal_raw(&library), json!([]));
    cleanup(&root);
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
    write_index_raw(&library, &json!({ "assets": [], "groups": [] }));
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
            .any(|p| p.contains("身份不符")),
        "应报告 cleanupPending：{:?}",
        recovery.cleanup_pending
    );
    assert!(
        fs::metadata(library.join("assets").join(".trash").join("t-x")).is_ok(),
        "占用者文件应保留现场"
    );
    cleanup(&root);
}

/// 日志 relPath 含 `..` 词法（评审修复）：进入只读态而非恢复整体失败。
#[test]
fn journal_entry_with_traversal_lexeme_blocks_writes() {
    let (library, root) = temp_fixture();
    write_journal_raw(
        &library,
        json!([{
            "id": "t-1", "assetId": "la-1", "relPath": "assets/../library.json",
            "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/t-x",
        }]),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "越界词法应只读告警态");
    cleanup(&root);
}

/// trashName 含嵌套子段（评审修复）：必须是 assets/.trash/ 单一子项。
#[test]
fn journal_entry_with_nested_trash_name_blocks_writes() {
    let (library, root) = temp_fixture();
    write_journal_raw(
        &library,
        json!([{
            "id": "t-1", "assetId": "la-1", "relPath": "assets/la-1.png",
            "identity": { "dev": 1, "ino": 1 }, "trashName": "assets/.trash/sub/t-x",
        }]),
    );
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "嵌套 trash 名应只读告警态");
    cleanup(&root);
}

/// 超限日志（评审修复）：受限读取在上限处截断后解析失败 → 只读态，
/// 不物化超大文件。
#[test]
fn oversized_journal_blocks_writes() {
    let (library, root) = temp_fixture();
    let pad = "a".repeat(crate::library_fs::INDEX_MAX_BYTES + 1);
    fs::write(library.join(JOURNAL_FILE_NAME), format!("[\"{pad}\"]")).expect("写超限日志");
    let recovery = recover(&cap(&library)).expect("恢复入口不失败");
    assert!(recovery.read_only, "超限日志应只读告警态");
    cleanup(&root);
}
