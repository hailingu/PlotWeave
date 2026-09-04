//! tauri.conf.json 的窗口契约守卫（仅测试）。
//!
//! 前端画布的全部拖放（设定集实体 §5、库资产 §7.3）基于 HTML5 DnD；
//! Tauri 默认 `dragDropEnabled: true` 会在 webview 层拦截拖拽会话，
//! 页面内 DOM 拖放整体失效（tauri-apps/tauri#14373/#6695）——该缺陷只
//! 在真实 webview 复现，前端 JSDOM 测试无法发现，故把「主窗口必须
//! 显式关闭原生拖放」固化为配置契约测试。本项目不用原生文件拖放
//! （资产导入走文件选择对话框），关闭无副作用。

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// 主窗口（label=main）必须显式 dragDropEnabled=false，否则页面内
    /// 拖放事件在到达 JS 前被 Tauri 原生拖放处理器吞掉。
    #[test]
    fn main_window_disables_native_drag_drop() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .expect("读取 tauri.conf.json 失败");
        let conf: Value = serde_json::from_str(&raw).expect("tauri.conf.json 不是合法 JSON");
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
}
