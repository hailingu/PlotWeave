//! store 子模块测试共用夹具：合法保存基线文档、摘要构造、唯一临时
//! projects 目录与受信句柄打开（等价生产端 projects_dir 的锚定句柄）。

use std::fs;
use std::path::PathBuf;

use cap_std::{ambient_authority, fs::Dir as CapDir};
use serde_json::json;

use crate::store::types::{new_id, ProjectFile, ProjectInfo, ProjectMeta};

/// 合法 v1 信封（保存边界校验的基线载荷）。
pub(crate) fn valid_save_doc() -> ProjectFile {
    ProjectFile {
        schema_version: 1,
        versionless: false,
        project: ProjectInfo {
            id: "p-self-reported".into(),
            name: "午夜出租车".into(),
            description: None,
            created_at: "2026-08-01T00:00:00.000Z".into(),
            updated_at: "2026-08-28T12:00:00.000Z".into(),
        },
        graph: json!({
            "nodes": [], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 1 },
        }),
        settings: json!({
            "characters": {}, "locations": {}, "props": {}, "documents": {},
        }),
        episode_titles: json!({ "1": "开端" }),
        assets: json!({ "byId": {} }),
    }
}

pub(crate) fn meta(id: &str, updated_at: &str) -> ProjectMeta {
    ProjectMeta {
        id: id.into(),
        name: id.into(),
        updated_at: updated_at.into(),
        scene_count: 0,
        ending_count: 0,
    }
}

/// 唯一临时项目根：`{tmp}/pw-store-test-{new_id}/projects/`，返回 projects 目录。
/// 测试内核用的受信句柄：对临时 projects 目录做环境打开（等价生产端
/// projects_dir 返回的锚定句柄）。
pub(crate) fn cap(p: &std::path::Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试项目根句柄")
}

pub(crate) fn temp_projects_dir() -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("pw-store-test-{}", new_id()))
        .join("projects");
    fs::create_dir_all(&dir).expect("创建临时 projects 目录");
    dir
}

pub(crate) fn cleanup_temp(projects: &std::path::Path) {
    if let Some(parent) = projects.parent() {
        let _ = fs::remove_dir_all(parent);
    }
}
