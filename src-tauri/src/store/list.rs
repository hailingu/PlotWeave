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
        // 检查转换（评审修复，PR #33 第十三轮）：u64 > i64::MAX 经 as 强转会
        // 溢出成负数，把脏时间戳静默替换成貌似合法的 1969 规范值；溢出即放弃
        // 迁移该字段（回退默认），不伪造瞬间
        .and_then(|ms| i64::try_from(ms).ok())
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
mod tests;
