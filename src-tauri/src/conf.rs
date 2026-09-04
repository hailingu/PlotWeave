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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn load_conf() -> Value {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .expect("读取 tauri.conf.json 失败");
        serde_json::from_str(&raw).expect("tauri.conf.json 不是合法 JSON")
    }

    fn asset_protocol_scope(conf: &Value) -> Vec<String> {
        conf.pointer("/app/security/assetProtocol/scope")
            .and_then(Value::as_array)
            .expect("app.security.assetProtocol.scope 缺失")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
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

    /// projects 树的 scope 只能授权专用资产子目录 `projects/*/assets/`
    ///（issue #9：媒体 URL 仅由 projectAssets 经 project_asset_path 校验
    /// 后合成，宽 glob 会让 project.json 等非资产文件也协议可达）。
    #[test]
    fn asset_protocol_scope_limits_projects_to_asset_subtrees() {
        let scope = asset_protocol_scope(&load_conf());
        let projects: Vec<&str> = scope
            .iter()
            .map(String::as_str)
            .filter(|s| s.starts_with("$APPDATA/projects"))
            .collect();
        assert!(
            !projects.is_empty(),
            "assetProtocol.scope 缺少 projects 资产子目录授权：缩略图媒体协议不可用"
        );
        assert!(
            projects
                .iter()
                .all(|s| s.starts_with("$APPDATA/projects/*/assets/")),
            "projects 相关 scope 只能授权 $APPDATA/projects/*/assets/ 下的专用资产子目录（数据模型 §7.1，issue #9）：{projects:?}"
        );
    }

    /// library 树的 scope 只能授权专用资产子目录 `library/assets/`
    ///（与 projects 同根因：library.json 与删除日志不得协议可达）。
    #[test]
    fn asset_protocol_scope_limits_library_to_asset_subtrees() {
        let scope = asset_protocol_scope(&load_conf());
        let library: Vec<&str> = scope
            .iter()
            .map(String::as_str)
            .filter(|s| s.starts_with("$APPDATA/library"))
            .collect();
        assert!(
            !library.is_empty(),
            "assetProtocol.scope 缺少 library 资产子目录授权：库媒体协议不可用"
        );
        assert!(
            library
                .iter()
                .all(|s| s.starts_with("$APPDATA/library/assets/")),
            "library 相关 scope 只能授权 $APPDATA/library/assets/ 下的专用资产子目录（数据模型 §7.1，issue #9）：{library:?}"
        );
    }
}
