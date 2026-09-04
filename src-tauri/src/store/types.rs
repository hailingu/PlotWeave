//! 项目文件类型与 id/名称工具（数据模型 §3/§10）：ProjectDocument
//! 信封的 serde 形状（description 在场保留、IPC 反序列化缺键整次拒绝）、
//! 项目摘要、新建空信封构造，以及文件名安全的 id 与项目名约束。

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
/// description 字段的在场保留反序列化：显式 null 映射为 Some(Null) 而非
/// None——serde 对 Option 的默认行为会把 null 与缺场折叠，保存边界因此
/// 看不见非字符串值（键被静默省略，既有描述被无声抹掉）。
fn raw_description<'de, D>(d: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde_json::Value::deserialize(d).map(Some)
}
/// 项目元信息：id/name + ISO 8601 创建与更新时间（§3）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    // None 省略键；字符串原样透传；非字符串（含显式 null，经 raw_description
    // 保留在场）也原样透传——前端 §11.1 剥离并警告、repaired 回写落定（折叠
    // 为 None 会让 repaired 检测看不见缺陷、保存边界看不见非法值而静默
    // 省略键抹掉既有描述）；保存边界（prepare_save）只收字符串
    #[serde(
        default,
        deserialize_with = "raw_description",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<serde_json::Value>,
    #[serde(default, rename = "createdAt")]
    pub created_at: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: String,
}
/// 项目文件：ProjectDocument 信封。graph/settings/episodeTitles/assets 以
/// `serde_json::Value` 透传。反序列化（save IPC 载荷）不设 serde 缺省：六键
/// 缺一整次拒绝——缺桶默认补空值会静默清光既有数据；加载宽容由手工构造承担。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    /// 信封判型发现文件缺 schemaVersion（按形状判为 v1，§11 第 0 步）：
    /// IPC 标记由前端 repaired 检测消费（载荷额外键使规范化比较必然不等，
    /// 触发回写补盖版本号）——否则文件永久无版本，违反 §10.5/§11.1 收敛
    /// 契约；持久化输出恒为 false（保存必盖显式版本）。
    #[serde(default, skip_serializing_if = "is_false")]
    pub versionless: bool,
    pub project: ProjectInfo,
    pub graph: serde_json::Value,
    pub settings: serde_json::Value,
    #[serde(rename = "episodeTitles")]
    pub episode_titles: serde_json::Value,
    pub assets: serde_json::Value,
}
/// 项目摘要：首页海报卡的展示模型；统计从 graph 派生，不落镜像字段。
#[derive(Debug, Clone, Serialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    /// ISO 8601；可含时区偏移/小数秒变体，排序须按解析后的瞬间比较。
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
/// serde 谓词：false 时省略键（versionless 标记仅真值跨 IPC）。
fn is_false(v: &bool) -> bool {
    !*v
}
pub(crate) fn empty_assets() -> serde_json::Value {
    json!({ "byId": {} })
}
/// 新建空项目（空画布 v1 信封），返回其摘要。
/// 新建项目的初始 v1 文档：settings 四桶齐备（§10.5 保存边界同域）——
/// 新建文档必须无需归一化修复即可通过 create → load → save 原始链路。
pub(crate) fn new_project_file(id: &str, name: String, now: String) -> ProjectFile {
    ProjectFile {
        schema_version: 1,
        versionless: false,
        project: ProjectInfo {
            id: id.to_string(),
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
        settings: json!({ "characters": {}, "locations": {}, "props": {}, "documents": {} }),
        episode_titles: json!({}),
        assets: empty_assets(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::isotime::now_iso;
    use crate::store::list::graph_stats;
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
    fn new_ids_never_collide_in_same_millisecond() {
        assert_ne!(new_id(), new_id());
    }

    #[test]
    fn project_info_none_description_is_omitted_not_null() {
        // description 缺省若序列化为 null：前端归一化把 null 当异型剥离
        // （repaired=true）→ 回写 → Rust 又写回 null——示例项目的列表升级
        // 循环永不收敛（全新启动首页加载不完、示例文件被反复重写）；
        // 缺省必须省略键，往返才收敛
        let file = new_project_file("p-1", "剧".into(), now_iso());
        let text = serde_json::to_string(&file).unwrap();
        assert!(!text.contains("\"description\""), "None 应省略键：{text}");
        let mut file = file;
        file.project.description = Some("简介".into());
        let text = serde_json::to_string(&file).unwrap();
        assert!(text.contains("\"description\":\"简介\""));
        // 省略键的解析往返：回到 None
        let bare = serde_json::to_string(&new_project_file("p-1", "剧".into(), now_iso())).unwrap();
        let back: ProjectFile = serde_json::from_str(&bare).unwrap();
        assert_eq!(back.project.description, None);
    }

    #[test]
    fn project_file_round_trip() {
        let file = ProjectFile {
            schema_version: 1,
            versionless: false,
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
    fn save_ipc_payload_requires_all_envelope_buckets() {
        // IPC 反序列化不设 serde 缺省：缺桶载荷默认补空值落盘，清光既有数据
        let full = serde_json::to_value(new_project_file("p-1", "剧".into(), now_iso())).unwrap();
        for key in "schemaVersion project graph settings episodeTitles assets".split(' ') {
            let mut missing = full.clone();
            missing.as_object_mut().expect("对象").remove(key);
            let err = serde_json::from_value::<ProjectFile>(missing).unwrap_err();
            assert!(err.to_string().contains(key), "缺 {key} 应整次拒绝：{err}");
        }
        assert!(serde_json::from_value::<ProjectFile>(full).is_ok());
    }
}
