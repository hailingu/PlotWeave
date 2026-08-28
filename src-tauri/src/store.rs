//! 项目持久化（docs/ui-design.md §3.2 / 数据模型 §11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 画布 nodes/edges 对前端是自有数据，Rust 端以 `serde_json::Value` 透传，
//! 仅校验项目名与 id（信任边界内的自有格式，不做逐字段断言）。

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 项目文件：name + 更新时间（epoch 毫秒）+ 画布两数组 + 设定集 + 集标题表
/// （nodes/edges/settings/episodeTitles 对前端是自有数据，以 `serde_json::Value` 透传）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    pub name: String,
    pub updated_at: u64,
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
    /// 设定集实体（角色/地点）；旧版文件缺失时按空对象处理。
    #[serde(default = "empty_settings")]
    pub settings: serde_json::Value,
    /// 大纲集标题（§3.5：集 = 编号 + 行内标题，不建实体表）；键为集号字符串。
    #[serde(default = "empty_settings", rename = "episodeTitles")]
    pub episode_titles: serde_json::Value,
}

/// 项目摘要：首页海报卡的展示模型；统计从 nodes 派生，不落镜像字段。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub updated_at: u64,
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

/// settings 字段缺省值：空对象（而非 Null），前端 normalizeSettings 兜底。
fn empty_settings() -> serde_json::Value {
    serde_json::json!({})
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

/// 从画布 nodes 派生统计：场数 = scene 节点数；结局数 = 无剧情流出边的
/// 场景数（分支剧情的叶子场景即结局）。attach 下挂边（索引卡 → 分镜卡，
/// 垂直派生从属）不算出边——挂了分镜的场景仍是叶子结局。
pub fn graph_stats(nodes: &serde_json::Value, edges: &serde_json::Value) -> (u64, u64) {
    let empty: Vec<serde_json::Value> = Vec::new();
    let nodes = nodes.as_array().unwrap_or(&empty);
    let edges = edges.as_array().unwrap_or(&empty);

    let scene_ids: HashSet<&str> = nodes
        .iter()
        .filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("scene"))
        .filter_map(|n| n.get("id").and_then(|i| i.as_str()))
        .collect();
    let is_attach = |e: &serde_json::Value| {
        e.get("sourceHandle").and_then(|h| h.as_str()) == Some("shots")
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
    let (scene_count, ending_count) = graph_stats(&file.nodes, &file.edges);
    ProjectMeta {
        id: id.to_string(),
        name: file.name.clone(),
        updated_at: file.updated_at,
        scene_count,
        ending_count,
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
        if let Ok(file) = serde_json::from_str::<ProjectFile>(&text) {
            metas.push(read_meta(id, &file));
        }
    }
    metas.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
    Ok(metas)
}

/// 新建空项目（空画布），返回其摘要。
#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&name)?;
    let id = new_id();
    let file = ProjectFile {
        name,
        updated_at: now_ms(),
        nodes: serde_json::json!([]),
        edges: serde_json::json!([]),
        settings: serde_json::json!({ "characters": [], "locations": [] }),
        episode_titles: serde_json::json!({}),
    };
    let path = project_path(&app, &id)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(path, text).map_err(|e| format!("写入项目失败：{e}"))?;
    Ok(read_meta(&id, &file))
}

/// 读取项目完整内容（含画布）。
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let path = project_path(&app, &id)?;
    let text = fs::read_to_string(path).map_err(|_| format!("项目不存在：{id}"))?;
    serde_json::from_str(&text).map_err(|e| format!("项目文件损坏：{e}"))
}

/// 全量保存：更新时间由服务端盖上，防前端时钟漂移。
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&doc.name)?;
    let file = ProjectFile {
        name,
        updated_at: now_ms(),
        nodes: doc.nodes,
        edges: doc.edges,
        settings: doc.settings,
        episode_titles: doc.episode_titles,
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
    fn graph_stats_ignores_attach_edges_for_endings() {
        let nodes = json!([
            { "id": "s1", "type": "scene", "data": {} },
            { "id": "s2", "type": "scene", "data": {} },
            { "id": "sh", "type": "shot", "data": {} },
        ]);
        // s1 只下挂分镜（attach 派生边）：仍是叶子结局；s2 无任何出边同为结局
        let attach_only = json!([
            { "id": "e1", "source": "s1", "target": "sh",
              "sourceHandle": "shots", "className": "pw-edge-attach" },
        ]);
        assert_eq!(graph_stats(&nodes, &attach_only), (2, 2));

        // s1 有剧情流出边 → 非结局
        let with_sequence = json!([
            { "id": "e1", "source": "s1", "target": "sh",
              "sourceHandle": "shots", "className": "pw-edge-attach" },
            { "id": "e2", "source": "s1", "target": "s2", "className": "pw-edge-sequence" },
        ]);
        assert_eq!(graph_stats(&nodes, &with_sequence), (2, 1));
    }

    #[test]
    fn new_ids_never_collide_in_same_millisecond() {
        assert_ne!(new_id(), new_id());
    }

    #[test]
    fn stats_count_scenes_and_leaf_endings() {
        let nodes = json!([
            { "id": "s1", "type": "scene" },
            { "id": "d1", "type": "dialogue" },
            { "id": "s2", "type": "scene" },
            { "id": "s3", "type": "scene" },
        ]);
        let edges = json!([
            { "source": "s1", "target": "d1" },
            { "source": "d1", "target": "s2" },
        ]);
        assert_eq!(graph_stats(&nodes, &edges), (3, 2)); // s2/s3 无出边 = 结局
    }

    #[test]
    fn stats_on_malformed_graph_fall_back_to_zero() {
        assert_eq!(graph_stats(&json!(null), &json!("oops")), (0, 0));
    }

    #[test]
    fn legacy_file_without_settings_defaults_empty() {
        let legacy = json!({
            "name": "旧项目",
            "updated_at": 1,
            "nodes": [],
            "edges": [],
        });
        let file: ProjectFile = serde_json::from_value(legacy).unwrap();
        assert_eq!(file.settings, json!({}));
    }

    #[test]
    fn project_file_round_trip() {
        let file = ProjectFile {
            name: "午夜出租车".into(),
            updated_at: 42,
            nodes: json!([{ "id": "a", "type": "scene", "data": {} }]),
            edges: json!([]),
            settings: json!({ "characters": [], "locations": [] }),
            episode_titles: json!({ "1": "开端" }),
        };
        let text = serde_json::to_string(&file).unwrap();
        let back: ProjectFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.name, "午夜出租车");
        assert_eq!(back.updated_at, 42);
        // 集标题表以 camelCase 键落盘（前端契约），缺省时按空对象处理
        assert_eq!(back.episode_titles, json!({ "1": "开端" }));
        assert!(text.contains("episodeTitles"));
    }
}
