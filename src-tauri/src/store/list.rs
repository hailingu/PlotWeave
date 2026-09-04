//! 列表读取与多版本封套解析（数据模型 §11 第 0 步）：信封判型（显式
//! 版本家族一致性 / 无版本形状判型）、旧扁平 v0 包装、宽容提取与
//! 列表摘要派生（graph 统计、排序、占位名）。

use std::collections::HashSet;

use cap_std::fs::Dir as CapDir;
use serde_json::json;
use tauri::AppHandle;

use crate::isotime::{iso8601_to_epoch_millis, iso_from_ms};
use crate::store::persist::{projects_dir, read_verified_file};
use crate::store::types::{empty_assets, validate_id, ProjectFile, ProjectInfo, ProjectMeta};
/// 从画布 graph 派生统计：场数 = scene 节点数；结局数 = 无剧情流出边的
/// 场景数（分支剧情的叶子场景即结局）。attach 下挂边（索引卡 → 分镜卡，
/// 垂直派生从属）不算出边——挂了分镜的场景仍是叶子结局。
/// v1 文档边带显式 data.kind；v0 运行态边按 sourceHandle/className 判别。
pub fn graph_stats(graph: &serde_json::Value) -> (u64, u64) {
    let empty: Vec<serde_json::Value> = Vec::new();
    let nodes = graph
        .get("nodes")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let edges = graph
        .get("edges")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let scene_ids: HashSet<&str> = nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("scene"))
        .filter_map(|n| n.get("id").and_then(|i| i.as_str()))
        .collect();
    let is_attach = |e: &serde_json::Value| {
        e.pointer("/data/kind").and_then(|k| k.as_str()) == Some("attach")
            || e.get("sourceHandle").and_then(|h| h.as_str()) == Some("shots")
            || e.get("className").and_then(|c| c.as_str()) == Some("pw-edge-attach")
    };
    let mut has_outgoing: HashSet<&str> = HashSet::new();
    for e in edges {
        if is_attach(e) {
            continue;
        }
        if let Some(src) = e.get("source").and_then(|s| s.as_str()) {
            has_outgoing.insert(src);
        }
    }
    let endings = scene_ids
        .iter()
        .filter(|id| !has_outgoing.contains(*id))
        .count() as u64;
    (scene_ids.len() as u64, endings)
}
/// 列表侧名称回退（§10.2）：空白/异型/超 64 字符（§9.3 名称域外，打开时
/// 会被前端归一化替换）的名不得交给首页——非示例项目不经前端归一化，
/// 空名直留空白卡片、超长名破坏排版；回退「未命名项目」占位。
fn legal_display_name(name: &str) -> String {
    let trimmed = name.trim();
    let legal = !trimmed.is_empty() && trimmed.chars().count() <= 64;
    (if legal { trimmed } else { "未命名项目" }).to_string()
}
pub(crate) fn read_meta(id: &str, file: &ProjectFile) -> ProjectMeta {
    let (scene_count, ending_count) = graph_stats(&file.graph);
    ProjectMeta {
        id: id.to_string(),
        name: legal_display_name(&file.project.name),
        updated_at: file.project.updated_at.clone(),
        scene_count,
        ending_count,
    }
}
/// 旧扁平格式（无 schemaVersion）→ v0 信封：节点/边上移 graph，
/// epoch 毫秒时间戳转 ISO；节点级字段迁移由前端模型层完成（§11.1）。
fn wrap_legacy(id: &str, v: &serde_json::Value) -> ProjectFile {
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("未命名")
        .to_string();
    let updated_at = v
        .get("updated_at")
        .and_then(|x| x.as_u64())
        .map(iso_from_ms)
        .unwrap_or_default();
    ProjectFile {
        schema_version: 0,
        versionless: false,
        project: ProjectInfo {
            id: id.to_string(),
            name,
            description: None,
            created_at: String::new(),
            updated_at,
        },
        graph: json!({
            "nodes": v.get("nodes").cloned().unwrap_or(json!([])),
            "edges": v.get("edges").cloned().unwrap_or(json!([])),
            // 旧格式从未持久化视口：保持缺省（前端打开时 fitView），不伪造原点
        }),
        settings: v.get("settings").cloned().unwrap_or_else(|| json!({})),
        episode_titles: v.get("episodeTitles").cloned().unwrap_or_else(|| json!({})),
        assets: empty_assets(),
    }
}
/// 项目列表排序：按更新瞬间（ISO 解析为 epoch 毫秒）新→旧；加载侧宽容保留
/// 的非法/缺失时间戳无法解析，排最后，不混入有效项之间。
fn sort_metas_by_recency(metas: &mut [ProjectMeta]) {
    metas.sort_by_key(|m| std::cmp::Reverse(iso8601_to_epoch_millis(&m.updated_at)));
}
/// 列出全部项目，按更新时间新→旧排序。扫描相对受信根锚定句柄执行。
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let root = projects_dir(&app)?;
    list_project_metas(&root)
}
/// list_projects 的可测内核（给定已验证的 projects 根句柄）。目录扫描逐条
/// 跳过符号链接/异型项/坏文件（单条坏数据不阻断列表），扫描与读取全程
/// 句柄相对——projects/ 路径名被并发整体替换也不会列出替换树的条目；
/// 读取走 read_verified_file 的身份绑定，校验通过后被并发替换为符号链接
/// 或另一文件时读到的仍是校验时的同一实体，否则跳过该条目。
fn list_project_metas(root: &CapDir) -> Result<Vec<ProjectMeta>, String> {
    let mut metas: Vec<ProjectMeta> = Vec::new();
    for entry in root
        .entries()
        .map_err(|e| format!("读取项目目录失败：{e}"))?
    {
        let entry = entry.map_err(|e| format!("遍历项目目录失败：{e}"))?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        // §10.2 目录扫描：校验 + 打开 + 读取绑定同一实体，绝不跟随替换
        let Ok(text) = read_verified_file(root, name) else {
            continue;
        };
        if let Ok(file) = parse_file(id, &text) {
            metas.push(read_meta(id, &file));
        }
    }
    sort_metas_by_recency(&mut metas);
    Ok(metas)
}
/// project 元信息的宽容提取（§11 第 0 步）：project 容器非对象或字段异型
/// （name/description/时间戳为 null 或非字符串等）时逐字段回退缺省——可恢复
/// 的元数据损坏不拒绝整个项目，字段级修复与警告归前端归一化层（§11.1 第 3
/// 步）；id/时间戳的空值由 parse_file 就地补齐为有效值。
fn parse_project_info(v: Option<&serde_json::Value>) -> ProjectInfo {
    let get = |k: &str| v.and_then(|x| x.get(k)).and_then(|x| x.as_str());
    ProjectInfo {
        id: get("id").unwrap_or_default().to_string(),
        name: get("name").unwrap_or_default().to_string(),
        description: v.and_then(|x| x.get("description")).cloned(),
        created_at: get("createdAt").unwrap_or_default().to_string(),
        updated_at: get("updatedAt").unwrap_or_default().to_string(),
    }
}
/// v1 信封的宽容解析（§11 第 0 步）：project 元信息经 parse_project_info
/// 逐字段提取；graph/settings/episodeTitles/assets 以 untyped 值原样透传，
/// **缺失以 Null 透传**（与 project 元信息空串同款原则）：预补空容器会让
/// 前端 repaired 检测看不见缺陷——载荷比对已是完整信封，缺桶永不回写
/// 收敛；Null 由前端 §11.1 第 2 步补齐（视为异型容器，修复并标记
/// repaired）。持久化层只拒绝两族矛盾或不可判型的信封。
fn parse_v1_envelope(value: &serde_json::Value) -> ProjectFile {
    let schema_version = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(1);
    ProjectFile {
        schema_version,
        versionless: false,
        project: parse_project_info(value.get("project")),
        graph: value
            .get("graph")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        settings: value
            .get("settings")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        episode_titles: value
            .get("episodeTitles")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        assets: value
            .get("assets")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    }
}
/// 显式 schemaVersion 的家族一致性校验与解析（§11 第 0 步）：0 属旧扁平
/// 家族、≥1 属 v1 家族，版本号与信封形状两族矛盾即拒绝并保留原文件——
/// 否则 v1 StoryNode 会被送进旧版迁移器，且每次 v0 加载都被视为已迁移
/// 并回写，可能摧毁节点字段；显式 0 且保持扁平形状时包装为 v0 信封。
fn parse_explicit_envelope(
    id: &str,
    value: serde_json::Value,
    v1_keys: usize,
    legacy_keys: usize,
) -> Result<ProjectFile, String> {
    let Some(version) = value.get("schemaVersion").and_then(|sv| sv.as_u64()) else {
        return Err("schemaVersion 不是非负整数，无法判别文档信封（已保留原文件）".into());
    };
    if version == 0 {
        if v1_keys > 0 {
            return Err(
                "文档信封自相矛盾：schemaVersion 0 却携带 v1 专属键（已保留原文件）".into(),
            );
        }
        return Ok(wrap_legacy(id, &value));
    }
    if legacy_keys > 0 {
        return Err(
            "文档信封自相矛盾：schemaVersion ≥ 1 却携带旧扁平特征键（已保留原文件）".into(),
        );
    }
    if version > u64::from(u32::MAX) {
        // 超出 u32 的版本号无法无损载入信封：截断回退会把未来文档当作当前
        // v1 交付，保存时按 v1 回写并丢弃未知字段——拒绝加载并保留原文件
        return Err("schemaVersion 超出可表示范围（疑似未来版本），拒绝加载并保留原文件".into());
    }
    Ok(parse_v1_envelope(&value))
}
/// 无版本号信封的形状判型（§11 第 0 步）：v1 专属键（project/graph/assets）
/// 独占时赋予待修复的有效版本 1；旧扁平特征键（≥2 个且含 nodes/edges）独占
/// 时包装为 v0 信封；混合或两组特征均不足的损坏文档拒绝加载并保留原文件——
/// 绝不把保持 v1 形状的文档误包装成空 v0 图后回写摧毁原画布。
fn classify_versionless(
    id: &str,
    value: serde_json::Value,
    v1_keys: usize,
    legacy_keys: usize,
    has_legacy_list: bool,
) -> Result<ProjectFile, String> {
    if v1_keys > 0 && legacy_keys == 0 {
        let mut file = parse_v1_envelope(&value);
        file.versionless = true;
        return Ok(file);
    }
    if v1_keys == 0 && legacy_keys >= 2 && has_legacy_list {
        return Ok(wrap_legacy(id, &value));
    }
    Err("无法判别文档信封：v1 与旧扁平特征键混合或均不足（已保留原文件）".into())
}
/// 解析项目文件（§11 第 0 步信封判型）：显式 `schemaVersion` 定族并经
/// 家族一致性校验（parse_explicit_envelope），缺失时按顶层键形状特征判型
/// （classify_versionless）；两族矛盾或不可判型一律拒绝并保留原文件。
/// 缺失/异型的 project 元数据（id/时间戳等）以空串**原样透传**，不在读取
/// 侧预合成——预合成会让前端 repaired 检测看不见缺陷（载荷已是修好的
/// 值）：修复不回写、脏文件长留磁盘，且每次 list 都合成新的当前时刻把
/// 未动过的项目顶到最近列表顶端。修复与落盘归前端 §11.1 第 2 步
/// （受信 id 覆盖、时间戳回退链，随 repaired 标志回写）；列表排序把
/// 不可解析时间戳稳定排最后（sort_metas_by_recency）。
pub(crate) fn parse_file(id: &str, text: &str) -> Result<ProjectFile, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let v1_keys = ["project", "graph", "assets"]
        .iter()
        .filter(|k| value.get(*k).is_some())
        .count();
    let legacy_keys = ["name", "updated_at", "nodes", "edges"]
        .iter()
        .filter(|k| value.get(*k).is_some())
        .count();
    let has_legacy_list = value.get("nodes").is_some() || value.get("edges").is_some();
    Ok(match value.get("schemaVersion") {
        Some(_) => parse_explicit_envelope(id, value, v1_keys, legacy_keys)?,
        None => classify_versionless(id, value, v1_keys, legacy_keys, has_legacy_list)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::isotime::now_iso;
    use crate::store::commands::{load_project_file, persist_project};
    use crate::store::testutil::{cap, cleanup_temp, meta, temp_projects_dir};
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
        let text = r#"{"schemaVersion":1,"project":{"id":"p-1","name":"剧","createdAt":"","updatedAt":""}}"#;
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
}
