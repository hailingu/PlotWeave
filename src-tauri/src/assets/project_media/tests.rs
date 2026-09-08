//! 项目媒体解析/打开内核与会话新增资产登记的回归测试（issue #31 及其
//! 评审修复）：防抖落盘窗口内登记项可服务、文档命中即权威并清除登记、
//! 项目删除后登记项不得复活媒体、生成产物登记同域。

use super::*;
use crate::store::new_id;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// 测试内核的受信句柄：对临时目录做环境打开（等价生产端锚定句柄）。
fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

/// 唯一临时根：`{tmp}/pw-pmedia-test-{new_id}/` 下含 `projects/` 与
/// `library/assets/`；返回 (projects, library, root)——root 供清理。
fn temp_fixture() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-pmedia-test-{}", new_id()));
    fs::create_dir_all(root.join("projects")).expect("创建临时 projects 目录");
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时 library 目录");
    (root.join("projects"), root.join("library"), root)
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

/// 直接按字节写项目文档（最小合法 v1 信封 + 给定 assets.byId）。
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

/// 库索引最小合法 fixture：单条目 + 媒体文件（目标 Record 形状）。
fn seed_library(library: &Path, id: &str, file: &str, bytes: &[u8], mime: &str) {
    fs::write(library.join("assets").join(file), bytes).expect("写入库媒体文件");
    let index = json!({
        "assets": { "byId": {
            id: {
                "id": id,
                "name": file,
                "kind": "other",
                "mime": mime,
                "relPath": format!("assets/{file}"),
                "source": "upload",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "tags": [],
            }
        }},
        "groups": { "byId": {} },
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化库索引"),
    )
    .expect("写入库索引");
}

/// 防抖落盘窗口（评审修复 P2-1）：导入落盘媒体后、项目文档尚未收录该
/// 条目前，协议解析即可看见会话新条目——新缩略图/生成产物不再等到文档
/// 落盘才可见。
#[test]
fn pending_registry_serves_import_before_doc_persists_it() {
    let (projects, library, root) = temp_fixture();
    // 进程级登记表跨测试共享：唯一项目 id 防并行串扰（评审修复）
    let pid = "p-import";
    write_project_doc_raw(&projects, pid, json!({}));
    seed_library(&library, "la-1", "la-1.png", b"PNGDATA", "image/png");
    let asset =
        crate::assets::import_asset_from_library(&cap(&projects), &cap(&library), pid, "la-1")
            .expect("导入应成功");
    let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
    // 文档 byId 仍为空：解析必须走登记表而非文档
    let (rel, mime) = resolve_project_media_entry(&cap(&projects), pid, asset_id)
        .expect("防抖窗口内解析应命中登记项");
    assert_eq!(mime, "image/png");
    assert_eq!(
        rel,
        asset
            .get("relPath")
            .and_then(Value::as_str)
            .expect("relPath 缺失")
    );
    let (mime, mut file) =
        open_project_media_with(&cap(&projects), pid, asset_id).expect("应打开登记项媒体");
    let mut bytes = Vec::new();
    use std::io::Read;
    file.read_to_end(&mut bytes).expect("读取登记项媒体");
    assert_eq!(mime, "image/png");
    assert_eq!(bytes, b"PNGDATA");
    cleanup(&root);
}

/// 文档命中即权威并清除登记项（opportunistic 清理）：之后文档移除该条目
/// （如撤销 + 重存）时解析必须失败，登记项不得替代文档权威。
#[test]
fn doc_hit_drains_pending_entry() {
    let (projects, library, root) = temp_fixture();
    // 并行隔离同上
    let pid = "p-doc-hit";
    write_project_doc_raw(&projects, pid, json!({}));
    seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
    let asset =
        crate::assets::import_asset_from_library(&cap(&projects), &cap(&library), pid, "la-1")
            .expect("导入应成功");
    let asset_id = asset
        .get("id")
        .and_then(Value::as_str)
        .expect("id 缺失")
        .to_string();
    let rel = asset
        .get("relPath")
        .and_then(Value::as_str)
        .expect("relPath")
        .to_string();
    write_project_doc_raw(
        &projects,
        pid,
        json!({ asset_id.clone(): {
            "id": asset_id,
            "relPath": rel,
            "mime": "image/png",
            "source": "upload",
            "createdAt": "2026-01-01T00:00:00.000Z",
        }}),
    );
    resolve_project_media_entry(&cap(&projects), pid, &asset_id)
        .expect("文档命中应成功并清除登记项");
    // 模拟撤销后重存：文档移除条目，登记项已被清除 → 按不存在拒绝
    write_project_doc_raw(&projects, pid, json!({}));
    let err = resolve_project_media_entry(&cap(&projects), pid, &asset_id)
        .expect_err("登记项清除后应按不存在拒绝");
    assert!(err.contains("不存在"), "意外诊断：{err}");
    cleanup(&root);
}

/// 项目删除后登记项不得复活媒体（评审修复 P2-1 伴生边界）：删除后
/// 项目控制文件缺失，登记项即使残留也按「项目不存在」拒绝。
#[test]
fn pending_media_is_not_served_after_project_deletion() {
    let (projects, library, root) = temp_fixture();
    // 并行隔离同上
    let pid = "p-deleted";
    write_project_doc_raw(&projects, pid, json!({}));
    seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
    let asset =
        crate::assets::import_asset_from_library(&cap(&projects), &cap(&library), pid, "la-1")
            .expect("导入应成功");
    let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
    fs::remove_file(projects.join(format!("{pid}.json"))).expect("删除项目控制文件");
    fs::remove_dir_all(projects.join(pid)).expect("删除项目资产目录");
    let err = resolve_project_media_entry(&cap(&projects), pid, asset_id)
        .expect_err("已删项目的登记项不得复活媒体");
    assert!(err.contains("项目不存在"), "意外诊断：{err}");
    cleanup(&root);
}

/// 生成产物同域登记（评审修复 P2-1）：write_generated_asset 落盘后同样
/// 立即可解析，relPath/mime 与返回的 AssetRef 一致。
#[test]
fn write_generated_asset_registers_pending_media() {
    let (projects, _library, root) = temp_fixture();
    // 并行隔离同上
    let pid = "p-gen";
    write_project_doc_raw(&projects, pid, json!({}));
    let asset = crate::assets::write_generated_asset(&cap(&projects), pid, b"GEN", "image/png")
        .expect("生成落盘应成功");
    let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
    let (rel, mime) = resolve_project_media_entry(&cap(&projects), pid, asset_id)
        .expect("生成产物应经登记项可解析");
    assert_eq!(mime, "image/png");
    assert_eq!(rel, format!("assets/{asset_id}.png"));
    cleanup(&root);
}
