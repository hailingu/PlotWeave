//! 项目文件、会话主文件及删除行为的文件系统集成测试。

use super::*;
use crate::isotime::now_iso;
use crate::store::error::StoreError;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use std::fs;

#[test]
fn persist_project_writes_envelope_and_passes_post_verify() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "剧".into(), now_iso());
    let meta = persist_project(&cap(&projects), "p-1", doc).expect("保存");
    assert_eq!(meta.name, "剧");
    assert!(projects.join("p-1.json").exists(), "项目文件应落盘");
    cleanup_temp(&projects);
}

#[test]
fn persist_project_rejects_untrusted_id_before_any_join() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "剧".into(), now_iso());
    // 空资产索引下复验不设防：id 词法校验必须在任何路径拼接前拒绝
    let err = persist_project(&cap(&projects), "../evil", doc).unwrap_err();
    assert!(
        matches!(err.root(), StoreError::InvalidInput { ref detail } if detail.contains("非法")),
        "意外诊断：{err}"
    );
    // 不得在 projects/ 之外创建任何文件
    assert!(
        fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
        "越界 id 不应写出 projects/"
    );
    cleanup_temp(&projects);
}

#[test]
fn persist_project_replaces_existing_file_and_leaves_no_temp() {
    let projects = temp_projects_dir();
    let first = new_project_file("p-1", "一版".into(), now_iso());
    persist_project(&cap(&projects), "p-1", first).expect("首存");
    let second = new_project_file("p-1", "二版".into(), now_iso());
    persist_project(&cap(&projects), "p-1", second).expect("覆盖保存（rename 替换已存在目标）");
    let loaded = load_project_file(&cap(&projects), "p-1").expect("重读");
    assert_eq!(loaded.project.name, "二版");
    let leftovers: Vec<String> = fs::read_dir(&projects)
        .expect("扫描项目目录")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "遗留临时文件：{leftovers:?}");
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn persist_project_rejects_symlinked_target_without_following() {
    let projects = temp_projects_dir();
    let outside = projects.parent().expect("临时根").join("evil-target.json");
    fs::write(&outside, b"{}").expect("写根外文件");
    std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
    let doc = new_project_file("p-1", "剧".into(), now_iso());
    let err = persist_project(&cap(&projects), "p-1", doc).unwrap_err();
    assert!(
        matches!(err.root(), StoreError::Refused { ref detail } if detail.contains("符号链接")),
        "意外诊断：{err}"
    );
    // 链接未被跟随或覆盖：根外文件原样保留，链接本身仍在
    assert_eq!(fs::read(&outside).expect("读根外文件"), b"{}".to_vec());
    assert!(fs::symlink_metadata(projects.join("p-1.json"))
        .expect("链接仍在")
        .file_type()
        .is_symlink());
    cleanup_temp(&projects);
}

#[test]
fn load_project_file_rejects_path_like_id_before_any_join() {
    let projects = temp_projects_dir();
    // 嵌套路径形态的 id：projects/ 内的资产/私有 JSON 不得经 load_project 读出
    let err = load_project_file(&cap(&projects), "p-1/assets/private").unwrap_err();
    assert!(
        matches!(err.root(), StoreError::InvalidInput { ref detail } if detail.contains("非法")),
        "意外诊断：{err}"
    );
    cleanup_temp(&projects);
}

#[test]
fn load_project_file_reads_envelope_from_verified_handle() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "午夜出租车".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("先保存");
    let loaded = load_project_file(&cap(&projects), "p-1").expect("从已验证句柄读取");
    assert_eq!(loaded.project.name, "午夜出租车");
    assert_eq!(loaded.schema_version, 1);
    cleanup_temp(&projects);
}

#[test]
fn delete_project_files_removes_nested_asset_subtrees() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(assets.join("sub").join("deep")).expect("建嵌套目录");
    fs::write(assets.join("a.png"), b"A").expect("写资产");
    fs::write(assets.join("sub").join("b.png"), b"B").expect("写子目录资产");
    fs::write(assets.join("sub").join("deep").join("c.png"), b"C").expect("写深层资产");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    delete_project_files(&cap(&projects), "p-1").expect("删除项目");
    assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
    assert!(fs::symlink_metadata(projects.join("p-1.json")).is_err());
    cleanup_temp(&projects);
}

#[test]
fn delete_project_files_removes_json_and_asset_tree_idempotently() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    fs::write(assets.join("a.png"), b"A").expect("写资产");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    delete_project_files(&cap(&projects), "p-1").expect("删除项目");
    assert!(fs::symlink_metadata(projects.join("p-1.json")).is_err());
    assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
    // 幂等：文件与目录均已缺失时再删不报错
    assert!(delete_project_files(&cap(&projects), "p-1").is_ok());
    cleanup_temp(&projects);
}

#[test]
fn ai_session_round_trips_in_its_own_project_file() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "msg", "role": "user", "text": "保留讨论" }]
    });
    save_ai_session_file(&cap(&projects), "p-1", &session).expect("保存会话");
    assert_eq!(
        load_ai_session_file(&cap(&projects), "p-1")
            .expect("读取会话")
            .session,
        Some(session)
    );
    assert!(projects.join("p-1").join("ai-session.json").exists());
    assert!(
        projects.join("p-1.json").exists(),
        "会话不得混入画布项目文件"
    );
    cleanup_temp(&projects);
}

#[test]
fn ai_session_save_requires_existing_project_record() {
    let projects = temp_projects_dir();
    let session = serde_json::json!({ "schemaVersion": 1, "entries": [] });
    let err = save_ai_session_file(&cap(&projects), "p-1", &session)
        .expect_err("已删除项目不得被迟到会话保存重建");
    assert!(
        matches!(err.root(), StoreError::NotFound { ref detail } if detail.contains("项目不存在")),
        "意外诊断：{err}"
    );
    assert!(
        fs::symlink_metadata(projects.join("p-1")).is_err(),
        "拒绝保存不得创建项目会话目录"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn delete_project_files_unlinks_symlinks_without_following() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    let outside_dir = projects.parent().expect("临时根").join("keep");
    fs::create_dir_all(&outside_dir).expect("建根外目录");
    fs::write(outside_dir.join("secret.png"), b"s").expect("写根外文件");
    std::os::unix::fs::symlink(&outside_dir, assets.join("link")).expect("建目录符号链接");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    delete_project_files(&cap(&projects), "p-1").expect("删除项目");
    // 链接被移除但未跟随：根外目录与文件原样保留
    assert!(fs::symlink_metadata(outside_dir.join("secret.png")).is_ok());
    assert!(fs::symlink_metadata(&outside_dir).is_ok());
    assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn delete_project_files_keeps_record_when_asset_tree_removal_fails() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    fs::write(assets.join("a.png"), b"A").expect("写资产");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    // 只读化资产目录：子项删除失败（非 root 用户无法 unlink）
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&assets).unwrap().permissions();
    perms.set_mode(0o555);
    fs::set_permissions(&assets, perms).expect("只读化");
    let result = delete_project_files(&cap(&projects), "p-1");
    let mut perms = fs::metadata(&assets).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&assets, perms);
    let err = result.expect_err("资产目录删除失败应显式报错");
    assert!(
        matches!(err.root(), StoreError::Io { .. }),
        "删除失败应为底层 I/O 类别：{err:?}"
    );
    // 展示边界契约（PR #179 评审修复）：条目名括注必须闭合，
    // 文案与历史 format! 形态逐字一致
    assert!(
        err.to_string().starts_with("移除条目失败（\"a.png\"）："),
        "实际文案：{err}"
    );
    // 权威项目文件必须仍在：项目可发现、删除可重试，不留孤儿媒体树
    assert!(
        projects.join("p-1.json").exists(),
        "项目记录先于资产目录被删，失败后媒体成不可发现孤儿"
    );
    cleanup_temp(&projects);
}

/// #47 单实例边界：旧 PR 写入的序号不再阻止当前主文件被正常更新。
#[test]
fn ai_session_single_writer_replaces_legacy_sequence() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("项目记录");
    let first = serde_json::json!({"schemaVersion": 1, "entries": [], "writeSeq": 20});
    save_ai_session_file(&cap(&projects), "p-1", &first).expect("旧主文件");
    let latest = serde_json::json!({
        "schemaVersion": 1, "entries": [{"id": 1, "kind": "note", "text": "最新消息"}]
    });
    let result = save_ai_session_file(&cap(&projects), "p-1", &latest);
    let loaded = load_ai_session_file(&cap(&projects), "p-1").expect("加载");
    cleanup_temp(&projects);
    assert!(result.is_ok(), "单实例保存不得被旧序号拒绝：{result:?}");
    assert_eq!(loaded.session, Some(latest));
}

/// 会话缺失、损坏、不可读是不同的加载结果，均由真实文件系统边界验证。
#[test]
fn ai_session_load_distinguishes_missing_corrupt_and_unreadable() {
    let projects = temp_projects_dir();
    let missing = load_ai_session_file(&cap(&projects), "p-1").expect("缺失合法");
    assert!(missing.session.is_none());
    assert!(!missing.corrupt);
    fs::create_dir(projects.join("p-1")).expect("项目目录");
    let path = projects.join("p-1/ai-session.json");
    for body in ["invalid json", r#"{"schemaVersion":2,"entries":[]}"#] {
        fs::write(&path, body).expect("损坏文件");
        let loaded = load_ai_session_file(&cap(&projects), "p-1").expect("损坏可诊断");
        assert!(loaded.session.is_none());
        assert!(loaded.corrupt);
    }
    fs::remove_file(&path).expect("移除文件");
    fs::create_dir(&path).expect("用目录占位");
    assert!(load_ai_session_file(&cap(&projects), "p-1").is_err());
    cleanup_temp(&projects);
}

/// 保存失败必须保留原主文件，之后可由下一次明确保存恢复。
#[cfg(unix)]
#[test]
fn ai_session_failed_write_preserves_main_and_next_save_succeeds() {
    use std::os::unix::fs::PermissionsExt;
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("项目记录");
    let first = serde_json::json!({"schemaVersion":1,"entries":[]});
    save_ai_session_file(&cap(&projects), "p-1", &first).expect("首次保存");
    let dir = projects.join("p-1");
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).expect("只读化");
    let latest = serde_json::json!({"schemaVersion":1,"entries":[{"text":"新内容"}]});
    let failed = save_ai_session_file(&cap(&projects), "p-1", &latest);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).expect("恢复权限");
    let retained = load_ai_session_file(&cap(&projects), "p-1").expect("读取旧文件");
    assert!(failed.is_err());
    assert_eq!(retained.session, Some(first));
    save_ai_session_file(&cap(&projects), "p-1", &latest).expect("再次保存");
    let loaded = load_ai_session_file(&cap(&projects), "p-1").expect("重新加载");
    assert_eq!(loaded.session, Some(latest));
    assert_eq!(fs::read_dir(&dir).expect("目录").count(), 1);
    cleanup_temp(&projects);
}

/// `projects/{id}` 为符号链接时会话读写均拒绝，且不触碰链接目标（#62）。
#[cfg(unix)]
#[test]
fn ai_session_rejects_symlinked_session_dir_for_read_and_write() {
    let projects = temp_projects_dir();
    let outside = projects.parent().expect("临时根").join("session-outside");
    fs::create_dir_all(&outside).expect("建根外目录");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目记录");
    std::os::unix::fs::symlink(&outside, projects.join("p-1")).expect("建目录符号链接");
    let session = serde_json::json!({"schemaVersion": 1, "entries": []});
    let read_err = load_ai_session_file(&cap(&projects), "p-1")
        .err()
        .expect("读必须拒绝");
    assert!(
        matches!(read_err.root(), StoreError::Refused { ref detail } if detail.contains("项目会话目录是符号链接")),
        "意外诊断：{read_err}"
    );
    let write_err = save_ai_session_file(&cap(&projects), "p-1", &session).expect_err("写必须拒绝");
    assert!(
        matches!(write_err.root(), StoreError::Refused { ref detail } if detail.contains("项目会话目录是符号链接")),
        "意外诊断：{write_err}"
    );
    assert!(
        fs::symlink_metadata(&outside).is_ok()
            && fs::read_dir(&outside).expect("根外目录").count() == 0,
        "拒绝路径不得写入链接目标"
    );
    cleanup_temp(&projects);
}

/// `projects/{id}` 被普通文件占位时会话读写均按「不是目录」拒绝（#62）。
#[test]
fn ai_session_rejects_non_directory_session_path_for_read_and_write() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目记录");
    fs::write(projects.join("p-1"), b"not a dir").expect("普通文件占位会话路径");
    let session = serde_json::json!({"schemaVersion": 1, "entries": []});
    let read_err = load_ai_session_file(&cap(&projects), "p-1")
        .err()
        .expect("读必须拒绝");
    assert!(
        matches!(read_err.root(), StoreError::Refused { ref detail } if detail.contains("不是目录")),
        "意外诊断：{read_err}"
    );
    let write_err = save_ai_session_file(&cap(&projects), "p-1", &session).expect_err("写必须拒绝");
    assert!(
        matches!(write_err.root(), StoreError::Refused { ref detail } if detail.contains("不是目录")),
        "意外诊断：{write_err}"
    );
    assert_eq!(
        fs::read(projects.join("p-1")).expect("占位文件"),
        b"not a dir",
        "拒绝路径不得改动占位文件"
    );
    cleanup_temp(&projects);
}

/// 保存前信封校验先行：非对象、异形版本、entries 非数组各自拒绝并给出
/// 具体诊断，且不创建会话目录（#62）。
#[test]
fn ai_session_save_rejects_invalid_envelope_before_touching_disk() {
    let projects = temp_projects_dir();
    let cases = [
        (serde_json::json!([]), "AI 会话必须是对象"),
        (
            serde_json::json!({"schemaVersion": 2, "entries": []}),
            "AI 会话版本不受支持",
        ),
        (
            serde_json::json!({"schemaVersion": 1, "entries": "no"}),
            "AI 会话 entries 必须是数组",
        ),
    ];
    for (bad, diagnostic) in cases {
        let err = save_ai_session_file(&cap(&projects), "p-1", &bad).expect_err("信封非法必须拒绝");
        assert!(
            matches!(err.root(), StoreError::InvalidInput { ref detail } if detail.contains(diagnostic)),
            "意外诊断：{err}"
        );
    }
    assert!(
        fs::symlink_metadata(projects.join("p-1")).is_err(),
        "拒绝保存不得创建项目会话目录"
    );
    cleanup_temp(&projects);
}

/// store 域错误分片（issue #144）：内核按失败类别区分且保留来源——
/// 缺失为 NotFound、损坏为 CorruptJson（serde 来源经 source 链可取）、
/// 信任链拒绝为 Refused、不可信输入为 InvalidInput；包装层保留阶段前缀。
#[test]
fn load_project_file_classifies_missing_as_not_found() {
    let projects = temp_projects_dir();
    let err = load_project_file(&cap(&projects), "p-1").unwrap_err();
    assert!(
        matches!(err.root(), StoreError::NotFound { ref detail } if detail == "项目不存在：p-1"),
        "实际错误：{err:?}"
    );
    assert_eq!(err.to_string(), "项目不存在：p-1");
    cleanup_temp(&projects);
}

#[test]
fn load_project_file_classifies_corrupt_json_with_serde_source() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"not json").expect("写损坏文件");
    let err = load_project_file(&cap(&projects), "p-1").unwrap_err();
    assert!(
        err.to_string().starts_with("项目文件损坏："),
        "实际文案：{err}"
    );
    assert!(
        matches!(err.root(), StoreError::CorruptJson(_)),
        "实际错误：{err:?}"
    );
    assert!(
        std::error::Error::source(&err).is_some(),
        "损坏来源应经 source 链保留"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn load_project_file_classifies_symlinked_file_as_refused() {
    let projects = temp_projects_dir();
    let outside = projects.parent().expect("临时根").join("evil.json");
    fs::write(&outside, b"{}").expect("写根外文件");
    std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
    let err = load_project_file(&cap(&projects), "p-1").unwrap_err();
    assert!(
        matches!(err.root(), StoreError::Refused { .. }),
        "实际错误：{err:?}"
    );
    assert_eq!(
        err.to_string(),
        "拒绝读取项目文件：项目文件是符号链接，拒绝读取"
    );
    cleanup_temp(&projects);
}

/// [PR #224 第二轮评审](https://github.com/hailingu/PlotWeave/pull/224)：
/// 库导入与项目删除经 projects 操作锁串行——删除持锁期间导入（及其同
/// 类 ensure-then-create 写入）不得越过控制校验；删除落定后导入按
/// 「项目不存在」拒绝，不重建已删项目目录、不留下孤儿资产。
#[test]
fn import_waits_for_delete_and_never_recreates_deleted_project() {
    let tmp_root = temp_projects_dir();
    let projects = tmp_root.clone();
    let library = tmp_root.parent().expect("临时根父目录").join("library");
    fs::create_dir_all(library.join("assets")).expect("建库目录");
    persist_project(&cap(&projects), "p-1", valid_save_doc()).expect("建项目");
    fs::create_dir(projects.join("p-1")).expect("建项目资产目录");
    fs::write(library.join("assets").join("la-1.png"), b"\x89PNG").expect("写库媒体");
    let entry = serde_json::json!({
        "id": "la-1", "name": "立绘", "kind": "reference", "mime": "image/png",
        "relPath": "assets/la-1.png", "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z", "tags": [],
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&serde_json::json!({
            "assets": { "byId": { "la-1": entry } }, "groups": { "byId": {} },
        }))
        .expect("序列化索引"),
    )
    .expect("写库索引");

    let projects_root = cap(&projects);
    let library_root = cap(&library);
    let pending = crate::assets::project_media::PendingProjectAssets::new();
    // 主线程持锁模拟「删除进行中」：导入必须停在锁外，不得越过控制校验
    let gate = projects_op_lock();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker_projects = projects_root.try_clone().expect("克隆 projects 句柄");
    let worker_library = library_root.try_clone().expect("克隆库句柄");
    let worker = std::thread::spawn(move || {
        let mut report = |_: &crate::library_journal::Recovery| {};
        let result = crate::assets::import_asset_from_library(
            &worker_projects,
            &worker_library,
            "p-1",
            "la-1",
            &pending,
            &mut report,
        );
        done_tx.send(result).expect("报告导入结果");
    });
    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "删除持锁期间导入不得推进（应等待操作锁）"
    );
    // 删除在持锁窗口内完成（含资产树与控制文件）
    fs::remove_dir_all(projects.join("p-1")).expect("删资产树");
    fs::remove_file(projects.join("p-1.json")).expect("删控制文件");
    drop(gate);
    let result = done_rx.recv().expect("导入完成");
    worker.join().expect("导入线程结束");
    assert!(result.is_err(), "删除落定后导入不得成功：{result:?}");
    assert!(
        !projects.join("p-1").exists(),
        "导入不得重建已删项目目录（孤儿资产）"
    );
    cleanup_temp(&projects);
}

/// PR #224 第二轮评审：delete_project_files 自身与 projects 操作锁
/// 串行——持锁期间不得推进，释放后完成（幂等）。
#[test]
fn delete_project_files_serializes_with_projects_op_lock() {
    let projects = temp_projects_dir();
    persist_project(&cap(&projects), "p-1", valid_save_doc()).expect("建项目");
    let gate = projects_op_lock();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let root = cap(&projects);
    let worker = std::thread::spawn(move || {
        done_tx
            .send(delete_project_files(&root, "p-1"))
            .expect("报告删除结果");
    });
    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "删除应与 projects 操作锁串行（持锁期间不得推进）"
    );
    drop(gate);
    worker.join().expect("删除线程结束");
    assert!(
        done_rx.recv().expect("删除完成").is_ok(),
        "持锁释放后删除应完成（幂等）"
    );
    cleanup_temp(&projects);
}

/// [PR #224 第六轮评审](https://github.com/hailingu/PlotWeave/pull/224)：
/// 副本后续保存的 expectExisting 前置——copy 释放锁后被排队的删除移除
/// 目标时，该保存不得复活控制文件。默认保存（false）保持既有语义
///（迟到重试复活由前端墓碑吸收治理，Rust 不越权）。
#[test]
fn persist_project_expect_existing_refuses_deleted_target() {
    let projects = temp_projects_dir();
    let doc = valid_save_doc();
    // 默认语义不变：目标缺失时保存可创建（既有项目权威写路径）
    assert!(
        persist_project(&cap(&projects), "p-new", valid_save_doc()).is_ok(),
        "默认保存不要求目标存在（既有语义）"
    );
    // 副本路径：目标被删（控制文件+目录）后，expectExisting 保存按
    // 「项目不存在」拒绝——锁内前置，先于 atomic_write
    let err = persist_project_expect_existing(&cap(&projects), "p-gone", doc, true).unwrap_err();
    assert!(
        matches!(err.root(), StoreError::NotFound { ref detail } if detail.contains("项目不存在")),
        "意外诊断：{err}"
    );
    assert!(!projects.join("p-gone.json").exists(), "不得复活已删目标");
    cleanup_temp(&projects);
}

/// PR #224 第六轮评审：expectExisting=true 且目标存在时照常保存。
#[test]
fn persist_project_expect_existing_saves_when_target_present() {
    let projects = temp_projects_dir();
    persist_project(&cap(&projects), "p-1", valid_save_doc()).expect("先建项目");
    persist_project_expect_existing(&cap(&projects), "p-1", valid_save_doc(), true)
        .expect("目标存在时 expectExisting 保存照常");
    cleanup_temp(&projects);
}

// ---- issue #267：主保存入口的逐阶段写盘故障回归 ----
//
// 复用 atomic_write 的既有故障注入 seam，把创建/写入/文件同步/rename/
// 目录同步五个真实失败转换施加到主保存内核，断言回执类别、磁盘状态、
// 临时文件所有权与重试收敛——读取真实产物与错误类别，不断言措辞之外
// 的调用记录。写后资产复验失败路径需保存期间并发替换资产文件；主入口
// 全程持 projects 操作锁，真实系统行为下同线程之外无法替换（本地并发
// 攻击者替换树不在威胁模型），按 issue 口径不纳入并以本注释披露。

use crate::store::persist::faults::{Injection, Stage};

/// 主保存失败后的临时文件清扫断言：projects 根不得遗留 .tmp 条目
///（失败清理只在取得临时文件所有权后生效，排他创建失败无可清理）。
/// 单条目读取失败直接失败（PR #306 评审）：静默跳过会让扫描不完整时
/// 漏报残留，回归测试虚假通过——测试助手同样 fail-closed。
fn assert_no_temp_left(projects: &std::path::Path) {
    let orphans: Vec<_> = fs::read_dir(projects)
        .expect("扫描 projects 根")
        .map(|e| e.expect("读取目录条目失败（不得静默跳过）"))
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        orphans.is_empty(),
        "失败保存不得遗留临时文件：{:?}",
        orphans.iter().map(|e| e.file_name()).collect::<Vec<_>>()
    );
}

/// 提交前四阶段（创建/写入/文件同步/rename）注入失败：Err 上浮、磁盘
/// 保持旧文档、无临时文件残留，重试收敛为新文档——注入以抵达阶段记录
/// 自证（未命中注入时保存会照常成功，断言失败即暴露守卫失效）。
#[test]
fn save_pre_commit_stage_failures_keep_old_doc_and_retry_converges() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    let mut old = valid_save_doc();
    old.project.name = "改前".into();
    persist_project(&root, "p-1", old).expect("预置旧文档");
    let mut revised = valid_save_doc();
    revised.project.name = "改后".into();
    for stage in [Stage::Create, Stage::Write, Stage::FileSync, Stage::Rename] {
        let inj = Injection::new(Some(stage), None);
        let err = persist_project(&root, "p-1", revised.clone()).unwrap_err();
        let stages = inj.stages();
        drop(inj);
        assert!(
            stages.contains(&stage),
            "注入阶段 {stage:?} 未抵达（守卫失效）：{stages:?}"
        );
        assert!(
            matches!(err.root(), StoreError::Io { .. }),
            "阶段 {stage:?} 失败应保留 I/O 诊断：{err}"
        );
        let on_disk = load_project_file(&root, "p-1").expect("旧文档可读");
        assert_eq!(
            on_disk.project.name, "改前",
            "阶段 {stage:?} 在 rename 提交前失败，磁盘必须保持旧文档"
        );
        assert_no_temp_left(&projects);
    }
    // 注入撤除后重试收敛：无残留状态阻碍，一次成功即新文档
    persist_project(&root, "p-1", revised).expect("重试保存");
    assert_eq!(
        load_project_file(&root, "p-1")
            .expect("重试后可读")
            .project
            .name,
        "改后"
    );
    cleanup_temp(&projects);
}

/// 提交后阶段失败（rename 成功后的 Unix 目录持久性屏障）：错误如实
/// 返回、磁盘状态可说明（新文档已提交——「已提交仍报错」不只发生在
/// 写后资产复验），重试幂等收敛；持久性屏障缺失不得粉饰为保存成功。
#[cfg(unix)]
#[test]
fn save_directory_sync_failure_reports_error_with_new_doc_committed() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    let mut old = valid_save_doc();
    old.project.name = "改前".into();
    persist_project(&root, "p-1", old).expect("预置旧文档");
    let mut revised = valid_save_doc();
    revised.project.name = "改后".into();
    let inj = Injection::new(Some(Stage::DirectorySync), None);
    let err = persist_project(&root, "p-1", revised.clone()).unwrap_err();
    let stages = inj.stages();
    drop(inj);
    assert!(
        stages.contains(&Stage::DirectorySync),
        "目录屏障阶段未抵达（守卫失效）：{stages:?}"
    );
    assert!(
        matches!(err.root(), StoreError::Io { ref context, .. } if context.contains("同步项目目录")),
        "目录屏障失败应如实报错：{err}"
    );
    // rename 已成功：新文档已提交（与提交前失败的可观察状态相区分）
    assert_eq!(
        load_project_file(&root, "p-1")
            .expect("已提交文档可读")
            .project
            .name,
        "改后",
        "目录屏障在 rename 之后失败，新文档应已在磁盘"
    );
    assert_no_temp_left(&projects);
    // 重试幂等收敛：屏障重走成功，文档不变
    persist_project(&root, "p-1", revised).expect("重试保存");
    assert_eq!(
        load_project_file(&root, "p-1")
            .expect("重试后可读")
            .project
            .name,
        "改后"
    );
    cleanup_temp(&projects);
}

/// [PR #224 第九轮评审](https://github.com/hailingu/PlotWeave/pull/224)：
/// expectExisting 前置的元数据失败（非 NotFound，如权限错误）不得误判为
/// 「项目不存在」——保留底层 I/O 诊断（可行动），不谎报契约状态。
#[test]
fn expect_existing_keeps_metadata_error_diagnostic() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    persist_project(&root, "p-1", valid_save_doc()).expect("先建项目");
    // 收权使 symlink_metadata 报 EACCES（非 NotFound）；句柄先开好——
    // ambient 打开同样会被 0o000 拒绝
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&projects).unwrap().permissions();
    perms.set_mode(0o000);
    fs::set_permissions(&projects, perms).expect("收权");
    let err = persist_project_expect_existing(&root, "p-1", valid_save_doc(), true);
    let mut perms = fs::metadata(&projects).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&projects, perms);
    let err = err.unwrap_err();
    assert!(
        matches!(err.root(), StoreError::Io { context, .. } if context.contains("元数据")),
        "非 NotFound 的元数据失败应保留 I/O 诊断：{err}"
    );
    assert!(
        !err.to_string().contains("项目不存在"),
        "不得把存在性校验失败谎报为项目不存在：{err}"
    );
    cleanup_temp(&projects);
}
