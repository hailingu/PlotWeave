//! `pwmedia` opaque asset URL 媒体协议的回归测试（issue #26：relPath 与本机
//! 绝对路径不出 Rust）：URL 形状、URI 解析白名单、scope 校验、按当前净化索引
//! 读字节、冲突期/符号链接/投毒条目拒绝服务、并发读取闸门与许可生命周期、
//! 404 折叠诊断可见性。自 `library/tests.rs` 拆出以符合源文件 800 行上限
//! （评审修复，PR #32 第六轮）。

use super::*;
use crate::store::new_id;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// 测试组合助手：等价协议处理器的两阶段（锁内打开 + 锁外读取）；许可
/// 随元组返回后立即丢弃（测试不持有交付）。
fn media_read(library: &CapDir, id: &str) -> Result<(String, Vec<u8>), String> {
    open_media_with(library, id)
        .and_then(|(mime, file)| read_media_capped(id, mime, file))
        .map(|(mime, bytes, _permit)| (mime, bytes))
}

/// 测试内核的受信句柄：对临时目录做环境打开（等价生产端锚定句柄）。
fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

/// 唯一临时根：`{tmp}/pw-library-test-{new_id}/` 下含 `library/assets/`；
/// 返回 (library, root)——root 供库外受害者文件与清理。
fn temp_fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-library-test-{}", new_id()));
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时库目录");
    (root.join("library"), root)
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 直接按字节写脏索引（绕过写入内核，模拟手工修改/损坏的 library.json）。
fn write_index_raw(library: &Path, index: &Value) {
    let mut f = fs::File::create(library.join("library.json")).expect("创建索引文件");
    use std::io::Write as _;
    f.write_all(serde_json::to_string(index).expect("序列化").as_bytes())
        .expect("写入索引");
}

/// 最小索引条目（relPath 按需投毒）。
fn entry(id: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "other",
        "mime": "image/png",
        "relPath": rel,
    })
}

/// 按字符串解析 http::Uri 的测试助手。
fn media_uri(s: &str) -> tauri::http::Uri {
    s.parse().expect("测试 URI 应可解析")
}

/// 直接按字节写删除日志（模拟中断的删除事务）。
fn write_journal_raw(library: &Path, entries: Value) {
    fs::write(
        library.join(crate::library_journal::JOURNAL_FILE_NAME),
        serde_json::to_string(&entries).expect("序列化日志"),
    )
    .expect("写入日志");
}

/// opaque URL 只含逻辑 scope + assetId：不携带 relPath 与本机绝对路径。
#[test]
fn opaque_media_url_carries_scope_and_id_only() {
    let url = opaque_media_url("la-1");
    assert!(url.ends_with("/library/la-1"), "意外 URL：{url}");
    assert!(url.starts_with("pwmedia"), "意外 scheme：{url}");
    assert!(!url.contains("/assets/"), "URL 不得携带 relPath：{url}");
    assert!(
        !url.contains("/Users/") && !url.contains("AppData"),
        "URL 不得携带本机路径：{url}"
    );
}

/// 协议请求解析：仅接受 `/library/{assetId}` 单段形式；id 字符集白名单
/// 天然拒绝百分号编码与其他 scope。
#[test]
fn parse_media_uri_accepts_only_library_scope() {
    assert_eq!(
        parse_media_uri(&media_uri("pwmedia://localhost/library/la-1")).as_deref(),
        Ok("la-1")
    );
    // Windows/Android 的 http 网关形状解析出同一资产 id
    assert_eq!(
        parse_media_uri(&media_uri("http://pwmedia.localhost/library/la-2")).as_deref(),
        Ok("la-2")
    );
    assert!(parse_media_uri(&media_uri("pwmedia://localhost/project/la-1")).is_err());
    assert!(parse_media_uri(&media_uri("pwmedia://localhost/library/")).is_err());
    assert!(parse_media_uri(&media_uri("pwmedia://localhost/library/a/b")).is_err());
    assert!(parse_media_uri(&media_uri("pwmedia://localhost/library/..%2Fevil")).is_err());
    assert!(parse_media_uri(&media_uri("pwmedia://localhost/library/assets/la-1.png")).is_err());
}

/// scope 白名单：命令面只接受 `{"kind":"library"}` 精确形状；目录/路径
/// 字符串与项目 scope 一律拒绝（项目 opaque 协议迁移另行落地）。
#[test]
fn media_scope_accepts_only_exact_library_shape() {
    assert!(validate_media_scope(&json!({ "kind": "library" })).is_ok());
    assert!(
        validate_media_scope(&json!({ "kind": "project", "projectId": "p-1" })).is_err(),
        "项目 scope 尚未迁移，须显式拒绝"
    );
    assert!(validate_media_scope(&json!({ "kind": "library", "dir": "/etc" })).is_err());
    assert!(validate_media_scope(&json!("/library")).is_err());
}

/// 绿路径：open_media_with 按当前净化索引解析 id，经句柄链读到字节。
#[test]
fn media_bytes_serves_indexed_asset() {
    let (library, root) = temp_fixture();
    let e = put_asset_with(
        &cap(&library),
        "立绘.png",
        "image/png",
        "character",
        b"PNGDATA",
    )
    .expect("导入应成功");
    let id = e["id"].as_str().expect("id 缺失");
    let (mime, bytes) = media_read(&cap(&library), id).expect("媒体读取应成功");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"PNGDATA");
    cleanup(&root);
}

/// 未知 id 与被隔离的投毒条目（脏 relPath）都拒绝服务。
#[test]
fn media_bytes_refuses_unknown_or_poisoned_entries() {
    let (library, root) = temp_fixture();
    put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    assert!(media_read(&cap(&library), "la-missing").is_err());
    // relPath 指向索引自身的投毒条目在净化读取时被隔离 → 按不存在拒绝
    write_index_raw(
        &library,
        &json!({
            "assets": [
                entry("la-1", "assets/la-1.png"),
                entry("la-evil", "library.json"),
            ],
            "groups": [],
        }),
    );
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体");
    assert!(media_read(&cap(&library), "la-evil").is_err());
    cleanup(&root);
}

/// 冲突期条目（隔离项身份不符）拒绝媒体服务——issue #25 语义在 opaque
/// 协议下延续，且不再依赖前端传入 relPath 复核。
#[test]
fn media_bytes_refuses_conflicted_asset() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        library.join("assets").join(".trash").join("t-x"),
        b"SWAPPED",
    )
    .expect("写身份不符的隔离项");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    write_journal_raw(
        &library,
        json!([{
            "id": "t-1",
            "assetId": "la-1",
            "relPath": "assets/la-1.png",
            "identity": { "dev": 1, "ino": 1 },
            "trashName": "assets/.trash/t-x",
        }]),
    );
    let err = media_read(&cap(&library), "la-1").expect_err("冲突期应拒绝");
    assert!(err.contains("冲突期"), "意外诊断：{err}");
    cleanup(&root);
}

/// 终点为符号链接（评审修复）：读取侧最终组件必须 no-follow 拒绝，不得
/// 把链外目标当作媒体返回——复用 open_library_asset 的拒绝 + 身份绑定。
#[cfg(unix)]
#[test]
fn media_bytes_refuses_symlinked_final_component() {
    let (library, root) = temp_fixture();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("建链外目录");
    fs::write(outside.join("victim.png"), b"VICTIM").expect("写链外目标文件");
    std::os::unix::fs::symlink(
        &outside.join("victim.png"),
        library.join("assets").join("la-1.png"),
    )
    .expect("建指向链外的符号链接");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    let err = media_read(&cap(&library), "la-1").expect_err("符号链接终点应拒绝");
    assert!(err.contains("符号链接"), "意外诊断：{err}");
    assert_eq!(
        fs::read(outside.join("victim.png")).expect("链外目标文件必须幸存"),
        b"VICTIM"
    );
    cleanup(&root);
}

/// 并发媒体读取闸门（评审修复）：并发读取数受上限约束，释放后可复用——
/// 防多数近 20 MiB 大图同时进视口时的 N×20 MiB 瞬时缓冲峰值。
#[test]
fn media_read_gate_bounds_concurrent_reads() {
    let gate = MediaReadGate::new(2);
    let a = gate.try_acquire().expect("第一个许可应可获取");
    let b = gate.try_acquire().expect("第二个许可应可获取");
    assert!(gate.try_acquire().is_none(), "超出并发上限应拒绝");
    drop(b);
    let c = gate.try_acquire().expect("释放后应可再获取");
    drop(a);
    drop(c);
    assert!(gate.try_acquire().is_some(), "全部释放后应可获取");
}

/// 许可生命周期覆盖交付（评审修复，PR #32 第五轮）：read_media_capped
/// 返回时许可不得释放，而是随响应体交还调用方、由调用方在响应交付
/// （responder.respond）后才丢弃——否则等待中的读者会在先前响应体仍待
/// 交付/消费时分配新缓冲，4×20 MiB 峰值契约不成立。
#[test]
fn media_read_permit_survives_until_caller_releases() {
    let gate = MediaReadGate::new(1);
    let (library, root) = temp_fixture();
    let e =
        put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    let id = e["id"].as_str().expect("id 缺失").to_string();
    let (mime, file) = open_media_with(&cap(&library), &id).expect("锁内打开应成功");
    let (mime, bytes, permit) = read_media_capped_in(&gate, &id, mime, file).expect("读取应成功");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"A");
    // 读取函数已返回，但许可仍由调用方持有：上限 1 时其余读者不得进入
    assert!(
        gate.try_acquire().is_none(),
        "响应交付前许可不得随读取函数返回而释放"
    );
    // 调用方在交付后释放，等待中的读者方可复用
    drop(permit);
    assert!(gate.try_acquire().is_some(), "调用方释放后许可应可复用");
    cleanup(&root);
}

/// 锁外消费已绑定句柄（评审修复，锁作用域收窄）：open_media_with 在锁内
/// 返回身份绑定句柄后，即便媒体随即被删除事务移走，read_media_capped 仍
/// 从已打开句柄读到内容——字节读取不依赖也不需要库锁。
#[cfg(unix)]
#[test]
fn media_read_consumes_identity_bound_handle_outside_locks() {
    let (library, root) = temp_fixture();
    let e =
        put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    let id = e["id"].as_str().expect("id 缺失").to_string();
    let (mime, file) = open_media_with(&cap(&library), &id).expect("锁内打开应成功");
    assert_eq!(mime, "image/png");
    let rel = e["relPath"].as_str().expect("relPath 缺失");
    fs::remove_file(library.join(rel)).expect("模拟删除事务已提交");
    let (mime, bytes, _permit) = read_media_capped(&id, mime, file).expect("锁外读取应成功");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"A");
    cleanup(&root);
}

/// 404 折叠不得隐匿失败（评审修复）：后端诊断文本带 `[library]` 标签并
/// 携带原始原因，脏数据与普通缺失可区分；webview 侧仍只收非敏感 404。
#[test]
fn media_failure_diagnostic_carries_cause_with_label() {
    let text = media_failure_diagnostic("资产 la-1 的媒体文件不存在");
    assert!(text.starts_with("[library]"), "诊断须带模块标签：{text}");
    assert!(text.contains("la-1"), "诊断须携带原始原因：{text}");
    // 响应映射保持非敏感：404 正文仍为固定文案
    let miss = media_http_response(Err("资产 la-1 处于删除事务冲突期，媒体不可用".into()));
    assert_eq!(miss.status(), tauri::http::StatusCode::NOT_FOUND);
    let body = String::from_utf8(miss.into_body()).expect("404 正文是 UTF-8");
    assert_eq!(body, "媒体不可用", "404 正文不得携带原因");
}

/// 响应映射：命中 → 200 + 索引 mime；任何失败 → 404（不向 webview 泄露
/// 错误种类）。
#[test]
fn media_response_maps_hit_and_miss() {
    let (library, root) = temp_fixture();
    let e =
        put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    let id = e["id"].as_str().expect("id 缺失");
    let hit = media_http_response(media_read(&cap(&library), id));
    assert_eq!(hit.status(), tauri::http::StatusCode::OK);
    assert_eq!(
        hit.headers()
            .get(tauri::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    let miss = media_http_response(media_read(&cap(&library), "la-missing"));
    assert_eq!(miss.status(), tauri::http::StatusCode::NOT_FOUND);
    cleanup(&root);
}
