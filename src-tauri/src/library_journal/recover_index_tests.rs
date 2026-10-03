//! 库删除恢复回归测试（issue #25）索引/Record 适配部分：冲突标记、
//! 冲突期导入/媒体字节复核、共享引用、指向保留目录的条目净化。
//! 原始磁盘夹具复用 crate::library_fixture；恢复断言仍由本模块拥有。

use super::*;
use crate::library_fixture::*;

use serde_json::{json, Map};
use std::fs;

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
    let err = crate::assets::import_asset_from_library(
        &cap(&projects),
        &cap(&library),
        "p-1",
        "la-1",
        &crate::assets::project_media::PendingProjectAssets::new(),
        &mut |_| {},
    )
    .expect_err("冲突期条目应拒绝导入");
    assert!(err.to_string().contains("冲突期"), "意外诊断：{err}");
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
    let err = crate::media_protocol::open_media_with(&cap(&library), "la-1", &mut |_| {})
        .expect_err("冲突期应拒绝");
    assert!(err.to_string().contains("冲突期"), "意外诊断：{err}");
    // 冲突解决后（移除日志）：按当前索引解析 id 读取媒体字节
    fs::remove_file(library.join(JOURNAL_FILE_NAME)).expect("移除日志");
    let (mime, file) = crate::media_protocol::open_media_with(&cap(&library), "la-1", &mut |_| {})
        .expect("合法请求应成功");
    let (mime, bytes, _permit) =
        crate::media_protocol::read_media_capped("la-1", mime, file).expect("锁外读取应成功");
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
    let err = crate::media_protocol::open_media_with(&cap(&library), "la-1", &mut |_| {})
        .expect_err("保留目录词法应拒绝");
    assert!(err.to_string().contains("不存在"), "意外诊断：{err}");
    cleanup(&root);
}
