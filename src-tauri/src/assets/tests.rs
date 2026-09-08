//! `assets` 管线的集成测试（自 assets.rs 内联模块外置，issue #39）：
//! 覆盖库资产导入、生成媒体落盘、AssetRef 预检与目录竞态容错。

use super::*;
use cap_std::ambient_authority;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// 测试内核的受信句柄：对临时目录做环境打开（等价生产端锚定句柄）。
fn cap(p: &Path) -> CapDir {
    CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
}

/// 本测试专用的登记表实例（应用状态语义，非共享全局）。
fn pending() -> project_media::PendingProjectAssets {
    project_media::PendingProjectAssets::new()
}

/// 唯一临时根：`{tmp}/pw-assets-test-{new_id}/` 下含 `projects/` 与
/// `library/assets/`；返回 (projects, library, root)——root 供清理。
fn temp_fixture() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("pw-assets-test-{}", new_id()));
    fs::create_dir_all(root.join("projects")).expect("创建临时 projects 目录");
    fs::create_dir_all(root.join("library").join("assets")).expect("创建临时 library 目录");
    (root.join("projects"), root.join("library"), root)
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

fn seed_project(projects: &Path, id: &str) {
    fs::write(projects.join(format!("{id}.json")), b"{}").expect("写入项目控制文件");
}

/// 库索引条目的完整合法形状（目标 Record 形状，含 §7.2 必填
/// source/ISO createdAt；relPath 按需投毒）。
fn library_entry(id: &str, name: &str, kind: &str, mime: &str, rel: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "kind": kind,
        "mime": mime,
        "relPath": rel,
        "source": "upload",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [],
    })
}

/// 把库索引条目数组包装为目标 Record 形状（`{"byId": {id: entry}}`）。
fn library_by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
}

/// 库索引 + 媒体文件的最小合法 fixture（索引条目按 §7.2 Record 形状）。
fn seed_library(library: &Path, id: &str, file: &str, bytes: &[u8], mime: &str) {
    fs::write(library.join("assets").join(file), bytes).expect("写入库媒体文件");
    let index = json!({
        "assets": library_by_id([library_entry(id, file, "character", mime, &format!("assets/{file}"))]),
        "groups": library_by_id([]),
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化库索引"),
    )
    .expect("写入库索引");
}

#[test]
fn import_copies_file_and_returns_project_asset_ref() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    seed_library(&library, "la-1", "la-1.png", b"PNGDATA", "image/png");
    let asset =
        import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
            .expect("导入应成功");
    let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
    assert!(asset_id.starts_with("pa-"), "意外 id 前缀：{asset_id}");
    assert_eq!(
        asset.get("relPath").and_then(Value::as_str),
        Some(format!("assets/{asset_id}.png").as_str())
    );
    assert_eq!(asset.get("mime").and_then(Value::as_str), Some("image/png"));
    assert_eq!(asset.get("source").and_then(Value::as_str), Some("upload"));
    let created = asset
        .get("createdAt")
        .and_then(Value::as_str)
        .expect("createdAt 缺失");
    assert!(
        is_canonical_utc_timestamp(created),
        "createdAt 非规范 UTC：{created}"
    );
    // 拷贝字节一致，且通过项目侧实路径复验
    let copied = projects
        .join("p-1")
        .join("assets")
        .join(format!("{asset_id}.png"));
    assert_eq!(fs::read(&copied).expect("副本缺失"), b"PNGDATA");
    assert!(
        verify_asset_real_path(&cap(&projects), "p-1", &format!("assets/{asset_id}.png")).is_ok()
    );
    // 源文件保持不动（拷贝语义）
    assert_eq!(
        fs::read(library.join("assets").join("la-1.png")).expect("源文件缺失"),
        b"PNGDATA"
    );
    cleanup(&root);
}

#[test]
fn import_twice_into_same_project_reuses_existing_dirs() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
    import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
        .expect("首次导入");
    let second =
        import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
            .expect("现存资产目录下二次导入");
    let file_count = fs::read_dir(projects.join("p-1").join("assets"))
        .expect("读取资产目录")
        .count();
    assert_eq!(file_count, 2, "两次导入应各落一份副本");
    assert!(second.get("id").and_then(Value::as_str).is_some());
    cleanup(&root);
}

#[test]
fn import_rejects_missing_project_and_unknown_library_asset() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
    let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-9", "la-1", &pending())
        .expect_err("不存在的项目应拒绝");
    assert!(err.contains("项目不存在"), "意外诊断：{err}");
    let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-9", &pending())
        .expect_err("未知库资产应拒绝");
    assert!(err.contains("库资产不存在"), "意外诊断：{err}");
    cleanup(&root);
}

#[test]
fn import_rejects_index_entry_with_escaping_rel_path() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    fs::write(library.join("assets").join("a.png"), b"A").expect("写库媒体");
    let index = json!({
        "assets": library_by_id([library_entry("la-1", "a.png", "other", "image/png", "../a.png")]),
        "groups": library_by_id([]),
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化"),
    )
    .expect("写库索引");
    // 脏条目在共享索引读取处即被隔离（issue #17）：导入侧以"不存在"拒绝，
    // relPath 永不进入拷贝流程
    let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
        .expect_err("越界 relPath 应拒绝");
    assert!(err.contains("库资产不存在"), "意外诊断：{err}");
    cleanup(&root);
}

#[cfg(unix)]
#[test]
fn import_rejects_symlinked_library_source() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    fs::write(root.join("secret.png"), b"SECRET").expect("写根外文件");
    std::os::unix::fs::symlink(
        root.join("secret.png"),
        library.join("assets").join("la-1.png"),
    )
    .expect("建符号链接");
    let index = json!({
        "assets": library_by_id([library_entry("la-1", "la-1.png", "other", "image/png", "assets/la-1.png")]),
        "groups": library_by_id([]),
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化"),
    )
    .expect("写库索引");
    let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
        .expect_err("符号链接源应拒绝");
    assert!(err.contains("符号链接"), "意外诊断：{err}");
    assert!(
        fs::symlink_metadata(projects.join("p-1").join("assets")).is_err()
            || fs::read_dir(projects.join("p-1").join("assets"))
                .expect("读资产目录")
                .count()
                == 0,
        "拒绝导入不得留下资产文件"
    );
    cleanup(&root);
}

/// 合法 AssetRef fixture（p-1 下落有对应媒体文件）。
fn seed_valid_asset(projects: &Path) -> Value {
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    fs::write(assets.join("a1.png"), b"PNG").expect("写资产文件");
    json!({
        "id": "a1",
        "relPath": "assets/a1.png",
        "mime": "image/png",
        "source": "upload",
        "createdAt": "2026-09-04T08:00:00.000Z",
    })
}

#[test]
fn validate_accepts_and_normalizes_valid_asset_ref() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let mut asset = seed_valid_asset(&projects);
    // 大小写/空白非规范的 mime 由预检规范化后放行
    asset["mime"] = json!(" Image/PNG ");
    let out = validate_project_asset_with(&cap(&projects), "p-1", &asset).expect("应通过");
    assert_eq!(out.get("mime").and_then(Value::as_str), Some("image/png"));
    assert_eq!(out.get("id").and_then(Value::as_str), Some("a1"));
    cleanup(&root);
}

#[test]
fn validate_rejects_shape_violations() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let good = seed_valid_asset(&projects);
    for (patch, expect_msg) in [
        (json!({"relPath": "../evil.png"}), "relPath"),
        (json!({"mime": "not-a-mime"}), "mime"),
        (json!({"source": "mystery"}), "source"),
        (json!({"createdAt": "2026-08-01"}), "createdAt"),
    ] {
        let mut bad = good.clone();
        for (k, v) in patch.as_object().expect("补丁对象") {
            bad[k] = v.clone();
        }
        let err =
            validate_project_asset_with(&cap(&projects), "p-1", &bad).expect_err("形状违规应拒绝");
        assert!(err.contains(expect_msg), "诊断缺 {expect_msg}：{err}");
    }
    cleanup(&root);
}

#[test]
fn import_rejects_missing_or_swapped_media_file() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("建资产目录");
    let asset = json!({
        "id": "a1",
        "relPath": "assets/gone.png",
        "mime": "image/png",
        "source": "upload",
        "createdAt": "2026-09-04T08:00:00.000Z",
    });
    let err =
        validate_project_asset_with(&cap(&projects), "p-1", &asset).expect_err("媒体缺失应拒绝");
    assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
    cleanup(&root);
}

/// 嵌套 relPath 的父目录缺失在导入侧仍是显式错误（删除侧才幂等，
/// 与 library_fs::remove_asset_file 的语义分野）。
#[test]
fn import_rejects_missing_nested_parent_dir() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let index = json!({
        "assets": library_by_id([library_entry("la-1", "a.png", "other", "image/png", "assets/gone/a.png")]),
        "groups": library_by_id([]),
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化"),
    )
    .expect("写库索引");
    let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
        .expect_err("父目录缺失应拒绝导入");
    assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
    cleanup(&root);
}

#[test]
fn write_generated_asset_lands_bytes_and_generated_ref() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3];
    let asset = write_generated_asset(&cap(&projects), "p-1", bytes, "image/png", &pending())
        .expect("生成媒体落盘应成功");
    let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
    assert!(asset_id.starts_with("pa-"), "意外 id 前缀：{asset_id}");
    assert_eq!(
        asset.get("relPath").and_then(Value::as_str),
        Some(format!("assets/{asset_id}.png").as_str())
    );
    assert_eq!(
        asset.get("source").and_then(Value::as_str),
        Some("generated")
    );
    assert_eq!(asset.get("mime").and_then(Value::as_str), Some("image/png"));
    let created = asset
        .get("createdAt")
        .and_then(Value::as_str)
        .expect("createdAt 缺失");
    assert!(
        is_canonical_utc_timestamp(created),
        "createdAt 非规范 UTC：{created}"
    );
    // 字节一致且通过项目侧实路径复验
    let landed = projects
        .join("p-1")
        .join("assets")
        .join(format!("{asset_id}.png"));
    assert_eq!(fs::read(&landed).expect("落盘文件缺失"), bytes);
    assert!(
        verify_asset_real_path(&cap(&projects), "p-1", &format!("assets/{asset_id}.png")).is_ok()
    );
    cleanup(&root);
}

#[test]
fn write_generated_asset_rejects_missing_project() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let err = write_generated_asset(&cap(&projects), "p-9", b"PNG", "image/png", &pending())
        .expect_err("不存在的项目应拒绝");
    assert!(err.contains("项目不存在"), "意外诊断：{err}");
    cleanup(&root);
}

#[test]
fn write_generated_asset_ext_follows_mime() {
    let (projects, _library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    let asset = write_generated_asset(
        &cap(&projects),
        "p-1",
        b"JPEGBYTES",
        "image/jpeg",
        &pending(),
    )
    .expect("jpeg 落盘应成功");
    let rel = asset
        .get("relPath")
        .and_then(Value::as_str)
        .expect("relPath");
    assert!(rel.ends_with(".jpg"), "jpeg 扩展应映射为 .jpg：{rel}");
    assert_eq!(ext_for_mime("image/webp"), "webp");
    assert_eq!(ext_for_mime("application/octet-stream"), "bin");
    cleanup(&root);
}

/// 只读告警态不得改写库索引（评审修复，PR #33 第七轮）：删除日志异型时
/// 项目导入的读取路径走不落盘归一化——library.json 保持原始字节，导入
/// 本身照常服务（读取不受只读限制）。
#[test]
fn import_read_does_not_persist_index_in_journal_read_only_mode() {
    let (projects, library, root) = temp_fixture();
    seed_project(&projects, "p-1");
    // 旧数组形状索引：正常路径下读取即迁移落盘
    let index = json!({
        "assets": [library_entry("la-1", "la-1.png", "character", "image/png", "assets/la-1.png")],
        "groups": [],
    });
    fs::write(
        library.join("library.json"),
        serde_json::to_string(&index).expect("序列化库索引"),
    )
    .expect("写入库索引");
    fs::write(library.join("assets").join("la-1.png"), b"PNGDATA").expect("写入库媒体");
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    // 异型删除日志根 → 整份恢复进入只读告警态
    fs::write(
        library.join(crate::library_journal::JOURNAL_FILE_NAME),
        b"{\"not\":\"array\"}",
    )
    .expect("写异型日志");
    let asset =
        import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1", &pending())
            .expect("只读态导入（读取路径）仍应服务");
    assert!(asset.get("id").is_some(), "导入应返回项目资产");
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "只读态不得改写 library.json");
    cleanup(&root);
}

#[test]
fn ensure_child_dir_tolerates_already_exists() {
    // 并发首次落盘的竞态窗口由「总是创建 + 容忍 AlreadyExists」消除：
    // 目录已存在（等价于另一并发创建者刚建好）同样成功返回绑定句柄
    let (projects, _lib, root) = temp_fixture();
    let parent = cap(&projects);
    let first = ensure_child_dir(&parent, "p-conc", "项目资产根").expect("首次创建");
    drop(first);
    let second = ensure_child_dir(&parent, "p-conc", "项目资产根").expect("已存在复用");
    drop(second);
    cleanup(&root);
}
