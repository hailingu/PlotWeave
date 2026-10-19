//! A held project lock must not occupy the single-thread async runtime or media reader.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::{load_project_file, persist_project, projects_op_lock, to_ipc_text};
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};

/// Keep the production lock until explicitly released; the long timeout only bounds a deadlock.
fn occupy_project_lock() -> (mpsc::Sender<()>, std::thread::JoinHandle<bool>) {
    let (ready, waiting) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let guard = projects_op_lock();
        ready.send(()).unwrap();
        let controlled = gate.recv_timeout(Duration::from_secs(10)).is_ok();
        drop(guard);
        controlled
    });
    waiting.recv_timeout(Duration::from_secs(10)).unwrap();
    (release, holder)
}

#[test]
fn slow_save_keeps_runtime_and_media_reads_responsive() {
    let dir = temp_projects_dir();
    let root = cap(&dir);
    let mut doc = valid_save_doc();
    persist_project(&root, "p-fixture", doc.clone()).unwrap();
    std::fs::write(dir.join("media.png"), b"fixture-media").unwrap();
    let file = root.open("media.png").unwrap();
    let (release, held) = occupy_project_lock();
    let (entered, started) = tokio::sync::oneshot::channel();
    doc.project.name = "after".into();
    let saving = root.try_clone().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let start = Instant::now();
    let save = runtime.spawn(crate::blocking::run("save_project", move || {
        entered.send(()).unwrap();
        persist_project(&saving, "p-fixture", doc).map_err(to_ipc_text)
    }));
    let (latency, old_name, bytes, finished) = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), async {
            started.await.unwrap();
            let bytes = crate::blocking::run("media-read", move || {
                crate::media_protocol::read_project_media_capped(
                    "fixture",
                    "image/png".into(),
                    file,
                )
                .map(|(_, bytes, _)| bytes)
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
            let old_name = load_project_file(&root, "p-fixture").unwrap().project.name;
            (start.elapsed(), old_name, bytes, save.is_finished())
        })
        .await
        .expect("runtime/media must progress while the project lock remains held")
    });
    let released = release.send(()).is_ok();
    let saved = runtime.block_on(save).unwrap().unwrap();
    let controlled = held.join().unwrap();
    let loaded = load_project_file(&root, "p-fixture").unwrap();
    cleanup_temp(&dir);
    println!("slow-save: async/media observation={latency:?}, explicit lock release");
    assert!(
        controlled && released,
        "the deadlock watchdog must not release the lock for the test"
    );
    assert!(!finished, "save must remain pending while the lock is held");
    assert_eq!(old_name, "午夜出租车");
    assert_eq!(bytes, b"fixture-media");
    assert_eq!(saved.name, "after");
    assert_eq!(loaded.project.name, "after");
}
