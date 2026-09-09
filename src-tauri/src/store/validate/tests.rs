//! 保存边界校验的集成测试（自 validate.rs 内联模块外置，issue #39）。

use super::*;
use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir, valid_save_doc};
use crate::store::types::new_project_file;
use serde_json::json;
use std::fs;

#[test]
fn save_rejects_missing_settings_buckets() {
    // 缺桶落盘后下次加载被归一化为空 Record，既有 characters/locations/
    // props/documents 永久丢失——持久化信任边界（§10.5）要求四桶齐备且
    // 均为普通对象，而不是只校验碰巧在场的桶
    let mut doc = valid_save_doc();
    doc.settings = json!({});
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.settings = json!({ "characters": {}, "locations": {}, "props": {} });
    let err = prepare_save("p-1", &doc).unwrap_err();
    assert!(err.contains("documents"), "错误应指名缺失的桶：{err}");
    // 四桶齐备才放行
    assert!(prepare_save("p-1", &valid_save_doc()).is_ok());
}

#[test]
fn save_rejects_unsupported_schema_version() {
    // schemaVersion 999 落盘后下次加载按未来版本拒绝（§11.1 第 0 步）；
    // 保存边界必须先行拦截
    let mut doc = valid_save_doc();
    doc.schema_version = 999;
    assert!(prepare_save("p-1", &doc).is_err());
    doc.schema_version = 0;
    assert!(prepare_save("p-1", &doc).is_err());
}

#[test]
fn save_rejects_alien_top_level_containers() {
    // graph: null 之类的载荷若落盘，下次加载会被归一化重置为空图，
    // 把无法判型的损坏静默变成内容丢失（§10.5）——保存边界整次拒绝
    let mut doc = valid_save_doc();
    doc.graph = json!(null);
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.graph = json!({ "nodes": {}, "edges": [] });
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.settings = json!([]);
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.settings = json!({ "characters": [] });
    assert!(prepare_save("p-1", &doc).is_err());
    // 数组型标题表落盘后下次加载被重置为 {}，标题静默丢失
    let mut doc = valid_save_doc();
    doc.episode_titles = json!(["第一集"]);
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.assets = json!({ "byId": [] });
    assert!(prepare_save("p-1", &doc).is_err());
}

#[test]
fn save_rejects_bad_project_metadata_and_viewport() {
    let mut doc = valid_save_doc();
    doc.project.created_at = "not-a-date".into();
    assert!(prepare_save("p-1", &doc).is_err());
    // updatedAt 虽被无条件覆盖，异型值仍拒绝（信封形状先行）
    let mut doc = valid_save_doc();
    doc.project.updated_at = String::new();
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.graph = json!({ "nodes": [], "edges": [], "viewport": { "x": 0, "y": 0, "zoom": 0 } });
    assert!(prepare_save("p-1", &doc).is_err());
    let mut doc = valid_save_doc();
    doc.graph = json!({ "nodes": [], "edges": [], "viewport": { "x": "0", "y": 0, "zoom": 1 } });
    assert!(prepare_save("p-1", &doc).is_err());
}

#[test]
fn save_rejects_non_canonical_episode_title_keys() {
    // "01"/"1e0" 与规范键折叠到同一集号，转换时按遍历序静默覆盖（§11.1 第 3 步）
    for bad in ["01", "1e0", " 1", "0", "-1", "9007199254740992"] {
        let mut doc = valid_save_doc();
        doc.episode_titles = json!({ bad: "标题" });
        assert!(prepare_save("p-1", &doc).is_err(), "应拒绝键 {bad:?}");
    }
    let mut doc = valid_save_doc();
    doc.episode_titles = json!({ "1": 42 });
    assert!(prepare_save("p-1", &doc).is_err());
    // 值域与 set_episode_title 同域（落盘前 trim、去空白后非空）：空白/
    // 带空白标题若放行，下次加载被 trim/删除并触发修复回写——保存边界
    // 接受过的文档不得重开即变
    for bad_title in ["   ", " 开局 ", ""] {
        let mut doc = valid_save_doc();
        doc.episode_titles = json!({ "1": bad_title });
        assert!(
            prepare_save("p-1", &doc).is_err(),
            "应拒绝标题 {bad_title:?}"
        );
    }
}

#[test]
fn save_rejects_bad_asset_entries() {
    let good = json!({
        "id": "a1", "relPath": "assets/pic.png", "mime": "image/png",
        "source": "upload", "createdAt": "2026-08-01T00:00:00.000Z",
    });
    let with_asset = |entry: serde_json::Value, key: &str| {
        let mut doc = valid_save_doc();
        doc.assets = json!({ "byId": { key: entry } });
        doc
    };
    // 基线合法
    assert!(prepare_save("p-1", &with_asset(good.clone(), "a1")).is_ok());
    // Record 键与内嵌 id 不一致（分裂身份）
    assert!(prepare_save("p-1", &with_asset(good.clone(), "a2")).is_err());
    // 空白 id（§8.1 共同值域 trim 口径）：键与内嵌 id 一致但纯空白——
    // 加载侧归一化会按空白键重发改写身份并重连引用，保存边界接受的
    // 数据重开即变 id，须整次拒绝
    let mut blank = good.clone();
    blank["id"] = json!("   ");
    assert!(prepare_save("p-1", &with_asset(blank, "   ")).is_err());
    // relPath 越出资产子目录
    for bad_path in [
        "../secret",
        "assets/../../etc/passwd",
        "/abs/path",
        "library.json",
        "assets/",
        "",
    ] {
        let mut e = good.clone();
        e["relPath"] = json!(bad_path);
        assert!(
            prepare_save("p-1", &with_asset(e, "a1")).is_err(),
            "应拒绝 {bad_path:?}"
        );
    }
    // MIME 非规范形式（大写/带空白/通配/缺 subtype）
    for bad_mime in [
        "IMAGE/PNG",
        " image/png",
        "image/*",
        "image",
        "image/png; q=1",
    ] {
        let mut e = good.clone();
        e["mime"] = json!(bad_mime);
        assert!(
            prepare_save("p-1", &with_asset(e, "a1")).is_err(),
            "应拒绝 {bad_mime:?}"
        );
    }
    let mut e = good.clone();
    e["source"] = json!("unknown");
    assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
    let mut e = good.clone();
    e["createdAt"] = json!("2026-08-01");
    assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
    let mut e = good.clone();
    e["createdAt"] = json!(null);
    assert!(prepare_save("p-1", &with_asset(e, "a1")).is_err());
}

#[test]
fn save_overrides_id_and_stamps_updated_at() {
    // 调用方自报 id 不落盘：无条件以受信路径参数覆盖（§10.5）
    let doc = valid_save_doc();
    let out = prepare_save("p-1", &doc).unwrap();
    assert_eq!(out.project.id, "p-1");
    // updatedAt 由 Rust 保存边界无条件盖戳，不信任调用方携带的旧值/未来值
    assert_ne!(out.project.updated_at, "2026-08-28T12:00:00.000Z");
    assert!(is_valid_iso8601(&out.project.updated_at));
    // createdAt/name 保留（name 为规范化值）
    assert_eq!(out.project.created_at, "2026-08-01T00:00:00.000Z");
    assert_eq!(out.project.name, "午夜出租车");
}

#[test]
fn validate_save_assets_requires_canonical_utc_timestamps() {
    let entry = |ts: &str| {
        json!({ "byId": { "a-1": { "id": "a-1", "relPath": "assets/a1.png",
        "mime": "image/png", "source": "upload", "createdAt": ts } } })
    };
    // 偏移/缺毫秒的合法 ISO 加载会规范化重写触发修复回写，保存只收规范形
    for bad in ["2026-08-01T08:00:00+08:00", "2026-08-01T08:00:00Z"] {
        let err = validate_save_assets(&entry(bad)).unwrap_err();
        assert!(err.contains("createdAt"), "{bad} 意外诊断：{err}");
    }
    assert!(validate_save_assets(&entry("2026-08-01T00:00:00.000Z")).is_ok());
}

#[test]
fn prepare_save_rejects_non_string_description() {
    let mut doc = valid_save_doc();
    doc.project.description = Some(json!(42));
    let err = prepare_save("p-1", &doc).unwrap_err();
    assert!(err.contains("description"), "意外诊断：{err}");
}

#[test]
fn save_ipc_explicit_null_description_preserved_and_rejected() {
    // 显式 null 不得被 serde 折叠为 None：那会让保存边界看不见非字符串
    // 值而静默省略键——既有描述被无声抹掉
    let mut payload = serde_json::to_value(valid_save_doc()).unwrap();
    payload["project"]["description"] = serde_json::Value::Null;
    let file: ProjectFile = serde_json::from_value(payload).expect("反序列化");
    assert_eq!(file.project.description, Some(serde_json::Value::Null));
    let err = prepare_save("p-1", &file).unwrap_err();
    assert!(err.contains("description"), "意外诊断：{err}");
}

#[test]
fn verify_asset_real_path_accepts_regular_file_under_project_root() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("创建资产目录");
    fs::write(assets.join("a1.png"), b"png").expect("写入资产文件");
    assert!(verify_asset_real_path(&cap(&projects), "p-1", "assets/a1.png").is_ok());
    cleanup_temp(&projects);
}

#[test]
fn verify_asset_real_path_rejects_missing_file_and_missing_root() {
    let projects = temp_projects_dir();
    fs::create_dir_all(projects.join("p-1").join("assets")).expect("创建资产目录");
    let err = verify_asset_real_path(&cap(&projects), "p-1", "assets/gone.png").unwrap_err();
    assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
    // 项目资产根本身缺失同样拒存（该项目从未落过资产文件）
    assert!(verify_asset_real_path(&cap(&projects), "p-2", "assets/a1.png").is_err());
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn verify_asset_real_path_rejects_symlink_escape() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("创建资产目录");
    let outside = projects.parent().expect("临时根").join("secret.png");
    fs::write(&outside, b"secret").expect("写入根外文件");
    std::os::unix::fs::symlink(&outside, assets.join("link.png")).expect("建立符号链接");
    let err = verify_asset_real_path(&cap(&projects), "p-1", "assets/link.png").unwrap_err();
    assert!(err.contains("符号链接"), "意外诊断：{err}");
    cleanup_temp(&projects);
}

#[test]
fn verify_asset_real_path_returns_open_handle_of_verified_file() {
    let projects = temp_projects_dir();
    let assets = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets).expect("建资产目录");
    fs::write(assets.join("a1.png"), b"png").expect("写资产文件");
    // 复验绑定打开句柄：调用方（save_project）持有至保存完成才释放
    let handle = verify_asset_real_path(&cap(&projects), "p-1", "assets/a1.png")
        .expect("复验通过应返回已打开的句柄");
    let md = handle.metadata().expect("句柄元数据可读");
    assert!(md.is_file());
    cleanup_temp(&projects);
}

#[test]
fn verify_save_asset_files_prefixes_asset_key_and_skips_lexical_invalid() {
    let projects = temp_projects_dir();
    // relPath 词法非法的条目交给 prepare_save 的形状诊断，实路径复验跳过不误报
    let doc_assets = json!({ "byId": { "a-bad": { "relPath": "../evil.png" } } });
    assert!(verify_save_asset_files(&cap(&projects), "p-1", &doc_assets).is_ok());

    let doc_assets = json!({ "byId": { "a1": { "relPath": "assets/a1.png" } } });
    let err = verify_save_asset_files(&cap(&projects), "p-1", &doc_assets).unwrap_err();
    assert!(err.contains("资产 a1"), "诊断缺资产键：{err}");
    cleanup_temp(&projects);
}

#[test]
fn unverifiable_asset_keys_reports_real_path_failures_only() {
    let projects = temp_projects_dir();
    let assets_dir = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets_dir).expect("建资产目录");
    fs::write(assets_dir.join("ok.png"), b"x").expect("写正常资产");
    // 词法非法/形状缺失条目不在此报告：前端形状归一化负责隔离
    let assets = json!({ "byId": {
        "a-ok": { "relPath": "assets/ok.png" },
        "a-miss": { "relPath": "assets/gone.png" },
        "a-bad": { "relPath": "../evil.png" },
        "a-noshape": {},
    }});
    let keys = unverifiable_asset_keys(&cap(&projects), "p-1", &assets);
    assert_eq!(keys, vec!["a-miss".to_string()]);
    cleanup_temp(&projects);
}

#[cfg(unix)]
#[test]
fn unverifiable_asset_keys_reports_symlinked_entries() {
    let projects = temp_projects_dir();
    let assets_dir = projects.join("p-1").join("assets");
    fs::create_dir_all(&assets_dir).expect("建资产目录");
    let outside = projects.parent().expect("临时根").join("outside.png");
    fs::write(&outside, b"s").expect("写根外文件");
    std::os::unix::fs::symlink(&outside, assets_dir.join("link.png")).expect("建符号链接");
    let assets = json!({ "byId": { "a-link": { "relPath": "assets/link.png" } } });
    let keys = unverifiable_asset_keys(&cap(&projects), "p-1", &assets);
    assert_eq!(keys, vec!["a-link".to_string()]);
    cleanup_temp(&projects);
}

#[test]
fn new_project_document_carries_all_settings_buckets() {
    // create_project 产出的初始文档必须四桶齐备——否则 create → load →
    // save 的原始链路在保存边界被拒（§10.5），只能依赖前端归一化碰巧修复
    let file = new_project_file("p-x", "新剧".into(), "2026-08-31T00:00:00.000Z".into());
    let s = file.settings.as_object().unwrap();
    for bucket in ["characters", "locations", "props", "documents"] {
        assert!(
            s.get(bucket).is_some_and(|v| v.is_object()),
            "缺桶 {bucket}"
        );
    }
    assert!(prepare_save("p-x", &file).is_ok());
}
