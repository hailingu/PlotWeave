//! commands.rs 的内联测试模块外置（文件行数上限合规，随恢复副本顺序守卫
//! 增补；与 list/tests.rs 同款结构）。

use super::*;
use crate::isotime::now_iso;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, temp_recovery_dir};
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
        load_ai_session_file(&cap(&projects), "p-1").expect("读取会话"),
        session
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

#[test]
fn ai_session_recovery_round_trips_and_requires_project_record() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    let session = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "msg", "role": "user", "text": "未落盘的讨论" }]
    });
    // 项目记录缺失：拒绝写恢复副本（已删除项目不得留下不可见聊天数据）
    let err = stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect_err("无项目记录时不得写恢复副本");
    assert!(err.contains("项目不存在"), "意外诊断：{err}");

    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("写恢复副本");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1").expect("读恢复副本"),
        Some(session.clone())
    );
    // 主文件此时仍缺失（保存失败）：恢复副本是唯一可跨进程恢复的拷贝
    assert!(
        fs::symlink_metadata(projects.join("p-1").join("ai-session.json")).is_err(),
        "恢复副本不得冒充主会话文件"
    );
    cleanup_temp(&projects);
}

#[test]
fn ai_session_authoritative_save_clears_recovery_copy() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "note", "text": "重试成功" }]
    });
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("写恢复副本");

    save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("权威保存");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1").expect("读恢复副本"),
        None,
        "权威副本落盘后恢复副本应被清除"
    );
    assert_eq!(
        load_ai_session_file(&cap(&projects), "p-1").expect("读主会话"),
        session
    );
    // 清除幂等：缺失时再清不报错
    assert!(clear_ai_session_recovery_file(&cap(&recovery), "p-1").is_ok());
    cleanup_temp(&projects);
}

/// 顺序守卫夹具：项目记录 + 指定写入序号的恢复副本。
fn setup_recovery_with_seq(
    seq: u64,
) -> (std::path::PathBuf, std::path::PathBuf, serde_json::Value) {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let existing = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "note", "text": "更新的历史" }],
        "writeSeq": seq
    });
    atomic_write(
        &cap(&recovery),
        "ai-session-p-1.json",
        &existing.to_string(),
    )
    .expect("写恢复副本");
    (projects, recovery, existing)
}

#[test]
fn save_and_stash_refuse_to_replace_newer_recovery_copy() {
    let (projects, recovery, existing) = setup_recovery_with_seq(10);
    let incoming = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "note", "text": "本次保存" }],
        "writeSeq": 5
    });

    let save_err =
        save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &incoming)
            .expect_err("更新副本不得被本次保存覆盖");
    assert!(save_err.contains("更新"), "意外诊断：{save_err}");
    assert!(
        fs::symlink_metadata(projects.join("p-1").join("ai-session.json")).is_err(),
        "拒绝保存不得写入主会话文件"
    );

    let stash_err =
        stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &incoming)
            .expect_err("更新副本不得被陈旧副本覆盖");
    assert!(stash_err.contains("更新"), "意外诊断：{stash_err}");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1").expect("读恢复副本"),
        Some(existing),
        "更新副本必须原样保留"
    );
    cleanup_temp(&projects);
}

#[test]
fn save_refuses_when_recovery_copy_is_unreadable() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    // 副本路径被目录占位：不可读（不是普通文件），新旧无法确定
    fs::create_dir(recovery.join("ai-session-p-1.json")).expect("建目录占位");
    let incoming = serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 5 });

    let err = save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &incoming)
        .expect_err("不可读副本不得被覆盖");
    assert!(err.contains("不可读"), "意外诊断：{err}");
    assert!(
        fs::symlink_metadata(projects.join("p-1").join("ai-session.json")).is_err(),
        "拒绝保存不得写入主会话文件"
    );
    cleanup_temp(&projects);
}

#[test]
fn delete_project_clears_recovery_copy() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({ "schemaVersion": 1, "entries": [] });
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("写恢复副本");

    delete_project_with_recovery(&cap(&projects), &cap(&recovery), "p-1").expect("删除项目");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1").expect("读恢复副本"),
        None,
        "删除项目应同时清除恢复副本"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn delete_project_failure_keeps_recovery_copy() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    fs::write(assets.join("a.png"), b"A").expect("写资产");
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({ "schemaVersion": 1, "entries": [] });
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("写恢复副本");

    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&assets).unwrap().permissions();
    perms.set_mode(0o555);
    fs::set_permissions(&assets, perms).expect("只读化");
    let result = delete_project_with_recovery(&cap(&projects), &cap(&recovery), "p-1");
    let mut perms = fs::metadata(&assets).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&assets, perms);

    assert!(result.is_err(), "资产目录删除失败应显式报错");
    assert!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .is_some(),
        "项目仍在磁盘时删除失败不得清除恢复副本"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn delete_project_reports_recovery_cleanup_failure() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({ "schemaVersion": 1, "entries": [] });
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("写恢复副本");

    // 只读化恢复目录：项目删除成功，但副本清除失败
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&recovery).unwrap().permissions();
    perms.set_mode(0o555);
    fs::set_permissions(&recovery, perms).expect("只读化");
    let result = delete_project_with_recovery(&cap(&projects), &cap(&recovery), "p-1");
    let mut perms = fs::metadata(&recovery).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&recovery, perms);

    let err = result.expect_err("副本清除失败必须上浮，不得静默遗留孤儿会话");
    assert!(err.contains("重试删除"), "意外诊断：{err}");
    assert!(
        fs::symlink_metadata(projects.join("p-1.json")).is_err(),
        "项目文件应已删除"
    );
    assert!(
        recovery.join("ai-session-p-1.json").exists(),
        "残留副本仍在，重试删除可清理"
    );
    cleanup_temp(&projects);
}
