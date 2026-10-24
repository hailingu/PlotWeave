//! issue #731 规模-耗时基线测量（自 tests.rs 拆出为独立模块）：`list_project_metas`
//! 持操作锁全量读取的耗时随项目树规模的增长，及并发 save/delete 的锁等待。
//! `#[ignore]` 测量工具，不参与常规回归；结论与环境记录见
//! docs/data-model/persistence.md §10.2 与 issue #731。

use super::*;
use crate::store::commands::{delete_project_files, persist_project};
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;

/// 构造目标字节数的合法 v1 项目文本（issue #731 夹具）：基线信封加结构化
/// 填充节点（每节点约 1 KiB，含 id/type/position/data.note），节点数组
/// 形态贴近真实画布文档的解析成本——单个超长字符串的 JSON 解析成本显著
/// 偏低，不作夹具形态。顶层键只含 v1 家族（project/graph/assets），不带
/// 旧扁平特征键，使 parse_file 走正常 v1 路径；实际字节数逼近目标（误差
/// 不超过一个填充节点）。
fn sized_v1_project_text(target_bytes: usize, index: usize) -> String {
    let filler = |i: usize| {
        json!({
            "id": format!("filler-{index}-{i}"),
            "type": "note",
            "position": { "x": 0.5, "y": 0.5 },
            "data": { "note": "x".repeat(1024) },
        })
    };
    let envelope = |nodes: serde_json::Value| {
        json!({
            "schemaVersion": 1,
            "project": {
                "id": format!("p-fx-{index:04}"),
                "name": format!("基线夹具 {index}"),
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": format!("2026-01-01T00:00:{:02}.000Z", index % 60),
            },
            "graph": { "nodes": nodes, "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 1 } },
            "settings": { "characters": {}, "locations": {}, "props": {}, "documents": {} },
            "episodeTitles": { "1": "开端" },
            "assets": { "byId": {} },
        })
    };
    let empty_len = serde_json::to_string(&envelope(json!([])))
        .expect("序列化基线信封")
        .len();
    let node_len = serde_json::to_string(&filler(0))
        .expect("序列化填充节点")
        .len();
    let count = target_bytes.saturating_sub(empty_len) / node_len.max(1);
    let nodes: Vec<_> = (0..count).map(filler).collect();
    serde_json::to_string(&envelope(json!(nodes))).expect("序列化夹具信封")
}

/// 在唯一临时 projects 根写入 n 个约 target_bytes 字节的夹具项目文件。
fn write_scaling_fixture(n: usize, target_bytes: usize) -> std::path::PathBuf {
    let projects = temp_projects_dir();
    for i in 0..n {
        let text = sized_v1_project_text(target_bytes, i);
        fs::write(projects.join(format!("p-fx-{i:04}.json")), text).expect("写夹具项目文件");
    }
    projects
}

/// 单一规模的列表持锁耗时（issue #731）：预热一次（兼作正确性断言——
/// 全部条目可读可解析、无损坏占位、条目数吻合），再取三次计时中位。
/// 夹具刚写完即读，页缓存为热，与「保存落定通知触发列表重读」的真实
/// 形态一致。
fn measure_list_at_scale(n: usize, target_bytes: usize) {
    let projects = write_scaling_fixture(n, target_bytes);
    let root = cap(&projects);
    let metas = list_project_metas(&root).expect("列表（预热）");
    assert_eq!(metas.len(), n, "夹具条目数");
    assert!(
        metas.iter().all(|m| m.diagnostic.is_none()),
        "夹具文件全部可读可解析，不得出现损坏占位"
    );
    let mut samples = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now();
        let metas = list_project_metas(&root).expect("列表（计时）");
        let elapsed = start.elapsed();
        assert_eq!(metas.len(), n);
        samples.push(elapsed);
    }
    samples.sort();
    let total_mib = n as f64 * target_bytes as f64 / (1024.0 * 1024.0);
    println!(
        "[issue-731] N={n:>3} 单文件≈{target_bytes:>7}B 总量≈{total_mib:>7.1}MiB | list 持锁耗时中位（3 次）：{:?}",
        samples[1]
    );
    cleanup_temp(&projects);
}

/// 争用观测的采样集合（issue #731）：纯取锁等待、争用保存与删除的逐样本
/// 计时；后台列表自身的耗时分布由列表线程的返回值单独携带。
struct ContentionObs {
    lock_waits: Vec<std::time::Duration>,
    saves: Vec<std::time::Duration>,
    deletes: Vec<std::time::Duration>,
}

/// 以同内容重建删除目标的项目文件（争用删除观测之间使用，重建不计时）。
fn rebuild_del_target(projects: &std::path::Path) {
    let text = serde_json::to_string(&valid_save_doc()).expect("序列化删除目标");
    fs::write(projects.join("p-del-target.json"), text).expect("重建删除目标项目文件");
}

/// 无争用基线（issue #731）：无后台负载时同一小项目的保存/删除各三次，
/// 返回前各自排序（中位 = 中间元素）。
fn uncontended_baselines(
    root: &CapDir,
    projects: &std::path::Path,
) -> (Vec<std::time::Duration>, Vec<std::time::Duration>) {
    let mut save_base = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now();
        persist_project(root, "p-save-target", valid_save_doc()).expect("无争用保存");
        save_base.push(start.elapsed());
    }
    let mut delete_base = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now();
        delete_project_files(root, "p-del-target").expect("无争用删除");
        delete_base.push(start.elapsed());
        rebuild_del_target(projects);
    }
    save_base.sort();
    delete_base.sort();
    (save_base, delete_base)
}

/// 争用采样（issue #731）：后台连续列表持锁期间，先做纯取锁等待探针
/// （10 次只取锁不做事——把「等锁」与保存/删除自身的 I/O（fsync 抖动）
/// 分开，端到端样本中的超出部分即自身工作在并发读负载下的延迟），再
/// 逐样本计时争用保存（5 次）与争用删除（3 次，每次删除后重建目标，
/// 重建不计时）。
fn contended_samples(root: &CapDir, projects: &std::path::Path) -> ContentionObs {
    let mut lock_waits = Vec::new();
    for _ in 0..10 {
        let start = std::time::Instant::now();
        let _guard = crate::store::persist::projects_op_lock();
        lock_waits.push(start.elapsed());
    }
    let mut saves = Vec::new();
    for _ in 0..5 {
        let start = std::time::Instant::now();
        persist_project(root, "p-save-target", valid_save_doc()).expect("争用保存");
        saves.push(start.elapsed());
    }
    let mut deletes = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now();
        delete_project_files(root, "p-del-target").expect("争用删除");
        deletes.push(start.elapsed());
        rebuild_del_target(projects);
    }
    ContentionObs {
        lock_waits,
        saves,
        deletes,
    }
}

/// 汇报争用观测（issue #731）：后台列表耗时分布、纯锁等待分布，以及
/// 保存/删除的无争用基线与争用逐样本对比。
fn report_contention(
    n: usize,
    target_bytes: usize,
    save_base: &[std::time::Duration],
    delete_base: &[std::time::Duration],
    mut obs: ContentionObs,
    mut list_runs: Vec<std::time::Duration>,
) {
    obs.lock_waits.sort();
    list_runs.sort();
    let sample_ms = |v: &[std::time::Duration]| {
        v.iter()
            .map(|d| format!("{:.1?}", d))
            .collect::<Vec<_>>()
            .join(" ")
    };
    println!(
        "[issue-731] N={n:>3} 单文件≈{target_bytes:>7}B | 后台列表 {} 次：中位 {:?} 最大 {:?}",
        list_runs.len(),
        list_runs[list_runs.len() / 2],
        list_runs[list_runs.len() - 1],
    );
    println!(
        "[issue-731]   纯锁等待（10 次采样）：中位 {:?} 最大 {:?}",
        obs.lock_waits[obs.lock_waits.len() / 2],
        obs.lock_waits[obs.lock_waits.len() - 1],
    );
    println!(
        "[issue-731]   保存 无争用中位 {:?}；争用逐样本（ms）：{}",
        save_base[save_base.len() / 2],
        sample_ms(&obs.saves)
    );
    println!(
        "[issue-731]   删除 无争用中位 {:?}；争用逐样本（ms）：{}",
        delete_base[delete_base.len() / 2],
        sample_ms(&obs.deletes)
    );
}

/// 并发等待观测（issue #731）：后台线程连续执行 `list_project_metas`
/// （每次完整持锁），主线程测量同一小项目的保存/删除总时长，与无争用
/// 基线对比——增量即 projects 操作锁等待，上限为当前列表的剩余持锁
/// 时长。等后台列表至少完成两次后才进入计时（排除线程启动未建立争用
/// 的假阴性），并输出后台列表自身的耗时分布与逐样本观测，使等待来源
/// （锁等待 vs 自身 I/O）当场可分。争用循环内的列表不断言条目数（删除/
/// 重建窗口内条目数波动是预期行为）。
fn measure_contended_save_delete(n: usize, target_bytes: usize) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let projects = write_scaling_fixture(n, target_bytes);
    let root = cap(&projects);
    persist_project(&root, "p-save-target", valid_save_doc()).expect("建保存目标项目");
    persist_project(&root, "p-del-target", valid_save_doc()).expect("建删除目标项目");
    let (save_base, delete_base) = uncontended_baselines(&root, &projects);
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let completed = std::sync::Arc::new(AtomicUsize::new(0));
    let list_root = cap(&projects);
    let (stop_flag, done_flag) = (stop.clone(), completed.clone());
    let list_thread = std::thread::spawn(move || {
        let mut durations = Vec::new();
        while !stop_flag.load(Ordering::Relaxed) {
            let start = std::time::Instant::now();
            list_project_metas(&list_root).expect("争用列表");
            durations.push(start.elapsed());
            done_flag.fetch_add(1, Ordering::Relaxed);
        }
        durations
    });
    while completed.load(Ordering::Relaxed) < 2 {
        std::thread::yield_now();
    }
    let obs = contended_samples(&root, &projects);
    stop.store(true, Ordering::Relaxed);
    let list_runs = list_thread.join().expect("争用列表线程结束");
    report_contention(n, target_bytes, &save_base, &delete_base, obs, list_runs);
    cleanup_temp(&projects);
}

/// issue #731 基线测量入口（手动运行，不参与常规回归）：
/// `cargo test -p plotweave-core --lib --release -- --ignored --nocapture list_scaling`
/// 先测并发等待（两档代表规模，避免后置大夹具的写入/清理 I/O 压力污染
/// fsync 观测），再测 N × V 网格（覆盖现实规模——几十个 × 小体积——到
/// 偏大规模——数百个 × 数 MiB）。release 构建：与生产应用同一优化级别。
/// 产物为 stdout 测量表，只断言正确性不变量、不断言任何时长；时长结论
/// 与环境记录见 docs/data-model/persistence.md §10.2 与 issue #731。
#[test]
#[ignore = "issue #731 基线测量：手动运行并记录结论，见 docs/data-model/persistence.md"]
fn list_scaling_baseline() {
    const KIB: usize = 1024;
    measure_contended_save_delete(100, 64 * KIB);
    measure_contended_save_delete(200, 512 * KIB);
    let grid = [
        (50, 64 * KIB),
        (100, 64 * KIB),
        (200, 64 * KIB),
        (50, 512 * KIB),
        (100, 512 * KIB),
        (200, 512 * KIB),
        (50, 2 * 1024 * KIB),
        (100, 2 * 1024 * KIB),
        (200, 2 * 1024 * KIB),
        (400, 2 * 1024 * KIB),
    ];
    for &(n, bytes) in &grid {
        measure_list_at_scale(n, bytes);
    }
}
