//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! 持久化命令（docs/ui-design.md §3.2、数据模型 §11）注册在 `store` 模块：
//! list/create/load/save/delete_project，前端经 `@tauri-apps/api` invoke 调用。

mod store;

/// 启动 Tauri 应用；移动端通过 `mobile_entry_point` 复用同一入口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            store::list_projects,
            store::create_project,
            store::load_project,
            store::save_project,
            store::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
}
