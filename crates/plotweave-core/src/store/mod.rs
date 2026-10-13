//! 项目持久化（docs/data-model.md v1 §10/§11）：
//! 每个项目一个 JSON 文件，存于应用数据目录 `projects/` 下，文件名即项目 id。
//! 落盘格式为 ProjectDocument 信封（schemaVersion + project 元信息 + graph +
//! settings + episodeTitles + assets）。graph/settings/assets 以 `serde_json::Value`
//! 透传，但保存边界（§10.5）执行完整信封校验：版本、容器形状、时间戳、
//! 集标题键、AssetRef 形状——只验证不修复，异型值整次拒绝；updatedAt 由 Rust
//! 端盖戳，id 以受信路径参数覆盖。落盘走原子写（§10.2）。
//! 旧扁平格式在 load 时按第 0 步信封判型：形状特征匹配旧扁平格式才包装为
//! v0 信封交付前端（显式 schemaVersion 0 同论），丢失版本号或版本字段为无法
//! 表达受支持/未来版本的异型值（null/布尔/容器/非规范数字串，issue #338）
//! 但保持 v1 信封特征的文档按 v1 交付；非法数值、规范整数字符串、显式版本
//! 号与信封形状两族矛盾的文档拒绝加载并保留原文件。v1 信封的 project 元信息
//! 逐字段宽容提取，字段级损坏不阻断加载，
//! 修复与警告归前端归一化层。节点级迁移与归一化由前端模型层（§11）完成。
//!
//! 模块组织（issue #14 拆分）：types（信封类型与 id/名称工具）、
//! validate（保存边界校验与实路径复验）、persist（受信句柄与原子写
//! 原语）、list（列表与多版本封套解析）、commands（生命周期命令）、
//! copy（跨项目资产复制）、error（领域错误类型，issue #144 store 分片）；
//! 对外 store:: 符号路径经 re-export 保持不变。

mod commands;
mod copy;
mod damaged_backup;
pub mod error;
mod file_permissions;
mod list;
mod persist;
mod types;
mod validate;

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod testutil;
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub use persist::faults as atomic_write_faults;

pub use commands::{
    create_project_in, delete_project_files, load_ai_session_file, load_project_file,
    persist_project, persist_project_expect_existing, save_ai_session_file, SessionCopy,
};
pub use copy::copy_assets_tree;
pub use damaged_backup::{backup_damaged_file, DamagedFileBackup};
pub use error::to_ipc_text;
pub use file_permissions::FilePermissions;
pub use list::list_project_metas;
#[cfg(unix)]
pub use persist::asset_identity;
pub use persist::{
    asset_stat, atomic_write, atomic_write_private, create_dir_all_durable, open_dir_bound,
    open_projects_root, projects_op_lock, sweep_orphan_temp_files, sync_new_child_dir_host,
};
pub use types::{
    new_id, new_id_with_prefix, sanitize_name, validate_id, ProjectFile, ProjectInfo, ProjectMeta,
};
pub use validate::{
    is_canonical_mime, is_valid_active_asset_rel_path, is_valid_asset_rel_path,
    unverifiable_asset_keys, verify_asset_real_path,
};
