//! 宿主无关的项目存储内核（P2 抽离；docs/swiftui-react-flow-migration-plan.md
//! §2.1/§2.3）：从 src-tauri 的 store 域整体迁出，业务规则不依赖任何宿主
//! （无 AppHandle/Tauri 运行时），数据根路径由调用方注入——当前 Tauri
//! 经 `store` 薄适配解析应用数据目录；历史 P2 C ABI 由 plotweave-ffi 保留
//! 回归覆盖。当前原生应用使用独立 Swift 服务，不链接这些 Rust crates
//! （所有者决定 2026-10-04；迁移计划 §2.1/§2.3）。内核 I/O 仍走既有校验
//! 与恢复边界（句柄相对、no-follow 归类、原子写、保存边界复验），行为
//! 与迁出前等价（原测试随迁守护）。

/// 锁中毒恢复内核的全仓库单一来源（issue #549）：src-tauri 与 plotweave-ffi
/// 跨 workspace 复用本模块，不再各自维护逐字节拷贝。
pub mod lock;

pub mod isotime;
pub mod store;
