//! PR #222 诊断顺序回归：真实库锁、文件锁与临时图库；不触碰用户目录。

use super::*;
use crate::library::{group_commands, list_assets_with, put_asset_with, update_meta_with};
use cap_std::ambient_authority;
use serde_json::json;
use std::{fs, path::PathBuf, sync::mpsc, thread};

/// 自持临时目录，允许多个线程打开同一真实库根，并在用例结束时清理。
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pw-diagnostics-{}", crate::store::new_id()));
        fs::create_dir_all(path.join("assets")).unwrap();
        Self(path)
    }

    fn open(&self) -> Dir {
        Dir::open_ambient_dir(&self.0, ambient_authority()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

/// 使用真实列表内核的响应，模拟命令在序列化前仍持锁的诊断快照。
fn list_response(library: &Dir) -> Result<Value, LibraryError> {
    let (mut index, warnings) = list_assets_with(library)?;
    index["warnings"] = json!(warnings);
    Ok(index)
}

/// IPC 合同：字符串承载规范十进制 u64，JSON 往返不能降为浮点数。
fn revision(value: &Value) -> u64 {
    let wire: Value = serde_json::from_slice(&serde_json::to_vec(value).unwrap()).unwrap();
    let revision = wire["diagnosticsRevision"].as_str().unwrap();
    let number: u64 = revision.parse().unwrap();
    assert_eq!(revision, number.to_string());
    number
}

#[test]
fn successful_operations_keep_payloads_and_order_delete_after_old_list() {
    let fixture = Fixture::new();
    let library = fixture.open();
    let imported = with_snapshot(&library, |dir| {
        put_asset_with(dir, "a.png", "image/png", "reference", b"image")
    })
    .unwrap();
    let id = imported["id"].as_str().unwrap();
    let group = with_snapshot(&library, |dir| {
        group_commands::upsert_group_with(dir, &json!({"id":"g1","name":"组","kind":"reference"}))
    })
    .unwrap();
    let updated = with_snapshot(&library, |dir| {
        update_meta_with(dir, id, &json!({"name":"新名","groupId":"g1"}))
    })
    .unwrap();
    let old_list = with_snapshot(&library, list_response).unwrap();
    assert_eq!(old_list["assets"]["byId"][id]["name"], "新名");
    assert_eq!(old_list["cleanupPending"], json!([]));
    let deleted = with_snapshot(&library, |dir| {
        crate::library_journal::delete_asset_transacted(dir, id)
    })
    .unwrap();
    assert!(!deleted["cleanupPending"].as_array().unwrap().is_empty());
    let ungrouped =
        with_snapshot(&library, |dir| group_commands::delete_group_with(dir, "g1")).unwrap();
    let latest = with_snapshot(&library, list_response).unwrap();
    assert!(latest["assets"]["byId"].get(id).is_none());
    assert!(latest["groups"]["byId"].get("g1").is_none());
    let ordered = [
        &imported, &group, &updated, &old_list, &deleted, &ungrouped, &latest,
    ];
    for pair in ordered.windows(2) {
        assert!(revision(pair[0]) < revision(pair[1]));
    }
    let persisted: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("library.json")).unwrap()).unwrap();
    assert!(persisted.get("diagnosticsRevision").is_none());
}

#[test]
fn concurrent_operations_stamp_snapshots_before_unlocking() {
    let fixture = Fixture::new();
    let first_dir = fixture.open();
    let second_dir = fixture.open();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = thread::spawn(move || {
        with_snapshot(&first_dir, |dir| {
            let imported = put_asset_with(dir, "a.png", "image/png", "reference", b"image")?;
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(imported)
        })
    });
    entered_rx.recv().unwrap();
    let second = thread::spawn(move || with_snapshot(&second_dir, list_response));
    release_tx.send(()).unwrap();
    let imported = first.join().unwrap().unwrap();
    let listed = second.join().unwrap().unwrap();
    assert!(revision(&imported) < revision(&listed));
    assert!(listed["assets"]["byId"]
        .get(imported["id"].as_str().unwrap())
        .is_some());
}

#[test]
fn failed_operation_releases_locks_without_fabricating_a_snapshot() {
    let fixture = Fixture::new();
    let library = fixture.open();
    let before = with_snapshot(&library, list_response).unwrap();
    let error = with_snapshot(&library, |_| Err(LibraryError::missing("injected"))).unwrap_err();
    assert!(matches!(error, LibraryError::NotFound { .. }));
    let after = with_snapshot(&library, list_response).unwrap();
    assert!(revision(&after) > revision(&before));
    assert_eq!(after["assets"], before["assets"]);
}

#[test]
fn counter_exhaustion_does_not_wrap_or_lose_precision() {
    let counter = AtomicU64::new(u64::MAX - 1);
    assert_eq!(reserve_revision(&counter).unwrap(), u64::MAX);
    assert!(matches!(
        reserve_revision(&counter),
        Err(LibraryError::Limit { .. })
    ));
    assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
}

#[test]
fn invalid_response_is_reported_and_the_next_operation_can_recover() {
    let fixture = Fixture::new();
    let library = fixture.open();
    let error = with_snapshot(&library, |_| Ok(Value::Null)).unwrap_err();
    assert!(matches!(error, LibraryError::Corrupt { .. }));
    assert!(revision(&with_snapshot(&library, list_response).unwrap()) > 0);
}
