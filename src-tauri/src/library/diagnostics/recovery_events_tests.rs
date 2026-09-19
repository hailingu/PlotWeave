//! PR #222：真实临时图库覆盖三个替代恢复入口；信封合同见数据模型 §7.2。

use super::*;
use crate::assets::{error::AssetsError, project_media::PendingProjectAssets};
use crate::library::{diagnostics::with_snapshot, list_assets_with, put_asset_with};
use cap_std::ambient_authority;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

/// 临时库与最小项目控制文件；仅测试夹具模拟外部修复/未提交事务现场。
struct Fixture {
    root: PathBuf,
    library: Dir,
    projects: Dir,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pw-events-{}", crate::store::new_id()));
        fs::create_dir_all(root.join("library/assets")).unwrap();
        fs::create_dir_all(root.join("projects")).unwrap();
        fs::write(root.join("projects/p-1.json"), b"{}").unwrap();
        Self {
            library: Dir::open_ambient_dir(root.join("library"), ambient_authority()).unwrap(),
            projects: Dir::open_ambient_dir(root.join("projects"), ambient_authority()).unwrap(),
            root,
        }
    }

    fn put(&self, name: &str) -> Value {
        with_snapshot(&self.library, |dir| {
            put_asset_with(dir, name, "image/png", "reference", b"original")
        })
        .unwrap()
    }

    fn list(&self) -> Value {
        with_snapshot(&self.library, |dir| {
            let (mut index, warnings) = list_assets_with(dir)?;
            index["warnings"] = json!(warnings);
            Ok(index)
        })
        .unwrap()
    }

    fn delete(&self, asset: &Value) -> PathBuf {
        with_snapshot(&self.library, |dir| {
            crate::library_journal::delete_asset_transacted(dir, asset["id"].as_str().unwrap())
        })
        .unwrap();
        let journal: Value = serde_json::from_slice(
            &fs::read(self.root.join("library/asset-delete-journal.json")).unwrap(),
        )
        .unwrap();
        self.root
            .join("library")
            .join(journal[0]["trashName"].as_str().unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

/// 三个生产入口共用相同锁/收集/发布边界，保留真实各自的恢复与访问内核。
fn run_entry(
    f: &Fixture,
    entry: &str,
    id: &str,
    events: &mut Vec<Value>,
) -> Result<(), AssetsError> {
    with_recovery_snapshot(
        &f.library,
        |library, report| match entry {
            "url" => crate::media_protocol::resolve_media_entry_with(library, id, report)
                .map(|_| ())
                .map_err(AssetsError::from),
            "media" => crate::media_protocol::open_media_with(library, id, report)
                .map(|_| ())
                .map_err(AssetsError::from),
            "import" => crate::assets::import_asset_from_library(
                &f.projects,
                library,
                "p-1",
                id,
                &PendingProjectAssets::new(),
                report,
            )
            .map(|_| ()),
            _ => unreachable!("测试入口枚举"),
        },
        |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
    )
}

/// IPC 序号为十进制字符串，事件与命令响应共用同一进程序号域。
fn revision(value: &Value) -> u64 {
    value["diagnosticsRevision"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn alternate_recovery_retires_missing_quarantine_and_supersedes_old_list() {
    for entry in ["url", "media", "import"] {
        let f = Fixture::new();
        let active = f.put("active.png");
        let removed = f.put("removed.png");
        let trash = f.delete(&removed);
        let old = f.list();
        assert_eq!(old["cleanupPending"].as_array().unwrap().len(), 1);
        // 既有恢复分支：隔离项已不存在，下一入口清除对应日志；不模拟自动 unlink。
        fs::remove_file(trash).unwrap();
        let mut events = Vec::new();
        run_entry(&f, entry, active["id"].as_str().unwrap(), &mut events).unwrap();
        assert_eq!(events.len(), 1, "{entry}");
        assert_eq!(events[0]["cleanupPending"], json!([]));
        assert!(revision(&events[0]) > revision(&old));
        assert!(revision(&f.list()) > revision(&events[0]));
        let journal: Value = serde_json::from_slice(
            &fs::read(f.root.join("library/asset-delete-journal.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(journal, json!([]));
    }
}

#[test]
fn conflict_is_published_even_when_each_entry_refuses_the_requested_asset() {
    for entry in ["url", "media", "import"] {
        let f = Fixture::new();
        let asset = f.put("asset.png");
        let original_index = fs::read(f.root.join("library/library.json")).unwrap();
        let trash = f.delete(&asset);
        let old = f.list();
        // 未提交索引的事务 + 原路径被占用：恢复应拒绝服务并保留两份现场。
        fs::write(f.root.join("library/library.json"), original_index).unwrap();
        let original_path = f
            .root
            .join("library")
            .join(asset["relPath"].as_str().unwrap());
        fs::write(&original_path, b"occupant").unwrap();
        let mut events = Vec::new();
        assert!(run_entry(&f, entry, asset["id"].as_str().unwrap(), &mut events).is_err());
        assert_eq!(events.len(), 1, "{entry}");
        assert!(!events[0]["warnings"].as_array().unwrap().is_empty());
        assert!(revision(&events[0]) > revision(&old));
        assert_eq!(fs::read(trash).unwrap(), b"original");
        assert_eq!(fs::read(original_path).unwrap(), b"occupant");
    }
}

#[test]
fn completed_recovery_is_published_when_subsequent_lookup_fails() {
    for entry in ["url", "media", "import"] {
        let f = Fixture::new();
        let asset = f.put("asset.png");
        let trash = f.delete(&asset);
        let old = f.list();
        fs::remove_file(trash).unwrap();
        let mut events = Vec::new();
        assert!(run_entry(&f, entry, "la-missing", &mut events).is_err());
        assert_eq!(events.len(), 1, "{entry}");
        assert_eq!(events[0]["cleanupPending"], json!([]));
        assert!(revision(&events[0]) > revision(&old));
    }
}

#[test]
fn incomplete_recovery_propagates_error_without_fabricating_empty_event() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("library/library.json")).unwrap();
    for entry in ["url", "media", "import"] {
        let mut events = Vec::new();
        assert!(run_entry(&f, entry, "la-missing", &mut events).is_err());
        assert!(events.is_empty());
    }
}

#[test]
fn repeated_observations_keep_warnings_and_latest_state_in_one_event() {
    let f = Fixture::new();
    let mut events = Vec::new();
    let result: Result<(), LibraryError> = with_recovery_snapshot(
        &f.library,
        |_, report| {
            report(&Recovery {
                warnings: vec!["repair".into()],
                cleanup_pending: vec!["pending".into()],
                ..Recovery::default()
            });
            report(&Recovery::default());
            Err(LibraryError::missing("later failure"))
        },
        |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
    );
    assert!(result.is_err());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["warnings"], json!(["repair"]));
    assert_eq!(events[0]["cleanupPending"], json!([]));
}
