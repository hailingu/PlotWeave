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
    // 数据模型 §10.2：文件内容同步必须先于 rename，父目录屏障必须后于 rename；
    // 目录条目宿主屏障（Unix）先于一切内容写入。
    let dir = PrefsDir::new();
    let injection = Injection::new(None, None);
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    let expected = vec![
        #[cfg(unix)]
        Stage::EntrySync,
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

#[cfg(unix)]
#[test]
fn save_syncs_entry_host_when_data_dir_newly_created() {
    // PR #201 评审（P2）：首次保存创建数据目录时，新目录条目所在的宿主
    // 必须先于内容写入同步——否则断电可整体丢目录而保存已报告成功。
    let base = PrefsDir::new();
    let target = base.0.join("app-data");
    let injection = Injection::new(None, None);
    save_prefs_in(&target, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(
        read_prefs_at(&target.join("settings.json")).unwrap(),
        json!({"defaultChat": "new"})
    );
    let stages = injection.stages();
    assert_eq!(
        stages.first(),
        Some(&Stage::EntrySync),
        "实际阶段：{stages:?}"
    );
}

#[cfg(unix)]
#[test]
fn save_syncs_every_host_of_newly_created_levels() {
    // 多级新建（nested/app-data）：最深已存在祖先与每个中间级都是新条目
    // 的宿主，逐级同步，缺一不可。
    let base = PrefsDir::new();
    let target = base.0.join("nested").join("app-data");
    let injection = Injection::new(None, None);
    save_prefs_in(&target, json!({"defaultChat": "new"})).unwrap();
    let stages = injection.stages();
    assert_eq!(
        &stages[..2],
        &[Stage::EntrySync, Stage::EntrySync],
        "实际阶段：{stages:?}"
    );
}

#[cfg(unix)]
#[test]
fn save_entry_sync_failure_preserves_old_settings_and_allows_retry() {
    // 条目宿主同步失败发生在任何临时文件创建之前：旧设置不变、无新增
    // 条目，失败上抛；重试可完成。
    let dir = PrefsDir::new();
    fs::write(dir.0.join("settings.json"), r#"{"defaultChat":"old"}"#).unwrap();
    let injection = Injection::new(Some(Stage::EntrySync), None);
    let error = save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap_err();
    assert!(error.contains("injected EntrySync failure"), "{error}");
    assert_eq!(
        fs::read_to_string(dir.0.join("settings.json")).unwrap(),
        r#"{"defaultChat":"old"}"#
    );
    assert_eq!(dir.entries(), ["settings.json"]);
    drop(injection);
    save_prefs_in(&dir.0, json!({"defaultChat": "new"})).unwrap();
    assert_eq!(dir.read(), json!({"defaultChat": "new"}));
}

#[cfg(unix)]
#[test]
fn ensure_data_dir_persists_every_host_of_new_levels() {
    // PR #201 第二轮评审（P2）：读取路径（首启 load_prefs）同样会创建
    // 数据目录——多级缺失（干净轮廓、嵌套 XDG_DATA_HOME）时，创建本身
    // 必须同步每个新条目宿主；否则随后的保存只同步直接父目录，更上层
    // 条目仍未落盘，成功返回后断电仍可丢失整棵目录。
    let base = PrefsDir::new();
    let target = base.0.join("level-a").join("level-b");
    let injection = Injection::new(None, None);
    ensure_data_dir(&target).unwrap();
    assert!(target.is_dir());
    assert_eq!(
        injection.stages(),
        vec![Stage::EntrySync, Stage::EntrySync],
        "实际阶段：{:?}",
        injection.stages()
    );
}

#[cfg(unix)]
#[test]
fn ensure_data_dir_removes_created_levels_on_sync_failure_for_full_retry() {
    // PR #201 第三轮评审（P2）：多级新建后条目同步失败时，新建层级若
    // 残留，重试会走「目录已存在」分支只兜底直接父目录，更上层条目
    // 永不落盘——失败必须拆除本次新建层级，重试才能重新探测锚点、
    // 再次全链同步。
    let base = PrefsDir::new();
    let target = base.0.join("level-a").join("level-b");
    let injection = Injection::new(Some(Stage::EntrySync), None);
    assert!(ensure_data_dir(&target).is_err());
    drop(injection);
    assert!(!target.exists(), "失败后最深新建层级应被清理");
    assert!(
        !base.0.join("level-a").exists(),
        "失败后中间新建层级应被清理"
    );
    let injection = Injection::new(None, None);
    ensure_data_dir(&target).unwrap();
    assert_eq!(
        injection.stages(),
        vec![Stage::EntrySync, Stage::EntrySync],
        "重试应重新全链同步，实际阶段：{:?}",
        injection.stages()
    );
}

#[test]
fn ensure_data_dir_rejects_file_blocked_path_without_side_effects() {
    // 守卫：路径中间级被文件占据时创建失败，不产生任何新建层级，也
    // 不改动既有条目（部分失败残留清理的边界用例）。
    let base = PrefsDir::new();
    let blocker = base.0.join("blocker");
    fs::write(&blocker, "occupied").unwrap();
    let target = blocker.join("leaf");
    let error = ensure_data_dir(&target).unwrap_err();
    assert!(error.contains("创建数据目录失败"), "{error}");
    assert_eq!(fs::read_to_string(&blocker).unwrap(), "occupied");
    assert!(!target.exists());
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
