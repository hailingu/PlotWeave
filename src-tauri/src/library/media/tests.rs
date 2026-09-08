//! `pwmedia` opaque asset URL 媒体协议的回归测试（issue #26/#31：relPath 与
//! 本机绝对路径不出 Rust）：URL 形状、URI 解析白名单、scope 校验、按当前
//! 净化索引/项目文档读字节、冲突期/符号链接/投毒条目拒绝服务、并发读取
//! 闸门与许可生命周期、404 折叠诊断可见性。自 `library.rs` 拆出以符合源
//! 文件 800 行上限（评审修复，PR #32 第六轮）。

use super::*;
use crate::library::put_asset_with;
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

/// 项目 scope 的测试组合助手：等价协议处理器 project 分支的两阶段。
fn project_media_read(
    projects: &CapDir,
    project_id: &str,
    id: &str,
) -> Result<(String, Vec<u8>), String> {
    crate::assets::project_media::open_project_media_with(projects, project_id, id)
        .and_then(|(mime, file)| read_project_media_capped(id, mime, file))
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

/// 最小合法索引条目（目标 Record 形状，含 §7.2 必填 source/ISO createdAt；
/// relPath 按需投毒）。
fn entry(id: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": "x",
        "kind": "other",
        "mime": "image/png",
        "relPath": rel,
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 把最小条目数组包装为目标 Record 形状（`{"byId": {id: entry}}`）。
/// 接受数组字面量或 Vec（与 tests.rs 的 Vec 版语义同款，形状兼容现有调用点）。
fn by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
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

/// opaque URL 只含逻辑 scope + assetId：不携带 relPath 与本机绝对路径
/// （issue #31：项目 scope 同样只由 project id 与 assetId 构成）。
#[test]
fn opaque_media_url_carries_scope_and_id_only() {
    let lib = opaque_media_url(&MediaScope::Library, "la-1");
    assert!(lib.ends_with("/library/la-1"), "意外 URL：{lib}");
    assert!(lib.starts_with("pwmedia"), "意外 scheme：{lib}");
    assert!(!lib.contains("/assets/"), "URL 不得携带 relPath：{lib}");
    assert!(
        !lib.contains("/Users/") && !lib.contains("AppData"),
        "URL 不得携带本机路径：{lib}"
    );
    let proj = opaque_media_url(
        &MediaScope::Project {
            project_id: "p-1".into(),
        },
        "pa-1",
    );
    assert!(proj.ends_with("/project/p-1/pa-1"), "意外 URL：{proj}");
    assert!(proj.starts_with("pwmedia"), "意外 scheme：{proj}");
    assert!(!proj.contains("/assets/"), "URL 不得携带 relPath：{proj}");
    assert!(
        !proj.contains("/Users/") && !proj.contains("AppData"),
        "URL 不得携带本机路径：{proj}"
    );
}

/// 协议请求解析：接受 `/library/{assetId}` 单段与 `/project/{projectId}/
/// {assetId}` 两段形式（issue #31）；段数/字符集白名单天然拒绝百分号编码、
/// 越界段与其他 scope。
#[test]
fn parse_media_uri_accepts_library_and_project_scope() {
    assert_eq!(
        parse_media_uri(&media_uri("pwmedia://localhost/library/la-1")).expect("库 scope 应解析"),
        (MediaScope::Library, "la-1".to_string())
    );
    // Windows/Android 的 http 网关形状解析出同一资产 id
    assert_eq!(
        parse_media_uri(&media_uri("http://pwmedia.localhost/library/la-2"))
            .expect("库 scope 网关形状应解析"),
        (MediaScope::Library, "la-2".to_string())
    );
    assert_eq!(
        parse_media_uri(&media_uri("pwmedia://localhost/project/p-1/pa-1"))
            .expect("项目 scope 应解析"),
        (
            MediaScope::Project {
                project_id: "p-1".into()
            },
            "pa-1".to_string()
        )
    );
    assert_eq!(
        parse_media_uri(&media_uri("http://pwmedia.localhost/project/p-2/pa-2"))
            .expect("项目 scope 网关形状应解析"),
        (
            MediaScope::Project {
                project_id: "p-2".into()
            },
            "pa-2".to_string()
        )
    );
    for bad in [
        "pwmedia://localhost/project/p-1",
        "pwmedia://localhost/project/p-1/",
        "pwmedia://localhost/project/p-1/a/b",
        "pwmedia://localhost/project/../evil/pa-1",
        "pwmedia://localhost/project/p-1/..%2Fevil",
        "pwmedia://localhost/other/la-1",
        "pwmedia://localhost/library/",
        "pwmedia://localhost/library/a/b",
        "pwmedia://localhost/library/..%2Fevil",
        "pwmedia://localhost/library/assets/la-1.png",
    ] {
        assert!(
            parse_media_uri(&media_uri(bad)).is_err(),
            "应拒绝非法媒体请求路径：{bad}"
        );
    }
}

/// scope 白名单（§10.5 命令表）：只接受 `{"kind":"library"}` 与
/// `{"kind":"project","projectId"}` 精确形状——目录/路径字符串、缺 projectId、
/// 多余键与越界 projectId 一律拒绝。
#[test]
fn media_scope_accepts_exact_library_or_project_shapes() {
    assert!(parse_media_scope(&json!({ "kind": "library" })).is_ok());
    assert!(parse_media_scope(&json!({ "kind": "project", "projectId": "p-1" })).is_ok());
    for bad in [
        json!({ "kind": "project", "projectId": "../evil" }),
        json!({ "kind": "project", "projectId": 42 }),
        json!({ "kind": "project" }),
        json!({ "kind": "project", "projectId": "p-1", "extra": 1 }),
        json!({ "kind": "library", "dir": "/etc" }),
        json!("/library"),
    ] {
        assert!(parse_media_scope(&bad).is_err(), "应拒绝异型 scope：{bad}");
    }
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
            "assets": by_id([
                entry("la-1", "assets/la-1.png"),
                entry("la-evil", "library.json"),
            ]),
            "groups": by_id([]),
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
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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
        outside.join("victim.png"),
        library.join("assets").join("la-1.png"),
    )
    .expect("建指向链外的符号链接");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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
    let (mime, bytes, permit) =
        read_media_capped_in(&gate, &id, mime, file, ASSET_MAX_BYTES).expect("读取应成功");
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

/// 404 折叠不得隐匿失败（评审修复）：后端诊断文本带 `[media]` 标签并
/// 携带原始原因，脏数据与普通缺失可区分；webview 侧仍只收非敏感 404。
#[test]
fn media_failure_diagnostic_carries_cause_with_label() {
    let text = media_failure_diagnostic("资产 la-1 的媒体文件不存在");
    assert!(text.starts_with("[media]"), "诊断须带模块标签：{text}");
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

// ---- 项目 scope（issue #31）：pwmedia 协议按项目文档 assets.byId 逐请求
// 解析 assetId → relPath，经 verify_asset_real_path 句柄链读取字节。

/// 唯一临时项目根：`{tmp}/pw-project-media-test-{new_id}/projects/`；
/// 返回 (projects, root)——root 供链外受害者文件与清理。
fn temp_projects() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-project-media-test-{}", new_id()));
    fs::create_dir_all(root.join("projects")).expect("创建临时 projects 目录");
    (root.join("projects"), root)
}

/// 直接按字节写项目文档（绕过保存边界，模拟手工修改/脏数据）：
/// 最小合法 v1 信封 + 给定 assets.byId。
fn write_project_doc_raw(projects: &Path, pid: &str, by_id: Value) {
    let doc = json!({
        "schemaVersion": 1,
        "project": { "id": pid, "name": "测试项目", "createdAt": "", "updatedAt": "" },
        "graph": { "nodes": [], "edges": [] },
        "settings": { "characters": {}, "locations": {}, "props": {}, "documents": {} },
        "episodeTitles": {},
        "assets": { "byId": by_id },
    });
    fs::write(
        projects.join(format!("{pid}.json")),
        serde_json::to_string(&doc).expect("序列化项目文档"),
    )
    .expect("写入项目文档");
}

/// 最小合法项目 AssetRef 条目（relPath/mime 按需投毒）。
fn project_asset_entry(id: &str, rel: &str, mime: &str) -> Value {
    json!({
        "id": id,
        "relPath": rel,
        "mime": mime,
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
    })
}

/// 绿路径：项目媒体按当前项目文档解析 assetId，经句柄链读到字节与 mime。
#[test]
fn project_media_bytes_serves_indexed_asset() {
    let (projects, root) = temp_projects();
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建项目资产目录");
    fs::write(projects.join("p-1").join("assets").join("a.png"), b"PNG").expect("写项目媒体");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({ "pa-1": project_asset_entry("pa-1", "assets/a.png", "image/png") }),
    );
    let (mime, bytes) = project_media_read(&cap(&projects), "p-1", "pa-1").expect("应命中");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"PNG");
    cleanup(&root);
}

/// 文档条目 mime 缺失或非规范形式时兜底 application/octet-stream（与库
/// 解析内核同域），服务不因脏 mime 中断。
#[test]
fn project_media_falls_back_to_octet_stream_for_dirty_mime() {
    let (projects, root) = temp_projects();
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建项目资产目录");
    fs::write(projects.join("p-1").join("assets").join("a.png"), b"PNG").expect("写项目媒体");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({ "pa-1": project_asset_entry("pa-1", "assets/a.png", " Image/PNG ") }),
    );
    let (mime, bytes) = project_media_read(&cap(&projects), "p-1", "pa-1").expect("应命中");
    assert_eq!(mime, "application/octet-stream");
    assert_eq!(bytes, b"PNG");
    cleanup(&root);
}

/// 项目不存在 / 资产 id 不在文档索引 / 文件缺失：一律拒绝服务——每次请求
/// 重新读文档，删除后条目即刻不可达（§7.1 opaque URL 权威校验在请求侧）。
#[test]
fn project_media_refuses_missing_project_unknown_asset_and_missing_file() {
    let (projects, root) = temp_projects();
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建项目资产目录");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({
            "pa-1": project_asset_entry("pa-1", "assets/a.png", "image/png"),
            "pa-gone": project_asset_entry("pa-gone", "assets/gone.png", "image/png"),
        }),
    );
    let err = project_media_read(&cap(&projects), "p-9", "pa-1").expect_err("项目缺失应拒绝");
    assert!(err.contains("项目不存在"), "意外诊断：{err}");
    let err = project_media_read(&cap(&projects), "p-1", "pa-missing").expect_err("未知资产应拒绝");
    assert!(err.contains("不存在"), "意外诊断：{err}");
    let err = project_media_read(&cap(&projects), "p-1", "pa-gone").expect_err("文件缺失应拒绝");
    assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
    cleanup(&root);
}

/// 文档中的投毒条目（越界 relPath / .trash 隔离区 relPath）在解析内核即
/// 拒绝——relPath 词法（活动索引口径，排除 .trash）先于任何路径触达。
#[test]
fn project_media_refuses_poisoned_or_trash_rel_paths() {
    let (projects, root) = temp_projects();
    fs::create_dir_all(projects.join("p-1").join("assets").join(".trash")).expect("建隔离目录");
    fs::write(
        projects
            .join("p-1")
            .join("assets")
            .join(".trash")
            .join("x.png"),
        b"T",
    )
    .expect("写隔离区文件");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({
            "pa-evil": project_asset_entry("pa-evil", "../p-1.json", "image/png"),
            "pa-trash": project_asset_entry("pa-trash", "assets/.trash/x.png", "image/png"),
        }),
    );
    for id in ["pa-evil", "pa-trash"] {
        let err = project_media_read(&cap(&projects), "p-1", id).expect_err("投毒 relPath 应拒绝");
        assert!(err.contains("relPath 非法"), "意外诊断：{err}");
    }
    cleanup(&root);
}

/// 终点为符号链接：项目读取侧最终组件必须 no-follow 拒绝（与库媒体同款
/// 信任链，复用 verify_asset_real_path 的句柄绑定）。
#[cfg(unix)]
#[test]
fn project_media_refuses_symlinked_final_component() {
    let (projects, root) = temp_projects();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("建链外目录");
    fs::write(outside.join("victim.png"), b"VICTIM").expect("写链外目标文件");
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建项目资产目录");
    std::os::unix::fs::symlink(
        outside.join("victim.png"),
        projects.join("p-1").join("assets").join("a.png"),
    )
    .expect("建指向链外的符号链接");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({ "pa-1": project_asset_entry("pa-1", "assets/a.png", "image/png") }),
    );
    let err = project_media_read(&cap(&projects), "p-1", "pa-1").expect_err("符号链接应拒绝");
    assert!(err.contains("符号链接"), "意外诊断：{err}");
    assert_eq!(
        fs::read(outside.join("victim.png")).expect("链外目标文件必须幸存"),
        b"VICTIM"
    );
    cleanup(&root);
}

/// 项目 scope 读取上限与生成产物写入契约同源（评审修复 P2-2）：20–32 MiB
/// 的合法生成产物可照常服务（旧 asset 协议无此限制，迁移不得引入永久
/// 404）；库 scope 维持 20 MiB 上限拒绝。
#[test]
fn project_media_serves_generated_size_between_caps() {
    let big = vec![0x50u8; 20 * 1024 * 1024 + 1];
    let (projects, root) = temp_projects();
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建项目资产目录");
    fs::write(projects.join("p-1").join("assets").join("big.png"), &big).expect("写大媒体");
    write_project_doc_raw(
        &projects,
        "p-1",
        json!({ "pa-big": project_asset_entry("pa-big", "assets/big.png", "image/png") }),
    );
    let (mime, bytes) =
        project_media_read(&cap(&projects), "p-1", "pa-big").expect("20–32 MiB 项目媒体应可服务");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes.len(), big.len());
    cleanup(&root);
    // 库 scope：20 MiB 上限保持不变
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-big.png"), &big).expect("写大媒体");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-big", "assets/la-big.png")]), "groups": by_id([]) }),
    );
    let err = media_read(&cap(&library), "la-big").expect_err("库媒体超 20 MiB 应拒绝");
    assert!(err.contains("20 MiB"), "意外诊断：{err}");
    cleanup(&root);
}
