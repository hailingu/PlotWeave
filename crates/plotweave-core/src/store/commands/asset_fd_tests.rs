//! issue #848：真实低描述符子进程上的保存规模、拒绝与恢复回归。
//! 限制只作用于子进程，正常测试运行器和用户系统额度均不变。

use super::*;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use std::{fs, process::Command};

const CHILD_SCENARIO: &str = "PLOTWEAVE_ASSET_FD_TEST_SCENARIO";
const CHILD_TEST: &str = "store::commands::asset_fd_tests::low_limit_child";

/// 通过 bash 在 exec 前设置实际 RLIMIT_NOFILE，避免影响并发测试进程。
#[test]
fn save_assets_under_low_fd_limit() {
    for scenario in ["126", "200", "240", "244", "248", "252", "260"] {
        let output = Command::new("bash")
            .args(["-c", "ulimit -n 256 && exec \"$@\"", "asset-fd-regression"])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"])
            .env(CHILD_SCENARIO, scenario)
            .output()
            .expect("启动低描述符子进程");
        assert!(
            output.status.success(),
            "scenario={scenario}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// 子进程夹具只通过真实保存／加载 API 观察结果；普通运行时不设置限制。
#[test]
fn low_limit_child() {
    let Ok(scenario) = std::env::var(CHILD_SCENARIO) else {
        return;
    };
    let count: usize = scenario.parse().unwrap();
    let projects = temp_projects_dir();
    let root = cap(&projects);
    let mut doc = document_with_assets(&projects, count);
    if count <= 200 {
        for attempt in 0..3 {
            doc.project.name = format!("资产保存 {attempt}");
            let meta = persist_project(&root, "p-1", doc.clone())
                .expect("预算内保存不得写后因累计复验句柄失败");
            let loaded = load_project_file(&root, "p-1").unwrap();
            assert_eq!(loaded.project.name, doc.project.name);
            assert_eq!(loaded.project.updated_at, meta.updated_at);
            assert_eq!(loaded.assets, doc.assets);
        }
    } else if count < 256 {
        match persist_project(&root, "p-1", doc.clone()) {
            Ok(_) => assert_eq!(load_project_file(&root, "p-1").unwrap().assets, doc.assets),
            Err(err) => {
                assert_precommit_fd_error(&err);
                assert!(!projects.join("p-1.json").exists());
            }
        }
    } else {
        let err = persist_project(&root, "p-1", doc.clone()).unwrap_err();
        assert_precommit_fd_error(&err);
        assert!(!projects.join("p-1.json").exists());
        persist_project(&root, "p-1", valid_save_doc()).unwrap();
        let original = fs::read(projects.join("p-1.json")).unwrap();
        doc.project.name = "不得部分覆盖".into();
        let err = persist_project_expect_existing(&root, "p-1", doc.clone(), true).unwrap_err();
        assert_precommit_fd_error(&err);
        assert_eq!(fs::read(projects.join("p-1.json")).unwrap(), original);
        // 失败须释放已验证句柄；减少本次引用后，不提高限制也能重试成功。
        let by_id = doc.assets["byId"].as_object_mut().unwrap();
        let keys: Vec<_> = by_id.keys().skip(200).cloned().collect();
        for key in keys {
            by_id.remove(&key);
        }
        persist_project_expect_existing(&root, "p-1", doc.clone(), true).unwrap();
        assert_eq!(load_project_file(&root, "p-1").unwrap().assets, doc.assets);
    }
    assert!(fs::read_dir(&projects).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    cleanup_temp(&projects);
}

/// 资源耗尽保留原始 errno 与写前阶段，不伪装成文件缺失或路径替换。
fn assert_precommit_fd_error(err: &StoreError) {
    assert!(
        matches!(err.root(), StoreError::Io { source, .. } if source.raw_os_error() == Some(24)),
        "{err}"
    );
    assert!(err.to_string().contains("文档未提交"), "{err}");
    assert!(!err.to_string().contains("被替换"), "{err}");
}

/// 保存期间的叶节点与中间目录替换仍在第二轮按 no-follow 拒绝。
#[test]
fn streamed_postcheck_still_rejects_symlink_replacement() {
    use crate::store::persist::faults::{Injection, Stage};
    for replace_directory in [false, true] {
        let projects = temp_projects_dir();
        let root = cap(&projects);
        let doc = document_with_assets(&projects, 1);
        let path = if replace_directory {
            projects.join("p-1/assets")
        } else {
            projects.join("p-1/assets/a-0.png")
        };
        let moved = path.with_extension("held");
        let injection = Injection::with_probe(Stage::DirectorySync, move || {
            fs::rename(&path, &moved).unwrap();
            std::os::unix::fs::symlink(&moved, &path).unwrap();
        });
        let err = persist_project(&root, "p-1", doc.clone()).unwrap_err();
        assert!(matches!(err.root(), StoreError::Refused { .. }), "{err}");
        assert!(err.to_string().contains("文档已提交"), "{err}");
        assert_eq!(load_project_file(&root, "p-1").unwrap().assets, doc.assets);
        drop(injection);
        cleanup_temp(&projects);
    }
}

/// 为真实文件系统构造合法资产索引，资产创建不保留额外文件句柄。
fn document_with_assets(projects: &std::path::Path, count: usize) -> ProjectFile {
    let dir = projects.join("p-1/assets");
    fs::create_dir_all(&dir).unwrap();
    let mut by_id = serde_json::Map::new();
    for i in 0..count {
        let key = format!("a-{i}");
        fs::write(dir.join(format!("{key}.png")), b"asset").unwrap();
        by_id.insert(
            key.clone(),
            serde_json::json!({
                "id": key, "relPath": format!("assets/{key}.png"),
                "mime": "image/png", "source": "upload",
                "createdAt": "2026-08-01T00:00:00.000Z"
            }),
        );
    }
    let mut doc = valid_save_doc();
    doc.assets = serde_json::json!({ "byId": by_id });
    doc
}
