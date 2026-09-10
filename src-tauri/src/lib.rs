//! PlotWeave 桌面端入口：初始化 Tauri 运行时并加载前端画布页面。
//!
//! - `store`：项目持久化命令（list/create/load/save/delete_project）。
//! - `prefs`：应用设置与 provider 密钥（设置 JSON 落盘；key 经 `seal`
//!   加密后随配置落盘，LLM 代理在 Rust 内存中解密，§6/§8.2）。
//! - `seal`：API key 加密封装（AES-256-GCM，绑定本机）。
//! - `library`：个人资产库（应用级 library/ 目录，索引 + 媒体文件，§8.1）。
//! - `library::media`：`pwmedia` opaque asset URL 媒体协议（库 scope 按净化
//!   索引、项目 scope 按项目文档索引逐请求解析 id，§7.1/§10.5，issue #26/#31）。
//! - `library_fs`：资产库文件系统共享内核（受信锚定句柄、索引受限读取与
//!   脏条目隔离——library 与 assets 共用，§7.1/§7.2 信任链）。
//! - `library_journal`：库删除事务与恢复（日志驱动身份绑定隔离事务、
//!   cleanupPending 与冲突期条目隔离，§7.2 可恢复提交协议）。
//! - `assets`：项目资产管线（库资产拷贝导入、set_asset 预检、项目媒体
//!   解析/打开内核，§7.1/§7.3/§9.3）。
//! - `imagegen`：画布内 AI 图像生成代理（文生图，docs/data-model.md §13 首片）。
//! - `http_util`：出站 HTTP 代理共享助手（响应体流式限读内核）。

mod assets;
mod http_util;
mod imagegen;
mod isotime;
mod library;
mod library_fs;
mod library_index;
mod library_journal;
#[cfg(target_os = "macos")]
mod native_quit;
mod prefs;
mod seal;
mod store;

/// tauri.conf.json 窗口契约守卫（仅测试构建参与编译）。
#[cfg(test)]
mod conf;

/// 保存屏障的受控退出：前端确认会话已排空后调用，直接退出 Tauri 事件循环。
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 启动 Tauri 应用；移动端通过 `mobile_entry_point` 复用同一入口。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 会话新增项目资产登记表（pwmedia 项目 scope 的防抖落盘窗口，
        // issue #31 评审修复）：应用显式拥有的状态，非进程级可变全局单例
        .manage(assets::project_media::PendingProjectAssets::new())
        .invoke_handler(tauri::generate_handler![
            store::list_projects,
            store::create_project,
            store::load_project,
            store::load_ai_session,
            store::save_project,
            store::save_ai_session,
            store::delete_project,
            store::copy_project_assets,
            store::verify_project_assets,
            prefs::load_prefs,
            prefs::save_prefs,
            prefs::set_provider_key,
            prefs::llm_chat,
            library::list_library_assets,
            library::import_library_asset,
            library::update_library_asset,
            library::delete_library_asset,
            library::group_commands::upsert_library_group,
            library::group_commands::delete_library_group,
            library::media::get_asset_media_url,
            assets::import_project_asset_from_library,
            assets::validate_project_asset,
            assets::project_media::register_project_asset_alias,
            imagegen::llm_image_generate,
            imagegen::llm_image_cancel,
            app_exit,
        ])
        // opaque asset URL 媒体协议（§7.1/§10.5，issue #26/#31）：每次请求按
        // 当前净化索引（库）/项目文档索引（项目）重新解析 id，经句柄链读取
        // 后返回字节——本机路径与 relPath 不进入前端媒体链路。读盘放
        // spawn_blocking，避免占用主线程。
        .register_asynchronous_uri_scheme_protocol(
            library::media::MEDIA_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let uri = request.uri().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    // 许可生命周期覆盖交付（评审修复，PR #32 第五轮）：
                    // respond 返回后才出界释放——等待中的读者不得在先前
                    // 响应体仍待交付/消费时分配新缓冲（4×单文件上限峰值契约）
                    let library::media::MediaDelivery {
                        response,
                        permit: _permit,
                    } = library::media::handle_media_request(&app, &uri);
                    responder.respond(response);
                });
            },
        )
        .build(tauri::generate_context!())
        .expect("启动 PlotWeave 应用失败");
    #[cfg(target_os = "macos")]
    let _quit_barrier = {
        use tauri::Emitter;
        let handle = app.handle().clone();
        native_quit::install(move || {
            if let Err(error) = handle.emit("app-quit-requested", ()) {
                eprintln!("发出退出请求事件失败：{error}");
            }
        })
        .expect("安装原生退出保存屏障失败")
    };
    app.run(|_, _| {});
}
