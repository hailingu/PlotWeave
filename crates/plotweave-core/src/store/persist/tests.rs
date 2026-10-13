//! persist 内核单元测试（自 persist.rs 内联模块外置，维持源文件 ≤800 行，
//! 同 list/commands 的 tests.rs 模式）：孤儿临时文件清扫（issue #148 及其
//! PR #217 两轮评审收紧）、目录条目宿主链、控制文件归类与原子写边界。

use super::*;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir};

/// 回拨/前瞻 mtime 的夹具：原子写临时文件的正常生命周期以秒计，
/// 超龄条目只可能来自「创建与 rename 之间进程被终止」的遗留。
fn plant_file_with_mtime(dir: &std::path::Path, name: &str, mtime: std::time::SystemTime) {
    let path = dir.join(name);
    fs::write(&path, b"orphan").expect("写遗留临时文件");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("打开遗留临时文件");
    file.set_modified(mtime).expect("设定 mtime");
}

#[test]
fn sweep_removes_only_aged_own_temp_files() {
    let projects = temp_projects_dir();
    let now = std::time::SystemTime::now();
    let aged = now - std::time::Duration::from_secs(48 * 60 * 60);
    // 超龄归属临时文件（崩溃遗留）：移除
    plant_file_with_mtime(&projects, ".p-1.json.p-18f-0.tmp", aged);
    // 同名模式但 mtime 新鲜（进行中的写入）：保留
    plant_file_with_mtime(&projects, ".p-2.json.p-18f-1.tmp", now);
    // 时钟回拨致的未来 mtime：保留（duration_since 失败按未超龄处理）
    plant_file_with_mtime(
        &projects,
        ".p-3.json.p-18f-2.tmp",
        now + std::time::Duration::from_secs(60 * 60),
    );
    // 与本协议无关的条目一律保留：项目文件、外来 tmp、无 id 段、非法 id 段
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
    fs::write(projects.join("notes.tmp"), b"x").expect("写外来 tmp");
    fs::write(projects.join(".no-sep.tmp"), b"x").expect("写无 id 段临时名");
    fs::write(projects.join(".a.b$d.tmp"), b"x").expect("写非法 id 段临时名");
    // 外来 id 形状（PR #217 评审）：即便超龄也不归属——生成器唯一产出
    // 形状是 p-<小写十六进制>-<小写十六进制>，宽字符集会把
    // `.notes.backup.tmp` 之类外来文件误收为「本协议临时文件」误删
    for foreign in [
        ".notes.backup.tmp",
        ".x.q-18f-0.tmp",
        ".x.p-18f.tmp",
        ".x.p--0.tmp",
        ".x.p-18g-0.tmp",
        ".x.p-18F-0.tmp",
    ] {
        plant_file_with_mtime(&projects, foreign, aged);
    }
    // 外来目标名（PR #217 第二轮评审）：合成 id 救不回非法目标——
    // projects/ 的唯一原子写目标是 {项目 id}.json
    for foreign in [
        ".notes.p-18f-0.tmp",
        ".p-1.txt.p-18f-0.tmp",
        ".bad id.json.p-18f-0.tmp",
    ] {
        plant_file_with_mtime(&projects, foreign, aged);
    }
    let removed = sweep_orphan_temp_files(&cap(&projects), "测试目录", is_project_temp_target);
    assert_eq!(removed, 1);
    assert!(
        !projects.join(".p-1.json.p-18f-0.tmp").exists(),
        "超龄归属临时文件应被清理"
    );
    for kept in [
        ".p-2.json.p-18f-1.tmp",
        ".p-3.json.p-18f-2.tmp",
        "p-1.json",
        "notes.tmp",
        ".no-sep.tmp",
        ".a.b$d.tmp",
        ".notes.backup.tmp",
        ".x.q-18f-0.tmp",
        ".x.p-18f.tmp",
        ".x.p--0.tmp",
        ".x.p-18g-0.tmp",
        ".x.p-18F-0.tmp",
        ".notes.p-18f-0.tmp",
        ".p-1.txt.p-18f-0.tmp",
        ".bad id.json.p-18f-0.tmp",
    ] {
        assert!(projects.join(kept).exists(), "{kept} 不应被清理");
    }
    cleanup_temp(&projects);
}

#[test]
fn sweep_candidate_gates_name_type_and_age() {
    let projects = temp_projects_dir();
    let now = std::time::SystemTime::now();
    plant_file_with_mtime(
        &projects,
        ".p-1.json.p-18f-0.tmp",
        now - std::time::Duration::from_secs(48 * 60 * 60),
    );
    plant_file_with_mtime(&projects, ".p-2.json.p-18f-1.tmp", now);
    let root = cap(&projects);
    let aged_md = root
        .symlink_metadata(".p-1.json.p-18f-0.tmp")
        .expect("读元数据");
    let fresh_md = root
        .symlink_metadata(".p-2.json.p-18f-1.tmp")
        .expect("读元数据");
    assert!(is_sweep_candidate(
        ".p-1.json.p-18f-0.tmp",
        &aged_md,
        now,
        &is_project_temp_target
    ));
    // 新鲜 mtime（进行中写入）：非候选
    assert!(!is_sweep_candidate(
        ".p-2.json.p-18f-1.tmp",
        &fresh_md,
        now,
        &is_project_temp_target
    ));
    // 名字不归属：即便超龄普通文件也非候选
    assert!(!is_sweep_candidate(
        "p-1.json",
        &aged_md,
        now,
        &is_project_temp_target
    ));
    // 外来 id 形状（PR #217 评审）：超龄普通文件同样非候选
    assert!(!is_sweep_candidate(
        ".notes.backup.tmp",
        &aged_md,
        now,
        &is_project_temp_target
    ));
    // 外来目标名（PR #217 第二轮评审）：合成 id 同样救不回
    assert!(!is_sweep_candidate(
        ".notes.p-18f-0.tmp",
        &aged_md,
        now,
        &is_project_temp_target
    ));
    // 目录条目即便名字归属也非候选（no-follow 归类拒绝异型）：目录
    // mtime 不可回拨，以远未来时刻旁路年龄门直接钉住归类门
    fs::create_dir(projects.join(".p-4.json.p-18f-3.tmp")).expect("建占位目录");
    let dir_md = root
        .symlink_metadata(".p-4.json.p-18f-3.tmp")
        .expect("读目录元数据");
    let far_future = now + std::time::Duration::from_secs(10 * 365 * 24 * 60 * 60);
    assert!(!is_sweep_candidate(
        ".p-4.json.p-18f-3.tmp",
        &dir_md,
        far_future,
        &is_project_temp_target
    ));
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn sweep_never_follows_symlink_temp_names() {
    let projects = temp_projects_dir();
    let outside = projects.parent().expect("临时根").join("victim.json");
    fs::write(&outside, b"{}").expect("写根外文件");
    std::os::unix::fs::symlink(&outside, projects.join(".p-1.json.p-18f-0.tmp"))
        .expect("建同名符号链接");
    let root = cap(&projects);
    let md = root
        .symlink_metadata(".p-1.json.p-18f-0.tmp")
        .expect("读链接元数据");
    // 符号链接自身 mtime 不可回拨：以远未来时刻旁路年龄门，钉住
    // 「任意年龄下符号链接都不是候选」的 no-follow 归类门
    let far_future =
        std::time::SystemTime::now() + std::time::Duration::from_secs(10 * 365 * 24 * 60 * 60);
    assert!(!is_sweep_candidate(
        ".p-1.json.p-18f-0.tmp",
        &md,
        far_future,
        &is_project_temp_target
    ));
    let removed = sweep_orphan_temp_files(&root, "测试目录", is_project_temp_target);
    assert_eq!(removed, 0);
    assert!(
        projects
            .join(".p-1.json.p-18f-0.tmp")
            .symlink_metadata()
            .is_ok(),
        "链接自身保留"
    );
    assert_eq!(
        fs::read(&outside).expect("读根外文件"),
        b"{}",
        "根外目标不受影响"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn entry_sync_plan_covers_hosts_and_rollback_scope_of_new_levels() {
    let tmp = std::env::temp_dir().join(format!("pw-chain-{}", new_id()));
    fs::create_dir(&tmp).expect("建临时根");
    // 两级新建：宿主 = 锚点 tmp 与中间级 tmp/mid；回滚范围含 dir 本身
    let plan = entry_sync_plan(&tmp.join("mid").join("leaf"))
        .unwrap()
        .unwrap();
    assert_eq!(plan.hosts, vec![tmp.clone(), tmp.join("mid")]);
    assert_eq!(
        plan.created,
        vec![tmp.join("mid"), tmp.join("mid").join("leaf")]
    );
    // 一级新建：宿主 = 既有父目录；回滚范围 = 目标本身
    let plan = entry_sync_plan(&tmp.join("leaf")).unwrap().unwrap();
    assert_eq!(plan.hosts, vec![tmp.clone()]);
    assert_eq!(plan.created, vec![tmp.join("leaf")]);
    // 目标已存在：仍同步直接父目录（单级兜底），无回滚范围
    fs::create_dir(tmp.join("exists")).expect("预建目标");
    let plan = entry_sync_plan(&tmp.join("exists")).unwrap().unwrap();
    assert_eq!(plan.hosts, vec![tmp.clone()]);
    assert!(plan.created.is_empty());
    // 根目录无父级宿主
    assert!(entry_sync_plan(std::path::Path::new("/"))
        .unwrap()
        .is_none());
    fs::remove_dir_all(&tmp).expect("清理临时根");
}

#[cfg(unix)]
#[test]
fn entry_sync_plan_fail_closed_on_transient_metadata_error() {
    // PR #201 第四、五轮评审：注入非 NotFound 的元数据失败必须
    // fail-closed 上抛，先于任何创建与清理（旧 is_ok 吞错实现会把
    // 现存目录误判为本次新建并被失败清理拆除；该测试在探测站点
    // 接入注入前必然失败——旧断言只走正常路径，吞错实现也能通过）。
    let tmp = std::env::temp_dir().join(format!("pw-anchor-{}", new_id()));
    fs::create_dir(&tmp).expect("建临时根");
    fs::create_dir(tmp.join("parent")).expect("建已存在层级");
    let target = tmp.join("parent").join("leaf");
    let injection = faults::Injection::new(Some(faults::Stage::AnchorProbe), None);
    let err = create_dir_all_durable(&target).unwrap_err();
    assert!(
        err.to_string().contains("injected AnchorProbe failure"),
        "实际错误：{err}"
    );
    assert!(
        err.to_string().contains("探测目录条目宿主失败"),
        "实际错误：{err}"
    );
    drop(injection);
    assert!(tmp.join("parent").is_dir(), "已存在层级不得被触碰");
    assert!(!target.exists(), "探测失败不得产生任何新建");
    fs::remove_dir_all(&tmp).expect("清理临时根");
}

#[test]
fn verify_control_file_requires_regular_file() {
    let projects = temp_projects_dir();
    let file = projects.join("p-1.json");
    fs::write(&file, b"{}").expect("写项目文件");
    assert!(verify_control_file(&cap(&projects), "p-1.json").is_ok());
    // 目录占位：不是普通文件
    let dir_as_file = projects.join("p-2.json");
    fs::create_dir(&dir_as_file).expect("建目录占位");
    let err = verify_control_file(&cap(&projects), "p-2.json").unwrap_err();
    assert!(
        matches!(err, StoreError::Refused { ref detail } if detail.contains("普通文件")),
        "意外诊断：{err}"
    );
    // 缺失文件拒绝（读取前置）
    assert!(verify_control_file(&cap(&projects), "p-3.json").is_err());
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn verify_control_file_rejects_symlinked_project_file() {
    let projects = temp_projects_dir();
    let outside = projects.parent().expect("临时根").join("evil.json");
    fs::write(&outside, b"{}").expect("写根外文件");
    std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
    let err = verify_control_file(&cap(&projects), "p-1.json").unwrap_err();
    assert!(
        matches!(err, StoreError::Refused { ref detail } if detail.contains("符号链接")),
        "意外诊断：{err}"
    );
    cleanup_temp(&projects);
}

#[test]
fn atomic_write_rejects_path_like_file_name() {
    let projects = temp_projects_dir();
    // 句柄相对写入的最后边界：嵌套形态的文件名不得相对句柄逃出 projects/
    let err = atomic_write(&cap(&projects), "../evil.json", "{}").unwrap_err();
    assert!(
        matches!(err, StoreError::Refused { ref detail } if detail.contains("路径分量")),
        "意外诊断：{err}"
    );
    assert!(
        fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
        "含路径分量的文件名不应写出 projects/"
    );
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn atomic_write_fails_closed_on_target_metadata_errors() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    // 收权让 symlink_metadata 报 EACCES（非 NotFound）：归类步骤必须
    // 显式上抛，不得把错误当目标缺失放行后误报后续步骤
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&projects).unwrap().permissions();
    perms.set_mode(0o000);
    fs::set_permissions(&projects, perms).expect("收权");
    let err = atomic_write(&root, "p-1.json", "{}").unwrap_err();
    let mut perms = fs::metadata(&projects).unwrap().permissions();
    perms.set_mode(0o755);
    let _ = fs::set_permissions(&projects, perms);
    assert!(
        matches!(&err, StoreError::Io { context, .. } if context.contains("元数据")),
        "意外诊断：{err}"
    );
    assert!(
        std::error::Error::source(&err).is_some(),
        "归类失败的 io 来源应保留"
    );
    cleanup_temp(&projects);
}

/// [PR #224 评审](https://github.com/hailingu/PlotWeave/pull/224)：
/// spawn_blocking 命令并行首用——多个入口同时发现 `projects/` 缺失时，
/// 所有调用方都必须成功（create 容忍 AlreadyExists，归类校验与身份
/// 绑定兜底；不得把「另一命令刚建好」报成虚假 IPC 失败）。
#[test]
fn ensure_projects_dir_tolerates_concurrent_first_use() {
    for round in 0..3 {
        let tmp = std::env::temp_dir().join(format!("pw-firstuse-{}", new_id()));
        fs::create_dir(&tmp).expect("建临时应用根");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(32));
        let mut handles = Vec::new();
        for _ in 0..32 {
            let barrier = barrier.clone();
            let tmp = tmp.clone();
            handles.push(std::thread::spawn(move || {
                let root = CapDir::open_ambient_dir(&tmp, ambient_authority()).expect("打开应用根");
                barrier.wait();
                ensure_projects_dir(&root).map(|_| ())
            }));
        }
        let results: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().expect("线程结束"))
            .collect();
        assert!(
            results.iter().all(|r| r.is_ok()),
            "第 {round} 轮并发首用不得有 AlreadyExists 失败：{results:?}"
        );
        fs::remove_dir_all(&tmp).expect("清理临时根");
    }
}

/// 首次创建 projects/ 的宿主同步失败（issue #309）：注入宿主同步失败后
/// 必须返回错误并拆除本次新建层级（重试得以重新创建并全链同步），不得
/// 以成功返回掩盖屏障缺失；重试（无注入）重新创建并同步成功。
#[cfg(unix)]
#[test]
fn ensure_projects_dir_host_sync_failure_removes_created_dir_and_retries() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    {
        let _injection = faults::Injection::new(Some(faults::Stage::ChildHostSync), None);
        let err = ensure_projects_dir(&root).unwrap_err();
        assert!(
            err.to_string().contains("injected ChildHostSync failure"),
            "实际错误：{err}"
        );
        assert!(
            err.to_string().contains("同步新目录条目宿主失败"),
            "屏障缺失应显式上抛：{err}"
        );
    }
    assert!(
        !projects.join("projects").exists(),
        "同步失败应拆除本次新建层级"
    );
    let dir = ensure_projects_dir(&root).expect("重试应重新创建并同步");
    drop(dir);
    assert!(projects.join("projects").is_dir(), "重试后目录应存在");
    cleanup_temp(&projects);
}

/// 已有 projects/ 目录（本次调用未创建条目）不得触发宿主同步——条目的
/// 持久性归创建时刻的调用方负责，与 create_dir_all_durable 的单级兜底
/// 分工一致（issue #309）。
#[cfg(unix)]
#[test]
fn ensure_projects_dir_existing_dir_skips_entry_sync() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    fs::create_dir(projects.join("projects")).expect("预置 projects 目录");
    let injection = faults::Injection::new(None, None);
    let dir = ensure_projects_dir(&root).expect("已存在目录应直接归类打开");
    drop(dir);
    assert!(
        !injection.stages().contains(&faults::Stage::ChildHostSync),
        "已存在目录不得触发宿主同步，实际阶段：{:?}",
        injection.stages()
    );
    drop(injection);
    cleanup_temp(&projects);
}
