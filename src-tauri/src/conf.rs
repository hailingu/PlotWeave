//! tauri.conf.json 的配置契约守卫（仅测试）。
//!
//! 前端画布的全部拖放（设定集实体 §5、库资产 §7.3）基于 HTML5 DnD；
//! Tauri 默认 `dragDropEnabled: true` 会在 webview 层拦截拖拽会话，
//! 页面内 DOM 拖放整体失效（tauri-apps/tauri#14373/#6695）——该缺陷只
//! 在真实 webview 复现，前端 JSDOM 测试无法发现，故把「主窗口必须
//! 显式关闭原生拖放」固化为配置契约测试。本项目不用原生文件拖放
//! （资产导入走文件选择对话框），关闭无副作用。
//!
//! 另守卫 assetProtocol scope 收窄契约（issue #9 低成本硬化）：媒体
//! 协议只授权数据模型 §7.1 的专用资产子目录，不覆盖控制文件
//! （project.json/library.json）所在的其他路径。
//!
//! 另守卫主窗口能力集契约（issue #76）：前端 `useExitFlush` 一经注册
//! `onCloseRequested`，Tauri 核心对随后每次原生关闭请求都先 `prevent_close`
//! 再交 JS 决断（tauri manager/window.rs）；未被 JS 阻止时唯一放行出口是
//! `destroy()`，而 `core:window:default` 不含 `allow-destroy`，能力集缺授权
//! 时拒绝被事件回调静默吞掉，关闭按钮永远无效——前端 JSDOM 测试 mock 掉
//! Tauri API 无法发现，故固化为配置契约测试。

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn load_conf() -> Value {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .expect("读取 tauri.conf.json 失败");
        serde_json::from_str(&raw).expect("tauri.conf.json 不是合法 JSON")
    }

    fn load_main_capability() -> Value {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/default.json"
        ))
        .expect("读取 capabilities/default.json 失败");
        let caps: Value =
            serde_json::from_str(&raw).expect("capabilities/default.json 不是合法 JSON");
        assert_eq!(
            caps.get("windows")
                .and_then(Value::as_array)
                .map(|w| w.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default(),
            vec!["main"],
            "capabilities/default.json 必须继续覆盖主窗口 label=main，否则全部授权对主窗口失效"
        );
        caps
    }

    /// 主窗口（label=main）必须显式 dragDropEnabled=false，否则页面内
    /// 拖放事件在到达 JS 前被 Tauri 原生拖放处理器吞掉。
    #[test]
    fn main_window_disables_native_drag_drop() {
        let conf = load_conf();
        let main = conf
            .pointer("/app/windows")
            .and_then(Value::as_array)
            .expect("app.windows 缺失")
            .iter()
            .find(|w| w.get("label").and_then(Value::as_str) == Some("main"))
            .expect("label=main 的窗口配置缺失");
        assert_eq!(
            main.get("dragDropEnabled").and_then(Value::as_bool),
            Some(false),
            "app.windows[main].dragDropEnabled 必须为 false：true 时 Tauri 在 webview 层拦截拖拽，HTML5 拖放整体失效"
        );
    }

    /// assetProtocol 整体停用契约（issue #9 低成本硬化 → issue #31 收敛）：
    /// 库媒体自 issue #26、项目媒体自 issue #31 起均走 `pwmedia` 自定义协议
    /// 按 scope + id 逐请求解析——asset 协议失去全部消费者，必须停用且授权
    /// 面为空，控制文件（project.json/library.json）与其余本机路径不可经
    /// 协议触达（数据模型 §7.1）。媒体 URL 仅由 projectAssets/libraryStore
    /// 两条管线合成。
    #[test]
    fn asset_protocol_is_disabled_with_empty_scope() {
        let conf = load_conf();
        let protocol = conf
            .pointer("/app/security/assetProtocol")
            .and_then(Value::as_object)
            .expect("app.security.assetProtocol 缺失");
        assert_eq!(
            protocol.get("enable").and_then(Value::as_bool),
            Some(false),
            "assetProtocol 必须停用：项目/库媒体已全部收敛至 pwmedia 协议（issue #26/#31），保留开启只会扩大本机路径直读面"
        );
        let scope = protocol
            .get("scope")
            .and_then(Value::as_array)
            .expect("app.security.assetProtocol.scope 缺失");
        assert!(
            scope.is_empty(),
            "assetProtocol.scope 必须为空：任何残留条目都会让对应子树协议可达（数据模型 §7.1，issue #9/#26/#31）"
        );
    }

    /// 主窗口能力集必须授予 `core:window:allow-destroy`（issue #76）：
    /// `useExitFlush` 注册 `onCloseRequested` 后，原生关闭一律被
    /// `prevent_close` 拦截、由 JS 决断；未阻止路径调用 `destroy()`，
    /// 该权限不在 `core:window:default` 内，缺失即点击关闭按钮被静默
    /// 吞掉。前端测试 mock 掉 Tauri API 无法发现此缺陷。
    #[test]
    fn main_window_capability_grants_window_destroy() {
        let caps = load_main_capability();
        let permissions = caps
            .get("permissions")
            .and_then(Value::as_array)
            .expect("capabilities/default.json permissions 缺失");
        assert!(
            permissions
                .iter()
                .filter_map(Value::as_str)
                .any(|p| p == "core:window:allow-destroy"),
            "capabilities/default.json 必须显式授予 core:window:allow-destroy：\
             core:window:default 只含查询权限，缺失时 onCloseRequested 拦截原生关闭后 \
             destroy() 被 ACL 拒绝，窗口永远无法经关闭按钮关闭（issue #76）"
        );
    }
}
