//! Issue #851: real filesystem vectors verify per-entry isolation at the listing boundary.

use super::*;
use crate::library_fixture::{by_id, cap, cleanup, entry, temp_fixture, write_index_raw};
use std::fs;

/// Each host consumes these same physical media states rather than duplicating verdict tables.
#[test]
#[cfg(unix)]
fn shared_library_media_vectors_isolate_only_unavailable_entries() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../crates/plotweave-core/testdata/asset-contract.json"
    ))
    .unwrap();
    for row in vectors["libraryMedia"].as_array().unwrap() {
        let (library, root) = temp_fixture();
        let id = row["id"].as_str().unwrap();
        let rel = row["relPath"].as_str().unwrap();
        prepare_media(&library, id);
        fs::write(library.join("assets/healthy.png"), b"healthy").unwrap();
        write_index_raw(
            &library,
            &json!({"assets": by_id([
            entry(id, rel), entry("healthy", "assets/healthy.png")
        ]), "groups": {"byId": {}}}),
        );
        let original = fs::read(library.join("library.json")).unwrap();
        for _ in 0..2 {
            let (index, warnings) = list_assets_with(&cap(&library), &mut |_| {}).unwrap();
            assert_eq!(
                index["assets"]["byId"].get(id).is_some(),
                row["available"].as_bool().unwrap(),
                "{id}"
            );
            assert!(index["assets"]["byId"].get("healthy").is_some());
            assert_eq!(
                warnings.iter().any(|w| w.contains(id)),
                !row["available"].as_bool().unwrap(),
                "{id}: {warnings:?}"
            );
            assert_eq!(fs::read(library.join("library.json")).unwrap(), original);
            assert_eq!(
                fs::read(library.join("assets/healthy.png")).unwrap(),
                b"healthy"
            );
            assert_eq!(
                fs::read(library.join("outside/media.png")).unwrap(),
                b"outside"
            );
        }
        cleanup(&root);
    }
}

/// Creates untrusted leaf and intermediate components, retaining outside bytes as a sentinel.
#[cfg(unix)]
fn prepare_media(library: &std::path::Path, kind: &str) {
    use std::os::unix::fs::symlink;
    fs::create_dir(library.join("outside")).unwrap();
    fs::write(library.join("outside/media.png"), b"outside").unwrap();
    let target = library.join("assets/media.png");
    match kind {
        "regular" => fs::write(target, b"media").unwrap(),
        "nested-regular" => {
            fs::create_dir(library.join("assets/nested")).unwrap();
            fs::write(library.join("assets/nested/media.png"), b"media").unwrap();
        }
        "missing" | "parent-missing" => {}
        "symlink" => symlink("../outside/media.png", target).unwrap(),
        "directory" => fs::create_dir(target).unwrap(),
        "fifo" => {
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }
        "parent-symlink" => symlink("../outside", library.join("assets/nested")).unwrap(),
        "parent-file" => fs::write(library.join("assets/nested"), b"file").unwrap(),
        _ => panic!("unknown shared media vector: {kind}"),
    }
}

/// A missing assets root is a read-side rejection, never a reason to create a directory.
#[test]
fn listing_missing_assets_root_does_not_create_it() {
    let (library, root) = temp_fixture();
    fs::remove_dir(library.join("assets")).unwrap();
    write_index_raw(
        &library,
        &json!({"assets": by_id([entry("missing", "assets/a.png")]), "groups": {"byId": {}}}),
    );
    let (index, warnings) = list_assets_with(&cap(&library), &mut |_| {}).unwrap();
    assert!(index["assets"]["byId"].as_object().unwrap().is_empty());
    assert!(!warnings.is_empty());
    assert!(!library.join("assets").exists());
    cleanup(&root);
}

/// A previously available path is rechecked; restoring media makes the same id safely deletable.
#[test]
fn listing_rechecks_media_and_restored_asset_can_be_deleted() {
    let (library, root) = temp_fixture();
    let asset = put_asset_with(
        &cap(&library),
        "a.png",
        "image/png",
        "other",
        b"old",
        &mut |_| {},
    )
    .unwrap();
    let id = asset["id"].as_str().unwrap();
    let media = library.join(asset["relPath"].as_str().unwrap());
    assert!(
        list_assets_with(&cap(&library), &mut |_| {}).unwrap().0["assets"]["byId"]
            .get(id)
            .is_some()
    );
    fs::remove_file(&media).unwrap();
    fs::create_dir(&media).unwrap();
    let (index, warnings) = list_assets_with(&cap(&library), &mut |_| {}).unwrap();
    assert!(index["assets"]["byId"].get(id).is_none());
    assert!(warnings.iter().any(|warning| warning.contains(id)));
    assert!(media.is_dir());
    fs::remove_dir(&media).unwrap();
    fs::write(&media, b"restored").unwrap();
    assert!(
        list_assets_with(&cap(&library), &mut |_| {}).unwrap().0["assets"]["byId"]
            .get(id)
            .is_some()
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), id, &mut |_| {}).unwrap();
    assert!(
        list_assets_with(&cap(&library), &mut |_| {}).unwrap().0["assets"]["byId"]
            .get(id)
            .is_none()
    );
    cleanup(&root);
}

/// Missing media in an unfinished deletion remains visible conflict evidence instead of being filtered away.
#[test]
#[cfg(unix)]
fn listing_preserves_conflicted_transaction_with_missing_media() {
    use crate::library_fixture::{
        file_identity, journal_entry_json, read_journal_raw, write_journal_raw,
    };
    let (library, root) = temp_fixture();
    fs::create_dir(library.join("assets/.trash")).unwrap();
    fs::write(library.join("assets/a.png"), b"original").unwrap();
    let (dev, ino) = file_identity(&library.join("assets/a.png"));
    fs::remove_file(library.join("assets/a.png")).unwrap();
    write_index_raw(
        &library,
        &json!({"assets": by_id([entry("a", "assets/a.png")]), "groups": {"byId": {}}}),
    );
    write_journal_raw(
        &library,
        json!([journal_entry_json(
            "t-a",
            "a",
            "assets/a.png",
            "assets/.trash/t-a",
            dev,
            ino
        )]),
    );
    for _ in 0..2 {
        let mut pending = Value::Null;
        let (index, warnings) = list_assets_with(&cap(&library), &mut |recovery| {
            pending = json!(recovery.cleanup_pending);
        })
        .unwrap();
        assert_eq!(index["assets"]["byId"]["a"]["conflicted"], true);
        assert_eq!(index["cleanupPending"], pending);
        assert!(!warnings.is_empty());
        assert_eq!(read_journal_raw(&library).as_array().unwrap().len(), 1);
    }
    cleanup(&root);
}

/// Invalid assets roots fail per entry without following links or changing the root's identity.
#[test]
#[cfg(unix)]
fn listing_isolates_untrusted_assets_roots_without_mutation() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    for kind in ["symlink", "directory-file", "fifo"] {
        let (library, root) = temp_fixture();
        fs::remove_dir(library.join("assets")).unwrap();
        fs::create_dir(library.join("outside")).unwrap();
        fs::write(library.join("outside/media.png"), b"outside").unwrap();
        let target = library.join("assets");
        match kind {
            "symlink" => symlink("outside", &target).unwrap(),
            "directory-file" => fs::write(&target, b"file").unwrap(),
            "fifo" => {
                let name = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => unreachable!(),
        }
        write_index_raw(
            &library,
            &json!({"assets": by_id([entry("a", "assets/media.png")]), "groups": {"byId": {}}}),
        );
        let before = fs::symlink_metadata(&target).unwrap();
        let (index, warnings) = list_assets_with(&cap(&library), &mut |_| {}).unwrap();
        assert!(
            index["assets"]["byId"].as_object().unwrap().is_empty(),
            "{kind}"
        );
        assert!(warnings.iter().any(|warning| warning.contains("a")));
        let after = fs::symlink_metadata(&target).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(before.file_type(), after.file_type());
        assert_eq!(
            fs::read(library.join("outside/media.png")).unwrap(),
            b"outside"
        );
        cleanup(&root);
    }
}
/// EMFILE/EIO/EACCES are transient media checks, never evidence that an indexed asset disappeared (#907).
#[test]
fn transient_media_errors_preserve_projection_and_disk() {
    use crate::store::error::StoreError;
    use std::io;
    for reason in [libc::EMFILE, libc::EIO, libc::EACCES] {
        for wrapped in [false, true] {
            let (library, root) = temp_fixture();
            let asset = entry("a", "assets/a.png");
            write_index_raw(
                &library,
                &json!({"assets": by_id([asset.clone()]), "groups": by_id([])}),
            );
            fs::write(library.join("assets/a.png"), b"media").unwrap();
            let before = fs::read(library.join("library.json")).unwrap();
            let (index, warnings) =
                super::list_assets_with_media(&cap(&library), &mut |_| {}, |_, _| {
                    let error = io::Error::from_raw_os_error(reason);
                    Err(if wrapped {
                        LibraryError::from(StoreError::io("injected", error))
                    } else {
                        LibraryError::io("injected", error)
                    })
                })
                .unwrap();
            assert_eq!(index["assets"]["byId"]["a"], asset);
            assert_eq!(warnings.len(), 1);
            assert!(warnings[0].contains("PW_LIBRARY_MEDIA_TEMPORARILY_UNAVAILABLE"));
            assert_eq!(fs::read(library.join("library.json")).unwrap(), before);
            assert_eq!(fs::read(library.join("assets/a.png")).unwrap(), b"media");
            let (retry, warnings) = list_assets_with(&cap(&library), &mut |_| {}).unwrap();
            assert_eq!(retry["assets"]["byId"]["a"], asset);
            assert!(warnings.is_empty());
            cleanup(&root);
        }
    }
}
