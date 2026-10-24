use super::*;
use crate::library_fixture as fixture;

fn metadata(total: usize) -> Metadata {
    Metadata {
        name: "参考.bmp".into(),
        mime: "image/bmp".into(),
        kind: "reference".into(),
        total,
    }
}
fn send(
    registry: &mut Registry,
    id: &str,
    total: usize,
    offset: usize,
    bytes: &[u8],
    now: Instant,
) -> Result<Step, String> {
    registry.accept(id, metadata(total), offset, &STANDARD.encode(bytes), now)
}

#[test]
fn complete_upload_preserves_bytes_and_existing_storage_diagnostics() {
    let mut registry = Registry::default();
    let bytes = vec![91; CHUNK_BYTES + 7];
    let now = Instant::now();
    assert!(matches!(
        send(
            &mut registry,
            "a",
            bytes.len(),
            0,
            &bytes[..CHUNK_BYTES],
            now
        ),
        Ok(Step::Pending(_))
    ));
    let Step::Complete(meta, actual) = send(
        &mut registry,
        "a",
        bytes.len(),
        CHUNK_BYTES,
        &bytes[CHUNK_BYTES..],
        now,
    )
    .unwrap() else {
        panic!("complete")
    };
    assert_eq!(actual, bytes);
    assert!(registry.uploads["a"].committing);
    assert!(send(&mut registry, "a", 0, 0, &[], now).is_err());
    let (library, root) = fixture::temp_fixture();
    let entry = super::super::put_asset_with(
        &fixture::cap(&library),
        &meta.name,
        &meta.mime,
        &meta.kind,
        &actual,
        &mut |_| {},
    )
    .unwrap();
    assert!(entry["cleanupPending"].is_array());
    assert_eq!(
        std::fs::read(library.join(entry["relPath"].as_str().unwrap())).unwrap(),
        bytes
    );
    fixture::cleanup(&root);
}

#[test]
fn boundaries_and_bad_continuations_release_staging() {
    let now = Instant::now();
    let mut registry = Registry::default();
    for size in [
        super::super::ASSET_MAX_BYTES - 1,
        super::super::ASSET_MAX_BYTES,
    ] {
        assert!(send(&mut registry, "a", size, 0, &[1], now).is_ok());
        assert!(send(&mut registry, "a", size, 2, &[2], now).is_err());
        assert!(registry.uploads.is_empty());
    }
    for (total, data) in [
        (0, vec![1]),
        (super::super::ASSET_MAX_BYTES + 1, vec![1]),
        (2, vec![]),
        (1, vec![1, 2]),
        (CHUNK_BYTES + 1, vec![1; CHUNK_BYTES + 1]),
    ] {
        assert!(send(&mut registry, "a", total, 0, &data, now).is_err());
        assert!(registry.uploads.is_empty());
    }
    assert!(registry.accept("a", metadata(4), 0, "!!!!", now).is_err());
    assert!(send(&mut registry, "../outside", 2, 0, &[1], now).is_err());
}

#[test]
fn slots_expire_abort_and_metadata_mismatch_releases_staging() {
    let now = Instant::now();
    let mut registry = Registry::default();
    for id in ["a", "b"] {
        assert!(send(&mut registry, id, 2, 0, &[1], now).is_ok());
    }
    assert!(send(&mut registry, "c", 2, 0, &[1], now).is_err());
    assert!(send(&mut registry, "a", 0, 0, &[], now).is_ok());
    assert!(send(&mut registry, "c", 2, 0, &[1], now).is_ok());
    assert!(send(&mut registry, "b", 2, 1, &[2], now + LIFETIME).is_err());
    assert!(registry.uploads.is_empty());
    assert!(send(&mut registry, "a", 2, 0, &[1], now).is_ok());
    let mut changed = metadata(2);
    changed.mime = "image/png".into();
    assert!(registry.accept("a", changed, 1, "Ag==", now).is_err());
    assert!(registry.uploads.is_empty());
}
