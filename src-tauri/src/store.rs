//! 项目持久化（docs/data-model.md v1 §10/§11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）；graph/settings/assets 对前端是自有数据，
//! Rust 端以 `serde_json::Value` 透传，仅校验项目名与 id（信任边界内的自有格式）。
//! 旧扁平格式（无 schemaVersion）在 load 时包装为 v0 信封交付前端，节点级
//! 迁移与归一化由前端模型层（§11）完成。

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

/// 项目元信息：id/name + ISO 8601 创建与更新时间（§3）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
}

/// 项目文件：ProjectDocument 信封。graph/settings/episodeTitles/assets
/// 以 `serde_json::Value` 透传；缺省字段按空对象兜底（旧文件兼容）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    #[serde(default, rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(default)]
    pub project: ProjectInfo,
    #[serde(default)]
    pub graph: serde_json::Value,
    #[serde(default = "empty_object")]
    pub settings: serde_json::Value,
    #[serde(default = "empty_object", rename = "episodeTitles")]
    pub episode_titles: serde_json::Value,
    #[serde(default = "empty_assets")]
    pub assets: serde_json::Value,
}

/// 项目摘要：首页海报卡的展示模型；统计从 graph 派生，不落镜像字段。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    /// ISO 8601；字典序即时间序，排序无需解析。
    pub updated_at: String,
    pub scene_count: u64,
    pub ending_count: u64,
}

/// 项目名约束：非空、去空白后 ≤ 64 字符。
pub fn sanitize_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("项目名不能为空".into());
    }
    if name.chars().count() > 64 {
        return Err("项目名过长（≤ 64 字符）".into());
    }
    Ok(name.to_string())
}

/// id 约束：文件名安全字符集，防路径穿越。
pub fn validate_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法项目 id：{id}"))
    }
}

/// 新 id：时间戳毫秒 + 进程内计数，保证同毫秒不碰撞。
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("p-{ms:x}-{seq:x}")
}

/// epoch 毫秒 → ISO 8601（UTC，civil-from-days 算法，无外部依赖）。
fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    iso_from_ms(ms)
}

/// settings 等对象字段缺省值：空对象（而非 Null），前端归一化兜底。
fn empty_object() -> serde_json::Value {
    json!({})
}

fn empty_assets() -> serde_json::Value {
    json!({ "byId": {} })
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("projects");
    fs::create_dir_all(&dir).map_err(|e| format!("创建项目目录失败：{e}"))?;
    Ok(dir)
}

fn project_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(projects_dir(app)?.join(format!("{id}.json")))
}

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

fn read_meta(id: &str, file: &ProjectFile) -> ProjectMeta {
    let (scene_count, ending_count) = graph_stats(&file.graph);
    ProjectMeta {
        id: id.to_string(),
        name: file.project.name.clone(),
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

/// 列出全部项目，按更新时间新→旧排序。
#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_dir(&app)?;
    let mut metas: Vec<ProjectMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取项目目录失败：{e}"))? {
        let path = entry.map_err(|e| format!("遍历项目目录失败：{e}"))?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(file) = parse_file(id, &text) {
            metas.push(read_meta(id, &file));
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

/// 解析项目文件：v1 信封直接反序列化（缺省字段兜底）；
/// 无 schemaVersion 的旧扁平格式包装为 v0 信封。
/// 缺失的时间戳就地修复为有效 ISO（serde 默认空串）——否则前端
/// new Date('') 抛 RangeError 会清空整个首页列表。
fn parse_file(id: &str, text: &str) -> Result<ProjectFile, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let mut file = if value.get("schemaVersion").is_some() {
        let mut file: ProjectFile = serde_json::from_value(value)?;
        if file.project.id.is_empty() {
            file.project.id = id.to_string();
        }
        file
    } else {
        wrap_legacy(id, &value)
    };
    if file.project.updated_at.is_empty() {
        file.project.updated_at = if file.project.created_at.is_empty() {
            now_iso()
        } else {
            file.project.created_at.clone()
        };
    }
    if file.project.created_at.is_empty() {
        file.project.created_at = file.project.updated_at.clone();
    }
    Ok(file)
}

/// 新建空项目（空画布 v1 信封），返回其摘要。
#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&name)?;
    let id = new_id();
    let now = now_iso();
    let file = ProjectFile {
        schema_version: 1,
        project: ProjectInfo {
            id: id.clone(),
            name,
            description: None,
            created_at: now.clone(),
            updated_at: now,
        },
        graph: json!({
            "nodes": [],
            "edges": [],
            "viewport": { "x": 0, "y": 0, "zoom": 1 },
        }),
        settings: json!({ "characters": {}, "locations": {}, "props": {} }),
        episode_titles: json!({}),
        assets: empty_assets(),
    };
    let path = project_path(&app, &id)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(path, text).map_err(|e| format!("写入项目失败：{e}"))?;
    Ok(read_meta(&id, &file))
}

/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let path = project_path(&app, &id)?;
    let text = fs::read_to_string(path).map_err(|_| format!("项目不存在：{id}"))?;
    parse_file(&id, &text).map_err(|e| format!("项目文件损坏：{e}"))
}

/// 全量保存：项目名在信任边界校验；updatedAt 由前端模型层盖戳。
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&doc.project.name)?;
    let file = ProjectFile {
        schema_version: doc.schema_version,
        project: ProjectInfo {
            id: id.clone(),
            name,
            description: doc.project.description,
            created_at: doc.project.created_at,
            updated_at: doc.project.updated_at,
        },
        graph: doc.graph,
        settings: doc.settings,
        episode_titles: doc.episode_titles,
        assets: doc.assets,
    };
    let path = project_path(&app, &id)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    // 先写临时文件再原子改名，避免保存中途崩溃留下半截文件
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入项目失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("落盘项目失败：{e}"))?;
    Ok(read_meta(&id, &file))
}

/// 删除项目（首页卡片菜单，§3.2）。
#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let path = project_path(&app, &id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除项目失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn name_rules() {
        assert!(sanitize_name("  ").is_err());
        assert!(sanitize_name("").is_err());
        assert_eq!(sanitize_name("  午夜出租车 ").unwrap(), "午夜出租车");
        let long = "剧".repeat(65);
        assert!(sanitize_name(&long).is_err());
        assert!(sanitize_name(&"剧".repeat(64)).is_ok());
    }

    #[test]
    fn id_rules() {
        assert!(validate_id("p-18f-0").is_ok());
        assert!(validate_id("sample_wu_ye").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a b").is_err());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn iso_from_ms_marks_known_instants() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        // 闰日边界：2024-02-29T00:00:00Z = 1_709_164_800_000
        assert_eq!(iso_from_ms(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
    }

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
    fn new_ids_never_collide_in_same_millisecond() {
        assert_ne!(new_id(), new_id());
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
    fn v1_file_missing_timestamps_gets_repaired() {
        // 缺 project 时间戳的信封（serde 默认空串）：读取即修复为有效 ISO，
        // 否则前端 new Date('').toISOString() 抛 RangeError，首页列表被清空
        let v1 = json!({
            "schemaVersion": 1,
            "project": { "id": "p-1", "name": "旧时间" },
            "graph": { "nodes": [], "edges": [] },
            "settings": {},
            "episodeTitles": {},
            "assets": { "byId": {} },
        });
        let file = parse_file("p-1", &v1.to_string()).unwrap();
        assert!(!file.project.updated_at.is_empty());
        assert!(!file.project.created_at.is_empty());
    }

    #[test]
    fn legacy_flat_file_wraps_as_v0_envelope() {
        let legacy = json!({
            "name": "旧项目",
            "updated_at": 1_700_000_000_000_i64,
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
    fn project_file_round_trip() {
        let file = ProjectFile {
            schema_version: 1,
            project: ProjectInfo {
                id: "p-1".into(),
                name: "午夜出租车".into(),
                description: None,
                created_at: "2026-08-01T00:00:00.000Z".into(),
                updated_at: "2026-08-28T12:00:00.000Z".into(),
            },
            graph: json!({
                "nodes": [{ "id": "a", "type": "scene", "layout": { "position": { "x": 0, "y": 0 } },
                            "ui": { "selected": false, "expanded": true },
                            "data": { "spec": {}, "meta": { "label": "场一" } } }],
                "edges": [],
                "viewport": { "x": 0, "y": 0, "zoom": 1 },
            }),
            settings: json!({ "characters": {}, "locations": {}, "props": {} }),
            episode_titles: json!({ "1": "开端" }),
            assets: json!({ "byId": {} }),
        };
        let text = serde_json::to_string(&file).unwrap();
        let back: ProjectFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.project.name, "午夜出租车");
        // 信封键名为 camelCase（前端契约）
        assert!(text.contains("schemaVersion"));
        assert!(text.contains("createdAt"));
        assert!(text.contains("episodeTitles"));
        assert_eq!(back.episode_titles, json!({ "1": "开端" }));
        // 统计从 graph 派生
        assert_eq!(graph_stats(&back.graph), (1, 1));
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
        assert_eq!(file.project.id, "p-1"); // 缺省时以文件名回填
        assert_eq!(file.settings, json!({}));
        assert_eq!(file.assets, json!({ "byId": {} }));
    }
}
