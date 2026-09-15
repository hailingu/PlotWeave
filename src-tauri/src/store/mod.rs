//! store 域的 Tauri 薄适配（P2 抽离，迁移计划 §2.1/§3）：业务内核已迁至
//! `crates/plotweave-core`（宿主无关、数据根注入），本模块只保留两件事：
//! 1) 命令包装——解析应用数据目录为受信 projects 根句柄后调用内核，
//!    签名与前端 IPC 契约保持不变（lib.rs 的 generate_handler 路径不变）；
//! 2) 内核符号的宿主侧 re-export——assets/library/prefs/imagegen 等域的
//!    `crate::store::X` 引用路径保持不变。

use cap_std::fs::Dir as CapDir;
use tauri::{AppHandle, Manager};

pub use plotweave_core::store::{
    create_project_in, delete_project_files, load_ai_session_file, load_project_file,
    persist_project, save_ai_session_file, ProjectFile, ProjectMeta, SessionCopy,
};

/// 受信 projects 根（§10.2）：应用数据目录 → 内核的注入路径开根
/// （canonicalize + projects/ 创建/归类 + 身份绑定打开，见内核 persist）。
pub(crate) fn projects_dir(app: &AppHandle) -> Result<CapDir, String> {
    let root_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    plotweave_core::store::open_projects_root(&root_path)
}

#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let root = projects_dir(&app)?;
    create_project_in(&root, &name)
}

#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let root = projects_dir(&app)?;
    load_project_file(&root, &id)
}

#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let root = projects_dir(&app)?;
    persist_project(&root, &id, doc)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let root = projects_dir(&app)?;
    delete_project_files(&root, &id)
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let root = projects_dir(&app)?;
    plotweave_core::store::list_project_metas(&root)
}

#[tauri::command]
pub fn load_ai_session(app: AppHandle, id: String) -> Result<SessionCopy, String> {
    let root = projects_dir(&app)?;
    load_ai_session_file(&root, &id)
}

#[tauri::command]
pub fn save_ai_session(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    let root = projects_dir(&app)?;
    save_ai_session_file(&root, &id, &session)
}

#[tauri::command]
pub fn copy_project_assets(app: AppHandle, from_id: String, to_id: String) -> Result<(), String> {
    let root = projects_dir(&app)?;
    plotweave_core::store::copy_assets_tree(&root, &from_id, &to_id)
}

#[tauri::command]
pub fn verify_project_assets(
    app: AppHandle,
    id: String,
    assets: serde_json::Value,
) -> Result<Vec<String>, String> {
    let root = projects_dir(&app)?;
    Ok(plotweave_core::store::unverifiable_asset_keys(
        &root, &id, &assets,
    ))
}

// —— 工具符号的宿主侧 re-export：外部域 crate::store::X 路径不变 ——
#[cfg(unix)]
pub(crate) use plotweave_core::store::asset_identity;
pub(crate) use plotweave_core::store::{
    asset_stat, atomic_write, is_canonical_mime, is_valid_active_asset_rel_path,
    is_valid_asset_rel_path, open_dir_bound, verify_asset_real_path,
};
pub use plotweave_core::store::{new_id, new_id_with_prefix, validate_id};
