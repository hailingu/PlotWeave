//! 资产库索引的兼容迁移与完整加载归一化内核（docs/data-model.md §7.2，
//! issue #29 PR 1）：把已发布的数组形状 `assets[]`/`groups[]` 迁移为目标
//! Record 形状 `assets.byId`/`groups.byId`，并在读取与全部写入口执行完整
//! LibraryAsset/AssetGroup 归一化（含 §7.1 AssetRef 共享字段与跨条目
//! groupId/kind 一致性）。纯函数、无 IO——IO 由 [`crate::library_fs`] 承担，
//! 本内核以「读出→迁移→归一化」后的索引为唯一逻辑基线（§7.2 库写边界）。
//!
//! 迁移链严格按 §7.2 顺序：① 数组/普通对象成员安全预检 → ② id 校验/重发
//! 并键化为 byId（含组 id 重复/空白的 groupId 映射规则）→ ③ source 补
//! upload、epoch 毫秒转 UTC ISO、null 可选字段删除、prop→wardrobe → ④ 完整
//! AssetGroup/LibraryAsset/跨条目校验。缺失/异型时间戳或显式未知 source 不
//! 猜测，隔离并警告；不得把目标校验直接套在旧数组成员上。

mod normalize;

pub(crate) use normalize::{migrate_and_normalize, migrate_and_normalize_readonly};

#[cfg(test)]
mod fixup_tests;
#[cfg(test)]
mod normalize_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod testutil;
