//! imagegen 命令面与下载链的回归测试（自 imagegen.rs 内联模块外置，
//! 维持源文件 ≤800 行，同 persist/list 的 tests.rs 模式）：作业总预算
//! 内核与各阶段门控（issue #141 及其 PR #220 两轮评审）、取消表中毒
//! 恢复（issue #145）、MIME 嗅探/b64 解码/url 成员、公网边界与下载
//! 目标静态校验。

use super::*;
use serde_json::json;

#[test]
fn sniff_matches_known_magics() {
    assert_eq!(
        sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A]),
        Some("image/png")
    );
    assert_eq!(
        sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
        Some("image/jpeg")
    );
    assert_eq!(
        sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
        Some("image/webp")
    );
    assert_eq!(sniff_image_mime(b"GIF89a\x01\x00"), Some("image/gif"));
    assert_eq!(sniff_image_mime(b"GIF87a\x01\x00"), Some("image/gif"));
    assert_eq!(sniff_image_mime(b"<html>not an image</html>"), None);
    assert_eq!(sniff_image_mime(b""), None);
}

#[test]
fn decode_b64_reads_data_member() {
    // "QUJD" = "ABC"
    let resp = json!({ "data": [{ "b64_json": "QUJD" }] });
    assert_eq!(decode_b64_image(&resp).as_deref(), Some(b"ABC".as_slice()));
    assert_eq!(decode_b64_image(&json!({ "data": [] })), None);
    assert_eq!(
        decode_b64_image(&json!({ "data": [{ "b64_json": 7 }] })),
        None
    );
    assert_eq!(
        decode_b64_image(&json!({ "data": [{ "b64_json": "!!!not-base64!!!" }] })),
        None
    );
}

#[test]
fn image_url_reads_string_member() {
    let resp = json!({ "data": [{ "url": "https://cdn.example.test/a.png" }] });
    assert_eq!(
        image_url_of(&resp).as_deref(),
        Some("https://cdn.example.test/a.png")
    );
    assert_eq!(image_url_of(&json!({ "data": [{}] })), None);
    assert_eq!(image_url_of(&json!({ "data": [{ "url": 42 }] })), None);
}

/// [issue #143](https://github.com/hailingu/PlotWeave/issues/143) 注册表
/// 状态观察夹具（子模块访问私有字段）。
fn tombstones_of(registry: &ImageJobRegistry) -> Vec<String> {
    crate::lock::recover_guard(registry.state.lock(), "生成作业注册表")
        .tombstones
        .iter()
        .cloned()
        .collect()
}

fn active_len_of(registry: &ImageJobRegistry) -> usize {
    crate::lock::recover_guard(registry.state.lock(), "生成作业注册表")
        .active
        .len()
}

/// 验收：未知 id 取消不无界增长——有界墓碑按 FIFO 淘汰、重复取消去重。
#[test]
fn unknown_id_cancels_are_bounded_and_deduped() {
    let registry = ImageJobRegistry::new();
    for i in 0..(CANCEL_TOMBSTONE_CAP * 2) {
        registry.cancel(&format!("ghost-{i}"));
    }
    let stones = tombstones_of(&registry);
    assert_eq!(
        stones.len(),
        CANCEL_TOMBSTONE_CAP,
        "墓碑按上限淘汰，不无界增长"
    );
    assert!(
        !stones.contains(&"ghost-0".to_string()),
        "最旧者被 FIFO 淘汰"
    );
    assert!(
        stones.contains(&format!("ghost-{}", CANCEL_TOMBSTONE_CAP * 2 - 1)),
        "最新者保留"
    );
    // 重复取消已在碑集的 id：去重，不产生第二份占位
    registry.cancel(&format!("ghost-{}", CANCEL_TOMBSTONE_CAP * 2 - 1));
    assert_eq!(tombstones_of(&registry).len(), CANCEL_TOMBSTONE_CAP);
}

/// 验收：预取消语义——先取消后登记在登记时生效（前端取消可早于命令
/// 登记）；墓碑被一次性消费；守卫 Drop（含错误路径）清理活动登记。
#[test]
fn pre_cancelled_job_registers_as_cancelled_and_cleans_on_drop() {
    let registry = ImageJobRegistry::new();
    registry.cancel("job-a");
    let registration = registry.register("job-a");
    assert!(registration.is_cancelled(), "预取消在登记时生效");
    assert!(
        !tombstones_of(&registry).contains(&"job-a".to_string()),
        "墓碑被登记消费"
    );
    drop(registration);
    assert_eq!(active_len_of(&registry), 0, "出口清理活动登记");
    let second = registry.register("job-a");
    assert!(!second.is_cancelled(), "墓碑一次性消费，复用不受旧取消影响");
}

/// 验收：作业中取消标记→检查点可见；出口（含错误路径 RAII）清理；
/// 迟到取消进有界墓碑并按预取消语义作用于复用 id；取消仍不能写回
/// 过时结果（登记守卫清理前任何写回路径都已带检查点）。
#[test]
fn cancel_during_job_marks_finish_cleans_and_late_cancel_bounds() {
    let registry = ImageJobRegistry::new();
    let registration = registry.register("job-b");
    assert!(!registration.is_cancelled());
    registry.cancel("job-b");
    assert!(registration.is_cancelled(), "作业中取消标记可见");
    drop(registration);
    assert_eq!(active_len_of(&registry), 0, "出口后活动表清空");
    // 迟到取消（作业已结束）：进有界墓碑；复用 id 时按预取消语义消费
    registry.cancel("job-b");
    let third = registry.register("job-b");
    assert!(third.is_cancelled(), "迟到取消按预取消语义作用于复用 id");
}

#[test]
fn request_body_omits_response_format() {
    // GPT Image 系（gpt-image-1 等）不接受 response_format（携带即
    // 400 unsupported parameter，生成前的主路径直接失败）
    let body = generation_request_body("gpt-image-1", "雨夜霓虹", "1024x1024");
    assert_eq!(
        body,
        json!({ "model": "gpt-image-1", "prompt": "雨夜霓虹", "size": "1024x1024" })
    );
    assert!(body.get("response_format").is_none());
}

#[test]
fn public_ip_allows_global_addresses() {
    for s in [
        "8.8.8.8",
        "1.1.1.1",
        "172.32.0.1",
        "100.128.0.1",
        "2606:4700::1111",
        "2400:cb00::1",
    ] {
        let ip: std::net::IpAddr = s.parse().expect(s);
        assert!(is_public_ip(ip), "{s} 应判定为公网");
    }
}

#[test]
fn public_ip_rejects_private_and_special_ranges() {
    for s in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "0.1.2.3",
        "100.64.0.1",
        "100.127.255.255",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "fe80::1",
        "fd00::1",
        "fc00::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:192.168.0.1",
    ] {
        let ip: std::net::IpAddr = s.parse().expect(s);
        assert!(!is_public_ip(ip), "{s} 应判定为非公网");
    }
}

#[test]
fn download_target_static_checks_reject_nonpublic_literals() {
    for s in [
        "http://127.0.0.1/a.png",
        "http://[::1]/a.png",
        "http://169.254.169.254/meta",
        "https://10.0.0.5/a.png",
        "ftp://8.8.8.8/a.png",
        "file:///etc/passwd",
    ] {
        let url: Url = s.parse().expect(s);
        assert!(static_target_violation(&url).is_some(), "{s} 应被静态拒绝");
    }
    // 公网 IP 字面量与域名（域名走解析复验，不在静态层拒绝）
    assert!(static_target_violation(&"https://8.8.8.8/a.png".parse().unwrap()).is_none());
    assert!(static_target_violation(&"http://cdn.example.test/a.png".parse().unwrap()).is_none());
}

#[test]
fn remaining_budget_bounds_job_stages() {
    let future = std::time::Instant::now() + std::time::Duration::from_secs(600);
    assert!(remaining_budget(future).is_some(), "未到期预算应可用");
    let past = std::time::Instant::now() - std::time::Duration::from_secs(1);
    assert!(remaining_budget(past).is_none(), "已过期预算应耗尽");
}

/// 前置阻塞消费预算（issue #141 评审）：凭据读取（同步阻塞访问）在
/// 预算耗尽后不得发起——过期截止时间下，阻塞闭包一次都不被调用，
/// 诊断标明读取凭据阶段。
#[test]
fn key_load_budget_gate_skips_blocking_access_when_expired() {
    let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let err = tauri::async_runtime::block_on(bounded_key_load(deadline, || {
        panic!("预算耗尽不得发起阻塞凭据访问")
    }))
    .expect_err("预算耗尽应拒绝");
    assert!(err.contains("总预算"), "实际诊断：{err}");
    assert!(err.contains("读取凭据"), "诊断应标明阶段：{err}");
}

/// 非零前置耗时后的过期用例（issue #141 评审）：预算已被前置工作
/// 耗尽时，生成 POST 不得发出（合法 URL 会产生计费请求，故以会快速
/// 失败的非法 URL 验证——修复前该用例落到 endpoint_url 解析错误，
/// 修复后在 POST 之前即按预算拒绝），诊断标明生成请求阶段。
#[test]
fn generate_request_budget_gate_precedes_post_when_expired() {
    let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let body = generation_request_body("m", "p", "1024x1024");
    let registry = ImageJobRegistry::new();
    let registration = registry.register("job-1");
    let err = tauri::async_runtime::block_on(generate_image_bytes(
        "not-a-url",
        "sk-FICTITIOUS",
        &body,
        &registration,
        deadline,
    ))
    .expect_err("预算耗尽应在 POST 前拒绝");
    assert!(err.contains("总预算"), "实际诊断：{err}");
    assert!(err.contains("生成请求"), "诊断应标明阶段：{err}");
}

/// 受控慢响应（issue #141）：挂起 future 与剩余预算赛跑——统一预算
/// 内核必须在预算耗尽时放弃等待并保留阶段标签；预算内的快 future 与
/// 自身错误原样透传（不过度介入）。
#[test]
fn with_stage_budget_times_out_hanging_future_and_labels_stage() {
    // 短预算（50ms）驱动超时路径：受控测试不等真实预算
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
    let started = std::time::Instant::now();
    let err = tauri::async_runtime::block_on(with_stage_budget(
        deadline,
        "测试阶段",
        std::future::pending::<Result<(), ProxyError>>(),
    ))
    .expect_err("挂起 future 应在预算耗尽时被放弃");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "预算内核应在短预算内放弃等待，实际等待 {:?}",
        started.elapsed()
    );
    assert!(
        matches!(
            err,
            ProxyError::JobBudgetExhausted {
                stage: "测试阶段",
                ..
            }
        ),
        "实际错误：{err:?}"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let ok = tauri::async_runtime::block_on(with_stage_budget(deadline, "测试阶段", async {
        Ok::<_, ProxyError>(7)
    }))
    .expect("预算内完成应透传");
    assert_eq!(ok, 7);
    let inner = tauri::async_runtime::block_on(with_stage_budget(deadline, "测试阶段", async {
        Err::<(), _>(ProxyError::InvalidResponse {
            detail: "内部错误".into(),
        })
    }))
    .expect_err("预算内的自身错误应原样透传");
    assert!(
        matches!(inner, ProxyError::InvalidResponse { .. }),
        "实际错误：{inner:?}"
    );
}

/// 作业总预算（issue #141）：预算已耗尽时，下载链在任何网络请求与
/// DNS 之前即拒绝（公网字面量目标，不触网）——产物无从产生，更不会
/// 写回；诊断标明阶段与总预算。
#[test]
fn download_chain_rejects_expired_budget_before_any_request() {
    let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let err = tauri::async_runtime::block_on(fetch_image_url("https://8.8.8.8/a.png", deadline))
        .expect_err("预算耗尽应拒绝");
    assert!(
        matches!(
            err,
            ProxyError::JobBudgetExhausted {
                stage: "下载图像",
                ..
            }
        ),
        "实际错误：{err:?}"
    );
    let shown = err.to_string();
    assert!(shown.contains("总预算"), "实际诊断：{shown}");
    assert!(shown.contains("下载图像"), "诊断应标明阶段：{shown}");
}

/// DNS 计数用例串行锁：在途计数是共享静态，跨用例交错会互相
/// 污染，本组用例串行执行（生产代码无此锁）。
static DNS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 轮询在途计数到达目标值（有界等待，防沉睡线程拖住套件）。
fn wait_in_flight(target: usize, timeout: std::time::Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if DNS_RESOLVE_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst) == target {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}

/// 有界解析（issue #141，PR #220 第四轮评审）：预算内解析通过在途
/// 计数立即归还（额度可恢复）；全程不占用 Tokio 阻塞池。
#[test]
fn dns_resolution_within_budget_passes_and_returns_capacity() {
    let _serial = crate::lock::recover_guard(DNS_TEST_LOCK.lock(), "DNS 测试锁");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let addrs = tauri::async_runtime::block_on(resolve_host_bounded_with(
        "cdn.example.test:443".into(),
        "cdn.example.test",
        deadline,
        |_t| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            Ok(vec!["8.8.8.8:443".parse().expect("地址")])
        },
    ))
    .expect("预算内解析应通过");
    assert_eq!(addrs.len(), 1);
    assert!(
        wait_in_flight(0, std::time::Duration::from_secs(2)),
        "解析返回即在途计数归还"
    );
}

/// 超时即放弃等待且泄漏被钉死在专用线程上限内（评审核心）：慢解析
/// 沉睡 200ms，50ms 预算超时返回；沉睡线程自行跑完并归还额度——
/// 等待者（recv_timeout）有界退出，不泄漏。
#[test]
fn dns_resolution_timeout_abandons_wait_and_recovers() {
    let _serial = crate::lock::recover_guard(DNS_TEST_LOCK.lock(), "DNS 测试锁");
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
    let started = std::time::Instant::now();
    let err = tauri::async_runtime::block_on(resolve_host_bounded_with(
        "cdn.example.test:443".into(),
        "cdn.example.test",
        deadline,
        |_t| {
            std::thread::sleep(std::time::Duration::from_millis(200));
            Ok(vec![])
        },
    ))
    .expect_err("慢解析应超时");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "等待有界：{:?}",
        started.elapsed()
    );
    assert!(
        matches!(
            err,
            ProxyError::JobBudgetExhausted {
                stage: "解析图像主机",
                ..
            }
        ),
        "实际错误：{err:?}"
    );
    assert!(
        wait_in_flight(0, std::time::Duration::from_secs(2)),
        "沉睡线程返回后额度归还"
    );
}

/// 在途到顶 fail-fast 且可恢复（评审核心）：两个挂起解析占满额度
/// （不再堆进共享阻塞池），第三个立即按「解析繁忙」拒绝、解析器
/// 零调用；挂起线程返回后额度归还、解析能力恢复。
#[test]
fn dns_resolver_busy_fails_fast_at_inflight_cap_and_recovers() {
    let _serial = crate::lock::recover_guard(DNS_TEST_LOCK.lock(), "DNS 测试锁");
    let slow = |_t: String| -> std::io::Result<Vec<std::net::SocketAddr>> {
        std::thread::sleep(std::time::Duration::from_millis(300));
        Ok(vec![])
    };
    tauri::async_runtime::block_on(async {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let _h1 = tauri::async_runtime::spawn(resolve_host_bounded_with(
            "a.example.test:443".into(),
            "a.example.test",
            deadline,
            slow,
        ));
        let _h2 = tauri::async_runtime::spawn(resolve_host_bounded_with(
            "b.example.test:443".into(),
            "b.example.test",
            deadline,
            slow,
        ));
        assert!(
            wait_in_flight(DNS_RESOLVE_MAX_IN_FLIGHT, std::time::Duration::from_secs(2)),
            "额度应被占满"
        );
        let err = resolve_host_bounded_with(
            "c.example.test:443".into(),
            "c.example.test",
            deadline,
            |_t| -> std::io::Result<Vec<std::net::SocketAddr>> {
                panic!("到顶 fail-fast 不得调用解析器")
            },
        )
        .await
        .expect_err("到顶应拒绝");
        assert!(
            matches!(err, ProxyError::DownloadRefused { .. }),
            "繁忙诊断为拒绝且可行动：{err:?}"
        );
        assert!(err.to_string().contains("繁忙"), "实际诊断：{err}");
        assert!(
            wait_in_flight(0, std::time::Duration::from_secs(2)),
            "挂起线程返回后额度归还"
        );
        resolve_host_bounded_with(
            "d.example.test:443".into(),
            "d.example.test",
            deadline,
            |_t| Ok(vec!["8.8.8.8:443".parse().expect("地址")]),
        )
        .await
        .expect("额度归还后解析应恢复");
    });
}

/// DNS 阶段预算门（issue #141）：预算耗尽时在解析器之前拒绝——
/// 不发起 spawn_blocking 解析（域名主机，静态层不拒绝）；诊断标明
/// 解析阶段。
#[test]
fn dns_budget_gate_precedes_resolver() {
    let deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let url: Url = "http://cdn.example.test/a.png".parse().expect("合法 url");
    let err = tauri::async_runtime::block_on(ensure_public_download_target(&url, deadline))
        .expect_err("预算耗尽应拒绝");
    assert!(
        matches!(
            err,
            ProxyError::JobBudgetExhausted {
                stage: "解析图像主机",
                ..
            }
        ),
        "实际错误：{err:?}"
    );
    let shown = err.to_string();
    assert!(shown.contains("解析图像主机"), "实际诊断：{shown}");
}

/// 超时诊断区分阶段（issue #141 验收）：三个阶段的预算耗尽诊断
/// 互不相同且都携带总预算。
#[test]
fn budget_exhausted_diagnostics_distinguish_stages() {
    let mk = |stage: &'static str| ProxyError::JobBudgetExhausted {
        stage,
        budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
    };
    let texts: Vec<String> = ["解析图像主机", "下载图像", "读取图像"]
        .iter()
        .map(|s| mk(s).to_string())
        .collect();
    assert_ne!(texts[0], texts[1], "不同阶段不得共享同一诊断");
    assert_ne!(texts[1], texts[2], "不同阶段不得共享同一诊断");
    for t in &texts {
        assert!(t.contains(&IMAGE_JOB_TOTAL_BUDGET_SECS.to_string()), "{t}");
    }
}

/// issue #308 的虚构标记：仅用于断言脱敏边界，绝不使用真实凭据形态。
const FICTITIOUS_QUERY_TOKEN: &str = "sk-FICTITIOUS-QUERY-MARKER";

/// 生图发送超时的最终错误出口（issue #308）：夹具接收连接后不回响应头，
/// post_json 以 1s 客户端超时（生产 300s 同一分类的缩短形态）取得真实
/// reqwest 发送超时，再经生成入口的出口映射转为前端诊断——自定义端点
/// base_url 带敏感 query 时，裸 reqwest Display 内嵌完整请求 URL，
/// #149 脱敏契约必须在生图出口同样成立：虚构标记与 query 整体剥离，
/// 类别前缀与主机可行动信息保留。
#[test]
fn generate_exit_send_timeout_redacts_sensitive_query() {
    let base_url = crate::testhttp::spawn_local_http(move |mut stream| {
        crate::testhttp::drain_request(&mut stream);
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
    let url = format!("{base_url}/v1?token={FICTITIOUS_QUERY_TOKEN}");
    let body = generation_request_body("m", "p", "1024x1024");
    let error = tauri::async_runtime::block_on(crate::provider_transport::post_json(
        &url,
        "images/generations",
        "sk-FICTITIOUS",
        &body,
        1,
    ))
    .expect_err("发送超时应失败");
    assert!(
        matches!(error, ProxyError::SendTimeout { secs: 1, .. }),
        "应分类为发送超时：{error:?}"
    );
    let text = generate_exit_text(error);
    assert!(
        !text.contains(FICTITIOUS_QUERY_TOKEN),
        "敏感 query 不得进入生图诊断：{text}"
    );
    assert!(!text.contains("token="), "query 应整体剥离：{text}");
    assert!(
        text.starts_with("请求失败："),
        "生图超时类别文案保留：{text}"
    );
    assert!(text.contains("127.0.0.1"), "主机可行动信息保留：{text}");
    assert!(
        text.contains("error sending request"),
        "发送阶段类别保留：{text}"
    );
}

/// 生图发送超时的无 query 对照（issue #308）：端点不含敏感成分时文本
/// 形态不变——脱敏不过度介入，主机与路径照常可见。
#[test]
fn generate_exit_send_timeout_keeps_plain_url_shape() {
    let base_url = crate::testhttp::spawn_local_http(move |mut stream| {
        crate::testhttp::drain_request(&mut stream);
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
    let url = format!("{base_url}/v1");
    let body = generation_request_body("m", "p", "1024x1024");
    let error = tauri::async_runtime::block_on(crate::provider_transport::post_json(
        &url,
        "images/generations",
        "sk-FICTITIOUS",
        &body,
        1,
    ))
    .expect_err("发送超时应失败");
    let text = generate_exit_text(error);
    assert!(
        text.starts_with("请求失败："),
        "生图超时类别文案保留：{text}"
    );
    assert!(
        text.contains("/v1/images/generations"),
        "路径可行动信息保留：{text}"
    );
    assert!(text.contains("127.0.0.1"), "主机可行动信息保留：{text}");
}

// --- 生图产物落盘的阻塞调度（issue #310）---

/// 落盘测试夹具：临时 projects 根 + 种子化项目控制文件；返回
/// (root, projects_path)——root 供断言与清理。
fn temp_projects_fixture(id: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-imagegen-persist-{}", crate::store::new_id()));
    std::fs::create_dir_all(&root).expect("创建临时 projects 目录");
    std::fs::write(root.join(format!("{id}.json")), b"{}").expect("写入项目控制文件");
    let projects = root.clone();
    (root, projects)
}

/// 单个落盘单元（与 persist_generated_asset 相同的调度与内核组合，
/// 句柄来源替换为测试夹具）：真实 blocking::run + 真实写内核 + 真实
/// 注册表取消查询。
fn persist_unit(
    projects_path: std::path::PathBuf,
    registry: std::sync::Arc<ImageJobRegistry>,
    job_id: String,
) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
    crate::blocking::run("llm_image_generate", move || {
        let projects = CapDir::open_ambient_dir(&projects_path, cap_std::ambient_authority())
            .expect("打开测试 projects 句柄");
        let pending = crate::assets::project_media::PendingProjectAssets::new();
        write_and_validate_generated_asset(
            &projects,
            &pending,
            &registry,
            &job_id,
            "p-1",
            b"generated-png-bytes",
            "image/png",
        )
    })
}

/// 真实锁竞争下兄弟异步任务仍可推进（issue #310 验收）：操作锁被他者
/// 持有 400ms 期间，32 个并发落盘单元（真实 blocking::run + 写内核）经
/// 阻塞执行等待锁，不占用异步工作线程——20ms 后完成的兄弟异步任务必须
/// 在锁仍被持有时落地；锁释放后全部单元落盘成功并通过 §9.3 校验。
/// K 取 32 ≫ 任意现实 worker 数：若落盘仍内联在异步任务上，等待期会
/// 钉死全部 worker，兄弟任务将拖延到锁释放之后。
#[test]
fn lock_contention_persist_leaves_async_workers_free() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-0");

    let holder = std::thread::spawn(|| {
        let _op = crate::store::projects_op_lock();
        std::thread::sleep(std::time::Duration::from_millis(400));
        // 先记录后释放：该时刻 ≤ 真实释放时刻，比较方向保守安全
        std::time::Instant::now()
    });

    let sibling_done = std::sync::Arc::new(std::sync::Mutex::new(None::<std::time::Instant>));
    let (units_ok, sibling_at) = tauri::async_runtime::block_on(async {
        let sibling = {
            let sibling_done = sibling_done.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                *sibling_done.lock().expect("兄弟任务账本") = Some(std::time::Instant::now());
            })
        };
        let mut handles = Vec::new();
        for _ in 0..32 {
            let unit = persist_unit(projects_path.clone(), registry.clone(), "job-0".to_string());
            handles.push(tauri::async_runtime::spawn(unit));
        }
        let mut results = Vec::new();
        for handle in handles {
            results.push(handle.await.expect("落盘单元不应 panic"));
        }
        sibling.await.expect("兄弟任务不应 panic");
        let sibling_at = sibling_done
            .lock()
            .expect("兄弟任务账本")
            .expect("兄弟任务应已记录完成时刻");
        (results, sibling_at)
    });
    let released_at = holder.join().expect("持锁线程应正常结束");
    drop(registration);

    for result in &units_ok {
        let asset = result.as_ref().expect("全部落盘单元应成功");
        assert!(
            asset
                .as_object()
                .is_some_and(|a| a["source"] == "generated"),
            "落盘单元应返回 source=generated 的项目级 AssetRef：{asset:?}"
        );
    }
    assert!(
        sibling_at < released_at,
        "兄弟异步任务应在锁仍被持有时推进（完成 {sibling_at:?} ≥ 释放 {released_at:?}）"
    );
    let _ = root;
}

/// 锁等待期间取消后不落盘（issue #310 验收）：取消登记发生在持锁窗口
/// 内，落盘单元拿到锁后的复验经托管注册表查询到取消——返回已取消，
/// 项目 assets 目录不创建（不留下不可达资产）；登记守卫保持到断言后，
/// 阻塞线程查询与命令侧检查点同一事实源。
#[test]
fn cancel_during_lock_wait_skips_disk_write() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-1");

    let holder = std::thread::spawn(|| {
        let _op = crate::store::projects_op_lock();
        std::thread::sleep(std::time::Duration::from_millis(300));
    });

    let unit_registry = registry.clone();
    let result = tauri::async_runtime::block_on(async {
        let unit = tauri::async_runtime::spawn(persist_unit(
            projects_path.clone(),
            unit_registry,
            "job-1".to_string(),
        ));
        // 单元此刻已在锁等待中；等待期间的取消必须在锁内复验被看见
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        registry.cancel("job-1");
        unit.await.expect("落盘单元不应 panic")
    });
    holder.join().expect("持锁线程应正常结束");
    drop(registration);

    let err = result.expect_err("锁等待期间的取消应拒绝落盘");
    assert!(err.contains("已取消"), "实际诊断：{err}");
    // 取消后连 assets 目录都不应创建；若存在则必须为空
    let dir = root.join("p-1").join("assets");
    assert!(
        !dir.exists()
            || std::fs::read_dir(&dir)
                .expect("读取 assets 目录")
                .next()
                .is_none(),
        "取消后不得写盘：{root:?}"
    );
}

/// 项目删除与生成写入仍串行，不能重建已删项目（issue #310 验收）：
/// 删除（控制文件移除，删除命令与落盘共用操作锁）发生在锁等待窗口内，
/// 落盘单元拿到锁后控制文件复验失败——返回项目不存在，不建项目目录。
#[test]
fn deleted_project_during_lock_wait_is_not_recreated() {
    let (root, projects_path) = temp_projects_fixture("p-1");
    let registry = std::sync::Arc::new(ImageJobRegistry::new());
    let registration = registry.register("job-1");

    let holder = std::thread::spawn(|| {
        let _op = crate::store::projects_op_lock();
        std::thread::sleep(std::time::Duration::from_millis(300));
    });

    let result = tauri::async_runtime::block_on(async {
        let unit = tauri::async_runtime::spawn(persist_unit(
            projects_path.clone(),
            registry.clone(),
            "job-1".to_string(),
        ));
        // 单元在锁等待中；删除在其关键区内移除控制文件（同一操作锁串行）
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        std::fs::remove_file(root.join("p-1.json")).expect("删除项目控制文件");
        unit.await.expect("落盘单元不应 panic")
    });
    holder.join().expect("持锁线程应正常结束");
    drop(registration);

    let err = result.expect_err("已删项目不得被写入重建");
    assert!(err.contains("项目不存在"), "实际诊断：{err}");
    assert!(
        !root.join("p-1").exists(),
        "不得替已删项目创建资产目录：{root:?}"
    );
}
