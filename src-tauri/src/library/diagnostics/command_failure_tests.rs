//! PR #222：业务拒绝不能丢弃命令已经完成的恢复；临时文件系统保留真实现场。

use super::*;

/// 以旧列表提供常规积压，再还原未提交索引和占用者，制造 warning-only 冲突。
fn conflict_fixture() -> (Fixture, Value, PathBuf, PathBuf) {
    let fixture = Fixture::new();
    let library = fixture.open();
    let asset = put_asset_with(
        &library,
        "a.png",
        "image/png",
        "reference",
        b"original",
        &mut |_| {},
    )
    .unwrap();
    let index = fs::read(fixture.0.join("library.json")).unwrap();
    crate::library_journal::delete_asset_transacted(
        &library,
        asset["id"].as_str().unwrap(),
        &mut |_| {},
    )
    .unwrap();
    let old = with_snapshot(&library, list_response, |_| {}).unwrap();
    assert_eq!(old["cleanupPending"].as_array().unwrap().len(), 1);
    let journal: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("asset-delete-journal.json")).unwrap())
            .unwrap();
    let trash = fixture.0.join(journal[0]["trashName"].as_str().unwrap());
    let original = fixture.0.join(asset["relPath"].as_str().unwrap());
    fs::write(fixture.0.join("library.json"), index).unwrap();
    fs::write(&original, b"occupant").unwrap();
    (fixture, old, trash, original)
}

/// 真实业务内核先恢复，再因合法但不存在的目标拒绝；事件序列化作为观察边界。
fn missing_command(library: &Dir, command: &str, events: &mut Vec<Value>) -> LibraryError {
    with_snapshot(
        library,
        |library, report| match command {
            "update" => update_meta_with(library, "la-missing", &json!({"name":"new"}), report),
            "delete" => {
                crate::library_journal::delete_asset_transacted(library, "la-missing", report)
            }
            "delete_group" => group_commands::delete_group_with(library, "g-missing", report),
            _ => unreachable!(),
        },
        |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
    )
    .unwrap_err()
}

#[test]
fn failed_commands_publish_warning_only_recovery_and_preserve_evidence() {
    for command in ["update", "delete", "delete_group"] {
        let (fixture, old, trash, original) = conflict_fixture();
        let mut events = Vec::new();
        let error = missing_command(&fixture.open(), command, &mut events);
        assert!(matches!(error, LibraryError::NotFound { .. }));
        assert_eq!(events.len(), 1, "{command}: 已完成恢复须可见");
        assert!(!events[0]["warnings"].as_array().unwrap().is_empty());
        assert_eq!(events[0]["cleanupPending"], json!([]));
        assert!(revision(&events[0]) > revision(&old));
        assert_eq!(fs::read(trash).unwrap(), b"original");
        assert_eq!(fs::read(original).unwrap(), b"occupant");
        assert!(
            revision(&with_snapshot(&fixture.open(), list_response, |_| {}).unwrap())
                > revision(&events[0])
        );
    }
}

#[test]
fn failed_commands_publish_completed_cleanup_without_reviving_old_pending() {
    for command in ["update", "delete", "delete_group"] {
        let (fixture, old, trash, original) = conflict_fixture();
        fs::write(
            fixture.0.join("library.json"),
            br#"{"assets":{"byId":{}},"groups":{"byId":{}}}"#,
        )
        .unwrap();
        fs::remove_file(trash).unwrap();
        fs::remove_file(original).unwrap();
        let mut events = Vec::new();
        assert!(matches!(
            missing_command(&fixture.open(), command, &mut events),
            LibraryError::NotFound { .. }
        ));
        assert_eq!(events.len(), 1, "{command}");
        assert_eq!(events[0]["warnings"], json!([]));
        assert_eq!(events[0]["cleanupPending"], json!([]));
        assert!(revision(&events[0]) > revision(&old));
        let journal: Value =
            serde_json::from_slice(&fs::read(fixture.0.join("asset-delete-journal.json")).unwrap())
                .unwrap();
        assert_eq!(journal, json!([]));
    }
}

/// 六个生产内核使用同一观察边界；有效参数使故障只发生在选定恢复阶段。
fn command_operation(
    library: &Dir,
    command: &str,
    id: &str,
    report: &mut dyn FnMut(&Recovery),
) -> Result<Value, LibraryError> {
    match command {
        "list" => list_response(library, report),
        "import" => put_asset_with(library, "new.png", "image/png", "reference", b"new", report),
        "update" => update_meta_with(library, id, &json!({"name":"new"}), report),
        "delete" => crate::library_journal::delete_asset_transacted(library, id, report),
        "upsert_group" => group_commands::upsert_group_with(
            library,
            &json!({"id":"g1","name":"组","kind":"reference"}),
            report,
        ),
        "delete_group" => group_commands::delete_group_with(library, "g1", report),
        _ => unreachable!(),
    }
}

#[test]
fn all_commands_publish_completed_recovery_on_io_failure_then_retry_with_final_response() {
    for command in [
        "list",
        "import",
        "update",
        "delete",
        "upsert_group",
        "delete_group",
    ] {
        let fixture = Fixture::new();
        let library = fixture.open();
        let asset = command_operation(&library, "import", "", &mut |_| {}).unwrap();
        command_operation(&library, "upsert_group", "", &mut |_| {}).unwrap();
        let index_path = fixture.0.join("library.json");
        let original = fs::read(&index_path).unwrap();
        let mut events = Vec::new();
        let failed = with_snapshot(
            &library,
            |dir, report| {
                command_operation(
                    dir,
                    command,
                    asset["id"].as_str().unwrap(),
                    &mut |recovery| {
                        report(recovery);
                        // 真实 I/O 拒绝：完成恢复后，下一次索引读取遇到目录。
                        fs::remove_file(&index_path).unwrap();
                        fs::create_dir(&index_path).unwrap();
                    },
                )
            },
            |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
        );
        assert!(failed.is_err(), "{command}");
        assert_eq!(events.len(), 1, "{command}");
        assert_eq!(events[0]["cleanupPending"], json!([]));
        let previous = revision(&events[0]);
        events.clear();
        // 恢复自身仍失败：不能发布伪空快照。
        assert!(with_snapshot(
            &library,
            |dir, report| command_operation(dir, command, asset["id"].as_str().unwrap(), report),
            |snapshot| events.push(serde_json::to_value(snapshot).unwrap())
        )
        .is_err());
        assert!(events.is_empty());
        fs::remove_dir(&index_path).unwrap();
        fs::write(&index_path, original).unwrap();
        let result = with_snapshot(
            &library,
            |dir, report| command_operation(dir, command, asset["id"].as_str().unwrap(), report),
            |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
        )
        .unwrap();
        assert!(events.is_empty(), "成功仅响应，不能先发同序号的旧恢复状态");
        assert!(revision(&result) > previous);
        if command == "delete" {
            assert_eq!(result["cleanupPending"].as_array().unwrap().len(), 1);
        }
    }
}

#[test]
fn validation_before_recovery_does_not_emit_an_observation() {
    let fixture = Fixture::new();
    let library = fixture.open();
    for command in ["import", "update", "upsert_group", "delete_group"] {
        let mut events = Vec::new();
        let error = with_snapshot(
            &library,
            |dir, report| match command {
                "import" => put_asset_with(dir, "", "image/png", "reference", b"new", report),
                "update" => update_meta_with(dir, "la-missing", &Value::Null, report),
                "upsert_group" => group_commands::upsert_group_with(dir, &Value::Null, report),
                "delete_group" => group_commands::delete_group_with(dir, "../invalid", report),
                _ => unreachable!(),
            },
            |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
        )
        .unwrap_err();
        assert!(matches!(error, LibraryError::InvalidInput { .. }));
        assert!(events.is_empty());
        assert!(!fixture.0.join("library.json").exists());
    }
}

#[test]
fn group_kind_conflict_keeps_recovery_warning_and_index_unchanged() {
    let (fixture, _, trash, original) = conflict_fixture();
    let index_path = fixture.0.join("library.json");
    let mut index: Value = serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    index["groups"]["byId"]["g1"] = json!({"id":"g1","name":"组","kind":"reference"});
    index["assets"]["byId"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["groupId"] = json!("g1");
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(&index_path, &bytes).unwrap();
    let mut events = Vec::new();
    let error = with_snapshot(
        &fixture.open(),
        |dir, report| {
            group_commands::upsert_group_with(
                dir,
                &json!({"id":"g1","name":"组","kind":"other"}),
                report,
            )
        },
        |snapshot| events.push(serde_json::to_value(snapshot).unwrap()),
    )
    .unwrap_err();
    assert!(matches!(error, LibraryError::Refused { .. }));
    assert_eq!(events.len(), 1);
    assert!(!events[0]["warnings"].as_array().unwrap().is_empty());
    assert_eq!(fs::read(index_path).unwrap(), bytes);
    assert_eq!(fs::read(trash).unwrap(), b"original");
    assert_eq!(fs::read(original).unwrap(), b"occupant");
}
