//! 设置与 provider 请求的既有单元测试；独立模块保持生产入口的职责与规模。

use super::*;
use crate::testhttp::{drain_request, spawn_local_http};
use std::fs;
use std::io::Write;

#[test]
fn provider_id_rules() {
    assert!(validate_provider_id("openai").is_ok());
    assert!(validate_provider_id("volcengine-ark").is_ok());
    assert!(validate_provider_id("").is_err());
    assert!(validate_provider_id("a/b").is_err());
    assert!(validate_provider_id(&"x".repeat(65)).is_err());
}

#[test]
fn chat_defense_limits_meet_issue_baseline() {
    // issue #15 验收基线：对话为非流式补全（长回复、慢模型），超时
    // 不低于 120s；主响应是纯 JSON 文本（无 base64 图像膨胀），上限
    // 无需 64 MiB，按对话 JSON 合理放宽（16 MiB 量级）。
    // 编译期断言（const block）：基线失守即编译失败，强于运行时测试。
    const { assert!(CHAT_REQUEST_TIMEOUT_SECS >= 120) };
    const { assert!(CHAT_RESPONSE_BODY_MAX_BYTES >= 1024 * 1024) };
    const { assert!(CHAT_RESPONSE_BODY_MAX_BYTES <= 16 * 1024 * 1024) };
}

// ---- issue #120：load_prefs 读取失败分类（read_prefs_at 内核） ----

/// 唯一临时目录：`{tmp}/pw-prefs-test-{new_id}-{tag}/`。
fn temp_prefs_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pw-prefs-test-{}-{tag}", crate::store::new_id()));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

#[test]
fn read_prefs_in_missing_file_is_first_launch_empty_object() {
    // 首次启动语义仅此一例：文件不存在 → Ok 空对象（前端补默认）
    let dir = temp_prefs_dir("missing");
    let v = read_prefs_in(&dir).expect("缺文件应 Ok 空对象");
    assert_eq!(v, serde_json::json!({}));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_prefs_in_reads_valid_file() {
    let dir = temp_prefs_dir("valid");
    fs::write(
        dir.join("settings.json"),
        r#"{"defaultChat":"openai:gpt-4o"}"#,
    )
    .expect("写入设置");
    let v = read_prefs_in(&dir).expect("合法文件应 Ok");
    assert_eq!(v["defaultChat"], "openai:gpt-4o");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_prefs_in_rejects_corrupt_json() {
    let dir = temp_prefs_dir("corrupt");
    fs::write(dir.join("settings.json"), "{ not json").expect("写入损坏设置");
    let err = read_prefs_in(&dir).expect_err("损坏 JSON 应 Err");
    assert!(err.contains("设置文件损坏"), "实际错误：{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_prefs_in_rejects_oversize_file() {
    let dir = temp_prefs_dir("oversize");
    fs::write(dir.join("settings.json"), vec![b'x'; PREFS_MAX_BYTES + 1]).expect("写入超限设置");
    let err = read_prefs_in(&dir).expect_err("超限应 Err");
    assert!(err.contains("设置文件过大"), "实际错误：{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_prefs_in_rejects_directory_settings() {
    // settings.json 为目录（issue #391 非普通条目之一）：归类拒绝且
    // 不得降级为空对象——首启语义专属 NotFound（issue #120）
    let dir = temp_prefs_dir("dir-target");
    fs::create_dir(dir.join("settings.json")).expect("创建目录条目");
    let err = read_prefs_in(&dir).expect_err("非 NotFound 读取失败应 Err");
    assert!(err.contains("非普通文件"), "实际错误：{err}");
    let _ = fs::remove_dir_all(&dir);
}

// ---- issue #147：设置读取的受限物化（cap+1 流式限读） ----

/// 无尽字节源：记录被拉取总量，供「超限拒绝前读取有界」断言。
struct EndlessReader {
    pulled: usize,
}

impl io::Read for EndlessReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        buf.fill(0);
        self.pulled += buf.len();
        Ok(buf.len())
    }
}

#[test]
fn capped_read_rejects_oversize_without_materializing() {
    // 超限拒绝必须发生在有限读取之后：从无尽源流拉取的字节数不得
    // 超过上限+1，不得先物化全量内容再判断长度（issue #147）
    let mut src = EndlessReader { pulled: 0 };
    let result = capped_prefs_text(&mut src);
    assert!(
        matches!(result, Err(PrefsReadError::TooLarge)),
        "超限应拒绝，实际：{result:?}"
    );
    assert!(
        src.pulled <= PREFS_MAX_BYTES + 1,
        "读取应有界于 cap+1：pulled={}",
        src.pulled
    );
}

#[test]
fn capped_read_maps_invalid_utf8_to_read_failure() {
    // 与 fs::read_to_string 同分类：非法 UTF-8 归为读取失败
    //（InvalidData）——load_prefs 的「读取设置失败」诊断与
    // provider_secret 的钥匙串回退语义不因实现替换而改变
    let bytes = [0xff, 0xfe, 0x00, 0x61];
    let result = capped_prefs_text(bytes.as_slice());
    match result {
        Err(PrefsReadError::Io(e)) => {
            assert_eq!(e.kind(), io::ErrorKind::InvalidData, "实际错误：{e}")
        }
        other => panic!("非法 UTF-8 应归类为读取失败，实际：{other:?}"),
    }
}

// ---- issue #279：凭据阶段离开异步工作线程 ----

#[test]
fn slow_credential_phase_keeps_async_siblings_responsive() {
    // 凭据准备（目录确保、受限读取、密文解析、历史钥匙串回退）是
    // 完整同步工作，须离开异步工作线程：受控 400ms 延迟模拟慢凭据
    // 来源，单线程异步运行时上的兄弟任务（计时器 + 经阻塞调度的
    // 同步读）必须在凭据阶段保持响应；凭据未完成前不得提前报告
    // 结果；领域错误原样上浮。HTTP 只在凭据成功后发出，本测试以
    // 错误终止，不触网。
    let dir = temp_prefs_dir("slow-credential");
    let sibling_target = dir.join("sibling.json");
    fs::write(&sibling_target, r#"{"providers":[]}"#).expect("写入兄弟读取目标");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("构建单线程运行时");
    let start = std::time::Instant::now();
    let credential = runtime.spawn(chat_credential(|| {
        std::thread::sleep(std::time::Duration::from_millis(400));
        Err("未配置 API key，请在设置页填写".to_string())
    }));
    let (latency, sibling_text, finished) = runtime.block_on(async {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let sibling_text = crate::blocking::run("sibling-read", move || {
            fs::read_to_string(&sibling_target).map_err(|e| e.to_string())
        })
        .await
        .expect("兄弟同步读应成功");
        (start.elapsed(), sibling_text, credential.is_finished())
    });
    let error = runtime
        .block_on(credential)
        .expect("凭据任务应完成")
        .expect_err("受控延迟后应携带领域错误");
    let _ = fs::remove_dir_all(&dir);
    println!("slow-credential: sibling latency={latency:?}, delay=400ms");
    assert!(
        latency < std::time::Duration::from_millis(200),
        "兄弟任务被凭据阶段阻塞：{latency:?}"
    );
    assert!(!finished, "凭据未完成前不得提前报告结果");
    assert_eq!(sibling_text, r#"{"providers":[]}"#);
    assert_eq!(error, "未配置 API key，请在设置页填写");
}

#[test]
fn chat_completion_returns_choices0_message_over_local_http() {
    // 本地 HTTP 夹具与请求排空助手已抽至 `crate::testhttp`（http_util
    // 的分类测试与本模块的传输路径测试共用，避免两份实现漂移）。
    let payload = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": "你好" } }]
    })
    .to_string();
    let base_url = spawn_local_http(move |mut stream| {
        drain_request(&mut stream);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        );
        let _ = stream.write_all(response.as_bytes());
    });
    let result = tauri::async_runtime::block_on(chat_completion(
        &base_url,
        "test-model",
        serde_json::json!([{ "role": "user", "content": "hi" }]),
        None,
        "sk-test",
        30,
    ));
    assert_eq!(result.expect("应返回 message 对象")["content"], "你好");
}

#[test]
fn chat_completion_rejects_oversize_body_from_local_http() {
    // 超 16 MiB 上限一字节：流式限读须在物化前拒绝（评审第 2 条行为
    // 回归测试——常量必须真实作用于传输路径）
    let total = CHAT_RESPONSE_BODY_MAX_BYTES + 1;
    let base_url = spawn_local_http(move |mut stream| {
        drain_request(&mut stream);
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {total}\r\n\r\n"
        );
        let _ = stream.write_all(header.as_bytes());
        let chunk = vec![b'a'; 65536];
        let mut sent = 0usize;
        while sent < total {
            let n = total.saturating_sub(sent).min(chunk.len());
            // 客户端在超限处断开：写端报错即终止，不阻塞线程
            if stream.write_all(&chunk[..n]).is_err() {
                break;
            }
            sent += n;
        }
    });
    let result = tauri::async_runtime::block_on(chat_completion(
        &base_url,
        "test-model",
        serde_json::json!([{ "role": "user", "content": "hi" }]),
        None,
        "sk-test",
        30,
    ));
    let err = result.expect_err("超限响应应被拒绝");
    assert!(err.to_string().contains("响应体超过"), "实际错误：{err}");
    assert!(
        err.to_string()
            .contains(&CHAT_RESPONSE_BODY_MAX_BYTES.to_string()),
        "实际错误：{err}"
    );
}

#[test]
fn chat_completion_classifies_body_read_timeout() {
    // 只写响应头并保持连接：模拟 provider 回完 headers 后慢速滴流/
    // 挂起——总超时在响应体读取阶段触发，错误必须保留超时分类
    // （评审第 1 条）
    let base_url = spawn_local_http(move |mut stream| {
        drain_request(&mut stream);
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n",
        );
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
    let result = tauri::async_runtime::block_on(chat_completion(
        &base_url,
        "test-model",
        serde_json::json!([{ "role": "user", "content": "hi" }]),
        None,
        "sk-test",
        1,
    ));
    let err = result.expect_err("挂起的响应体应超时");
    // 限读超时经 Body 透传（#45 首片类型），类别与文案均可区分
    assert!(
        matches!(
            err,
            ProxyError::Body(crate::http_util::ReadBodyError::ReadTimeout(_))
        ),
        "实际错误：{err:?}"
    );
    assert!(
        err.to_string().starts_with("读取响应超时"),
        "实际错误：{err}"
    );
}

#[test]
fn chat_completion_classifies_send_phase_timeout() {
    // 收到请求后不回任何字节：总超时在 send 阶段触发
    let base_url = spawn_local_http(move |mut stream| {
        drain_request(&mut stream);
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
    let result = tauri::async_runtime::block_on(chat_completion(
        &base_url,
        "test-model",
        serde_json::json!([{ "role": "user", "content": "hi" }]),
        None,
        "sk-test",
        1,
    ));
    let err = result.expect_err("不回包应超时");
    // 发送阶段超时为独立类别（issue #144 代理分片）
    assert!(
        matches!(err, ProxyError::SendTimeout { .. }),
        "实际错误：{err:?}"
    );
    assert!(err.to_string().starts_with("请求超时"), "实际错误：{err}");
}

#[test]
fn chat_completion_redacts_key_echoed_in_status_body() {
    // [issue #149](https://github.com/hailingu/PlotWeave/issues/149)：
    // 网关/代理在错误正文回显请求密钥时，展示边界须把本次 API key
    // 替换为 ***（虚构 token）；状态码/类别文案与 200 字符摘录上限保留
    let key = "sk-FICTITIOUS-KEY";
    let body = format!("{{\"error\": \"invalid key {key} for model test-model\"}}");
    let base_url = spawn_local_http(move |mut stream| {
        drain_request(&mut stream);
        let response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes());
    });
    let result = tauri::async_runtime::block_on(chat_completion(
        &base_url,
        "test-model",
        serde_json::json!([{ "role": "user", "content": "hi" }]),
        None,
        key,
        30,
    ));
    let err = result.expect_err("500 应失败");
    assert!(
        matches!(err, ProxyError::Status { .. }),
        "实际错误：{err:?}"
    );
    let shown = err.to_string();
    assert!(
        !shown.contains("sk-FICTITIOUS-KEY"),
        "回显密钥不得进入诊断：{shown}"
    );
    assert!(shown.contains("***"), "密钥应替换为 ***：{shown}");
    assert!(shown.contains("服务返回 500"), "状态码与类别保留：{shown}");
}
