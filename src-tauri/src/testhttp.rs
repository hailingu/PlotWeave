//! 本地 HTTP 测试夹具（仅测试编译）：环回一次性 TCP 服务器，供不经
//! 公网的 HTTP 行为测试（`http_util` 限读分类、`prefs::chat_completion`
//! 传输路径等）驱动真实 reqwest 客户端。生产代码不得引用本模块。

use std::io::Read;
use std::net::TcpStream;

/// 环回一次性 TCP 服务器：接受一次连接后按给定脚本处理（丢弃请求、
/// 写出响应、可保持连接模拟慢速/挂起）。返回基址。强制 NO_PROXY 环回
/// 直连，防环境代理劫持夹具流量。
pub(crate) fn spawn_local_http(handler: impl FnOnce(TcpStream) + Send + 'static) -> String {
    std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定环回端口");
    let port = listener.local_addr().expect("读取端口").port();
    std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            handler(stream);
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// 请求体积小于缓冲：尽力读一次即丢弃，防客户端写端阻塞。
pub(crate) fn drain_request(stream: &mut TcpStream) {
    let mut buf = [0u8; 8192];
    let _ = stream.read(&mut buf);
}
