//! 列表顺带清扫的集成测试（issue #148 根目录清扫与 issue #722 会话目录
//! 清扫；自 tests.rs 拆出，维持源文件 ≤800 行，同 commands 的 limit_tests
//! 模式）：清扫三条件、操作锁串行与会话目录范围边界。

use super::*;
use crate::isotime::now_iso;
use crate::store::atomic_write_faults as faults;
use crate::store::commands::persist_project;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use crate::store::types::new_project_file;
use std::fs;

/// [PR #217 第三轮评审](https://github.com/hailingu/PlotWeave/pull/217)：
/// 挂起恢复/时钟前跳使进行中写入的临时文件 mtime 越过宽限期时，列表
/// 清扫必须持 projects 操作锁等待写入落定，不得在排他创建与 rename
/// 之间把活动临时文件当孤儿误删（rename 失败 → 在途保存被迫重试）。
/// 测试协同（确定性，无计时竞态）：写入线程经 faults 探针在 rename
/// 前回拨 mtime 并暂停等待放行；写入在等待放行期间持有操作锁，故
/// 修复后的清扫线程 200ms 内不可能完成——超时上界只用于判定「清扫
/// 提前完成」的红线情形。
#[test]
fn list_sweep_waits_for_active_write_even_when_temp_looks_aged() {
    let projects = temp_projects_dir();
    let (paused_tx, paused_rx) = std::sync::mpsc::channel::<String>();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel::<()>();
    let writer_dir = projects.clone();
    let writer = std::thread::spawn(move || {
        let probe_dir = writer_dir.clone();
        let _injection = faults::Injection::with_probe(faults::Stage::Rename, move || {
            let tmp = std::fs::read_dir(&probe_dir)
                .expect("读项目目录")
                .filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .find(|n| n.starts_with('.') && n.ends_with(".tmp"))
                .expect("临时文件存在");
            let file = fs::OpenOptions::new()
                .write(true)
                .open(probe_dir.join(&tmp))
                .expect("打开临时文件");
            file.set_modified(
                std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60),
            )
            .expect("回拨 mtime");
            paused_tx.send(tmp).expect("通知主线程");
            resume_rx.recv().expect("等待放行");
        });
        persist_project(&cap(&writer_dir), "p-1", valid_save_doc())
    });
    let tmp_name = paused_rx.recv().expect("写入线程在 rename 前暂停");
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let sweep_dir = projects.clone();
    let sweeper = std::thread::spawn(move || {
        let metas = list_project_metas(&cap(&sweep_dir));
        done_tx.send(metas).expect("报告列表结果");
    });
    let early = done_rx.recv_timeout(std::time::Duration::from_millis(200));
    let sweep_finished_during_write = early.is_ok();
    resume_tx.send(()).expect("放行写入线程");
    let save_result = writer.join().expect("写入线程结束");
    let metas = match early {
        Ok(metas) => metas,
        Err(_) => done_rx.recv().expect("清扫线程在写入落定后完成"),
    };
    assert!(
        !sweep_finished_during_write,
        "列表清扫在写入进行中不得完成（应持锁等待写入落定）"
    );
    assert!(
        save_result.is_ok(),
        "活动写入的 rename 不得因清扫误删临时文件而失败：{save_result:?}"
    );
    let metas = metas.expect("列出项目");
    assert_eq!(metas.len(), 1, "写入落定后列表可见新项目");
    assert!(
        !projects.join(&tmp_name).exists(),
        "临时文件已随 rename 落位"
    );
    sweeper.join().expect("清扫线程结束");
    cleanup_temp(&projects);
}

/// [issue #148](https://github.com/hailingu/PlotWeave/issues/148)：列表
/// 顺带清扫崩溃遗留的孤儿临时文件（归属可辨 + 超龄 + 普通文件三条件
/// 同时成立）；进行中写入的新鲜临时文件与项目文件不受影响，清扫
/// fail-soft 永不阻断列表。
#[test]
fn list_sweeps_crash_orphaned_temp_files() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "正常项目".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("先保存");
    let aged_tmp = projects.join(".p-1.json.p-18f-0.tmp");
    fs::write(&aged_tmp, b"partial").expect("写遗留临时文件");
    fs::OpenOptions::new()
        .write(true)
        .open(&aged_tmp)
        .expect("打开遗留临时文件")
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60))
        .expect("回拨 mtime");
    let fresh_tmp = projects.join(".p-2.json.p-18f-1.tmp");
    fs::write(&fresh_tmp, b"writing").expect("写进行中临时文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 1);
    assert!(!aged_tmp.exists(), "超龄归属临时文件应随列表被清理");
    assert!(fresh_tmp.exists(), "进行中的临时文件不得被清理");
    cleanup_temp(&projects);
}

/// issue #722：列表顺带清扫会话目录（`projects/{id}/`）内崩溃遗留的
/// AI 会话原子写临时文件——同款三条件（目标白名单 `ai-session.json` +
/// 生成器 id 形状、mtime 超龄、普通文件）；新鲜临时文件、正会话文件与
/// `assets/` 媒体临时文件不受影响（媒体目录仍为记录边界）。
#[test]
fn list_sweeps_crash_orphaned_ai_session_temp_files() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "会话项目".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("先保存");
    let session_dir = projects.join("p-1");
    fs::create_dir_all(session_dir.join("assets")).expect("建会话目录与媒体子目录");
    let aged_tmp = session_dir.join(".ai-session.json.p-18f-0.tmp");
    fs::write(&aged_tmp, b"partial").expect("写会话遗留临时文件");
    fs::OpenOptions::new()
        .write(true)
        .open(&aged_tmp)
        .expect("打开会话遗留临时文件")
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60))
        .expect("回拨 mtime");
    let fresh_tmp = session_dir.join(".ai-session.json.p-18f-1.tmp");
    fs::write(&fresh_tmp, b"writing").expect("写会话进行中临时文件");
    fs::write(session_dir.join("ai-session.json"), "{}").expect("写正会话文件");
    let aged_media_tmp = session_dir.join("assets/.poster.png.p-18f-2.tmp");
    fs::write(&aged_media_tmp, b"partial").expect("写媒体遗留临时文件");
    fs::OpenOptions::new()
        .write(true)
        .open(&aged_media_tmp)
        .expect("打开媒体遗留临时文件")
        .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60))
        .expect("回拨媒体 mtime");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 1);
    assert!(!aged_tmp.exists(), "会话目录超龄归属临时文件应随列表被清理");
    assert!(fresh_tmp.exists(), "会话目录进行中的临时文件不得被清理");
    assert!(
        session_dir.join("ai-session.json").exists(),
        "正会话文件不得被触碰"
    );
    assert!(
        aged_media_tmp.exists(),
        "assets/ 媒体临时文件仍为记录边界，不在本清扫范围"
    );
    cleanup_temp(&projects);
}
