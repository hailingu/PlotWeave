//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! 业务命令（数据模型、持久化、剧本导出）后续以 `tauri::command` 形式
//! 注册到此处，保持前端只负责画布交互。

/// 启动 Tauri 应用；移动端通过 `mobile_entry_point` 复用同一入口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
}
