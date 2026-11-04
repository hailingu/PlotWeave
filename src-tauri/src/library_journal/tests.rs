//! 库删除事务回归测试（issue #25）：事务四步、平台能力分支的 cleanupPending/日志收敛。

use super::*;
use crate::library::error::LibraryError;
use crate::library_fixture::*;
use serde_json::json;
use std::fs;

/// 删除提交去项索引并把媒体隔离进 .trash/：原路径清空；日志按平台能力
/// 收敛（Linux 清理完成移除日志项；其他平台保留 + cleanupPending）。
#[test]
fn delete_commits_index_and_quarantines_media() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    let out = delete_asset_transacted(&cap(&library), "la-1", &mut |_| {}).expect("删除应成功");
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
    // 受支持平台均无身份绑定删除原语：按契约保留隔离项与日志并报告
    // cleanupPending（评审修复：Linux 分支伪装修复路径的断言残留）
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
    cleanup(&root);
}

/// 锁文件名被预置为指向锚定目录之外的符号链接（issue #721）：no-follow
/// 归类必须拒绝——句柄虽仅用于 flock，也不得锁到目录外目标。
#[cfg(unix)]
#[test]
fn file_lock_refuses_preset_symlink() {
    let (library, root) = temp_fixture();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("建链外目录");
    fs::write(outside.join("victim.txt"), b"VICTIM").expect("写链外目标文件");
    std::os::unix::fs::symlink(outside.join("victim.txt"), library.join(".library-op.lock"))
        .expect("预置符号链接锁文件");
    let err = library_file_lock(&cap(&library)).expect_err("预置符号链接锁文件应拒绝");
    assert!(
        matches!(err, LibraryError::Refused { .. }),
        "符号链接应为保护性拒绝类别：{err}"
    );
    assert!(
        fs::symlink_metadata(library.join(".library-op.lock"))
            .expect("符号链接条目应保持原样")
            .file_type()
            .is_symlink(),
        "拒绝路径不得改动库内条目"
    );
    cleanup(&root);
}

/// 锁文件名被预置为目录（issue #721）：归类为非普通文件即保护性拒绝
/// （旧实现退化为 Io/EISDIR，偏离同域归类纪律）。
#[test]
fn file_lock_refuses_non_file_entry() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join(".library-op.lock")).expect("预置目录占位");
    let err = library_file_lock(&cap(&library)).expect_err("目录占位应拒绝");
    assert!(
        matches!(err, LibraryError::Refused { .. }),
        "非普通文件应为保护性拒绝类别：{err}"
    );
    cleanup(&root);
}

/// 正常首建与复用（issue #721 验收）：首次调用创建普通锁文件并持锁；
/// 再次调用打开同一文件（(dev, ino) 不变——锁对象不漂移）。
#[test]
fn file_lock_creates_then_reopens_same_file() {
    let (library, root) = temp_fixture();
    let lock_path = library.join(".library-op.lock");
    {
        let _handle = library_file_lock(&cap(&library)).expect("首建锁文件应成功");
    }
    let first = file_identity(&lock_path);
    {
        let _handle = library_file_lock(&cap(&library)).expect("复用锁文件应成功");
    }
    assert!(
        fs::metadata(&lock_path).expect("锁文件应存在").is_file(),
        "锁文件应为普通文件"
    );
    assert_eq!(
        file_identity(&lock_path),
        first,
        "复用必须打开同一文件（锁对象不漂移）"
    );
    cleanup(&root);
}
