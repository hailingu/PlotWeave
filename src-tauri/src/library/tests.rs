//! library.rs 命令面与句柄域内核的回归测试（issue #17 及其评审轮次）：
//! 投毒索引条目隔离、锚定句柄删除信任链、读侧与大小上限编码闭环、并发
//! 首用。pwmedia 媒体协议测试见同目录 media_protocol_tests.rs（issue #26）；
//! 只读态与元信息评审修复测试见同目录 read_only_tests.rs（均自本文件拆出
//! 以符合源文件 800 行上限，评审修复）。

use super::*;
use crate::store::new_id;
use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::json;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

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
fn by_id(entries: impl IntoIterator<Item = Value>) -> Value {
    let mut m = serde_json::Map::new();
    for e in entries {
        m.insert(e["id"].as_str().unwrap().to_string(), e);
    }
    json!({ "byId": m })
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
        &json!({ "assets": by_id([entry("la-1", "library.json")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", victim.to_str().unwrap())]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "settings.json")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "assets/sub/g.png")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "assets/characters/a.png")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
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
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    crate::library_journal::delete_asset_transacted(&cap(&library), "la-1")
        .expect("缺失媒体应幂等成功");
    cleanup(&root);
}

/// 索引读取完整归一化（§7.2）：relPath 越界/必填字段异型的条目隔离出内存
/// 索引并逐条携带警告；非法 id 按兼容迁移规则重发而非隔离（条目存活）。
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
    let (index, warnings, _s) = crate::library_fs::read_index_capped(&cap(&library))
        .expect("含非法条目的索引应可读（条目级隔离，不整册拒绝）");
    let by_id = index["assets"]["byId"]
        .as_object()
        .expect("assets.byId 对象");
    // relPath 越界的两条被隔离；缺 source/createdAt 的裸对象被隔离；
    // la-ok 与「bad id」（重发新 id）两条存活
    let names: Vec<&str> = by_id
        .values()
        .filter_map(|a| a.get("relPath").and_then(Value::as_str))
        .collect();
    assert!(
        by_id.contains_key("la-ok"),
        "合法条目应保留：{:?}",
        by_id.keys()
    );
    assert!(
        !names.contains(&"../escape.png") && !names.contains(&"/etc/passwd"),
        "越界条目应隔离：{names:?}"
    );
    assert!(
        !names.contains(&"assets/x.png") || by_id.values().any(|a| a.get("name").is_some()),
        "缺字段裸对象应隔离：{names:?}"
    );
    // bad id 重发：存活条目含一条非 la-ok 的重发 id
    assert_eq!(by_id.len(), 2, "la-ok + bad id 重发项应存活：{names:?}");
    assert!(
        warnings.len() >= 4,
        "越界×2 + 裸对象隔离 + id 重发各产生警告：{warnings:?}"
    );
    cleanup(&root);
}

/// 索引读取大小上限：超过 1 MiB 上限在物化前显式拒绝。
#[test]
fn read_index_enforces_size_cap() {
    let (library, root) = temp_fixture();
    let pad = "a".repeat(1024 * 1024 + 1);
    write_index_raw(
        &library,
        &json!({ "assets": by_id([]), "groups": by_id([]), "pad": pad }),
    );
    let err = crate::library_fs::read_index_capped(&cap(&library)).expect_err("超限索引应拒绝");
    assert!(err.contains("上限"), "意外诊断：{err}");
    cleanup(&root);
}

/// 索引缺失回退默认空索引（首启/被清理后库仍可用）。
#[test]
fn read_index_missing_falls_back_to_default() {
    let (library, root) = temp_fixture();
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("缺失索引应回退默认");
    assert_eq!(
        index["assets"]["byId"]
            .as_object()
            .map(serde_json::Map::len),
        Some(0)
    );
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
    let mut e = entry("la-1", "assets/la-1.png");
    e["mime"] = json!(" Image/PNG ");
    write_index_raw(
        &library,
        &json!({ "assets": by_id([e]), "groups": by_id([]) }),
    );
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("可修复条目应保留");
    assert_eq!(
        index["assets"]["byId"]["la-1"]["mime"].as_str(),
        Some("image/png")
    );
    assert!(
        warnings.iter().any(|w| w.contains("规范化")),
        "修复应可见：{warnings:?}"
    );
    cleanup(&root);
}

/// 写入侧同上限（评审修复）：接近上限的索引 + 导入扩容在物化前拒绝，
/// 不落媒体文件——否则超限索引落盘后全部读取入口卡死且 UI 无法自愈。
/// 填充用合法条目（迁移内核会丢弃未知字段，不能用 pad 字段撑体积）：
/// 3639 条 name=120 字符的条目把种子撑到读上限内（≈1048 KB），再以同款
/// 长名导入一条，候选索引越过 1 MiB 写上限而被物化前拒绝。
#[test]
fn put_rejects_when_serialized_index_would_exceed_cap() {
    let (library, root) = temp_fixture();
    let long_name = "n".repeat(120);
    let entries: Vec<Value> = (0..3639)
        .map(|i| {
            let mut e = entry(&format!("la-{i}"), &format!("assets/la-{i}.png"));
            e["name"] = json!(long_name);
            e
        })
        .collect();
    let seed = json!({ "assets": by_id(entries), "groups": by_id([]) });
    let seed_len = serde_json::to_string(&seed).unwrap().len();
    assert!(
        seed_len <= crate::library_fs::INDEX_MAX_BYTES,
        "种子索引应可通过读取上限：{seed_len}"
    );
    write_index_raw(&library, &seed);
    // 导入条目用同款长名，把候选索引推过写上限
    let err = put_asset_with(&cap(&library), &long_name, "image/png", "other", b"A")
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
    // 目标 Record 形状（含 source/createdAt/tags）每条约 130 字节，6000 条
    // 远低于 1 MiB 读取上限、又足以暴露写回编码膨胀（评审修复闭环）
    let entries: Vec<Value> = (0..6000)
        .map(|i| entry(&format!("la-{i}"), &format!("assets/la-{i}.png")))
        .collect();
    write_index_raw(
        &library,
        &json!({ "assets": by_id(entries), "groups": by_id([]) }),
    );
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
    let (index, _w, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("写回后的索引必须仍可读");
    let by_id = index["assets"]["byId"]
        .as_object()
        .expect("assets.byId 对象");
    assert_eq!(by_id.len(), 5999, "应恰好移除 la-0 一个条目");
    assert!(!by_id.contains_key("la-0"));
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
    // id 为防碰撞生成器产物（la 前缀，毫秒+进程内计数；评审修复 PR #33 第
    // 十二轮——旧 {毫秒}-{大小} 方案同毫秒同大小即碰撞）
    let id = e["id"].as_str().unwrap_or_default();
    assert!(
        id.starts_with("la_") && validate_asset_id(id).is_ok(),
        "id：{id}"
    );
    let rel = e["relPath"].as_str().unwrap_or_default();
    assert!(
        rel.starts_with(&format!("assets/{id}.")) && rel.ends_with(".png"),
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

/// 迁移产物超大小上限的降级（评审修复，PR #33 第十四轮）：旧数组索引紧凑、
/// 迁移后（byId 键 + source + ISO）膨胀可越过 1 MiB 写上限——此时不得让
/// 迁移落盘失败拖垮全部库命令（升级死锁），降级为「内存归一化照常 + 不落
/// 盘 + 警告」，磁盘保持原始字节，条目删除后自然回落可写。
#[test]
fn oversized_migrated_index_degrades_to_in_memory_without_write() {
    let (library, root) = temp_fixture();
    let long_name = "n".repeat(120);
    let entries: Vec<Value> = (0..3700)
        .map(|i| {
            let mut e = entry(&format!("la-{i}"), &format!("assets/la-{i}.png"));
            e["name"] = json!(long_name);
            e
        })
        .collect();
    let seed = json!({ "assets": entries, "groups": [] });
    let seed_len = serde_json::to_string(&seed).unwrap().len();
    assert!(
        seed_len <= crate::library_fs::INDEX_MAX_BYTES,
        "种子（旧数组）应可通过读取上限：{seed_len}"
    );
    write_index_raw(&library, &seed);
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("迁移超限不得拒绝读取");
    assert_eq!(
        index["assets"]["byId"]
            .as_object()
            .map(serde_json::Map::len),
        Some(3700),
        "归一化视图照常返回"
    );
    assert!(
        warnings.iter().any(|w| w.contains("上限")),
        "降级应警告迁移结果超上限：{warnings:?}"
    );
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "超限迁移结果不得写盘（避免升级死锁）");
    cleanup(&root);
}

/// 超限降级不暴露未持久化的重发 id（评审修复，PR #33 第十五轮）：迁移产物
/// 超上限降级为不落盘时，与只读态同性质——需重发的条目必须隔离而非暴露
/// 跨读漂移的新身份。
#[test]
fn oversized_migration_isolates_reissue_entries_instead_of_exposing() {
    let (library, root) = temp_fixture();
    let long_name = "n".repeat(120);
    // 一个空白 id 条目 + 足量合法条目把迁移产物撑过上限
    let mut blank = {
        let mut e = entry("la-blank-src", "assets/la-blank.png");
        e["id"] = json!("  ");
        e["name"] = json!(long_name);
        e
    };
    blank["id"] = json!("  ");
    let mut entries: Vec<Value> = vec![blank];
    entries.extend((0..3700).map(|i| {
        let mut e = entry(&format!("la-{i}"), &format!("assets/la-{i}.png"));
        e["name"] = json!(long_name);
        e
    }));
    write_index_raw(&library, &json!({ "assets": entries, "groups": [] }));
    let (index, warnings, _s) =
        crate::library_fs::read_index_capped(&cap(&library)).expect("超限降级仍可读");
    let by_id = index["assets"]["byId"].as_object().expect("byId 对象");
    assert_eq!(
        by_id.len(),
        3700,
        "合法条目照常归一化保留，空白 id 条目应隔离：{}",
        by_id.len()
    );
    assert!(
        warnings.iter().any(|w| w.contains("上限")),
        "超限降级应警告：{warnings:?}"
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("只读") || w.contains("隔离")),
        "需重发条目应隔离并告警：{warnings:?}"
    );
    cleanup(&root);
}

/// 降级挂起态阻断变更（评审修复，PR #33 第十六轮）：迁移产物超限的降级
/// 视图（需重发条目已隔离）不得作为写基线落盘——否则无关变更会永久抹掉
/// 被隔离条目。变更命令须拒绝并保留磁盘原始字节；解除途径与 journal 只读
/// 态同先例：人工修整 library.json。
#[test]
fn migration_suspended_blocks_mutations_preserving_disk() {
    let (library, root) = temp_fixture();
    let long_name = "n".repeat(120);
    // 夹具经精确校准：旧数组 ≤1MiB 可读、可写遍迁移产物 >1MiB（触发降级）、
    // 只读遍（隔离全部空白条目）≤1MiB——正是「若无挂起语义则无关变更写回
    // 会成功并抹掉隔离条目」的窗口
    let mut entries: Vec<Value> = (0..60)
        .map(|k| {
            let mut e = entry("la-blank-src", "assets/la-blank.png");
            e["id"] = json!(" ".repeat(k)); // 60 个不同长度的空白拼写（含空串）
            e["name"] = json!(long_name);
            e
        })
        .collect();
    entries.extend((0..3580).map(|i| {
        let mut e = entry(&format!("la-{i}"), &format!("assets/la-{i}.png"));
        e["name"] = json!(long_name);
        e
    }));
    write_index_raw(&library, &json!({ "assets": entries, "groups": [] }));
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    let err = update_meta_with(&cap(&library), "la-0", &json!({ "name": "改名" }))
        .expect_err("迁移挂起态应阻断变更");
    assert!(
        err.contains("上限") || err.contains("迁移"),
        "意外诊断：{err}"
    );
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "挂起态变更不得写盘（防隔离条目被抹）");
    cleanup(&root);
}

/// 库 id 查重重试（评审修复，PR #33 第十七轮）：生成器产出与当前 byId 冲突
/// 时重试——进程内计数器跨进程不唯一（Windows 的库锁为进程本地互斥），按
/// 当前索引查重 + 随机段在跨进程锁正确平台闭合碰撞窗口。
#[test]
fn unique_library_id_retries_on_collision_with_current_by_id() {
    let mut taken = serde_json::Map::new();
    taken.insert("dup".into(), json!({}));
    let mut calls = 0;
    let id = unique_library_id_with(&taken, || {
        calls += 1;
        if calls <= 2 {
            "dup".to_string() // 模拟跨进程同毫秒同计数碰撞
        } else {
            "fresh".to_string()
        }
    });
    assert_eq!(id, "fresh", "碰撞应重试直到未占用");
    assert_eq!(calls, 3);
}
