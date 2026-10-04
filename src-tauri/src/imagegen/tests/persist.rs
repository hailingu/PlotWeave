//! 生图产物落盘的阻塞调度测试（issue #310，自 tests.rs 拆分以维持源
//! 文件 800 行上限，同 tests.rs 外置先例）：真实操作锁竞争下兄弟异步
//! 任务推进、锁等待期取消不落盘、已删项目不被重建，以及命令 future
//! 丢弃后登记缺失拒绝挂起写入（评审修复）。

use super::*;

/// 落盘测试夹具：临时 projects 根 + 种子化项目控制文件；返回
/// (root, projects_path)——root 供断言与清理。
fn temp_projects_fixture(id: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-imagegen-persist-{}", crate::store::new_id()));
    std::fs::create_dir_all(&root).expect("创建临时 projects 目录");
    std::fs::write(root.join(format!("{id}.json")), b"{}").expect("写入项目控制文件");
    let projects = root.clone();
    (root, projects)
}

/// 单个落盘单元（与 persist_generated_asset 相同的调度与内核组合，
/// 句柄来源替换为测试夹具）：真实 blocking::run + 真实写内核 + 真实
/// 注册表取消查询。
fn persist_unit(
    projects_path: std::path::PathBuf,
    registry: std::sync::Arc<ImageJobRegistry>,
    job_id: String,
) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
    crate::blocking::run("llm_image_generate", move || {
        let projects = CapDir::open_ambient_dir(&projects_path, cap_std::ambient_authority())
            .expect("打开测试 projects 句柄");
        let pending = crate::assets::project_media::PendingProjectAssets::new();
        write_and_validate_generated_asset(
            &projects,
            &pending,
            &registry,
            &job_id,
            "p-1",
            b"generated-png-bytes",
            "image/png",
        )
    })
}

/// 真实锁竞争下兄弟异步任务仍可推进（issue #310 验收）：操作锁被他者
/// 持有 400ms 期间，32 个并发落盘单元（真实 blocking::run + 写内核）经
/// 阻塞执行等待锁，不占用异步工作线程——20ms 后完成的兄弟异步任务必须
/// 在锁仍被持有时落地；锁释放后全部单元落盘成功并通过 §9.3 校验。
/// K 取 32 ≫ 任意现实 worker 数：若落盘仍内联在异步任务上，等待期会
/// 钉死全部 worker，兄弟任务将拖延到锁释放之后。
#[test]
fn lock_contention_persist_leaves_async_workers_free() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-0");

    // 持锁确认栅栏（评审修复）：栅栏之后才启动单元，锁竞争真实成立
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _op = crate::store::projects_op_lock();
        locked_tx.send(()).expect("通知持锁");
        std::thread::sleep(std::time::Duration::from_millis(400));
        // 先记录后释放：该时刻 ≤ 真实释放时刻，比较方向保守安全
        std::time::Instant::now()
    });
    locked_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("持锁者应取得操作锁");

    let sibling_done = std::sync::Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));
    let (units_ok, sibling_at) = tauri::async_runtime::block_on(async {
        let sibling = {
            let sibling_done = sibling_done.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                *sibling_done.lock().expect("兄弟任务账本") = Some(std::time::Instant::now());
            })
        };
        let mut handles = Vec::new();
        for _ in 0..32 {
            let unit = persist_unit(projects_path.clone(), registry.clone(), "job-0".to_string());
            handles.push(tauri::async_runtime::spawn(unit));
        }
        let mut results = Vec::new();
        for handle in handles {
            results.push(handle.await.expect("落盘单元不应 panic"));
        }
        sibling.await.expect("兄弟任务不应 panic");
        let sibling_at = sibling_done
            .lock()
            .expect("兄弟任务账本")
            .expect("兄弟任务应已记录完成时刻");
        (results, sibling_at)
    });
    let released_at = holder.join().expect("持锁线程应正常结束");
    drop(registration);

    for result in &units_ok {
        let asset = result.as_ref().expect("全部落盘单元应成功");
        assert!(
            asset
                .as_object()
                .is_some_and(|a| a["source"] == "generated"),
            "落盘单元应返回 source=generated 的项目级 AssetRef：{asset:?}"
        );
    }
    assert!(
        sibling_at < released_at,
        "兄弟异步任务应在锁仍被持有时推进（完成 {sibling_at:?} ≥ 释放 {released_at:?}）"
    );
    let _ = root;
}

/// 锁等待期间取消后不落盘（issue #310 验收）：取消登记发生在持锁窗口
/// 内，落盘单元拿到锁后的复验经托管注册表查询到取消——返回已取消，
/// 项目 assets 目录不创建（不留下不可达资产）；登记守卫保持到断言后，
/// 阻塞线程查询与命令侧检查点同一事实源。
#[test]
fn cancel_during_lock_wait_skips_disk_write() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-1");

    // 持锁确认栅栏（评审修复）：单元启动时锁必然已被持有，50ms 处的
    // 取消必然落在锁等待窗口内
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _op = crate::store::projects_op_lock();
        locked_tx.send(()).expect("通知持锁");
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    locked_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("持锁者应取得操作锁");

    let unit_registry = registry.clone();
    let result = tauri::async_runtime::block_on(async {
        let unit = tauri::async_runtime::spawn(persist_unit(
            projects_path.clone(),
            unit_registry,
            "job-1".to_string(),
        ));
        // 单元此刻已在锁等待中；等待期间的取消必须在锁内复验被看见
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        registry.cancel("job-1");
        unit.await.expect("落盘单元不应 panic")
    });
    holder.join().expect("持锁线程应正常结束");
    drop(registration);

    let err = result.expect_err("锁等待期间的取消应拒绝落盘");
    assert!(err.contains("已取消"), "实际诊断：{err}");
    // 取消后连 assets 目录都不应创建；若存在则必须为空
    let dir = root.join("p-1").join("assets");
    assert!(
        !dir.exists()
            || std::fs::read_dir(&dir)
                .expect("读取 assets 目录")
                .next()
                .is_none(),
        "取消后不得写盘：{root:?}"
    );
}

/// 项目删除与生成写入仍串行，不能重建已删项目（issue #310 验收）：
/// 删除（控制文件移除，删除命令与落盘共用操作锁）发生在锁等待窗口内，
/// 落盘单元拿到锁后控制文件复验失败——返回项目不存在，不建项目目录。
#[test]
fn deleted_project_during_lock_wait_is_not_recreated() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-1");

    // 持锁确认栅栏（评审修复）：删除必然落在单元的锁等待窗口内
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _op = crate::store::projects_op_lock();
        locked_tx.send(()).expect("通知持锁");
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    locked_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("持锁者应取得操作锁");

    let result = tauri::async_runtime::block_on(async {
        let unit = tauri::async_runtime::spawn(persist_unit(
            projects_path.clone(),
            registry.clone(),
            "job-1".to_string(),
        ));
        // 单元在锁等待中；删除在其关键区内移除控制文件（同一操作锁串行）
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::fs::remove_file(root.join("p-1.json")).expect("删除项目控制文件");
        unit.await.expect("落盘单元不应 panic")
    });
    holder.join().expect("持锁线程应正常结束");
    drop(registration);

    let err = result.expect_err("已删项目不得被写入重建");
    assert!(err.contains("项目不存在"), "实际诊断：{err}");
    assert!(
        !root.join("p-1").exists(),
        "不得替已删项目创建资产目录：{root:?}"
    );
}

/// 命令 future 被丢弃后的挂起写入仍被拒绝（issue #310 评审修复）：
/// spawn_blocking 不随等待者取消中断——运行时关闭等场景下命令 future
/// 在持久化单元等锁期间被丢弃，登记守卫先行 Drop 移除活动条目。锁内
/// 复验必须因登记缺失拒绝写入（响应已无人接收，不留不可达资产）；
/// 此前已登记的取消也不得被守卫释放抹去。
#[test]
fn dropped_command_registration_rejects_pending_write() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-1");

    // 持锁确认栅栏：单元必然在锁等待中被丢弃
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _op = crate::store::projects_op_lock();
        locked_tx.send(()).expect("通知持锁");
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    locked_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("持锁者应取得操作锁");

    let result = tauri::async_runtime::block_on(async {
        let unit = tauri::async_runtime::spawn(persist_unit(
            projects_path.clone(),
            registry.clone(),
            "job-1".to_string(),
        ));
        // 单元在锁等待中；此刻命令 future 被丢弃（守卫先行 Drop 移除
        // 活动条目），阻塞任务自身继续运行
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        drop(registration);
        unit.await.expect("落盘单元不应 panic")
    });
    holder.join().expect("持锁线程应正常结束");

    let err = result.expect_err("登记已移除的挂起写入应拒绝");
    assert!(err.contains("已取消"), "实际诊断：{err}");
    let dir = root.join("p-1").join("assets");
    assert!(
        !dir.exists()
            || std::fs::read_dir(&dir)
                .expect("读取 assets 目录")
                .next()
                .is_none(),
        "结果无人接收时不得写盘：{root:?}"
    );
}
