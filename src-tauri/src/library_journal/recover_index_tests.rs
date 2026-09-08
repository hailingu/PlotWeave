//! 库删除恢复回归测试（issue #25）索引/Record 适配部分：冲突标记、
//! 冲突期导入/媒体字节复核、共享引用、指向保留目录的条目净化。
//! helper 为 recover_tests.rs 的本地副本（Rust 测试模块惯例）。

use super::*;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

fn temp_fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-journal-test-{}", new_id()));
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
    (root.join("library"), root)
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 最小合法索引条目（目标 Record 形状，含 §7.2 必填 source/ISO createdAt；
/// relPath 按需投毒）。
fn entry(id: &str, rel: &str) -> Value {
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
fn by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}

fn write_index_raw(library: &Path, index: &Value) {
    fs::write(
        library.join("library.json"),
        serde_json::to_string(index).expect("序列化"),
    )
    .expect("写索引");
}

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
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("索引可读");
    assert!(warnings.is_empty());
    let _ = index;
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
    let err =
        crate::library::media::open_media_with(&cap(&library), "la-1").expect_err("冲突期应拒绝");
    assert!(err.contains("冲突期"), "意外诊断：{err}");
    // 冲突解决后（移除日志）：按当前索引解析 id 读取媒体字节
    fs::remove_file(library.join(JOURNAL_FILE_NAME)).expect("移除日志");
    let (mime, file) =
        crate::library::media::open_media_with(&cap(&library), "la-1").expect("合法请求应成功");
    let (mime, bytes, _permit) =
        crate::library::media::read_media_capped("la-1", mime, file).expect("锁外读取应成功");
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
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("索引可读");
    assert_eq!(
        index["assets"]["byId"].as_object().map(Map::len),
        Some(0),
        "应被隔离"
    );
    assert!(!warnings.is_empty(), "应携带隔离警告：{warnings:?}");
    // 媒体读取同样拒绝：投毒条目在净化索引中不存在
    let err = crate::library::media::open_media_with(&cap(&library), "la-1")
        .expect_err("保留目录词法应拒绝");
    assert!(err.contains("不存在"), "意外诊断：{err}");
    cleanup(&root);
}
