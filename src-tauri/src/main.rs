// 调试构建之外使用 Windows 子系统，避免发布版本弹出控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    plotweave_lib::run();
}
