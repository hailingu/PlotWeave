//! 项目持久化（docs/data-model.md v1 §10/§11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）。graph/settings/assets 以 `serde_json::Value`
//! 透传，但保存边界（§10.5）执行完整信封校验：版本、容器形状、时间戳、
//! 集标题键、AssetRef 形状——只验证不修复，异型值整次拒绝；updatedAt 由 Rust
//! 端盖戳，id 以受信路径参数覆盖。落盘走原子写（§10.2）。
//! 旧扁平格式在 load 时按第 0 步信封判型：形状特征匹配旧扁平格式才包装为
//! v0 信封交付前端（显式 schemaVersion 0 同论），丢失版本号但保持 v1 信封
//! 特征的文档按 v1 交付；显式版本号与信封形状两族矛盾的文档拒绝加载并保留
//! 原文件。v1 信封的 project 元信息逐字段宽容提取，字段级损坏不阻断加载，
//! 修复与警告归前端归一化层。节点级迁移与归一化由前端模型层（§11）完成。
//!
//! 模块组织（issue #14 拆分）：types（信封类型与 id/名称工具）、
//! validate（保存边界校验与实路径复验）、persist（受信句柄与原子写
//! 原语）、list（列表与多版本封套解析）、commands（生命周期命令）、
//! copy（跨项目资产复制）；对外 store:: 符号路径经 re-export 保持不变。

mod commands;
mod copy;
mod list;
mod persist;
mod types;
mod validate;

#[cfg(test)]
mod testutil;

pub use commands::{create_project, delete_project, load_project, save_project};
pub use copy::copy_project_assets;
pub use list::list_projects;
pub use types::{new_id, validate_id};
pub use validate::verify_project_assets;

#[cfg(unix)]
pub(crate) use persist::asset_identity;
pub(crate) use persist::{asset_stat, atomic_write, open_dir_bound, projects_dir};
pub(crate) use validate::{is_canonical_mime, is_valid_asset_rel_path, verify_asset_real_path};

// #[tauri::command] 的隐藏包装项（__cmd__* / __tauri_command_name_*）留在
// 定义模块：一并 re-export，lib.rs 的 generate_handler!(store::…) 注册
// 路径保持不变
#[doc(hidden)]
pub use commands::__cmd__create_project;
#[doc(hidden)]
pub use commands::__cmd__delete_project;
#[doc(hidden)]
pub use commands::__cmd__load_project;
#[doc(hidden)]
pub use commands::__cmd__save_project;
#[doc(hidden)]
pub use commands::__tauri_command_name_create_project;
#[doc(hidden)]
pub use commands::__tauri_command_name_delete_project;
#[doc(hidden)]
pub use commands::__tauri_command_name_load_project;
#[doc(hidden)]
pub use commands::__tauri_command_name_save_project;
#[doc(hidden)]
pub use copy::__cmd__copy_project_assets;
#[doc(hidden)]
pub use copy::__tauri_command_name_copy_project_assets;
#[doc(hidden)]
pub use list::__cmd__list_projects;
#[doc(hidden)]
pub use list::__tauri_command_name_list_projects;
#[doc(hidden)]
pub use validate::__cmd__verify_project_assets;
#[doc(hidden)]
pub use validate::__tauri_command_name_verify_project_assets;
