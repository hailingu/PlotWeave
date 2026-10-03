//! issue #421：折叠退役与累计指标在写入故障及重试之间保持一致；故障只
//! 替换指定系统调用，其余日志落盘、文件身份与恢复均使用真实文件系统。

use super::*;
use crate::library_fixture::*;
use crate::store::atomic_write_faults::{Injection, Stage};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 两笔已提交删除的真实隔离项：独立推导累计值为 2 项、7 字节。
fn completed_pair(library: &Path) {
    fs::create_dir_all(library.join("assets/.trash")).expect("建隔离目录");
    write_index_raw(library, &json!({"assets": by_id([]), "groups": by_id([])}));
    let entries: Vec<Value> = [("a", b"ABC".as_slice()), ("b", b"DEFG".as_slice())]
        .into_iter()
        .map(|(id, bytes)| {
            let trash = format!("assets/.trash/{id}");
            fs::write(library.join(&trash), bytes).expect("写隔离项");
            let (dev, ino) = file_identity(&library.join(&trash));
            journal_entry_json(
                id,
                &format!("la-{id}"),
                &format!("assets/{id}.png"),
                &trash,
                dev,
                ino,
            )
        })
        .collect();
    write_journal_raw(library, json!(entries));
}

/// 若退役与指标分开落盘，rename 后的同步失败会让重试永久遗漏这两笔。
#[cfg(unix)]
#[test]
fn retirement_directory_sync_failure_keeps_folded_totals_on_retry() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    let injection = Injection::new(Some(Stage::DirectorySync), None);
    recover(&cap(&library)).expect_err("目录同步失败必须继续向上传播");
    drop(injection);
    assert_eq!(
        snapshot(&library)["entries"],
        json!([]),
        "已抵达退役 rename 后的故障窗口"
    );
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(2));
    assert_eq!(snapshot(&library)["trashBytes"], json!(7));

    for _ in 0..2 {
        let retried = recover(&cap(&library)).expect("重试恢复");
        assert_eq!(retried.cleanup_pending.len(), 1, "两笔不得永久失联");
        assert_eq!(
            retried.cleanup_pending[0].count,
            Some(2),
            "重试不得少计或重复累计"
        );
        assert_eq!(retried.cleanup_pending[0].bytes, Some(7));
    }
    assert_eq!(fs::read(library.join("assets/.trash/a")).unwrap(), b"ABC");
    assert_eq!(fs::read(library.join("assets/.trash/b")).unwrap(), b"DEFG");
    cleanup(&root);
}

/// §7.2 新日志根承载完整快照，不使用测试内核计算期望值。
fn snapshot(library: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(library.join(JOURNAL_FILE_NAME)).unwrap()).unwrap()
}

/// 旧份额迁移一次，随后陈旧旁路文件不得重复累计或复活已归零的指标。
#[test]
fn legacy_totals_migrate_once_and_stale_archive_is_ignored() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":3,"trashBytes":10}"#,
    )
    .unwrap();
    let migrated = recover(&cap(&library)).expect("旧格式迁移");
    assert_eq!(migrated.cleanup_pending[0].count, Some(5));
    assert_eq!(migrated.cleanup_pending[0].bytes, Some(17));
    assert_eq!(snapshot(&library)["entries"], json!([]));
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(5));
    fs::write(library.join(ARCHIVE_FILE_NAME), b"invalid stale archive").unwrap();
    let repeated = recover(&cap(&library)).expect("迁移后恢复");
    assert!(repeated.warnings.is_empty(), "新根不得读取陈旧旁路");
    assert_eq!(repeated.cleanup_pending[0].count, Some(5));
    assert_eq!(repeated.cleanup_pending[0].bytes, Some(17));
    fs::remove_dir_all(library.join("assets/.trash")).unwrap();
    for _ in 0..2 {
        assert!(recover(&cap(&library)).unwrap().cleanup_pending.is_empty());
        assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(0));
        assert_eq!(snapshot(&library)["trashBytes"], json!(0));
    }
    cleanup(&root);
}

/// 只有旧归档而日志缺失时，也必须在空事务恢复中迁移且保留未知字节。
#[test]
fn missing_journal_migrates_legacy_totals_without_entries() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets/.trash")).unwrap();
    write_index_raw(&library, &json!({"assets": by_id([]), "groups": by_id([])}));
    fs::write(
        library.join(ARCHIVE_FILE_NAME),
        br#"{"retainedCleanupCount":3}"#,
    )
    .unwrap();
    let migrated = recover(&cap(&library)).unwrap();
    assert_eq!(migrated.cleanup_pending[0].count, Some(3));
    assert_eq!(migrated.cleanup_pending[0].bytes, None);
    assert!(
        library.join(JOURNAL_FILE_NAME).exists(),
        "空事务迁移也须提交新日志"
    );
    assert_eq!(snapshot(&library)["entries"], json!([]));
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(3));
    assert!(snapshot(&library).get("trashBytes").is_none());
    cleanup(&root);
}

/// 新根的咨询性指标异型不能触发整库只读，也不得删掉仍需恢复的事务。
#[test]
fn embedded_malformed_totals_are_advisory() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    let entries = snapshot(&library);
    write_journal_raw(
        &library,
        json!({"entries":entries,"retainedCleanupCount":"bad","trashBytes":false}),
    );
    let recovered = recover(&cap(&library)).unwrap();
    assert!(!recovered.read_only);
    assert!(!recovered.warnings.is_empty());
    assert_eq!(recovered.cleanup_pending[0].count, Some(2));
    assert_eq!(recovered.cleanup_pending[0].bytes, Some(7));
    assert_eq!(snapshot(&library)["entries"], json!([]));
    assert!(recover(&cap(&library)).unwrap().warnings.is_empty());
    cleanup(&root);
}

/// rename 之前每个真实 I/O 失败都保留旧条目与旧累计，重试各折叠一次。
#[test]
fn retirement_pre_rename_failures_keep_old_snapshot_until_retry() {
    for stage in [Stage::Create, Stage::Write, Stage::FileSync, Stage::Rename] {
        let (library, root) = temp_fixture();
        completed_pair(&library);
        let entries = snapshot(&library);
        write_journal_raw(
            &library,
            json!({"entries":entries,"retainedCleanupCount":3,"trashBytes":10}),
        );
        let before = snapshot(&library);
        let injection = Injection::new(Some(stage), None);
        recover(&cap(&library)).expect_err("日志写入故障必须传播");
        drop(injection);
        assert_eq!(snapshot(&library), before, "rename 前不得提前退役或累计");
        for _ in 0..2 {
            let retried = recover(&cap(&library)).unwrap();
            assert_eq!(retried.cleanup_pending[0].count, Some(5));
            assert_eq!(retried.cleanup_pending[0].bytes, Some(17));
        }
        cleanup(&root);
    }
}

/// 追加目录屏障同样在联合替换之后；原错误继续传播，后续快照稳定。
#[cfg(unix)]
#[test]
fn retirement_additional_directory_sync_failure_keeps_totals() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    let injection = Injection::new(Some(Stage::LibraryDirectorySync), None);
    let err = recover(&cap(&library)).expect_err("追加屏障失败必须传播");
    assert!(std::error::Error::source(&err).is_some(), "保留底层来源");
    drop(injection);
    assert_eq!(snapshot(&library)["entries"], json!([]));
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(2));
    assert_eq!(snapshot(&library)["trashBytes"], json!(7));
    for _ in 0..2 {
        let repeated = recover(&cap(&library)).unwrap();
        assert_eq!(repeated.cleanup_pending[0].count, Some(2));
        assert_eq!(repeated.cleanup_pending[0].bytes, Some(7));
    }
    cleanup(&root);
}

/// 新删除追加、索引损坏置闩及修复后的折叠都必须保持既存累计值。
#[test]
fn deletion_and_uncertain_latch_preserve_existing_totals() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    recover(&cap(&library)).unwrap();
    fs::write(library.join("assets/la-c.png"), b"X").unwrap();
    write_index_raw(
        &library,
        &json!({"assets":by_id([entry("la-c","assets/la-c.png")]),"groups":by_id([])}),
    );
    delete_asset_transacted(&cap(&library), "la-c", &mut |_| {}).unwrap();
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(2));
    assert_eq!(snapshot(&library)["trashBytes"], json!(7));
    assert_eq!(snapshot(&library)["entries"].as_array().unwrap().len(), 1);

    fs::write(library.join("library.json"), b"{broken").unwrap();
    let uncertain = recover(&cap(&library)).unwrap();
    assert_eq!(uncertain.conflicted, ["la-c"]);
    assert_eq!(
        snapshot(&library)["entries"][0]["indexUncertain"],
        json!(true)
    );
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(2));
    assert_eq!(snapshot(&library)["trashBytes"], json!(7));

    write_index_raw(&library, &json!({"assets":by_id([]),"groups":by_id([])}));
    let repaired = recover(&cap(&library)).unwrap();
    assert!(repaired.conflicted.is_empty());
    assert_eq!(repaired.cleanup_pending[0].count, Some(3));
    assert_eq!(repaired.cleanup_pending[0].bytes, Some(8));
    assert_eq!(snapshot(&library)["entries"], json!([]));
    cleanup(&root);
}

/// 重隔离的预 rename 写即使后置同步失败，也只改变映射、不提前累计。
#[cfg(unix)]
#[test]
fn requarantine_intermediate_failure_preserves_existing_totals() {
    let (library, root) = temp_fixture();
    completed_pair(&library);
    recover(&cap(&library)).unwrap();
    fs::write(library.join("assets/c.png"), b"X").unwrap();
    let (dev, ino) = file_identity(&library.join("assets/c.png"));
    let mut before = snapshot(&library);
    before["entries"] = json!([journal_entry_json(
        "c",
        "la-c",
        "assets/c.png",
        "assets/.trash/c",
        dev,
        ino
    )]);
    write_journal_raw(&library, before);
    let injection = Injection::new(Some(Stage::LibraryDirectorySync), None);
    recover(&cap(&library)).expect_err("中间日志同步失败应阻止媒体移动");
    drop(injection);
    assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(2));
    assert_eq!(snapshot(&library)["trashBytes"], json!(7));
    assert_eq!(snapshot(&library)["entries"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read(library.join("assets/c.png")).unwrap(), b"X");
    for _ in 0..2 {
        let retried = recover(&cap(&library)).unwrap();
        assert_eq!(retried.cleanup_pending[0].count, Some(3));
        assert_eq!(retried.cleanup_pending[0].bytes, Some(8));
    }
    cleanup(&root);
}

/// 新对象的事务形状异型仍只读，不能借指标降级吞掉事务证据。
#[test]
fn malformed_embedded_entries_keep_journal_read_only() {
    for entries in [json!(null), json!({}), json!([{}])] {
        let (library, root) = temp_fixture();
        completed_pair(&library);
        let before = json!({"entries":entries,"retainedCleanupCount":3,"trashBytes":10});
        write_journal_raw(&library, before.clone());
        let blocked = recover(&cap(&library)).unwrap();
        assert!(blocked.read_only);
        assert!(!blocked.warnings.is_empty());
        assert_eq!(snapshot(&library), before);
        cleanup(&root);
    }
}

/// 没有历史删除状态的健康库，读取不应因新增空日志写入而失败。
#[test]
fn missing_journal_without_legacy_totals_needs_no_write() {
    let (library, root) = temp_fixture();
    write_index_raw(&library, &json!({"assets":by_id([]),"groups":by_id([])}));
    let injection = Injection::new(Some(Stage::Create), None);
    let clean = recover(&cap(&library)).expect("没有历史状态的读取无需写空日志");
    assert!(clean.cleanup_pending.is_empty());
    assert!(!library.join(JOURNAL_FILE_NAME).exists());
    drop(injection);
    cleanup(&root);
}

/// 迁移与本轮折叠同次提交；rename 前后失败均不可重新导入旧份额。
#[cfg(unix)]
#[test]
fn legacy_migration_failure_retries_with_totals_exactly_once() {
    for stage in [Stage::Rename, Stage::DirectorySync] {
        let (library, root) = temp_fixture();
        completed_pair(&library);
        fs::write(
            library.join(ARCHIVE_FILE_NAME),
            br#"{"retainedCleanupCount":3,"trashBytes":10}"#,
        )
        .unwrap();
        let before = snapshot(&library);
        let injection = Injection::new(Some(stage), None);
        recover(&cap(&library)).expect_err("迁移持久化失败应传播");
        drop(injection);
        if stage == Stage::Rename {
            assert_eq!(snapshot(&library), before);
        } else {
            assert_eq!(snapshot(&library)["entries"], json!([]));
            assert_eq!(snapshot(&library)["retainedCleanupCount"], json!(5));
            assert_eq!(snapshot(&library)["trashBytes"], json!(17));
        }
        for _ in 0..2 {
            let repeated = recover(&cap(&library)).unwrap();
            assert_eq!(repeated.cleanup_pending[0].count, Some(5));
            assert_eq!(repeated.cleanup_pending[0].bytes, Some(17));
        }
        cleanup(&root);
    }
}
