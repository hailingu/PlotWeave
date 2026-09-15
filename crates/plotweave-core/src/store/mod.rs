//! 项目持久化（docs/data-model.md v1 §10/§11；P2 抽离为宿主无关内核）：
//! 每个项目一个 JSON 文件，存于数据根 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）。graph/settings/assets 以 `serde_json::Value`
//! 透传，但保存边界（§10.5）执行完整信封校验：版本、容器形状、时间戳、
//! 集标题键、AssetRef 形状——只验证不修复，异型值整次拒绝；updatedAt 由内核
//! 盖戳，id 以受信路径参数覆盖。落盘走原子写（§10.2）。
//! 旧扁平格式在 load 时按第 0 步信封判型：形状特征匹配旧扁平格式才包装为
//! v0 信封交付（显式 schemaVersion 0 同论），丢失版本号但保持 v1 信封
//! 特征的文档按 v1 交付；显式版本号与信封形状两族矛盾的文档拒绝加载并保留
//! 原文件。v1 信封的 project 元信息逐字段宽容提取，字段级损坏不阻断加载，
//! 修复与警告归前端归一化层。节点级迁移与归一化由前端模型层（§11）完成。
//!
//! 模块组织（issue #14 拆分）：types（信封类型与 id/名称工具）、
//! validate（保存边界校验与实路径复验）、persist（受信句柄与原子写
//! 原语）、list（列表与多版本封套解析）、commands（生命周期内核）、
//! copy（跨项目资产复制）。原 Tauri 命令包装在 src-tauri 的 store 薄适配层；
//! Swift 宿主经 plotweave-ffi 的 C ABI 调用同一内核。

mod commands;
mod copy;
mod list;
mod persist;
mod types;
mod validate;

#[cfg(test)]
mod testutil;

pub use commands::{
    create_project_in, delete_project_files, load_ai_session_file, load_project_file,
    persist_project, save_ai_session_file, SessionCopy,
};
pub use copy::copy_assets_tree;
pub use list::list_project_metas;
pub use types::{new_id, new_id_with_prefix, validate_id};
pub use types::{ProjectFile, ProjectInfo, ProjectMeta};
pub use validate::unverifiable_asset_keys;

// 原语与工具跨 crate 复用（原 pub(crate) 面）：src-tauri 的 assets/library/
// prefs 等域与 pwmedia 媒体解析经其宿主侧 store 适配 re-export 使用。
#[cfg(unix)]
pub use persist::asset_identity;
pub use persist::{asset_stat, atomic_write, open_dir_bound, open_projects_root};
pub use validate::{
    is_canonical_mime, is_valid_active_asset_rel_path, is_valid_asset_rel_path,
    verify_asset_real_path,
};
