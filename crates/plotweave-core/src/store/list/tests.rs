//! 项目列表/加载的解析集成测试（自 list.rs 内联模块外置，issue #39）。

use super::*;
use crate::isotime::now_iso;
use crate::store::commands::{load_project_file, persist_project};
use crate::store::testutil::{cap, cleanup_temp, meta, temp_projects_dir};
use crate::store::types::new_project_file;
use serde_json::json;
use std::fs;

/// The raw-number corpus is shared with Swift so integer-valued float/exponent spelling cannot diverge (#918).
#[test]
fn schema_version_shared_number_vectors() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../testdata/schema-version-contract.json"
    ))
    .unwrap();
    let rows = vectors["cases"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        let text = format!(
            r#"{{"schemaVersion":{},"project":{{"id":"p1","name":"vector"}},"graph":{{"nodes":[],"edges":[]}},"assets":{{"byId":{{}}}}}}"#,
            row["raw"].as_str().unwrap()
        );
        let parsed = parse_file(&text);
        assert_eq!(
            parsed.is_ok(),
            row["accepted"].as_bool().unwrap(),
            "{}",
            row["id"]
        );
        if let Ok(file) = parsed {
            assert_eq!(
                u64::from(file.schema_version),
                row["version"].as_u64().unwrap(),
                "{}",
                row["id"]
            );
            assert_eq!(
                file.versionless,
                row["versionless"].as_bool().unwrap(),
                "{}",
                row["id"]
            );
        }
    }
}

/// Actual list/load share the numeric contract and never rewrite an accepted or rejected source file.
#[test]
fn numeric_schema_spelling_preserves_file_bytes() {
    let projects = temp_projects_dir();
    let root = cap(&projects);
    let path = projects.join("p1.json");
    for (raw, accepted, version) in [
        ("1.0", true, 1),
        ("1e2", true, 100),
        ("1.5", false, 0),
        ("-1.0", false, 0),
    ] {
        let text = format!(
            r#"{{"schemaVersion":{raw},"project":{{"id":"p1","name":"vector"}},"graph":{{"nodes":[],"edges":[]}},"assets":{{"byId":{{}}}}}}"#
        );
        fs::write(&path, &text).unwrap();
        let loaded = load_project_file(&root, "p1");
        assert_eq!(loaded.is_ok(), accepted, "{raw}");
        if let Ok(file) = loaded {
            assert_eq!(file.schema_version, version, "{raw}");
        }
        let rows = list_project_metas(&root).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].diagnostic.is_none(), accepted, "{raw}");
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    cleanup_temp(&projects);
}

/// issue #592 回归用的控制文件超限长度：越过 64 MiB 上限一字节。
const OVERSIZE_BYTES: u64 = crate::store::persist::CONTROL_FILE_MAX_BYTES as u64 + 1;

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
    let file = parse_file(&v1.to_string()).unwrap();
    assert!(file.project.updated_at.is_empty());
    assert!(file.project.created_at.is_empty());
}

#[test]
fn legacy_flat_envelope_is_rejected() {
    // 旧扁平格式（无 schemaVersion，顶层 name/updated_at/nodes/edges）已随
    // v0 支持退役（#519 处置）不再包装交付：拒绝加载并保留原文件——两栈
    // （Rust/Swift）对异型 updated_at（小数）的排序分歧随之消失
    let legacy = json!({
        "name": "旧项目",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [{ "id": "a", "type": "scene", "data": {} }],
        "edges": [],
        "settings": { "characters": [], "locations": [] },
        "episodeTitles": { "1": "开端" },
    });
    let err = parse_file(&legacy.to_string()).expect_err("旧扁平信封应被拒绝（v0 支持已退役）");
    assert!(matches!(err.root(), StoreError::CorruptEnvelope(_)));
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
    let file = parse_file(&v1.to_string()).unwrap();
    assert_eq!(file.schema_version, 1);
    assert_eq!(file.graph["nodes"][0]["id"], json!("s1"));
    // 判型打 versionless IPC 标记：载荷额外键让前端 repaired 比较必然
    // 不等，回写补盖显式版本号——文件不再永久无版本（§10.5/§11.1 收敛）
    assert!(file.versionless);
    let ipc = serde_json::to_value(&file).unwrap();
    assert_eq!(ipc["versionless"], json!(true));
    // 显式版本不打标记；形状判型（v1 族）打标记——版本主张缺失/异型的
    // 判型修复必须可向前端解释（§11 第 0 步「均记录警告」，issue #338
    // 评审：versionless 标记只承载警告，修复回写本身即落定）
    let explicit = json!({
        "schemaVersion": 1,
        "project": { "id": "p-1", "name": "显式" },
        "graph": { "nodes": [], "edges": [] },
    });
    assert!(!parse_file(&explicit.to_string()).unwrap().versionless);
    // 旧扁平形状的判型路径已随 v0 支持退役（#519 处置）：不再包装 v0 信封
    let legacy = json!({
        "name": "旧项目", "updated_at": 1_700_000_000_000u64,
        "nodes": [], "edges": [],
    });
    assert!(parse_file(&legacy.to_string()).is_err());
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
    assert!(parse_file(&mixed.to_string()).is_err());
    assert!(parse_file("{}").is_err());
    assert!(parse_file(r#"{"foo": 1}"#).is_err());
    // 单个旧扁平键不足以判型
    assert!(parse_file(r#"{"nodes": []}"#).is_err());
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
    assert!(parse_file(&v0_with_v1.to_string()).is_err());
    // 反向冲突：显式 v1 信封携带旧扁平专属键（顶层 name/updated_at/nodes/edges）
    let v1_with_legacy = json!({
        "schemaVersion": 1,
        "project": { "name": "x" },
        "graph": { "nodes": [], "edges": [] },
        "name": "旧名",
        "nodes": [],
    });
    assert!(parse_file(&v1_with_legacy.to_string()).is_err());
    // 非数字版本号不可判型
    assert!(parse_file(r#"{"schemaVersion": "1", "project": {}, "graph": {}}"#).is_err());
}

/// [issue #338]（§11 第 0 步）：schemaVersion 键存在但为无法表达受支持/
/// 未来版本的异型值（null/布尔/容器/非规范数字串）时不构成版本主张——
/// 与缺失版本号同款按唯一信封形状判型：唯一匹配 v1 → versionless 标记
/// 交付前端修复回写补盖显式版本号，graph 内容原样透传，不整份拒绝。
#[test]
fn heterogeneous_version_value_falls_back_to_v1_shape() {
    let cases = [
        ("null", "null"),
        ("布尔", "true"),
        ("对象", r#"{"future":true}"#),
        ("数组", "[2]"),
        ("非规范数字串", r#""01""#),
    ];
    for (label, raw) in cases {
        let text = format!(
            r#"{{"schemaVersion":{raw},"project":{{"id":"p-1","name":"异型版本"}},"graph":{{"nodes":[{{"id":"s1","type":"scene"}}],"edges":[]}},"assets":{{"byId":{{}}}}}}"#
        );
        let file = parse_file(&text).unwrap_or_else(|e| panic!("{label}：应按 v1 形状判型：{e}"));
        assert_eq!(file.schema_version, 1, "{label}：判型赋予待修复有效版本 1");
        assert!(file.versionless, "{label}：应打 versionless 修复标记");
        assert_eq!(
            file.graph["nodes"][0]["id"],
            json!("s1"),
            "{label}：graph 原样透传不丢内容"
        );
    }
}

/// [issue #338]：异型版本值 + 唯一旧扁平形状 → 与缺失版本号同款按 v0
/// 支持退役处置拒绝（#519）：不再包装 v0 信封交付，保留原文件。
#[test]
fn heterogeneous_version_value_with_legacy_shape_is_rejected() {
    let legacy = json!({
        "schemaVersion": null,
        "name": "旧项目",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [{ "id": "a", "type": "scene", "data": {} }],
        "edges": [],
    });
    let err = parse_file(&legacy.to_string())
        .expect_err("异型版本值 + 旧扁平形状应被拒绝（v0 支持已退役）");
    assert!(matches!(err.root(), StoreError::CorruptEnvelope(_)));
}

/// [issue #338]：异型版本值不放宽混合/不足形状的拒绝——形状不足以单独
/// 判型时仍拒绝并保留原文件，绝不猜测家族回退空 v0 图。
#[test]
fn heterogeneous_version_value_with_mixed_or_insufficient_shape_is_rejected() {
    let mixed = json!({
        "schemaVersion": true,
        "project": { "name": "混合信封" },
        "name": "旧名",
        "nodes": [],
        "edges": [],
    });
    assert!(parse_file(&mixed.to_string()).is_err());
    // 仅一个异型版本键、无任何家族特征：两组特征均不足
    assert!(parse_file(r#"{"schemaVersion": null}"#).is_err());
}

/// [issue #338]（§11 第 0 步）：带内版本主张非法或非契约载体时直接拒绝，
/// 不得按形状降级——number 但负数/小数、规范整数字符串（含表达受支持/
/// 未来版本者，数字才是版本载体；未来串按形状降级会在回写中丢失升级判据）。
#[test]
fn illegal_version_claims_rejected_without_shape_downgrade() {
    let cases = [
        ("负数", "-1"),
        ("小数", "1.5"),
        ("未来规范数字串", r#""2""#),
        ("负数规范数字串", r#""-1""#),
    ];
    for (label, raw) in cases {
        let text = format!(
            r#"{{"schemaVersion":{raw},"project":{{"id":"p-1","name":"非法主张"}},"graph":{{"nodes":[],"edges":[]}}}}"#
        );
        let err = parse_file(&text)
            .err()
            .unwrap_or_else(|| panic!("{label}：非法版本主张应拒绝"));
        assert!(
            matches!(err.root(), StoreError::CorruptEnvelope(_)),
            "{label}：应为信封判型拒绝：{err:?}"
        );
    }
}

#[test]
fn explicit_v0_claim_is_rejected() {
    // 显式 schemaVersion 0（旧扁平家族主张）已随 v0 支持退役（#519 处置）
    // 统一拒绝——无论信封保持扁平形状还是混入 v1 专属键（两族矛盾见
    // explicit_version_conflicting_with_envelope_family_is_rejected）
    let legacy = json!({
        "schemaVersion": 0,
        "name": "显式旧版",
        "updated_at": 1_700_000_000_000u64,
        "nodes": [{ "id": "a", "type": "scene", "data": {} }],
        "edges": [],
    });
    let err = parse_file(&legacy.to_string())
        .expect_err("显式 schemaVersion 0 应被拒绝（v0 支持已退役）");
    assert!(matches!(err.root(), StoreError::CorruptEnvelope(_)));
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
    let file = parse_file(&doc.to_string()).unwrap();
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
    let file = parse_file(&doc.to_string()).unwrap();
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
    let file = parse_file(text).expect("解析 v1");
    assert_eq!(file.project.description, Some(json!(42)));
}

#[test]
fn v1_missing_buckets_pass_through_null_for_frontend_repair() {
    // 缺桶以 Null 透传：前端 §11.1 第 2 步补齐并标记 repaired 回写——
    // 预补空容器会让 repaired 检测看不见缺陷，缺桶信封永不收敛
    let text =
        r#"{"schemaVersion":1,"project":{"id":"p-1","name":"剧","createdAt":"","updatedAt":""}}"#;
    let file = parse_file(text).expect("解析 v1");
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
    let file = parse_file(&sparse.to_string()).unwrap();
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
    assert!(parse_file(&doc.to_string()).is_err());
    // 可表示范围内的未来版本照旧放行给前端判定
    let doc = json!({
        "schemaVersion": 2,
        "project": { "name": "未来文档" },
        "graph": { "nodes": [], "edges": [] },
    });
    let file = parse_file(&doc.to_string()).unwrap();
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

/// issue #592：单个异常膨胀的项目控制文件在列表读取边界被拒绝，呈现为
/// 损坏占位而非被全量解析或静默跳过；正常项目不受影响，原文件字节保持。
/// 合法 JSON + 尾随空白与损坏字节两种形态都必须被同一个字节上限拦截
///（合法形态若被完整读取会作为正常项目出现，正是缺陷的可观察面）。
#[test]
fn list_returns_broken_placeholder_for_oversize_project_files() {
    for damaged in [false, true] {
        let projects = temp_projects_dir();
        persist_project(
            &cap(&projects),
            "p-ok",
            new_project_file("p-ok", "正常项目".into(), now_iso()),
        )
        .expect("预置正常项目");
        let path = projects.join("p-big.json");
        if damaged {
            let file = fs::File::create(&path).expect("创建超限文件");
            file.set_len(OVERSIZE_BYTES).expect("设置超限长度");
        } else {
            write_padded_oversize_project(&path);
        }
        let before = fs::metadata(&path).expect("读超限元数据").len();
        let metas = list_project_metas(&cap(&projects)).expect("列出项目");
        assert_eq!(metas.len(), 2, "超限项目不得静默消失（damaged={damaged}）");
        assert_eq!(metas[0].id, "p-ok", "正常项目不受影响");
        let broken = metas
            .iter()
            .find(|m| m.id == "p-big")
            .expect("超限项目应返回占位");
        assert!(
            broken
                .diagnostic
                .as_deref()
                .is_some_and(|d| d.contains("64 MiB") && d.contains("上限")),
            "damaged={damaged}：占位诊断须点明字节上限：{:?}",
            broken.diagnostic
        );
        assert_eq!(
            fs::metadata(&path).expect("复核超限文件").len(),
            before,
            "超限拒绝不得改写原文件"
        );
        cleanup_temp(&projects);
    }
}

/// 合法 JSON + 尾随空白：完整读取仍可解析，因此缺陷形态下会以正常项目
/// 出现；该构造同时证明上限判定发生在解析之前。
fn write_padded_oversize_project(path: &std::path::Path) {
    use std::io::Write;
    let mut file = fs::File::create(path).expect("创建超限合法 JSON");
    file.write_all(
        br#"{"schemaVersion":1,"project":{"id":"p-big","name":"oversize"},"graph":{"nodes":[],"edges":[]},"settings":{"characters":{},"locations":{},"props":{},"documents":{}},"episodeTitles":{},"assets":{"byId":{}}}"#,
    )
    .expect("写 JSON 前缀");
    let mut remaining = OVERSIZE_BYTES - file.metadata().expect("读文件长度").len();
    let padding = [b' '; 1024 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(padding.len() as u64) as usize;
        file.write_all(&padding[..chunk]).expect("写尾随空白");
        remaining -= chunk as u64;
    }
}

/// issue #592：load 对超限文件返回可定位的拒绝诊断而非完整物化/解析；
/// 原文件保持不变。
#[test]
fn load_project_file_rejects_oversize_file_with_limit_diagnostic() {
    let projects = temp_projects_dir();
    let path = projects.join("p-big.json");
    let file = fs::File::create(&path).expect("创建超限文件");
    file.set_len(OVERSIZE_BYTES).expect("设置超限长度");
    drop(file);
    let err = load_project_file(&cap(&projects), "p-big").unwrap_err();
    assert!(
        err.to_string().contains("64 MiB") && err.to_string().contains("上限"),
        "超限加载须给出可定位诊断：{err}"
    );
    assert_eq!(
        fs::metadata(&path).expect("复核超限文件").len(),
        OVERSIZE_BYTES,
        "超限拒绝不得改写原文件"
    );
    cleanup_temp(&projects);
}

/// 信封两族矛盾（不可判型）与非 UTF-8 不可读同样产出占位而非跳过（issue
/// #123）。不可读触发取非 UTF-8 字节而非 mode 000 收权（PR #196 评审）：
/// root/CAP_DAC_OVERRIDE（容器 CI 常态）下收权不拦读取；read_to_string
/// 的 UTF-8 校验与特权无关，同一 Io 分派分支随处触发。两形态共用「坏
/// 文件 → 占位 + 判型诊断」模板（issue #291 参数化；损坏 JSON 的完整
/// 占位行为——正常项目排序与 IPC wire 形状——由上方用例覆盖）。
#[test]
fn list_returns_broken_placeholder_for_unclassifiable_or_unreadable() {
    let cases: [(&str, Vec<u8>, &str); 3] = [
        (
            "信封两族矛盾（不可判型）",
            r#"{"schemaVersion":1,"project":{"name":"伪装新版"},"graph":{"nodes":[]},"name":"旧名"}"#
                .as_bytes()
                .to_vec(),
            "信封",
        ),
        (
            "已退役的旧扁平 v0 主张",
            r#"{"schemaVersion":0,"project":{"name":"伪装旧版"},"graph":{"nodes":[]},"assets":{"byId":{}}}"#
                .as_bytes()
                .to_vec(),
            "不再受支持",
        ),
        ("非 UTF-8 字节", vec![0xff, 0xfe, b'{'], "不可读"),
    ];
    for (label, bytes, keyword) in cases {
        let projects = temp_projects_dir();
        fs::write(projects.join("p-bad.json"), bytes).expect("写坏项目文件");
        let metas = list_project_metas(&cap(&projects)).expect("列出项目");
        assert_eq!(metas.len(), 1, "{label}：坏项目不得静默消失");
        assert_eq!(metas[0].id, "p-bad");
        assert!(
            metas[0]
                .diagnostic
                .as_deref()
                .is_some_and(|d| d.contains(keyword)),
            "{label}：占位须带判型诊断：{:?}",
            metas[0].diagnostic
        );
        cleanup_temp(&projects);
    }
}

/// 名称域外（超 64 字符，§9.3）与空白名称：列表回退「未命名项目」占位
/// （打开时由前端归一化替换/修复，§11.1）；两形态共用回退模板（issue
/// #291 参数化）。
#[test]
fn list_projects_fall_back_to_placeholder_for_out_of_range_names() {
    let long = "剧".repeat(65);
    let cases: [(&str, String); 2] = [
        (
            "超长名称",
            format!(
                r#"{{"schemaVersion":1,"project":{{"id":"p-1","name":"{long}","createdAt":"","updatedAt":""}},"graph":{{"nodes":[],"edges":[]}}}}"#
            ),
        ),
        (
            "空白名称",
            r#"{"schemaVersion":1,"project":{"id":"p-1","name":""},"graph":{"nodes":[],"edges":[]}}"#
                .to_string(),
        ),
    ];
    for (label, content) in cases {
        let projects = temp_projects_dir();
        fs::write(projects.join("p-1.json"), content).expect("写项目文件");
        let metas = list_project_metas(&cap(&projects)).expect("列出项目");
        assert_eq!(metas[0].name, "未命名项目", "{label}：应回退占位名");
        cleanup_temp(&projects);
    }
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
