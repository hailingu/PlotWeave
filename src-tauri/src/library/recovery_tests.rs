//! #137：损坏索引的局部读取、后续写入和原件保留，经过真实文件系统命令边界。

use super::*;
use cap_std::{ambient_authority, fs::Dir};
use std::{fs, io::Read, path::PathBuf};

/// 每个测试持有独立图库；析构删除测试数据，不触及用户应用目录。
struct LibraryFixture {
    path: PathBuf,
    dir: Dir,
}

impl LibraryFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pw-recovery-{}", crate::store::new_id()));
        fs::create_dir_all(path.join("assets")).unwrap();
        let dir = Dir::open_ambient_dir(&path, ambient_authority()).unwrap();
        Self { path, dir }
    }

    fn write(&self, bytes: impl AsRef<[u8]>) {
        fs::write(self.path.join("library.json"), bytes).unwrap();
    }

    fn original(&self) -> Vec<u8> {
        fs::read(self.path.join("library.json")).unwrap()
    }

    fn backups(&self) -> Vec<Vec<u8>> {
        fs::read_dir(&self.path)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                (path.extension().is_some_and(|ext| ext == "bak")).then(|| fs::read(path).unwrap())
            })
            .collect()
    }

    /// 仅用于已经断言创建一份备份的异常注入，不依赖备份文件的命名算法。
    fn only_backup_path(&self) -> PathBuf {
        let paths: Vec<_> = fs::read_dir(&self.path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "bak"))
            .collect();
        assert_eq!(paths.len(), 1);
        paths.into_iter().next().unwrap()
    }
}

impl Drop for LibraryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// 完整且有效的库资产；损坏仅由测试显式注入。
fn asset(id: &str) -> Value {
    json!({"id": id, "name": id, "kind": "other", "mime": "image/png",
        "relPath": format!("assets/{id}.png"), "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z", "tags": []})
}

/// 中间条目语法损坏，前后资产和独立编组均有完整边界。
fn damaged_index() -> String {
    format!(
        r#"{{"assets":{{"byId":{{"a":{},"bad":BROKEN,"b":{}}}}},"groups":{{"byId":{{"g":{{"id":"g","name":"组","kind":"other"}}}}}}}}"#,
        asset("a"),
        asset("b")
    )
}

#[test]
fn corrupt_index_keeps_complete_records_and_media_without_rewriting() {
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    fs::write(fixture.path.join("assets/a.png"), b"image-a").unwrap();
    let (index, warnings) = list_assets_with(&fixture.dir).expect("局部损坏不阻断列表");
    assert_eq!(index["assets"]["byId"]["a"], asset("a"));
    assert_eq!(index["assets"]["byId"]["b"], asset("b"));
    assert!(index["assets"]["byId"].get("bad").is_none());
    assert_eq!(index["groups"]["byId"]["g"]["name"], "组");
    assert!(!warnings.is_empty());
    let (mime, mut file) =
        crate::media_protocol::open_media_with(&fixture.dir, "a", &mut |_| {}).unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"image-a");
    assert_eq!(mime, "image/png");
    assert_eq!(fixture.original(), raw.as_bytes());
    assert!(fixture.backups().is_empty());
}

#[test]
fn later_edit_backs_up_original_and_retains_healthy_data_across_reload() {
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    update_meta_with(&fixture.dir, "a", &json!({"name": "改名"})).unwrap();
    group_commands::upsert_group_with(
        &fixture.dir,
        &json!({"id":"g2","name":"新组","kind":"other"}),
    )
    .unwrap();
    let added = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").unwrap();
    let (index, warnings) = list_assets_with(&fixture.dir).unwrap();
    assert_eq!(index["assets"]["byId"]["a"]["name"], "改名");
    assert_eq!(index["assets"]["byId"]["b"], asset("b"));
    assert!(index["assets"]["byId"]
        .get(added["id"].as_str().unwrap())
        .is_some());
    assert_eq!(index["groups"]["byId"].as_object().unwrap().len(), 2);
    assert!(warnings.is_empty());
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
}

#[test]
fn truncated_index_keeps_finished_records_without_guessing_partial_record() {
    let fixture = LibraryFixture::new();
    let raw = format!(
        r#"{{"assets":{{"byId":{{"a":{},"bad":{{"name":"unfinished"#,
        asset("a")
    );
    fixture.write(&raw);
    let (index, warnings) = list_assets_with(&fixture.dir).unwrap();
    assert_eq!(index["assets"]["byId"].as_object().unwrap().len(), 1);
    assert_eq!(index["assets"]["byId"]["a"], asset("a"));
    assert!(!warnings.is_empty());
    assert_eq!(fixture.original(), raw.as_bytes());
}

#[test]
fn wholly_unreadable_index_allows_new_import_and_preserves_raw_bytes() {
    let fixture = LibraryFixture::new();
    let raw = b"broken\xff index";
    fixture.write(raw);
    fs::write(fixture.path.join("assets/original.png"), b"old").unwrap();
    let (index, warnings) = list_assets_with(&fixture.dir).unwrap();
    assert_eq!(index["assets"]["byId"], json!({}));
    assert!(!warnings.is_empty());
    let added = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").unwrap();
    assert!(list_assets_with(&fixture.dir).unwrap().0["assets"]["byId"]
        .get(added["id"].as_str().unwrap())
        .is_some());
    assert_eq!(fixture.backups(), vec![raw.to_vec()]);
    assert_eq!(
        fs::read(fixture.path.join("assets/original.png")).unwrap(),
        b"old"
    );
}

#[test]
fn malformed_journal_still_blocks_writes_but_not_healthy_index_view() {
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    fs::write(fixture.path.join("asset-delete-journal.json"), b"broken").unwrap();
    assert_eq!(
        list_assets_with(&fixture.dir).unwrap().0["assets"]["byId"]["a"],
        asset("a")
    );
    assert!(put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").is_err());
    assert_eq!(fixture.original(), raw.as_bytes());
}

#[cfg(unix)]
#[test]
fn unknown_delete_transaction_never_cleans_media_after_index_repair() {
    use std::os::unix::fs::MetadataExt;
    let fixture = LibraryFixture::new();
    fixture.write(damaged_index());
    let path = fixture.path.join("assets/unknown.png");
    fs::write(&path, b"keep").unwrap();
    let md = fs::metadata(&path).unwrap();
    let journal = fixture.path.join("asset-delete-journal.json");
    fs::write(
        &journal,
        json!([{"id":"t1","assetId":"unknown",
        "relPath":"assets/unknown.png","trashName":"assets/.trash/t1",
        "identity":{"dev":md.dev(),"ino":md.ino()}}])
        .to_string(),
    )
    .unwrap();
    let (_, warnings) = list_assets_with(&fixture.dir).unwrap();
    assert!(!warnings.is_empty());
    assert_eq!(fs::read(&path).unwrap(), b"keep");
    update_meta_with(&fixture.dir, "a", &json!({"name":"新名称"})).unwrap();
    list_assets_with(&fixture.dir).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"keep");
    let saved: Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(saved[0]["indexUncertain"], true);
}

#[cfg(unix)]
#[test]
fn failed_backup_blocks_index_replacement_and_retry_recovers() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o500)).unwrap();
    let result = update_meta_with(&fixture.dir, "a", &json!({"name":"新名称"}));
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fixture.original(), raw.as_bytes());
    assert!(fixture.backups().is_empty());
    update_meta_with(&fixture.dir, "a", &json!({"name":"新名称"})).unwrap();
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
}

#[test]
fn oversized_uncertainty_journal_is_not_written() {
    let fixture = LibraryFixture::new();
    fixture.write(damaged_index());
    let mut journal = json!([{"id":"t","assetId":"unknown","relPath":"assets/u.png",
        "trashName":"assets/.trash/t", "identity":{"dev":1,"ino":1}}]);
    let padding = crate::library_fs::INDEX_MAX_BYTES - journal.to_string().len() - 10;
    journal[0]["id"] = json!("t".repeat(padding + 1));
    let original = journal.to_string();
    fs::write(fixture.path.join("asset-delete-journal.json"), &original).unwrap();
    assert!(list_assets_with(&fixture.dir).is_err());
    assert_eq!(
        fs::read_to_string(fixture.path.join("asset-delete-journal.json")).unwrap(),
        original
    );
}

#[test]
fn healthy_asset_can_be_deleted_from_corrupt_index_without_losing_other_records() {
    for media_exists in [false, true] {
        let fixture = LibraryFixture::new();
        let raw = damaged_index();
        fixture.write(&raw);
        if media_exists {
            fs::write(fixture.path.join("assets/a.png"), b"image-a").unwrap();
        }
        crate::library_journal::delete_asset_transacted(&fixture.dir, "a").unwrap();
        let (index, _) = list_assets_with(&fixture.dir).unwrap();
        assert!(index["assets"]["byId"].get("a").is_none());
        assert_eq!(index["assets"]["byId"]["b"], asset("b"));
        assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
        assert!(!fixture.path.join("assets/a.png").exists());
    }
}

#[test]
fn healthy_asset_imports_into_project_without_rewriting_corrupt_library() {
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    fs::write(fixture.path.join("assets/a.png"), b"image-a").unwrap();
    let projects = fixture.path.join("projects");
    fs::create_dir(&projects).unwrap();
    fs::write(projects.join("p-1.json"), b"{}").unwrap();
    let project_dir = Dir::open_ambient_dir(&projects, ambient_authority()).unwrap();
    let pending = crate::assets::project_media::PendingProjectAssets::new();
    let imported = crate::assets::import_asset_from_library(
        &project_dir,
        &fixture.dir,
        "p-1",
        "a",
        &pending,
        &mut |_| {},
    )
    .unwrap();
    let target = projects
        .join("p-1")
        .join(imported["relPath"].as_str().unwrap());
    assert_eq!(fs::read(target).unwrap(), b"image-a");
    assert_ne!(imported["id"], "a");
    assert_eq!(fixture.original(), raw.as_bytes());
    assert!(fixture.backups().is_empty());
}

#[test]
fn mismatched_member_cannot_expose_or_persist_nested_asset() {
    let fixture = LibraryFixture::new();
    let raw = format!(
        r#"{{"groups":{{"byId":{{"g":{{"id":"g","name":"组","kind":"other"}}}}}},"assets":{{"byId":{{"a":{},"bad":{{"nested":],"fake":{},"pad":[}}}}}}}}"#,
        asset("a"),
        asset("fake"),
    );
    fixture.write(&raw);
    fs::write(fixture.path.join("assets/fake.png"), b"unconfirmed").unwrap();
    let (index, warnings) = list_assets_with(&fixture.dir).unwrap();
    assert!(!warnings.is_empty());
    assert_eq!(index["assets"]["byId"], json!({"a":asset("a")}));
    assert_eq!(index["groups"]["byId"]["g"]["name"], "组");
    assert!(crate::media_protocol::open_media_with(&fixture.dir, "fake", &mut |_| {}).is_err());
    assert_eq!(fixture.original(), raw.as_bytes());
    update_meta_with(&fixture.dir, "a", &json!({"name":"保留的资产"})).unwrap();
    let (saved, _) = list_assets_with(&fixture.dir).unwrap();
    assert_eq!(saved["assets"]["byId"].as_object().unwrap().len(), 1);
    assert_eq!(saved["assets"]["byId"]["a"]["name"], "保留的资产");
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
    assert_eq!(
        fs::read(fixture.path.join("assets/fake.png")).unwrap(),
        b"unconfirmed"
    );
}

#[cfg(unix)]
#[test]
fn failed_import_backup_leaves_no_media_across_retries() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    let assets = fixture.path.join("assets");
    fs::write(assets.join("a.png"), b"original-a").unwrap();
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o500)).unwrap();
    let attempts: Vec<_> = (0..3)
        .map(|_| {
            let failed =
                put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").is_err();
            (failed, fs::read_dir(&assets).unwrap().count())
        })
        .collect();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(attempts, vec![(true, 1); 3]);
    assert_eq!(fixture.original(), raw.as_bytes());
    assert!(fixture.backups().is_empty());
    let added = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").unwrap();
    let (index, _) = list_assets_with(&fixture.dir).unwrap();
    assert_eq!(index["assets"]["byId"]["a"], asset("a"));
    assert!(index["assets"]["byId"]
        .get(added["id"].as_str().unwrap())
        .is_some());
    assert_eq!(fs::read_dir(&assets).unwrap().count(), 2);
    assert_eq!(fs::read(assets.join("a.png")).unwrap(), b"original-a");
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
}

#[cfg(unix)]
#[test]
fn failed_import_media_keeps_original_index_and_backup() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    let assets = fixture.path.join("assets");
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o500)).unwrap();
    let attempts: Vec<_> = (0..3)
        .map(|_| {
            let reopened = Dir::open_ambient_dir(&fixture.path, ambient_authority()).unwrap();
            let failed =
                put_asset_with(&reopened, "new.png", "image/png", "other", b"new").is_err();
            (failed, fixture.backups().len())
        })
        .collect();
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(attempts, vec![(true, 1); 3]);
    assert_eq!(fixture.original(), raw.as_bytes());
    assert_eq!(fixture.backups(), vec![raw.as_bytes().to_vec()]);
    assert_eq!(fs::read_dir(&assets).unwrap().count(), 0);
    let added = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").unwrap();
    let (index, _) = list_assets_with(&fixture.dir).unwrap();
    assert!(index["assets"]["byId"]
        .get(added["id"].as_str().unwrap())
        .is_some());
    assert_eq!(fs::read_dir(&assets).unwrap().count(), 1);
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
}

#[cfg(unix)]
#[test]
fn index_commit_failure_after_media_preserves_recovery_evidence() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    let (mut index, _) = list_assets_with(&fixture.dir).unwrap();
    index["assets"]["byId"]["new"] = asset("new");
    let assets = assets_root(&fixture.dir).unwrap();
    let result = write_index_with(&fixture.dir, &index, || {
        atomic_write_with(&assets, "new.png", |file| {
            std::io::Write::write_all(file, b"new")
        })?;
        // 模拟媒体成功之后索引目录不可写；最终索引提交仍须显式失败。
        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o500)).unwrap();
        Ok(())
    });
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fixture.original(), raw.as_bytes());
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
    assert_eq!(
        fs::read(fixture.path.join("assets/new.png")).unwrap(),
        b"new"
    );
    assert!(list_assets_with(&fixture.dir).unwrap().0["assets"]["byId"]
        .get("new")
        .is_none());
}

#[cfg(unix)]
#[test]
fn changed_damaged_original_keeps_distinct_backups() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let first = damaged_index();
    let second = first.replace("BROKEN", "OTHER_BROKEN");
    let assets = fixture.path.join("assets");
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o500)).unwrap();
    let attempts: Vec<_> = [&first, &second, &second]
        .into_iter()
        .map(|raw| {
            fixture.write(raw);
            let failed =
                put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").is_err();
            (failed, fixture.backups().len())
        })
        .collect();
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(attempts, [(true, 1), (true, 2), (true, 2)]);
    assert_eq!(fixture.original(), second.as_bytes());
    assert!(fixture.backups().contains(&first.into_bytes()));
    assert!(fixture.backups().contains(&second.into_bytes()));
    assert_eq!(fs::read_dir(assets).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn mismatched_existing_backup_blocks_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = LibraryFixture::new();
    let raw = damaged_index();
    fixture.write(&raw);
    let assets = fixture.path.join("assets");
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o500)).unwrap();
    let failed = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new");
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.is_err());
    let path = fixture.only_backup_path();
    let mut changed = raw.as_bytes().to_vec();
    changed[0] = b'[';
    fs::write(&path, &changed).unwrap();
    assert!(put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").is_err());
    assert_eq!(fixture.original(), raw.as_bytes());
    assert_eq!(fixture.backups(), vec![changed]);
    assert_eq!(fs::read_dir(&assets).unwrap().count(), 0);
    fs::write(&path, &raw).unwrap();
    put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").unwrap();
    assert_eq!(fixture.backups(), vec![raw.into_bytes()]);
    assert_eq!(fs::read_dir(assets).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn unsafe_existing_backup_blocks_replacement() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for use_symlink in [false, true] {
        let fixture = LibraryFixture::new();
        let raw = damaged_index();
        fixture.write(&raw);
        let assets = fixture.path.join("assets");
        fs::set_permissions(&assets, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new");
        fs::set_permissions(&assets, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(failed.is_err());
        let path = fixture.only_backup_path();
        fs::remove_file(&path).unwrap();
        let target = fixture.path.join("original-copy");
        fs::write(&target, &raw).unwrap();
        if use_symlink {
            symlink(&target, &path).unwrap();
        } else {
            fs::create_dir(&path).unwrap();
        }
        assert!(put_asset_with(&fixture.dir, "new.png", "image/png", "other", b"new").is_err());
        assert_eq!(fixture.original(), raw.as_bytes());
        assert_eq!(fs::read(target).unwrap(), raw.as_bytes());
        assert_eq!(fs::read_dir(&assets).unwrap().count(), 0);
    }
}
