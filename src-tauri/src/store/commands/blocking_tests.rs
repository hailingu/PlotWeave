//! 真实项目保存等待操作锁时，单线程异步运行时与媒体读取不得被占住。

use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::{load_project_file, persist_project, projects_op_lock, to_ipc_text};
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};

/// 故意占用生产项目锁，定时释放作为失败兜底；破坏调度后测试也不会永久挂住。
fn occupy_project_lock() -> std::thread::JoinHandle<()> {
    let (ready, waiting) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _guard = projects_op_lock();
        ready.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(500));
    });
    waiting.recv_timeout(Duration::from_secs(10)).unwrap();
    holder
}

#[test]
fn slow_save_keeps_runtime_and_media_reads_responsive() {
    let dir = temp_projects_dir();
    let root = cap(&dir);
    let mut doc = valid_save_doc();
    persist_project(&root, "p-fixture", doc.clone()).unwrap();
    std::fs::write(dir.join("media.png"), b"fixture-media").unwrap();
    let file = root.open("media.png").unwrap();
    let held = occupy_project_lock();
    doc.project.name = "after".into();
    let saving = root.try_clone().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let start = Instant::now();
    let save = runtime.spawn(crate::blocking::run("save_project", move || {
        persist_project(&saving, "p-fixture", doc).map_err(to_ipc_text)
    }));
    let (latency, old_name, bytes, finished) = runtime.block_on(async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let bytes = crate::blocking::run("media-read", move || {
            crate::media_protocol::read_project_media_capped("fixture", "image/png".into(), file)
                .map(|(_, bytes, _)| bytes)
                .map_err(|error| error.to_string())
        })
        .await
        .unwrap();
        let latency = start.elapsed();
        let old_name = load_project_file(&root, "p-fixture").unwrap().project.name;
        (latency, old_name, bytes, save.is_finished())
    });
    let saved = runtime.block_on(save).unwrap().unwrap();
    held.join().unwrap();
    let loaded = load_project_file(&root, "p-fixture").unwrap();
    cleanup_temp(&dir);
    println!("slow-save: async/media latency={latency:?}, lock=500ms");
    assert!(latency < Duration::from_millis(200));
    assert!(!finished, "持锁期间保存不得提前报告完成");
    assert_eq!(old_name, "午夜出租车");
    assert_eq!(bytes, b"fixture-media");
    assert_eq!(saved.name, "after");
    assert_eq!(loaded.project.name, "after");
}
