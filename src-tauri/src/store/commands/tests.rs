//! commands.rs 的内联测试模块外置（文件行数上限合规，随恢复副本顺序守卫
//! 增补；与 list/tests.rs 同款结构）。

use super::*;
use crate::isotime::now_iso;
use crate::store::persist::bound_subdir;
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
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session,
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
    assert!(
        !load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session
            .is_some(),
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
fn save_rejects_write_seq_outside_safe_integer_range() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    // u64 可表示而 JS Number 不能精确表示（负数/小数同斥）：一旦落盘，前端
    // seqOf 会把同一值归一为 0，下一次合法保存从 1 续起却被序号守卫当作
    // 更旧而永久拒绝，权威持久化从此无法恢复
    for bad in [
        serde_json::json!(9_007_199_254_740_992u64),
        serde_json::json!(u64::MAX),
        serde_json::json!(-1i64),
        serde_json::json!(1.5f64),
    ] {
        let session = serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": bad });
        let err = save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &session)
            .expect_err("超出安全整数范围的 writeSeq 不得落盘");
        assert!(err.contains("writeSeq"), "意外诊断：{err}");
        let err = stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
            .expect_err("副本写入同样拒绝超范围 writeSeq");
        assert!(err.contains("writeSeq"), "意外诊断：{err}");
        assert!(
            fs::symlink_metadata(projects.join("p-1").join("ai-session.json")).is_err(),
            "拒绝保存不得写入主会话文件"
        );
    }
    // 缺失（旧文件兼容）与非负安全整数合法
    for good in [
        serde_json::json!({ "schemaVersion": 1, "entries": [] }),
        serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 0u64 }),
        serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 9_007_199_254_740_991u64 }),
    ] {
        save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &good)
            .expect("合法 writeSeq 必须可保存");
    }
    cleanup_temp(&projects);
}

#[test]
fn session_file_with_unsafe_write_seq_is_replaceable() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    // 旧缺陷落盘的超范围序号文件按损坏归类：序号守卫不得用它的序号卡死
    // 后续合法保存（前端 seqOf 同样把它归一为 0，视作损坏一致）
    fs::create_dir_all(projects.join("p-1")).expect("建会话目录");
    fs::write(
        projects.join("p-1").join("ai-session.json"),
        r#"{ "schemaVersion": 1, "entries": [], "writeSeq": 9007199254740992 }"#,
    )
    .expect("写带毒会话文件");

    let session = serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 1u64 });
    save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("带毒序号文件必须可被合法保存替换");
    let text = fs::read_to_string(projects.join("p-1").join("ai-session.json")).expect("读回");
    let saved: serde_json::Value = serde_json::from_str(&text).expect("解析读回内容");
    assert_eq!(session_write_seq(&saved), 1, "应已替换为合法序号内容");
    cleanup_temp(&projects);
}

#[test]
fn save_refuses_unreadable_or_newer_authoritative_session() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let session = |seq: u64| {
        serde_json::json!({
            "schemaVersion": 1,
            "entries": [{ "id": 1, "kind": "note", "text": "历史" }],
            "writeSeq": seq
        })
    };
    // 首次写入建立主文件（序号 10）
    save_ai_session_file(&cap(&projects), "p-1", &session(10)).expect("首次保存");
    // 序号更小的保存拒绝覆盖，主文件原样保留
    let err = save_ai_session_file(&cap(&projects), "p-1", &session(5))
        .expect_err("更新主文件不得被旧序号覆盖");
    assert!(err.contains("更新"), "意外诊断：{err}");
    assert_eq!(
        load_ai_session_file(&cap(&projects), "p-1").expect("读主会话"),
        session(10)
    );

    // 主文件不可读（目录占位）：新旧无法确定，拒绝覆盖
    fs::remove_file(projects.join("p-1").join("ai-session.json")).expect("移除主文件");
    fs::create_dir(projects.join("p-1").join("ai-session.json")).expect("建目录占位");
    let err = save_ai_session_file(&cap(&projects), "p-1", &session(20))
        .expect_err("不可读主文件不得被覆盖");
    assert!(err.contains("不可读"), "意外诊断：{err}");

    // 主文件可读但内容损坏：内容不可用，允许覆盖修复
    fs::remove_dir(projects.join("p-1").join("ai-session.json")).expect("移除目录占位");
    atomic_write(&cap(&projects.join("p-1")), "ai-session.json", "{not json")
        .expect("写损坏主文件");
    save_ai_session_file(&cap(&projects), "p-1", &session(20)).expect("损坏内容允许覆盖修复");
    assert_eq!(
        load_ai_session_file(&cap(&projects), "p-1").expect("读主会话"),
        session(20)
    );
    cleanup_temp(&projects);
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
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session,
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

/// 无单实例约束下两进程各自从同一磁盘序号续起会撞号：相等序号的不同
/// 会话是并发冲突，后写不得悄悄替换先写（先落盘者胜），否则一侧对话被
/// 静默丢失而写入边界还报告成功（评审 pullrequestreview-5161801056）。
#[test]
fn equal_write_seq_conflicting_content_is_rejected() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    let process = |text: &str, seq: u64| {
        serde_json::json!({
            "schemaVersion": 1,
            "entries": [{ "id": 1, "kind": "note", "text": text }],
            "writeSeq": seq
        })
    };
    save_ai_session_file(&cap(&projects), "p-1", &process("进程 A", 10)).expect("先写建立权威会话");
    let err = save_ai_session_file(&cap(&projects), "p-1", &process("进程 B", 10))
        .expect_err("同序号的不同会话不得覆盖权威文件");
    assert!(err.contains("序号"), "意外诊断：{err}");
    assert_eq!(
        load_ai_session_file(&cap(&projects), "p-1").expect("读主会话"),
        process("进程 A", 10),
        "先落盘的会话必须原样保留"
    );

    stash_ai_session_recovery_file(
        &cap(&projects),
        &cap(&recovery),
        "p-1",
        &process("进程 A", 10),
    )
    .expect("先写恢复副本");
    let err = stash_ai_session_recovery_file(
        &cap(&projects),
        &cap(&recovery),
        "p-1",
        &process("进程 B", 10),
    )
    .expect_err("同序号的不同会话不得替换恢复副本");
    assert!(err.contains("序号"), "意外诊断：{err}");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session,
        Some(process("进程 A", 10)),
        "先落盘的恢复副本必须原样保留"
    );
    cleanup_temp(&projects);
}

/// 相等序号且对话内容一致 = 同一逻辑写入的幂等重放（权威保存后清除副本
/// 失败时的同序号改写；旧无序号文件补显式 writeSeq 0 的升级）：替换不
/// 丢失任何历史，必须放行。
#[test]
fn equal_write_seq_identical_retry_is_allowed() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    fs::write(projects.join("p-2.json"), b"{}").expect("写项目文件");
    let session = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{ "id": 1, "kind": "note", "text": "同一保存" }],
        "writeSeq": 10
    });
    save_ai_session_file(&cap(&projects), "p-1", &session).expect("首次写");
    save_ai_session_file(&cap(&projects), "p-1", &session).expect("同序号同内容的重试必须放行");
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("先写恢复副本");
    stash_ai_session_recovery_file(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("同序号同内容的副本改写必须放行");

    let legacy = serde_json::json!({ "schemaVersion": 1, "entries": [] });
    save_ai_session_file(&cap(&projects), "p-2", &legacy).expect("写旧格式会话");
    let upgraded = serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 0u64 });
    save_ai_session_file(&cap(&projects), "p-2", &upgraded)
        .expect("补显式序号 0（对话内容一致）按同一写入放行");
    cleanup_temp(&projects);
}

/// 损坏（不可解析/信封非法）的恢复副本无法被任何进程载入，按可安全替换
/// 归类：读取返回 corrupt 标记而非错误——前端不得据此进入「新旧未知」
/// 门禁永久暂缓保存；Err 仅保留给真实 I/O 失败（权限/瞬态 I/O）。
#[test]
fn corrupt_recovery_copy_loads_as_replaceable_not_unreadable() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    atomic_write(&cap(&recovery), "ai-session-p-1.json", "{not json").expect("写损坏副本");
    let copy =
        load_ai_session_recovery_file(&cap(&recovery), "p-1").expect("损坏副本不得按读取失败上浮");
    assert!(copy.corrupt, "损坏副本必须带 corrupt 标记");
    assert_eq!(copy.session, None);

    atomic_write(
        &cap(&recovery),
        "ai-session-p-2.json",
        r#"{ "schemaVersion": 9 }"#,
    )
    .expect("写非法信封副本");
    let copy =
        load_ai_session_recovery_file(&cap(&recovery), "p-2").expect("信封非法同样按损坏归类");
    assert!(copy.corrupt, "非法信封必须带 corrupt 标记");
    assert_eq!(copy.session, None);

    let copy = load_ai_session_recovery_file(&cap(&recovery), "p-3")
        .expect("缺失是合法状态（无失败保存）");
    assert!(!copy.corrupt);
    assert_eq!(copy.session, None);

    // 不可读（目录占位）：新旧未知，仍是 Err
    fs::create_dir(recovery.join("ai-session-p-4.json")).expect("建目录占位");
    assert!(
        load_ai_session_recovery_file(&cap(&recovery), "p-4").is_err(),
        "不可读副本必须保持 Err（写入边界将拒绝覆盖）"
    );
    cleanup_temp(&projects);
}

/// 损坏副本不得阻断权威保存：ensure_recovery_replaceable 同口径把它当可
/// 替换内容，主文件落盘后副本照常清除（自愈，无须手工清理磁盘）。
#[test]
fn corrupt_recovery_copy_is_cleared_by_authoritative_save() {
    let projects = temp_projects_dir();
    let recovery = temp_recovery_dir(&projects);
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    atomic_write(&cap(&recovery), "ai-session-p-1.json", "{not json").expect("写损坏副本");
    let session = serde_json::json!({ "schemaVersion": 1, "entries": [], "writeSeq": 1u64 });
    save_ai_session_authoritative(&cap(&projects), &cap(&recovery), "p-1", &session)
        .expect("损坏副本不得阻断权威保存");
    assert_eq!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session,
        None,
        "权威保存成功后损坏副本应被清除"
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

    let report = delete_project_with_recovery(&cap(&projects), || Ok(cap(&recovery)), "p-1")
        .expect("删除项目");
    assert!(report.cleanup_error.is_none(), "干净删除不得带清理诊断");
    assert!(
        !load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session
            .is_some(),
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
    let result = delete_project_with_recovery(&cap(&projects), || Ok(cap(&recovery)), "p-1");
    let mut perms = fs::metadata(&assets).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&assets, perms);

    assert!(result.is_err(), "资产目录删除失败应显式报错");
    assert!(
        load_ai_session_recovery_file(&cap(&recovery), "p-1")
            .expect("读恢复副本")
            .session
            .is_some(),
        "项目仍在磁盘时删除失败不得清除恢复副本"
    );
    cleanup_temp(&projects);
}

#[test]
fn delete_project_commits_when_recovery_dir_unavailable() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    // recovery 被普通文件占位：真实打开路径（bound_subdir）归类失败
    let root = projects.parent().expect("临时根").to_path_buf();
    fs::write(root.join("recovery"), "占位").expect("占位恢复目录");

    let report = delete_project_with_recovery(
        &cap(&projects),
        || bound_subdir(&cap(&root), "recovery", "会话恢复目录"),
        "p-1",
    )
    .expect("恢复目录不可用不得阻断删除");
    let cleanup_error = report.cleanup_error.expect("不可用的清理位置必须带诊断");
    assert!(
        cleanup_error.contains("恢复目录"),
        "意外诊断：{cleanup_error}"
    );
    assert!(
        fs::symlink_metadata(projects.join("p-1.json")).is_err(),
        "项目文件应已删除"
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
    let result = delete_project_with_recovery(&cap(&projects), || Ok(cap(&recovery)), "p-1");
    let mut perms = fs::metadata(&recovery).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&recovery, perms);

    // 删除已提交：回执带清理诊断而非删除失败——前端不得回吐画布保存
    let report = result.expect("删除本身已提交，副本清理失败只是诊断");
    let cleanup_error = report.cleanup_error.expect("副本清除失败必须带诊断");
    assert!(
        cleanup_error.contains("恢复副本"),
        "意外诊断：{cleanup_error}"
    );
    assert!(
        fs::symlink_metadata(projects.join("p-1.json")).is_err(),
        "项目文件应已删除"
    );
    assert!(
        recovery.join("ai-session-p-1.json").exists(),
        "残留副本仍在，由列表孤儿清扫兜底"
    );
    cleanup_temp(&projects);
}
