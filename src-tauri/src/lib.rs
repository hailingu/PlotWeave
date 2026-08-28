//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! - `store`：项目持久化命令（list/create/load/save/delete_project）。
//! - `prefs`：应用设置与 provider 密钥（设置 JSON 落盘；key 经 `seal`
//!   加密后随配置落盘，LLM 代理在 Rust 内存中解密，§6/§8.2）。
//! - `seal`：API key 加密封装（AES-256-GCM，绑定本机）。
//! - `library`：个人资产库（应用级 library/ 目录，索引 + 媒体文件，§8.1）。

mod library;
mod prefs;
mod seal;
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
            prefs::llm_chat,
            library::library_dir_path,
            library::library_list,
            library::library_put,
            library::library_update_meta,
            library::library_delete,
        ])
        .run(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
}
