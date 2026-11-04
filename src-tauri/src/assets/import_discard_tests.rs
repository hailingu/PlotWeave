//! Real project/library fixtures prove quarantine bytes and acceptance safeguards (issue #864).
use super::tests::{pending, seed_library};
use super::*;
use crate::library_fixture::{cap, cleanup, project_fixture};
use crate::store::testutil::valid_save_doc;
use std::fs;

/// Import a fresh real library copy into a valid persisted project.
pub(super) fn imported() -> (
    std::path::PathBuf,
    std::path::PathBuf,
    project_media::PendingProjectAssets,
    Value,
) {
    let (projects, library, root) = project_fixture();
    let mut doc = valid_save_doc();
    doc.project.id = "p-1".into();
    fs::write(projects.join("p-1.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    seed_library(&library, "la-1", "source.png", b"copied bytes", "image/png");
    let pending = pending();
    let asset = import_asset_from_library(
        &cap(&projects),
        &cap(&library),
        "p-1",
        "la-1",
        &pending,
        &mut |_| {},
    )
    .unwrap();
    (projects, root, pending, asset)
}

#[test]
fn discard_preserves_quarantined_bytes_and_durable_receipt() {
    let (projects, root, pending, asset) = imported();
    let id = asset["id"].as_str().unwrap();
    import_discard::discard(&cap(&projects), "p-1", id, &pending).unwrap();
    assert!(!projects
        .join("p-1")
        .join(asset["relPath"].as_str().unwrap())
        .exists());
    let trash = projects.join("p-1/assets/.trash");
    let slots: Vec<_> = fs::read_dir(trash).unwrap().collect();
    assert_eq!(slots.len(), 1);
    let slot = slots[0].as_ref().unwrap().path();
    assert_eq!(fs::read(slot.join("media")).unwrap(), b"copied bytes");
    let record: Value =
        serde_json::from_slice(&fs::read(slot.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(record["assetId"], asset["id"]);
    assert!(import_discard::discard(&cap(&projects), "p-1", id, &pending).is_err());
    cleanup(&root);
}

#[test]
fn accepted_then_undone_import_never_regains_discard_authority() {
    let (projects, root, pending, asset) = imported();
    let id = asset["id"].as_str().unwrap();
    let mut doc = valid_save_doc();
    doc.project.id = "p-1".into();
    doc.assets = json!({"byId": {id: asset}});
    fs::write(projects.join("p-1.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    assert!(import_discard::discard(&cap(&projects), "p-1", id, &pending).is_err());
    import_discard::retire(&pending, "p-1", &doc.assets);
    doc.assets = json!({"byId": {}});
    fs::write(projects.join("p-1.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    assert!(import_discard::discard(&cap(&projects), "p-1", id, &pending).is_err());
    assert_eq!(
        fs::read(
            projects
                .join("p-1")
                .join(asset["relPath"].as_str().unwrap())
        )
        .unwrap(),
        b"copied bytes"
    );
    cleanup(&root);
}

#[test]
fn replacement_inode_is_preserved() {
    let (projects, root, pending, asset) = imported();
    let path = projects
        .join("p-1")
        .join(asset["relPath"].as_str().unwrap());
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"replacement").unwrap();
    assert!(import_discard::discard(
        &cap(&projects),
        "p-1",
        asset["id"].as_str().unwrap(),
        &pending
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    cleanup(&root);
}
