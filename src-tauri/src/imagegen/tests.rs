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

#[test]
fn cancel_flags_register_and_clear() {
    let job = format!("job-{}", crate::store::new_id());
    assert!(!is_cancelled(&job));
    // 与并行的中毒恢复用例共存（PR #219 评审）：静态表可能被并行
    // 用例注入中毒，本用例的直接访问同样走恢复路径，保持套件确定性
    crate::lock::recover_guard(cancelled_jobs().lock(), "生成取消登记表").insert(job.clone());
    assert!(is_cancelled(&job));
    clear_cancel(&job);
    assert!(!is_cancelled(&job));
}

#[test]
fn cancel_registry_recovers_after_poison() {
    // [issue #145](https://github.com/hailingu/PlotWeave/issues/145)：
    // 取消表中毒恢复——持锁 panic 后，取消登记真实生效才报成功
    // （不静默忽略却报成功），is_cancelled 如实回答。静态表此后保持
    // 中毒状态，后续用例经同一恢复路径照常工作（透明恢复）
    let job = format!("job-{}", crate::store::new_id());
    std::thread::spawn(|| {
        let _guard = cancelled_jobs().lock().expect("先取得锁");
        panic!("测试注入的持锁 panic");
    })
    .join()
    .expect_err("注入 panic 应发生");
    llm_image_cancel(job.clone()).expect("中毒后取消登记仍应成功");
    assert!(is_cancelled(&job), "中毒后取消登记须真实生效");
    clear_cancel(&job);
    assert!(!is_cancelled(&job), "中毒后清理须照常");
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
    let err = tauri::async_runtime::block_on(generate_image_bytes(
        "not-a-url",
        "sk-FICTITIOUS",
        &body,
        "job-1",
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
