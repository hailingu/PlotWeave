//! library.rs 命令面与句柄域内核的回归测试（issue #17 及其评审轮次）：
//! 投毒索引条目隔离、锚定句柄删除信任链、大小上限编码闭环、并发首用
//! 与净化诊断可见性。

use super::*;
use crate::store::new_id;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// 测试组合助手：等价协议处理器的两阶段（锁内打开 + 锁外读取）。
fn media_read(library: &CapDir, id: &str) -> Result<(String, Vec<u8>), String> {
    open_media_with(library, id).and_then(|(mime, file)| read_media_capped(id, mime, file))
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

#[test]
fn asset_id_rules() {
    assert!(validate_asset_id("la-18f-1024").is_ok());
    assert!(validate_asset_id("").is_err());
    assert!(validate_asset_id("../evil").is_err());
}

#[test]
fn name_and_kind_rules() {
    assert!(validate_name("女主·林晚 三视图").is_ok());
    assert!(validate_name("   ").is_err());
    assert!(validate_kind("wardrobe").is_ok());
    assert!(validate_kind("prop").is_err());
}

#[test]
fn ext_mapping_prefers_name_and_falls_back_to_mime() {
    assert_eq!(ext_for("立绘.PNG", "image/png"), "png");
    assert_eq!(ext_for("noext", "image/webp"), "webp");
    assert_eq!(ext_for("noext", "application/x-unknown"), "bin");
    assert_eq!(ext_for("bad.<script>", "image/png"), "png");
}

// ---- 脏索引安全回归（issue #17 阶段 1：场景 1-3 + 符号链接 + 隔离）----

/// 场景 1：relPath = "library.json" 通过旧 `!contains("..")` 检查，可删除
/// 全库索引——修复后条目被隔离，索引文件必须幸存。
#[test]
fn delete_refuses_poisoned_index_self_target() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "library.json")], "groups": [] }),
    );
    let err = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect_err("脏条目应拒绝删除");
    assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
    assert!(
        fs::metadata(library.join("library.json")).is_ok(),
        "索引自身不得被删除"
    );
    cleanup(&root);
}

/// 场景 2：绝对路径 relPath 借 `Path::join` 整体替换基路径，旧实现可删除
/// 应用沙箱外任意文件——修复后条目被隔离，库外受害者文件必须幸存。
#[test]
fn delete_refuses_absolute_rel_path_outside_library() {
    let (library, root) = temp_fixture();
    let victim = root.join("victim.png");
    fs::write(&victim, b"VICTIM").expect("写库外受害者文件");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", victim.to_str().unwrap())], "groups": [] }),
    );
    let err = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect_err("绝对路径应拒绝");
    assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
    assert_eq!(fs::read(&victim).expect("受害者文件必须幸存"), b"VICTIM");
    cleanup(&root);
}

/// 场景 3：不含 `..` 的相对名（如 "settings.json"）旧实现可删除库根下
/// assets/ 之外的任意文件——修复后词法校验要求首段 assets，条目被隔离。
#[test]
fn delete_refuses_relative_name_outside_assets() {
    let (library, root) = temp_fixture();
    fs::write(library.join("settings.json"), b"{}").expect("写库根非资产文件");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "settings.json")], "groups": [] }),
    );
    let err = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect_err("assets/ 外相对名应拒绝");
    assert!(err.contains("资产不存在"), "隔离条目应不可达：{err}");
    assert_eq!(
        fs::read(library.join("settings.json")).expect("库内非资产文件必须幸存"),
        b"{}"
    );
    assert!(
        fs::metadata(library.join("library.json")).is_ok(),
        "索引自身必须幸存"
    );
    cleanup(&root);
}

/// 中间组件为符号链接：旧实现路径解析逃逸出 assets/——修复后逐组件
/// no-follow 绑定打开，链外目标文件必须幸存。
#[cfg(unix)]
#[test]
fn delete_refuses_symlinked_parent_component() {
    let (library, root) = temp_fixture();
    let outside = root.join("outside");
    fs::create_dir_all(&outside).expect("建链外目录");
    fs::write(outside.join("g.png"), b"G").expect("写链外目标文件");
    std::os::unix::fs::symlink(&outside, library.join("assets").join("sub"))
        .expect("建符号链接目录");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/sub/g.png")], "groups": [] }),
    );
    let err = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect_err("符号链接中间组件应拒绝");
    assert!(err.contains("符号链接"), "意外诊断：{err}");
    assert_eq!(
        fs::read(outside.join("g.png")).expect("链外目标文件必须幸存"),
        b"G"
    );
    cleanup(&root);
}

/// 终点被换成目录：归类为非普通文件即拒绝，不得误删。
#[test]
fn delete_refuses_non_file_target() {
    let (library, root) = temp_fixture();
    fs::create_dir_all(library.join("assets").join("la-1.png")).expect("把目标换成目录");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    let err = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect_err("非普通文件目标应拒绝");
    assert!(err.contains("不是普通文件"), "意外诊断：{err}");
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_ok(),
        "目标目录必须幸存"
    );
    cleanup(&root);
}

/// 中间目录已丢失的合法嵌套条目按已删除幂等处理（评审修复）：删除
/// 入口不得被悬挂父目录卡死，索引条目必须可收敛。
#[test]
fn delete_treats_missing_parent_dir_as_already_deleted() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/characters/a.png")], "groups": [] }),
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect("缺失父目录应按已删除幂等成功");
    let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
    assert!(!raw.contains("la-1"), "索引条目应被移除：{raw}");
    cleanup(&root);
}

/// 绿路径：合法条目删除媒体文件并原子更新索引；文件缺失幂等成功。
#[test]
fn delete_removes_media_updates_index_and_is_idempotent_on_missing_file() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-1.png"), b"PNG").expect("写媒体文件");
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), "la-1").expect("删除应成功");
    assert!(
        fs::metadata(library.join("assets").join("la-1.png")).is_err(),
        "媒体文件应被删除"
    );
    let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
    assert!(!raw.contains("la-1"), "索引条目应被移除：{raw}");
    // 媒体已不存在的合法条目：再次删除幂等成功
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect("缺失媒体应幂等成功");
    cleanup(&root);
}

/// 索引读取逐条目白名单：非法条目隔离出内存索引并逐条携带警告。
#[test]
fn read_index_quarantines_illegal_entries_with_warnings() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({
            "assets": [
                entry("la-ok", "assets/ok.png"),
                entry("la-bad", "../escape.png"),
                entry("la-abs", "/etc/passwd"),
                entry("bad id", "assets/x.png"),
                { "id": "la-nomime", "relPath": "assets/x.png", "mime": "not a mime" },
            ],
            "groups": [],
        }),
    );
    let (index, warnings) = crate::library_fs::read_index_capped(&cap(&library))
        .expect("含非法条目的索引应可读（条目级隔离，不整册拒绝）");
    let ids: Vec<&str> = index["assets"]
        .as_array()
        .expect("assets 数组")
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str))
        .collect();
    assert_eq!(ids, vec!["la-ok"], "仅合法条目可进内存索引");
    assert_eq!(warnings.len(), 4, "每条非法条目一条警告：{warnings:?}");
    cleanup(&root);
}

/// 索引读取大小上限：超过 1 MiB 上限在物化前显式拒绝。
#[test]
fn read_index_enforces_size_cap() {
    let (library, root) = temp_fixture();
    let pad = "a".repeat(1024 * 1024 + 1);
    write_index_raw(&library, &json!({ "assets": [], "groups": [], "pad": pad }));
    let err = crate::library_fs::read_index_capped(&cap(&library)).expect_err("超限索引应拒绝");
    assert!(err.contains("上限"), "意外诊断：{err}");
    cleanup(&root);
}

/// 索引缺失回退默认空索引（首启/被清理后库仍可用）。
#[test]
fn read_index_missing_falls_back_to_default() {
    let (library, root) = temp_fixture();
    let (index, warnings) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("缺失索引应回退默认");
    assert_eq!(index["assets"].as_array().map(Vec::len), Some(0));
    assert!(warnings.is_empty());
    cleanup(&root);
}

/// 非对象根（标量/数组）显式拒绝而非 panic（评审修复：serde_json 字符串
/// 索引在非对象根上 panic 会让全部库命令不可用）。
#[test]
fn read_index_rejects_non_object_root() {
    let (library, root) = temp_fixture();
    for raw in ["[1,2,3]", "42", "\"text\""] {
        fs::write(library.join("library.json"), raw).expect("写非对象根索引");
        let err =
            crate::library_fs::read_index_capped(&cap(&library)).expect_err("非对象根应显式拒绝");
        assert!(err.contains("对象"), "意外诊断：{err}");
    }
    cleanup(&root);
}

/// mime 仅空白/大小写差异的存量条目就地修复，且修复必须可见（逐条警告，
/// 评审修复：静默修复会让前端与后续写回都无法感知）。
#[test]
fn read_index_reports_mime_repair_warning() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({
            "assets": [{
                "id": "la-1", "name": "x", "kind": "other",
                "mime": " Image/PNG ", "relPath": "assets/la-1.png",
            }],
            "groups": [],
        }),
    );
    let (index, warnings) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("可修复条目应保留");
    assert_eq!(index["assets"][0]["mime"].as_str(), Some("image/png"));
    assert!(
        warnings.iter().any(|w| w.contains("规范化")),
        "修复应可见：{warnings:?}"
    );
    cleanup(&root);
}

/// 写入侧同上限（评审修复）：接近上限的索引 + 导入扩容在物化前拒绝，
/// 不落媒体文件——否则超限索引落盘后全部读取入口卡死且 UI 无法自愈。
#[test]
fn put_rejects_when_serialized_index_would_exceed_cap() {
    let (library, root) = temp_fixture();
    let pad = "a".repeat(crate::library_fs::INDEX_MAX_BYTES - 64);
    write_index_raw(&library, &json!({ "assets": [], "groups": [], "pad": pad }));
    let raw_len = fs::metadata(library.join("library.json"))
        .expect("读种子索引元数据")
        .len() as usize;
    assert!(
        raw_len <= crate::library_fs::INDEX_MAX_BYTES,
        "种子索引应可通过读取上限：{raw_len}"
    );
    let err = put_asset_with(&cap(&library), "x.png", "image/png", "other", b"A")
        .expect_err("超限候选索引应拒绝写入");
    assert!(err.contains("上限"), "意外诊断：{err}");
    let files = fs::read_dir(library.join("assets"))
        .expect("读资产目录")
        .count();
    assert_eq!(files, 0, "拒绝导入不得留下媒体文件");
    cleanup(&root);
}

/// 大索引删除全程同一编码（评审修复）：紧凑落盘的索引可读就必须可写回
/// ——写盘若换用膨胀编码（pretty），删除会命中"媒体已删、索引卡死"，
/// 且每次重试同样失败。
#[test]
fn delete_round_trips_large_compact_index_within_cap() {
    let (library, root) = temp_fixture();
    fs::write(library.join("assets").join("la-0.png"), b"PNG").expect("写媒体文件");
    let entries: Vec<Value> = (0..=9000)
        .map(|i| entry(&format!("la-{i}"), &format!("assets/la-{i}.png")))
        .collect();
    write_index_raw(&library, &json!({ "assets": entries, "groups": [] }));
    let raw_len = fs::metadata(library.join("library.json"))
        .expect("读种子索引元数据")
        .len() as usize;
    assert!(
        raw_len <= crate::library_fs::INDEX_MAX_BYTES,
        "种子索引应可通过读取上限：{raw_len}"
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), "la-0")
        .expect("删除应成功（写回不得因编码膨胀被卡死）");
    assert!(
        fs::metadata(library.join("assets").join("la-0.png")).is_err(),
        "媒体应被删除"
    );
    let (index, _) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("写回后的索引必须仍可读");
    let ids: Vec<&str> = index["assets"]
        .as_array()
        .expect("assets 数组")
        .iter()
        .filter_map(|a| a.get("id").and_then(Value::as_str))
        .collect();
    assert_eq!(ids.len(), 9000, "应恰好移除 la-0 一个条目");
    assert!(!ids.contains(&"la-0"));
    cleanup(&root);
}

/// 并发首用（评审修复）：多个命令同时首次确保库目录，create_dir 的
/// AlreadyExists 不得使失败方误报——与 ensure_child_dir 同语义。
#[test]
fn ensure_library_dir_tolerates_concurrent_first_use() {
    let root_path = std::env::temp_dir().join(format!("pw-library-race-{}", new_id()));
    fs::create_dir_all(&root_path).expect("建临时根");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let barrier = barrier.clone();
            let root_path = root_path.clone();
            std::thread::spawn(move || {
                let root = cap(&root_path);
                barrier.wait();
                crate::library_fs::ensure_library_dir(&root)
            })
        })
        .collect();
    for h in handles {
        h.join()
            .expect("线程不得 panic")
            .expect("并发首用应全部成功");
    }
    cleanup(&root_path);
}

/// 并发首用 assets/ 子目录：同上容忍语义。
#[test]
fn assets_root_tolerates_concurrent_first_use() {
    let (library, root) = temp_fixture();
    let _ = fs::remove_dir(library.join("assets"));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let barrier = barrier.clone();
            let library = library.clone();
            std::thread::spawn(move || {
                let dir = cap(&library);
                barrier.wait();
                crate::library_fs::assets_root(&dir)
            })
        })
        .collect();
    for h in handles {
        h.join()
            .expect("线程不得 panic")
            .expect("并发首用应全部成功");
    }
    cleanup(&root);
}

/// 导入绿路径：媒体原子落盘 assets/、索引追加新条目、mime 规范化。
#[test]
fn put_writes_media_and_appends_entry() {
    let (library, root) = temp_fixture();
    let e = put_asset_with(&cap(&library), "立绘.png", "image/png", "character", b"PNG")
        .expect("导入应成功");
    assert!(e["id"].as_str().unwrap_or_default().starts_with("la-"));
    let rel = e["relPath"].as_str().unwrap_or_default();
    assert!(
        rel.starts_with("assets/la-") && rel.ends_with(".png"),
        "relPath：{rel}"
    );
    assert_eq!(e["mime"].as_str(), Some("image/png"));
    let file = library
        .join("assets")
        .join(rel.strip_prefix("assets/").expect("前缀"));
    assert_eq!(fs::read(&file).expect("媒体文件"), b"PNG");
    let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
    assert!(
        raw.contains(e["id"].as_str().unwrap_or_default()),
        "索引应含新条目"
    );
    cleanup(&root);
}

/// 导入 mime 信任边界：非规范形式在写盘前拒绝。
#[test]
fn put_rejects_non_canonical_mime() {
    let (library, root) = temp_fixture();
    let err = put_asset_with(&cap(&library), "a.png", "not a mime", "other", b"A")
        .expect_err("非法 mime 应拒绝");
    assert!(err.contains("mime"), "意外诊断：{err}");
    let files = fs::read_dir(library.join("assets"))
        .expect("读资产目录")
        .count();
    assert_eq!(files, 0, "拒绝导入不得留下媒体文件");
    cleanup(&root);
}

// ---- 变更命令的净化诊断可见性（评审修复）----

/// 脏索引下导入：返回条目携带 warnings（落盘即净化不得静默）。
#[test]
fn put_on_dirty_index_returns_warnings() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-bad", "../escape.png")], "groups": [] }),
    );
    let e =
        put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    let warnings = e["warnings"].as_array().expect("warnings 应随响应返回");
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap_or_default().contains("隔离")),
        "诊断应含隔离说明：{warnings:?}"
    );
    cleanup(&root);
}

/// 常态导入（索引干净）：响应不含 warnings 键，形状纯净。
#[test]
fn put_on_clean_index_omits_warnings() {
    let (library, root) = temp_fixture();
    let e =
        put_asset_with(&cap(&library), "a.png", "image/png", "other", b"A").expect("导入应成功");
    assert!(
        e.get("warnings").is_none(),
        "干净索引不得附加 warnings：{e}"
    );
    cleanup(&root);
}

/// 脏索引下更新元信息：返回条目携带 warnings。
#[test]
fn update_meta_on_dirty_index_returns_warnings() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({
            "assets": [
                entry("la-1", "assets/la-1.png"),
                entry("la-bad", "/etc/passwd"),
            ],
            "groups": [],
        }),
    );
    let library_dir = cap(&library);
    let updated =
        update_meta_with(&library_dir, "la-1", &json!({ "name": "改名" })).expect("更新应成功");
    let warnings = updated["warnings"]
        .as_array()
        .expect("warnings 应随响应返回");
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap_or_default().contains("隔离")),
        "诊断应含隔离说明：{warnings:?}"
    );
    cleanup(&root);
}

/// 脏索引下删除：响应携带 warnings；删除自身成功。
#[test]
fn delete_on_dirty_index_returns_warnings() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({
            "assets": [
                entry("la-1", "assets/la-1.png"),
                entry("la-bad", "library.json"),
            ],
            "groups": [],
        }),
    );
    let result = crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect("删除应成功");
    let warnings = result["warnings"].as_array().expect("warnings 应在响应中");
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap_or_default().contains("隔离")),
        "诊断应含隔离说明：{warnings:?}"
    );
    let raw = fs::read_to_string(library.join("library.json")).expect("读回索引");
    assert!(!raw.contains("\"la-1\""), "目标条目应被移除：{raw}");
    cleanup(&root);
}

/// 规范化表示同上限（评审修复）：原始字节 ≤ 上限但解析后规范化表示
/// 膨胀超限的索引拒绝读取——可读 ⇒ 可写回的编码闭环不因数字词法
/// 差异破洞（1e10 原始 4 字节，规范化 13 字节）。
#[test]
fn read_index_rejects_when_normalized_form_exceeds_cap() {
    let (library, root) = temp_fixture();
    let raw = format!(
        "{{\"assets\":[],\"groups\":[],\"pad\":[{}]}}",
        vec!["1e10"; 100_000].join(",")
    );
    fs::write(library.join("library.json"), raw).expect("写投毒索引");
    let raw_len = fs::metadata(library.join("library.json"))
        .expect("读种子索引元数据")
        .len() as usize;
    assert!(
        raw_len <= crate::library_fs::INDEX_MAX_BYTES,
        "种子索引原始字节应可通过读取上限：{raw_len}"
    );
    let err =
        crate::library_fs::read_index_capped(&cap(&library)).expect_err("规范化表示超限应拒绝读取");
    assert!(err.contains("上限"), "意外诊断：{err}");
    cleanup(&root);
}

// ---- opaque asset URL 媒体协议（issue #26：relPath/本机绝对路径不出 Rust）----

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
    let (mime, bytes) = read_media_capped(&id, mime, file).expect("锁外读取应成功");
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
