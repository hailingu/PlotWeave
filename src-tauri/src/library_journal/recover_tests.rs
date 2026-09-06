//! 库删除恢复回归测试（issue #25）：中断恢复四分支、冲突隔离、只读态、
//! 共享引用、硬链接残留、上限守卫。

use super::*;
use crate::library::put_asset_with;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

pub(crate) fn temp_fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-journal-test-{}", new_id()));
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
    (root.join("library"), root)
}

pub(crate) fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 最小合法索引条目（目标 Record 形状，含 §7.2 必填 source/ISO createdAt；
/// relPath 按需投毒）。
pub(crate) fn entry(id: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "other",
        "mime": "image/png",
        "relPath": rel,
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 把最小条目数组包装为目标 Record 形状（`{"byId": {id: entry}}`）。
pub(crate) fn by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}

pub(crate) fn write_index_raw(library: &Path, index: &Value) {
    fs::write(
        library.join("library.json"),
        serde_json::to_string(index).expect("序列化"),
    )
    .expect("写索引");
}

pub(crate) fn write_journal_raw(library: &Path, entries: Value) {
    fs::write(
        library.join(JOURNAL_FILE_NAME),
        serde_json::to_string(&entries).expect("序列化"),
    )
    .expect("写日志");
}

pub(crate) fn file_identity(p: &Path) -> (u64, u64) {
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

pub(crate) fn journal_entry_json(
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

pub(crate) fn read_journal_raw(library: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(library.join(JOURNAL_FILE_NAME)).expect("读回日志"))
        .expect("日志 JSON")
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
    let (index, warnings) = crate::library_fs::read_index_capped(&cap(&library)).expect("索引可读");
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
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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

/// 隔离项缺失但媒体回到原位（脏数据）：复查原路径身份后重新隔离
/// （评审修复：此前 Missing 直接清日志，遗漏该状态）。
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
    // 受支持平台均无身份绑定删除原语：按契约保留隔离项与日志并报告
    // cleanupPending（评审修复：Linux 分支伪装修复路径的断言残留）
    assert_eq!(
        read_journal_raw(&library).as_array().expect("日志").len(),
        1,
        "清理不可用应保留日志"
    );
    assert!(
        !recovery.cleanup_pending.is_empty(),
        "应报告 cleanupPending"
    );
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

/// 媒体字节内核（issue #26：opaque 协议按 id 解析，迁移自 media_path_with
/// 用例）：每次请求复核冲突状态，冲突解决后按当前索引读取媒体。
#[test]
fn media_bytes_rechecks_conflict_state_per_request() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"ORIGINAL",
    )
    .expect("写隔离项");
    fs::write(library.join("assets").join("la-1.png"), b"OCCUPIER").expect("后来文件");
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
    // 冲突期：拒绝服务（relPath 不再由前端传入，按 id 复核）
    let err = crate::library::open_media_with(&cap(&library), "la-1").expect_err("冲突期应拒绝");
    assert!(err.contains("冲突期"), "意外诊断：{err}");
    // 冲突解决后（移除日志）：按当前索引解析 id 读取媒体字节
    fs::remove_file(library.join(JOURNAL_FILE_NAME)).expect("移除日志");
    let (mime, file) =
        crate::library::open_media_with(&cap(&library), "la-1").expect("合法请求应成功");
    let (mime, bytes, _permit) =
        crate::library::read_media_capped("la-1", mime, file).expect("锁外读取应成功");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"OCCUPIER");
    cleanup(&root);
}

/// 活动索引边界拒保留隔离目录（评审修复）：relPath 指向 .trash 的条目
/// 在读取时隔离，不暴露为可用媒体、删除入口也不会把它当另一资产。
#[test]
fn index_entry_pointing_into_trash_is_quarantined() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(library.join("assets").join(".trash").join("t-x"), b"Q").expect("写隔离项");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/.trash/t-x")]), "groups": by_id([]) }),
    );
    let (index, warnings) = crate::library_fs::read_index_capped(&cap(&library)).expect("索引可读");
    assert_eq!(
        index["assets"]["byId"].as_object().map(Map::len),
        Some(0),
        "应被隔离"
    );
    assert!(!warnings.is_empty(), "应携带隔离警告：{warnings:?}");
    // 媒体读取同样拒绝：投毒条目在净化索引中不存在
    let err =
        crate::library::open_media_with(&cap(&library), "la-1").expect_err("保留目录词法应拒绝");
    assert!(err.contains("不存在"), "意外诊断：{err}");
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
    let err = delete_asset_transacted(&cap(&library), "la-1").expect_err("接近上限应拒绝新事务");
    assert!(err.contains("接近上限"), "意外诊断：{err}");
    // 索引未动：删除被拒绝且媒体原样
    assert!(fs::metadata(library.join("assets").join("la-1.png")).is_ok());
    cleanup(&root);
}

/// 重隔离的新映射先于 rename 落盘（评审修复）：恢复后日志 trashName 与
/// 隔离区实际文件一致，中断不会孤儿化新隔离项。
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
    // 日志 trashName 与隔离区实际文件一致
    let journal = read_journal_raw(&library);
    let arr = journal.as_array().expect("日志数组");
    assert_eq!(arr.len(), 1, "非清理平台保留一条日志");
    let recorded = arr[0]["trashName"].as_str().expect("trashName").to_string();
    let leaf = recorded.rsplit('/').next().expect("隔离名");
    assert!(
        fs::metadata(library.join("assets").join(".trash").join(leaf)).is_ok(),
        "日志记录的隔离名应指向实际文件：{recorded}"
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
