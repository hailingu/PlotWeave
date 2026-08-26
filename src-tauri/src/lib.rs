//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! - `store`：项目持久化命令（list/create/load/save/delete_project）。
//! - `prefs`：应用设置与 provider 密钥（设置 JSON 落盘 + 钥匙串），
//!   并代理 AI 对话请求（key 只在钥匙串与 Rust 内流转，§6/§8.2）。

mod prefs;
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
            prefs::load_prefs,
            prefs::save_prefs,
            prefs::set_provider_key,
            prefs::clear_provider_key,
            prefs::has_provider_key,
            prefs::ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
}
