//! 库删除事务回归测试（issue #25）：事务四步、平台能力分支的 cleanupPending/日志收敛。

use super::recover_tests::*;
use super::*;
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
