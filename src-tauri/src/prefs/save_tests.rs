//! issue #121：设置保存使用真实隔离文件系统，验证占位冲突、信任链与完整快照。

use super::*;
use crate::store::atomic_write_faults::{Injection, Stage};
use serde_json::json;

/// 自动回收本测试拥有的目录，包括失败断言留下的临时文件。
struct PrefsDir(PathBuf);

impl PrefsDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pw-prefs-save-{}", crate::store::new_id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn read(&self) -> serde_json::Value {
        read_prefs_at(&self.0.join("settings.json")).unwrap()
    }

    fn entries(&self) -> Vec<String> {
        let mut entries: Vec<_> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        entries.sort();
        entries
    }
}

impl Drop for PrefsDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn save_creates_then_replaces_complete_settings() {
    let dir = PrefsDir::new();
    save_prefs_in(&dir.0, json!({"defaultChat": "old"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "old"}));
    save_prefs_in(&dir.0, json!({"defaultChat": "new", "providers": []})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new", "providers": []}));
    assert_eq!(dir.entries(), ["settings.json"]);
}

#[test]
fn save_ignores_legacy_temp_directory_and_file() {
    // 固定临时路径会被目录阻断，或覆盖不属于本次写入的文件。
    for directory in [true, false] {
        let dir = PrefsDir::new();
        let legacy = dir.0.join("settings.json.tmp");
        if directory {
            fs::create_dir(&legacy).unwrap();
        } else {
            fs::write(&legacy, "keep").unwrap();
        }
        save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
        assert_eq!(dir.read(), json!({"defaultChat": "new"}));
        if directory {
            assert!(legacy.is_dir());
        } else {
            assert_eq!(fs::read_to_string(&legacy).unwrap(), "keep");
        }
        assert_eq!(dir.entries(), ["settings.json", "settings.json.tmp"]);
    }
}

#[cfg(unix)]
#[test]
fn save_does_not_follow_legacy_temp_symlink() {
    let dir = PrefsDir::new();
    let outside = PrefsDir::new();
    let other = outside.0.join("unrelated.json");
    fs::write(&other, "keep").unwrap();
    std::os::unix::fs::symlink(&other, dir.0.join("settings.json.tmp")).unwrap();
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    assert_eq!(fs::read_to_string(other).unwrap(), "keep");
    assert!(fs::symlink_metadata(dir.0.join("settings.json.tmp"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn save_rejects_directory_target_without_leaving_temp_files() {
    let dir = PrefsDir::new();
    fs::create_dir(dir.0.join("settings.json")).unwrap();
    assert!(save_prefs_in(&dir.0, json!({"defaultChat": "new"})).is_err());
    assert!(dir.0.join("settings.json").is_dir());
    assert_eq!(dir.entries(), ["settings.json"]);
}

#[cfg(unix)]
#[test]
fn save_rejects_symlink_target_without_replacing_it() {
    let dir = PrefsDir::new();
    let outside = PrefsDir::new();
    let other = outside.0.join("unrelated.json");
    fs::write(&other, "keep").unwrap();
    let target = dir.0.join("settings.json");
    std::os::unix::fs::symlink(&other, &target).unwrap();
    assert!(save_prefs_in(&dir.0, json!({"defaultChat": "new"})).is_err());
    assert_eq!(fs::read_to_string(other).unwrap(), "keep");
    assert!(fs::symlink_metadata(target)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(dir.entries(), ["settings.json"]);
}

#[test]
fn save_enforces_serialized_byte_limit_before_touching_files() {
    let dir = PrefsDir::new();
    let overhead = serde_json::to_string_pretty(&json!({"value": ""}))
        .unwrap()
        .len();
    let value = json!({"value": "x".repeat(PREFS_MAX_BYTES - overhead)});
    save_prefs_in(&dir.0, value.clone()).unwrap();
    assert_eq!(dir.read(), value);
    let before = fs::read(dir.0.join("settings.json")).unwrap();
    assert_eq!(before.len(), PREFS_MAX_BYTES);
    let error =
        save_prefs_in(&dir.0, json!({"value": "界".repeat(PREFS_MAX_BYTES / 3)})).unwrap_err();
    assert!(error.contains("设置内容过大"));
    assert_eq!(fs::read(dir.0.join("settings.json")).unwrap(), before);
    assert_eq!(dir.entries(), ["settings.json"]);
}

#[test]
fn overlapping_saves_leave_one_complete_snapshot() {
    let dir = PrefsDir::new();
    let barrier = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..4)
            .map(|writer| {
                let path = &dir.0;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    save_prefs_in(path, json!({"writer": writer, "data": "x".repeat(8192)}))
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
    });
    let saved = dir.read();
    assert!(saved["writer"].as_u64().unwrap() < 4);
    assert_eq!(saved["data"], "x".repeat(8192));
    assert_eq!(dir.entries(), ["settings.json"]);
}

#[test]
fn save_precommit_io_failures_preserve_old_settings_and_allow_retry() {
    for stage in [Stage::Create, Stage::Write, Stage::FileSync, Stage::Rename] {
        let dir = PrefsDir::new();
        fs::write(dir.0.join("settings.json"), r#"{"defaultChat":"old"}"#).unwrap();
        let before = fs::read(dir.0.join("settings.json")).unwrap();
        let injection = Injection::new(Some(stage), None);
        let error = save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap_err();
        assert!(
            error.contains(&format!("injected {stage:?} failure")),
            "{error}"
        );
        assert_eq!(fs::read(dir.0.join("settings.json")).unwrap(), before);
        assert_eq!(dir.entries(), ["settings.json"]);
        drop(injection);
        save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
        assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    }
}

#[cfg(unix)]
#[test]
fn save_directory_sync_failure_reports_error_with_complete_new_file() {
    let dir = PrefsDir::new();
    fs::write(dir.0.join("settings.json"), r#"{"defaultChat":"old"}"#).unwrap();
    let injection = Injection::new(Some(Stage::DirectorySync), None);
    let error = save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap_err();
    assert!(error.contains("injected DirectorySync failure"), "{error}");
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    assert_eq!(dir.entries(), ["settings.json"]);
    drop(injection);
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
}

#[test]
fn save_obeys_durability_protocol_order() {
    // 数据模型 §10.2：文件内容同步必须先于 rename，父目录屏障必须后于 rename。
    let dir = PrefsDir::new();
    let injection = Injection::new(None, None);
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    let expected = vec![
        Stage::Create,
        Stage::Write,
        Stage::FileSync,
        Stage::Rename,
        #[cfg(unix)]
        Stage::DirectorySync,
    ];
    assert_eq!(injection.stages(), expected);
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
}

#[test]
fn atomic_save_collision_does_not_remove_another_writers_temp_file() {
    // 排他创建失败意味着该临时文件从未归本次操作所有，清理不能删除它。
    let dir = PrefsDir::new();
    fs::write(dir.0.join("settings.json"), r#"{"defaultChat":"old"}"#).unwrap();
    let name = ".settings.json.collision.tmp";
    fs::write(dir.0.join(name), "other writer").unwrap();
    let injection = Injection::new(None, Some(name));
    let root = cap_std::fs::Dir::open_ambient_dir(&dir.0, cap_std::ambient_authority()).unwrap();
    let error = crate::store::atomic_write(&root, "settings.json", "{}").unwrap_err();
    assert!(
        matches!(error, crate::store::error::StoreError::Io { source, .. }
        if source.kind() == io::ErrorKind::AlreadyExists)
    );
    assert_eq!(
        fs::read_to_string(dir.0.join(name)).unwrap(),
        "other writer"
    );
    assert_eq!(dir.read(), json!({"defaultChat": "old"}));
    drop(injection);
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
    assert_eq!(
        fs::read_to_string(dir.0.join(name)).unwrap(),
        "other writer"
    );
}
