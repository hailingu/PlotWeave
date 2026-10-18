//! 控制文件字节上限的保存/会话闭环测试（issue #592）：自 commands/tests.rs
//! 拆出以维持受维护源文件 800 行上限；读取侧列表/加载回归在 list/tests.rs。

use super::*;
use crate::store::persist::CONTROL_FILE_MAX_BYTES;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use std::fs;

/// issue #592：写入侧与读取上限闭环——序列化结果超过控制文件上限时在
/// 落盘前拒绝，避免产生下次启动无法读取的文件；失败不留临时文件。
#[test]
fn save_rejects_document_over_control_file_limit_before_writing() {
    let projects = temp_projects_dir();
    let mut doc = valid_save_doc();
    doc.graph = serde_json::json!({
        "nodes": [{
            "id": "n-big",
            "type": "scene",
            "data": { "script": "x".repeat(CONTROL_FILE_MAX_BYTES) }
        }],
        "edges": []
    });
    let err = persist_project(&cap(&projects), "p-1", doc).unwrap_err();
    assert!(
        err.to_string().contains("64 MiB") && err.to_string().contains("上限"),
        "超限保存须拒绝并点明上限：{err}"
    );
    assert!(
        fs::symlink_metadata(projects.join("p-1.json")).is_err(),
        "超限保存不得落盘"
    );
    assert_no_temp_left(&projects);
    cleanup_temp(&projects);
}

/// issue #592：AI 会话主文件与项目控制文件共用同一字节上限——超限保存
/// 拒绝；超限读取返回错误而非静默 corrupt（也不完整物化）。
#[test]
fn ai_session_control_file_limit_is_enforced_on_read_and_write() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-1.json"), b"{}").expect("写项目记录");
    let session = serde_json::json!({
        "schemaVersion": 1,
        "entries": [{
            "id": 1,
            "kind": "msg",
            "role": "user",
            "text": "x".repeat(CONTROL_FILE_MAX_BYTES)
        }]
    });
    let err = save_ai_session_file(&cap(&projects), "p-1", &session).unwrap_err();
    assert!(
        err.to_string().contains("AI 会话") && err.to_string().contains("64 MiB"),
        "超限会话保存须拒绝并点明上限：{err}"
    );
    assert!(
        fs::symlink_metadata(projects.join("p-1").join("ai-session.json")).is_err(),
        "超限会话保存不得落盘"
    );
    // 预置超限损坏字节：读取须显式报错，不得降级为 corrupt 空历史
    fs::create_dir_all(projects.join("p-1")).expect("建会话目录");
    let path = projects.join("p-1").join("ai-session.json");
    let file = fs::File::create(&path).expect("创建超限会话");
    file.set_len(CONTROL_FILE_MAX_BYTES as u64 + 1)
        .expect("设置超限长度");
    drop(file);
    let err = load_ai_session_file(&cap(&projects), "p-1")
        .err()
        .expect("超限会话读取应报错");
    assert!(
        err.to_string().contains("64 MiB"),
        "超限会话读取须点明上限：{err}"
    );
    cleanup_temp(&projects);
}

/// issue #592 回归：合法大项目（远低于上限）仍可保存与加载，限读不误伤
/// 正常文档。
#[test]
fn large_document_under_limit_round_trips() {
    let projects = temp_projects_dir();
    let mut doc = valid_save_doc();
    doc.graph = serde_json::json!({
        "nodes": [{
            "id": "n-large",
            "type": "scene",
            "data": { "script": "x".repeat(4 * 1024 * 1024) }
        }],
        "edges": []
    });
    let root = cap(&projects);
    persist_project(&root, "p-large", doc).expect("低于上限的大项目应可保存");
    let loaded = load_project_file(&root, "p-large").expect("低于上限的大项目应可加载");
    assert_eq!(
        loaded.graph["nodes"][0]["data"]["script"]
            .as_str()
            .map(str::len),
        Some(4 * 1024 * 1024)
    );
    cleanup_temp(&projects);
}

/// 超限保存失败后 projects/ 根不得遗留原子写临时文件。
fn assert_no_temp_left(projects: &std::path::Path) {
    let leftovers: Vec<String> = fs::read_dir(projects)
        .expect("扫描 projects 根")
        .map(|entry| {
            entry
                .expect("读取目录条目失败")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "超限保存不得遗留临时文件：{leftovers:?}"
    );
}
