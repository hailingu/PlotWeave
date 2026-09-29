//! 库删除事务与恢复内核（docs/data-model.md §7.2 可恢复提交协议 + §10.5）：
//! 持久化日志驱动的身份绑定隔离事务——①捕获媒体文件身份并把事务耐久写入
//! `library/asset-delete-journal.json`；②原目录项原子 rename 进保留的
//! `library/assets/.trash/` 隔离区并复核身份；③原子提交去项索引；④仅以
//! 绑定①身份的操作系统原语清理隔离项（受支持平台均无该原语——Linux
//! `/proc/self/fd` 是 procfs 符号链接，unlink 不解引用最终符号链接返回
//! EPERM——故保留隔离项并报告 `cleanupPending`，绝不按名删除）。
//! 启动及每次库列表/写入前按日志恢复未完成事务；冲突期条目标为不可用；
//! 日志异型时整份恢复进入只读告警态，所有库写入/删除暂停。
//!
//! 域拆分（issue #39）：op_lock（操作互斥锁）、journal_io（日志解析与
//! 读写）、trash（隔离区与身份原语）、recover（恢复分支）、transaction
//! （删除事务步骤）、archive（已完成清理项的折叠计数归档，issue #359）、
//! fsync（目录持久性屏障叶子，issue #399 解环拆出）。对外契约保持
//! `crate::library_journal::{…}` 不变；子模块间依赖单向（transaction →
//! recover → trash → journal_io → fsync，模块图无环守卫见
//! src/module_graph.rs），兄弟模块直接互引、不经父级转口。

mod archive;
mod fsync;
mod journal_io;
mod op_lock;
mod recover;
mod trash;

// 日志文件名对 library_fs 的孤儿临时文件清扫（issue #148 目标白名单）
// 与测试可见；单一事实源仍在 journal_io
pub(crate) use journal_io::JOURNAL_FILE_NAME;
// 折叠归档文件名同款白名单可见性（issue #359）
pub(crate) use archive::ARCHIVE_FILE_NAME;
pub(crate) use op_lock::{library_file_lock, library_op_lock};
pub(crate) use recover::{recover, CleanupPendingItem, Recovery};

mod transaction;
pub(crate) use transaction::{delete_asset_transacted, ensure_importable};

#[cfg(test)]
mod recover_compact_tests;
#[cfg(test)]
mod recover_index_tests;
#[cfg(test)]
mod recover_tests;
#[cfg(test)]
mod recover_uncertain_tests;
#[cfg(test)]
mod tests;
