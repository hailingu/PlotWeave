//! 宿主无关的项目存储内核（P2 抽离；docs/swiftui-react-flow-migration-plan.md
//! §2.1/§2.3）：从 src-tauri 的 store 域整体迁出，业务规则不依赖任何宿主
//! （无 AppHandle/Tauri 运行时），数据根路径由宿主注入（§4.3）——Tauri 侧
//! 经 `store` 薄适配解析应用数据目录，Swift 侧经 plotweave-ffi 的 C ABI
//! 注入独立数据根。所有 I/O 仍走既有校验与恢复内核（句柄相对、no-follow
//! 归类、原子写、保存边界复验），行为与迁出前等价（原测试随迁守护）。

pub mod isotime;
pub mod store;
