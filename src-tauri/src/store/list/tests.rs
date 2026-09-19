//! 项目列表/加载的解析集成测试（自 list.rs 内联模块外置，issue #39）。

use super::*;
use crate::isotime::now_iso;
use crate::store::atomic_write_faults as faults;
use crate::store::commands::{load_project_file, persist_project};
use crate::store::testutil::{cap, cleanup_temp, meta, temp_projects_dir, valid_save_doc};
use crate::store::types::new_project_file;
use serde_json::json;
use std::fs;

#[test]
fn graph_stats_ignores_attach_edges_for_endings() {
    let nodes = json!([
        { "id": "s1", "type": "scene", "data": {} },
        { "id": "s2", "type": "scene", "data": {} },
        { "id": "sh", "type": "shot", "data": {} },
    ]);
    // s1 只下挂分镜（attach 派生边）：仍是叶子结局；s2 无任何出边同为结局
    let attach_only = json!({
        "nodes": nodes,
        "edges": [
            { "id": "e1", "source": "s1", "target": "sh",
              "sourceHandle": "shots", "className": "pw-edge-attach" },
        ],
    });
    assert_eq!(graph_stats(&attach_only), (2, 2));

    // s1 有剧情流出边 → 非结局（v1 形态：kind 显式存于 data.kind）
    let with_sequence = json!({
        "nodes": nodes,
        "edges": [
            { "id": "e1", "source": "s1", "target": "sh",
              "sourceHandle": "shots", "data": { "kind": "attach" } },
            { "id": "e2", "source": "s1", "target": "s2", "data": { "kind": "sequence" } },
        ],
    });
    assert_eq!(graph_stats(&with_sequence), (2, 1));
}

#[test]
fn stats_count_scenes_and_leaf_endings() {
    let graph = json!({
        "nodes": [
            { "id": "s1", "type": "scene" },
            { "id": "d1", "type": "dialogue" },
            { "id": "s2", "type": "scene" },
            { "id": "s3", "type": "scene" },
        ],
        "edges": [
            { "source": "s1", "target": "d1" },
            { "source": "d1", "target": "s2" },
        ],
    });
    assert_eq!(graph_stats(&graph), (3, 2)); // s2/s3 无出边 = 结局
}

#[test]
fn stats_on_malformed_graph_fall_back_to_zero() {
    assert_eq!(graph_stats(&json!(null)), (0, 0));
    assert_eq!(graph_stats(&json!({ "nodes": "oops" })), (0, 0));
}

#[test]
fn v1_file_missing_timestamps_pass_through_for_frontend_repair() {
    // 缺 project 时间戳的信封原样透传（空串）：Rust 侧预合成会让前端
    // repaired 检测看不见缺陷（快照已是修好的值）——修复不回写、脏文件
    // 长留，且每次 list 都合成新时刻把未动过的项目顶到最近列表顶端。
    // 前端 §11.1 第 2 步修复时间戳并按 repaired 回写落定；列表排序把
    // 不可解析时间戳稳定排最后（sort_metas_by_recency）。
    let v1 = json!({
        "schemaVersion": 1,
        "project": { "id": "p-1", "name": "旧时间" },
        "graph": { "nodes": [], "edges": [] },
        "settings": {},
        "episodeTitles": {},
        "assets": { "byId": {} },
    });
    let file = parse_file("p-1", &v1.to_string()).unwrap();
    assert!(file.project.updated_at.is_empty());
    assert!(file.project.created_at.is_empty());
}

#[test]
fn legacy_flat_file_wraps_as_v0_envelope() {
    let legacy = json!({
        "name": "旧项目",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [{ "id": "a", "type": "scene", "data": {} }],
        "edges": [],
        "settings": { "characters": [], "locations": [] },
        "episodeTitles": { "1": "开端" },
    });
    let file = parse_file("p-old", &legacy.to_string()).unwrap();
    assert_eq!(file.schema_version, 0);
    assert_eq!(file.project.id, "p-old");
    assert_eq!(file.project.name, "旧项目");
    assert_eq!(file.project.updated_at, "2023-11-14T22:13:20.000Z");
    assert_eq!(file.graph["nodes"][0]["id"], json!("a"));
    // 旧格式无视口：信封不伪造，前端打开时 fitView
    assert!(file.graph.get("viewport").is_none());
    assert_eq!(file.episode_titles, json!({ "1": "开端" }));
}

#[test]
fn versionless_v1_envelope_classifies_as_v1_and_keeps_graph() {
    // 丢失版本号但保持 v1 信封特征（§11 第 0 步）：按 v1 交付归一化，
    // 绝不按旧扁平格式读取顶层 nodes/edges 装配出空画布并回写摧毁原文件
    let v1 = json!({
        "project": {
            "id": "p-1", "name": "丢版本号",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "updatedAt": "2026-08-28T12:00:00.000Z",
        },
        "graph": {
            "nodes": [{ "id": "s1", "type": "scene",
                        "layout": { "position": { "x": 0, "y": 0 } },
                        "ui": { "selected": false, "expanded": true },
                        "data": { "spec": {}, "meta": { "label": "场一" } } }],
            "edges": [],
        },
        "settings": { "characters": {}, "locations": {}, "props": {}, "documents": {} },
        "episodeTitles": {},
        "assets": { "byId": {} },
    });
    let file = parse_file("p-1", &v1.to_string()).unwrap();
    assert_eq!(file.schema_version, 1);
    assert_eq!(file.graph["nodes"][0]["id"], json!("s1"));
    // 判型打 versionless IPC 标记：载荷额外键让前端 repaired 比较必然
    // 不等，回写补盖显式版本号——文件不再永久无版本（§10.5/§11.1 收敛）
    assert!(file.versionless);
    let ipc = serde_json::to_value(&file).unwrap();
    assert_eq!(ipc["versionless"], json!(true));
    // 显式版本与 v0 包装不打标记（v0 迁移本身即回写）
    let explicit = json!({
        "schemaVersion": 1,
        "project": { "id": "p-1", "name": "显式" },
        "graph": { "nodes": [], "edges": [] },
    });
    assert!(
        !parse_file("p-1", &explicit.to_string())
            .unwrap()
            .versionless
    );
    let v0 = json!({
        "name": "旧项目", "updated_at": 1_700_000_000_000u64,
        "nodes": [], "edges": [],
    });
    assert!(!parse_file("p-1", &v0.to_string()).unwrap().versionless);
}

#[test]
fn mixed_or_unclassifiable_envelope_is_rejected() {
    // v1 专属键与旧扁平键并存（混合信封）、或两组特征都不满足的损坏文档：
    // 拒绝加载并保留原文件（§11 第 0 步），不得回退为空 v0 图
    let mixed = json!({
        "project": { "name": "混合信封" },
        "name": "旧名",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [],
        "edges": [],
    });
    assert!(parse_file("p-1", &mixed.to_string()).is_err());
    assert!(parse_file("p-1", "{}").is_err());
    assert!(parse_file("p-1", r#"{"foo": 1}"#).is_err());
    // 单个旧扁平键不足以判型
    assert!(parse_file("p-1", r#"{"nodes": []}"#).is_err());
}

#[test]
fn explicit_version_conflicting_with_envelope_family_is_rejected() {
    // 显式 schemaVersion: 0 却携带 v1 专属键（§11 第 0 步两族冲突）：
    // 若放行，前端会把 v1 StoryNode 送进旧版迁移器，且每次 v0 加载都
    // 视为已迁移并回写，可能摧毁节点字段——拒绝加载并保留原文件
    let v0_with_v1 = json!({
        "schemaVersion": 0,
        "project": { "name": "伪装旧版" },
        "graph": { "nodes": [], "edges": [] },
        "assets": { "byId": {} },
    });
    assert!(parse_file("p-1", &v0_with_v1.to_string()).is_err());
    // 反向冲突：显式 v1 信封携带旧扁平专属键（顶层 name/updated_at/nodes/edges）
    let v1_with_legacy = json!({
        "schemaVersion": 1,
        "project": { "name": "x" },
        "graph": { "nodes": [], "edges": [] },
        "name": "旧名",
        "nodes": [],
    });
    assert!(parse_file("p-1", &v1_with_legacy.to_string()).is_err());
    // 非数字版本号不可判型
    assert!(parse_file(
        "p-1",
        r#"{"schemaVersion": "1", "project": {}, "graph": {}}"#
    )
    .is_err());
}

#[test]
fn explicit_v0_with_legacy_shape_wraps_as_v0_envelope() {
    // 显式 0 = 旧扁平家族：信封保持扁平形状时与无版本号路径一致包装
    let legacy = json!({
        "schemaVersion": 0,
        "name": "显式旧版",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [{ "id": "a", "type": "scene", "data": {} }],
        "edges": [],
    });
    let file = parse_file("p-old", &legacy.to_string()).unwrap();
    assert_eq!(file.schema_version, 0);
    assert_eq!(file.project.name, "显式旧版");
    assert_eq!(file.graph["nodes"][0]["id"], json!("a"));
}

#[test]
fn v1_file_with_recoverable_project_metadata_loads_for_frontend_repair() {
    // project 容器/字段异型不再整份拒绝（§11 第 0 步）：逐字段回退缺省，
    // 字段级修复与警告归前端归一化层（§11.1 第 3 步）——可恢复的元数据
    // 损坏不应让整个项目打不开
    let doc = json!({
        "schemaVersion": 1,
        "project": null,
        "graph": { "nodes": [], "edges": [] },
        "settings": {},
        "episodeTitles": {},
        "assets": { "byId": {} },
    });
    let file = parse_file("p-1", &doc.to_string()).unwrap();
    // id 缺省同样透传（空串）：前端以受信路径 id 覆盖并按 repaired 回写
    assert!(file.project.id.is_empty());
    assert!(file.project.name.is_empty()); // 名称缺省，前端按回退链修复

    // 字段级异型：name/description/时间戳非字符串，id 非字符串——
    // 一律回退空串透传，修复与落盘归前端归一化层
    let doc = json!({
        "schemaVersion": 1,
        "project": { "id": 7, "name": null, "description": 42, "createdAt": 5, "updatedAt": [] },
        "graph": { "nodes": [{ "id": "s1" }], "edges": [] },
    });
    let file = parse_file("p-1", &doc.to_string()).unwrap();
    assert!(file.project.id.is_empty());
    assert!(file.project.name.is_empty());
    assert_eq!(file.project.description, Some(json!(42)));
    assert!(file.project.created_at.is_empty());
    assert!(file.project.updated_at.is_empty());
    // graph 原样透传，内容不丢
    assert_eq!(file.graph["nodes"][0]["id"], json!("s1"));
}

#[test]
fn v1_invalid_description_passes_through_for_frontend_repair() {
    // 非字符串 description 原样透传：折叠为 None 会让前端 repaired 检测
    // 看不见缺陷（§11.1「存在但非字符串时剥离并警告」永不触发）
    let text = r#"{"schemaVersion":1,"project":{"id":"p-1","name":"剧","createdAt":"","updatedAt":"","description":42},"graph":{"nodes":[],"edges":[]}}"#;
    let file = parse_file("p-1", text).expect("解析 v1");
    assert_eq!(file.project.description, Some(json!(42)));
}

#[test]
fn v1_missing_buckets_pass_through_null_for_frontend_repair() {
    // 缺桶以 Null 透传：前端 §11.1 第 2 步补齐并标记 repaired 回写——
    // 预补空容器会让 repaired 检测看不见缺陷，缺桶信封永不收敛
    let text =
        r#"{"schemaVersion":1,"project":{"id":"p-1","name":"剧","createdAt":"","updatedAt":""}}"#;
    let file = parse_file("p-1", text).expect("解析 v1");
    assert_eq!(file.graph, serde_json::Value::Null);
    assert_eq!(file.settings, serde_json::Value::Null);
    assert_eq!(file.episode_titles, serde_json::Value::Null);
    assert_eq!(file.assets, serde_json::Value::Null);
}

#[test]
fn v1_envelope_with_missing_buckets_defaults_empty() {
    let sparse = json!({
        "schemaVersion": 1,
        "project": { "name": "稀疏文档" },
        "graph": { "nodes": [], "edges": [] },
    });
    let file = parse_file("p-1", &sparse.to_string()).unwrap();
    assert_eq!(file.schema_version, 1);
    // 缺省 id 透传空串：前端以受信路径 id 覆盖并随 repaired 回写落定
    assert_eq!(file.project.id, "");
    // 缺省桶以 Null 透传（同款原则）：前端 §11.1 第 2 步补齐并标记
    // repaired，缺桶信封随回写收敛
    assert_eq!(file.settings, serde_json::Value::Null);
    assert_eq!(file.assets, serde_json::Value::Null);
}

#[test]
fn explicit_schema_version_beyond_u32_is_rejected() {
    // schemaVersion 超出 u32 可表示范围：截断回退为 1 会让未来版本文档被
    // 当作当前 v1 交付，随后保存按 v1 回写、未知字段静默丢弃——拒绝加载
    // 并保留原文件（§11 第 0 步；可表示的更大版本仍交付前端「版本过新」判定）
    let doc = json!({
        "schemaVersion": 4_294_967_296u64, // u32::MAX + 1
        "project": { "name": "未来文档" },
        "graph": { "nodes": [], "edges": [] },
    });
    assert!(parse_file("p-1", &doc.to_string()).is_err());
    // 可表示范围内的未来版本照旧放行给前端判定
    let doc = json!({
        "schemaVersion": 2,
        "project": { "name": "未来文档" },
        "graph": { "nodes": [], "edges": [] },
    });
    let file = parse_file("p-1", &doc.to_string()).unwrap();
    assert_eq!(file.schema_version, 2);
}

#[test]
fn project_list_sorts_by_instant_not_text() {
    // 字典序把 "2026-01-01T00:00:00+10:00" 排在 "2025-12-31T20:00:00Z" 之前，
    // 但前者实为更早的瞬间（2025-12-31T14:00:00Z）——排序必须按瞬间比较，
    // 缺失/非法时间戳排最后
    let mut metas = vec![
        meta("b", "2026-01-01T00:00:00+10:00"),
        meta("a", "2025-12-31T20:00:00Z"),
        meta("c", "2025-12-31T20:00:00.500Z"),
        meta("d", "garbage"),
    ];
    sort_metas_by_recency(&mut metas);
    let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["c", "a", "b", "d"]);
}

#[cfg(unix)]
#[test]
fn list_project_metas_reads_only_verified_entries() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "午夜出租车".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("先保存");
    // 指向根外文件的符号链接条目不得经列表路径读出（§10.2 信任链）
    let outside = projects.parent().expect("临时根").join("outside.json");
    fs::write(
        &outside,
        r#"{"schemaVersion":1,"project":{"id":"p-2","name":"外部","createdAt":"","updatedAt":""}}"#,
    )
    .expect("写根外文件");
    std::os::unix::fs::symlink(&outside, projects.join("p-2.json")).expect("建符号链接");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].id, "p-1");
    cleanup_temp(&projects);
}

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

/// [issue #123](https://github.com/hailingu/PlotWeave/issues/123)：损坏或
/// 不可读的项目不再从列表静默消失——以占位摘要（诊断 + 缺省统计/时间，
/// 缺省时间排序最后）返回，正常项目不受影响；点击占位卡打开仍走
/// load_project 的失败诊断（issue #98 横幅）。
#[test]
fn list_returns_broken_placeholder_for_corrupt_project() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-ok", "正常项目".into(), now_iso());
    persist_project(&cap(&projects), "p-ok", doc).expect("先保存");
    fs::write(projects.join("p-bad.json"), "{not json").expect("写损坏文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 2, "坏项目不得静默消失");
    assert_eq!(metas[0].id, "p-ok", "正常项目在前，不受坏项目影响");
    let broken = &metas[1];
    assert_eq!(broken.id, "p-bad");
    assert!(
        broken
            .diagnostic
            .as_deref()
            .is_some_and(|d| d.contains("损坏")),
        "占位须带诊断：{:?}",
        broken.diagnostic
    );
    assert_eq!(broken.scene_count, 0);
    assert_eq!(broken.ending_count, 0);
    assert!(broken.updated_at.is_empty(), "缺省时间排序最后");
    // IPC 形状：正常项目省略 diagnostic 键（wire 兼容），占位携带
    assert!(serde_json::to_value(&metas[0])
        .unwrap()
        .get("diagnostic")
        .is_none());
    assert_eq!(
        serde_json::to_value(broken).unwrap()["diagnostic"],
        json!(broken.diagnostic)
    );
    cleanup_temp(&projects);
}

/// 信封两族矛盾（不可判型）同样产出占位而非跳过（issue #123）。
#[test]
fn list_returns_broken_placeholder_for_unclassifiable_envelope() {
    let projects = temp_projects_dir();
    fs::write(
        projects.join("p-mixed.json"),
        r#"{"schemaVersion":0,"project":{"name":"伪装旧版"},"graph":{"nodes":[]},"assets":{"byId":{}}}"#,
    )
    .expect("写信封矛盾文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].id, "p-mixed");
    assert!(
        metas[0]
            .diagnostic
            .as_deref()
            .is_some_and(|d| d.contains("信封")),
        "占位须带判型诊断：{:?}",
        metas[0].diagnostic
    );
    cleanup_temp(&projects);
}

/// 底层 I/O 读取失败产出「不可读」占位（issue #123）。触发机制取非 UTF-8
/// 字节而非 mode 000 收权（PR #196 评审）：root/CAP_DAC_OVERRIDE（容器 CI
/// 常态）下收权不拦读取，`{}` 会被解析成「损坏」占位而误报；read_to_string
/// 的 UTF-8 校验与特权无关，同一 Io 分派分支（kind ≠ NotFound）随处触发。
#[test]
fn list_returns_broken_placeholder_for_unreadable_file() {
    let projects = temp_projects_dir();
    fs::write(projects.join("p-locked.json"), [0xff, 0xfe, b'{']).expect("写项目文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas.len(), 1);
    assert!(
        metas[0]
            .diagnostic
            .as_deref()
            .is_some_and(|d| d.contains("不可读")),
        "占位须带不可读诊断：{:?}",
        metas[0].diagnostic
    );
    cleanup_temp(&projects);
}

#[test]
fn list_projects_falls_back_to_placeholder_for_overlong_name() {
    let projects = temp_projects_dir();
    let long = "剧".repeat(65);
    fs::write(
    projects.join("p-1.json"),
    format!(
        r#"{{"schemaVersion":1,"project":{{"id":"p-1","name":"{long}","createdAt":"","updatedAt":""}},"graph":{{"nodes":[],"edges":[]}}}}"#
    ),
)
.expect("写项目文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    // 超 64 字符在 §9.3 名称域外（打开时会被前端归一化替换）：列表同款占位
    assert_eq!(metas[0].name, "未命名项目");
    cleanup_temp(&projects);
}

#[test]
fn list_projects_falls_back_to_placeholder_for_blank_name() {
    let projects = temp_projects_dir();
    // project.name 空白：列表回退占位，修复留待 §11.1 加载归一化
    fs::write(
        projects.join("p-1.json"),
        r#"{"schemaVersion":1,"project":{"id":"p-1","name":""},"graph":{"nodes":[],"edges":[]}}"#,
    )
    .expect("写项目文件");
    let metas = list_project_metas(&cap(&projects)).expect("列出项目");
    assert_eq!(metas[0].name, "未命名项目");
    cleanup_temp(&projects);
}
#[test]
fn load_and_list_read_anchored_tree_after_dir_replacement() {
    let projects = temp_projects_dir();
    let doc = new_project_file("p-1", "正版".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("先保存");
    // 受信根锚定后，另一本地进程把 projects/ 路径名整体换成外部目录树
    let root = cap(&projects);
    let tmp_root = projects.parent().expect("临时根").to_path_buf();
    let rogue = tmp_root.join("rogue");
    fs::create_dir_all(&rogue).expect("建替换目录");
    fs::write(
        rogue.join("p-1.json"),
        r#"{"schemaVersion":1,"project":{"id":"p-1","name":"外部内容","createdAt":"","updatedAt":""}}"#,
    )
    .expect("写替换内容");
    fs::rename(&projects, tmp_root.join("stolen")).expect("移走锚定目录");
    fs::rename(&rogue, &projects).expect("占用原路径名");
    // 读取/列表只认锚定句柄：不得从替换树读出外部内容
    let loaded = load_project_file(&root, "p-1").expect("读取");
    assert_eq!(loaded.project.name, "正版");
    let metas = list_project_metas(&root).expect("列表");
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].name, "正版");
    cleanup_temp(&projects);
}

/// 旧格式时间戳溢出保护（评审修复，PR #33 第十三轮）：u64 毫秒超 i64::MAX
/// 时不得经 as 强转成负数、把脏时间戳静默替换成貌似合法的 1969 值——
/// 检查转换失败即放弃迁移该字段（回退默认，由前端/后续归一化处置）。
#[test]
fn wrap_legacy_rejects_overflowing_numeric_timestamp() {
    let legacy = json!({
        "name": "旧项目",
        "updated_at": u64::MAX, // 溢出 i64 的脏时间戳
    });
    let wrapped = wrap_legacy("p-1", &legacy);
    assert_ne!(
        wrapped.project.updated_at, "1969-12-31T23:59:59.999Z",
        "溢出时间戳不得静默替换为负瞬间的规范值"
    );
    assert!(
        wrapped.project.updated_at.is_empty(),
        "溢出时间戳应回退默认而非伪造"
    );
}

/// [issue #145](https://github.com/hailingu/PlotWeave/issues/145)：projects
/// 操作锁中毒恢复——持锁 panic 后列表/保存照常：磁盘一致性由 §10.2
/// 原子写协议独立保证（遗留临时文件由清扫承接），锁不守卫内存状态。
/// 静态锁此后保持中毒状态，后续用例经同一恢复路径照常工作。
#[test]
fn projects_op_lock_recovers_after_poison() {
    let projects = temp_projects_dir();
    std::thread::spawn(|| {
        let _guard = crate::store::persist::projects_op_lock();
        panic!("测试注入的持锁 panic");
    })
    .join()
    .expect_err("注入 panic 应发生");
    let doc = new_project_file("p-1", "正常项目".into(), now_iso());
    persist_project(&cap(&projects), "p-1", doc).expect("中毒后保存应可用");
    let metas = list_project_metas(&cap(&projects)).expect("中毒后列表应可用");
    assert_eq!(metas.len(), 1);
    cleanup_temp(&projects);
}
