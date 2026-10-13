//! Tauri 项目命令适配：宿主解析数据根，阻塞调度后调用共享存储内核。
//! 命令参数、结构化领域错误的 IPC 文案及保存存在性约束沿用 dev。

use cap_std::fs::Dir as CapDir;
use plotweave_core::store::error::load_project_ipc_text;
use plotweave_core::store::{
    copy_assets_tree, create_project_in, delete_project_files, list_project_metas,
    load_ai_session_file, persist_project, persist_project_expect_existing, sanitize_name,
    save_ai_session_file, unverifiable_asset_keys, ProjectFile, ProjectMeta, SessionCopy,
};
use tauri::{AppHandle, Manager};

#[cfg(unix)]
pub(crate) use plotweave_core::store::asset_identity;
#[cfg(test)]
pub(crate) use plotweave_core::store::atomic_write_faults;
pub(crate) use plotweave_core::store::error;
#[cfg(test)]
pub(crate) use plotweave_core::store::testutil;
pub(crate) use plotweave_core::store::{
    asset_stat, atomic_write, atomic_write_private, backup_damaged_file, create_dir_all_durable,
    is_canonical_mime, is_valid_active_asset_rel_path, is_valid_asset_rel_path, new_id_with_prefix,
    open_dir_bound, projects_op_lock, sweep_orphan_temp_files, sync_new_child_dir_host,
    to_ipc_text, verify_asset_real_path, DamagedFileBackup, FilePermissions,
};
pub use plotweave_core::store::{load_project_file, new_id, validate_id};

/// 宿主数据根解析后注入内核；开根的耐久创建与身份绑定归内核负责。
pub(crate) fn projects_dir(app: &AppHandle) -> Result<CapDir, error::StoreError> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|source| error::StoreError::AppDataDir {
            source: Box::new(source),
        })?;
    plotweave_core::store::open_projects_root(&data_root)
}

/// 新建项目：先校验名称，再在阻塞线程内完成目录准备和原子落盘。
#[tauri::command]
pub async fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    crate::blocking::run("create_project", move || {
        // 不可信输入校验先于任何存储打开/创建（PR #179 评审修复）：名称非法
        // 不得触发应用数据/projects 目录创建副作用，也不得被存储故障顶替为
        // 名称诊断——历史行为是名称校验先于 projects_dir
        sanitize_name(&name)?;
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        create_project_in(&root, &name).map_err(to_ipc_text)
    })
    .await
}
/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。读取相对
/// projects_dir 的受信根锚定句柄解析（§10.2），不按路径名重开。
/// NotFound 出口携带 `[project_not_found] ` 机器码前缀（issue #229）——
/// 前端空库播种按码分支，不经中文文案；码不上屏，展示层剥离。
#[tauri::command]
pub async fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    crate::blocking::run("load_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        load_project_file(&root, &id).map_err(load_project_ipc_text)
    })
    .await
}
/// 读取项目独立 AI 会话：`session` 为 None 表示缺失（旧项目，前端视作空
/// 历史）或损坏（`corrupt` 置位，按可安全替换归类）；会话损坏只阻断会话
/// 恢复，不影响同项目的画布文档读取。
#[tauri::command]
pub async fn load_ai_session(app: AppHandle, id: String) -> Result<SessionCopy, String> {
    crate::blocking::run("load_ai_session", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        load_ai_session_file(&root, &id).map_err(to_ipc_text)
    })
    .await
}
/// 单实例会话保存：仅原子写入主文件，失败直接上浮，不写恢复副本。
#[tauri::command]
pub async fn save_ai_session(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    crate::blocking::run("save_ai_session", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        save_ai_session_file(&root, &id, &session).map_err(to_ipc_text)
    })
    .await
}
/// 全量保存（§10.5 保存边界）：完整信封校验先行，任一失败整次拒绝；
/// 资产 relPath 在已验证的 projects 目录下做实路径复验（no-follow +
/// canonical 包含），通过后才盖戳 updatedAt、创建临时文件并原子落盘；
/// 落盘后再复验一次——句柄只绑定打开时的 inode，不钉住路径名，保存期间
/// 被并发进程替换（unlink/重命名/换符号链接）的路径在写后复验中上浮为
/// 显式失败（文档虽已提交，篡改不得静默；下次加载复验会隔离条目兜底）。
#[tauri::command]
pub async fn save_project(
    app: AppHandle,
    id: String,
    doc: ProjectFile,
    expect_existing: Option<bool>,
) -> Result<ProjectMeta, String> {
    crate::blocking::run("save_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        match expect_existing.unwrap_or(false) {
            false => persist_project(&root, &id, doc),
            true => persist_project_expect_existing(&root, &id, doc, true),
        }
        .map_err(to_ipc_text)
    })
    .await
}
/// 删除项目（首页卡片菜单，§3.2）：移除 `projects/{id}.json` 与项目资产
/// 目录 `projects/{id}/`（当前扁平布局的资产根，§10.1）。目录删除逐项
/// no-follow 且全程相对已打开的 projects 根目录句柄（§10.2 openat 语义，
/// cap-std）——符号链接条目只移除链接本身，绝不跟随；任一失败显式报错，
/// 不静默遗留媒体文件。
#[tauri::command]
pub async fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    crate::blocking::run("delete_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        delete_project_files(&root, &id).map_err(to_ipc_text)
    })
    .await
}
/// §7.3 复制项目：整目录拷贝项目资产（当前扁平布局下 `projects/{fromId}/
/// assets` → `projects/{toId}/assets`），供 §10.5 保存边界的实路径复验在
/// 副本侧通过。源资产目录缺失视为无资产（no-op）；存在时源根必须为非
/// 符号链接的实际目录，子树逐项 no-follow——符号链接与非普通文件条目
/// 拒绝；目标目录已存在视为异常（新副本 id 刚分配）。任一失败整次报错
/// 并回滚已拷贝的目标子树，不遗留半拷贝。
#[tauri::command]
pub async fn copy_project_assets(
    app: AppHandle,
    from_id: String,
    to_id: String,
) -> Result<(), String> {
    crate::blocking::run("copy_project_assets", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        copy_assets_tree(&root, &from_id, &to_id).map_err(to_ipc_text)
    })
    .await
}
/// 列出全部项目，按更新时间新→旧排序。扫描相对受信根锚定句柄执行。
#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Result<Vec<ProjectMeta>, String> {
    crate::blocking::run("list_projects", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        list_project_metas(&root).map_err(to_ipc_text)
    })
    .await
}
/// 加载侧资产复验命令：调用方回传刚加载文档的资产索引（避免二次读盘），
/// 返回不可验证键，交前端归一化层隔离——否则下一次保存会被保存边界
/// 拒收，防抖静默吞错后用户编辑永不落盘。加载本身保持只读；复验相对
/// projects_dir 的受信根锚定句柄执行。
#[tauri::command]
pub async fn verify_project_assets(
    app: AppHandle,
    id: String,
    assets: serde_json::Value,
) -> Result<Vec<String>, String> {
    crate::blocking::run("verify_project_assets", move || {
        validate_id(&id)?;
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        Ok(unverifiable_asset_keys(&root, &id, &assets))
    })
    .await
}

#[cfg(test)]
mod blocking_tests;
#[cfg(test)]
mod integration_tests;
