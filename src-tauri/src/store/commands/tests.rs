//! 项目文件、会话主文件及删除行为的文件系统集成测试。

use super::*;
use crate::isotime::now_iso;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir};
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
    assert!(err.contains("非法"), "意外诊断：{err}");
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
    assert!(err.contains("符号链接"), "意外诊断：{err}");
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
        err.contains("非法") || err.contains("不存在"),
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
    assert!(err.contains("项目不存在"), "意外诊断：{err}");
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
    assert!(result.is_err(), "资产目录删除失败应显式报错");
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
        read_err.contains("项目会话目录是符号链接"),
        "意外诊断：{read_err}"
    );
    let write_err = save_ai_session_file(&cap(&projects), "p-1", &session).expect_err("写必须拒绝");
    assert!(
        write_err.contains("项目会话目录是符号链接"),
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
    assert!(read_err.contains("不是目录"), "意外诊断：{read_err}");
    let write_err = save_ai_session_file(&cap(&projects), "p-1", &session).expect_err("写必须拒绝");
    assert!(write_err.contains("不是目录"), "意外诊断：{write_err}");
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
        assert!(err.contains(diagnostic), "意外诊断：{err}");
    }
    assert!(
        fs::symlink_metadata(projects.join("p-1")).is_err(),
        "拒绝保存不得创建项目会话目录"
    );
    cleanup_temp(&projects);
}
