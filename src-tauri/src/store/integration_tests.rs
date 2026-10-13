//! 库导入与内核删除共享操作锁的宿主集成回归（PR #224）。

use super::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use super::{persist_project, projects_op_lock};
use std::fs;

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
