//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! - `store`：项目持久化命令（list/create/load/save/delete_project）。
//! - `prefs`：应用设置与 provider 密钥（设置 JSON 落盘；key 经 `seal`
//!   加密后随配置落盘，LLM 代理在 Rust 内存中解密，§6/§8.2）。
//! - `seal`：API key 加密封装（AES-256-GCM，绑定本机）。
//! - `library`：个人资产库（应用级 library/ 目录，索引 + 媒体文件，§8.1）。
//! - `assets`：项目资产管线（库资产拷贝导入、set_asset 预检、媒体路径，§7.1/§7.3/§9.3）。
//! - `imagegen`：画布内 AI 图像生成代理（文生图，docs/data-model.md §13 首片）。
//! - `http_util`：出站 HTTP 代理共享助手（响应体流式限读内核）。

mod assets;
mod http_util;
mod imagegen;
mod isotime;
mod library;
mod prefs;
mod seal;
mod store;

/// tauri.conf.json 窗口契约守卫（仅测试构建参与编译）。
#[cfg(test)]
mod conf;

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
            store::copy_project_assets,
            store::verify_project_assets,
            prefs::load_prefs,
            prefs::save_prefs,
            prefs::set_provider_key,
            prefs::llm_chat,
            library::library_dir_path,
            library::library_list,
            library::library_put,
            library::library_update_meta,
            library::library_delete,
            assets::import_project_asset_from_library,
            assets::validate_project_asset,
            assets::project_asset_path,
            imagegen::llm_image_generate,
            imagegen::llm_image_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
}
