//! library.rs 命令面评审修复的回归测试：只读告警态读取不落盘、只读隔离
//! 诊断、kind 与编组冲突复验、update patch 值域与 groupId verbatim、导入
//! id 防碰撞、变更命令的净化诊断可见性。自 `library/tests.rs` 拆出以符合
//! 源文件 800 行上限（评审修复，PR #33 第五至十三轮）。

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

// ---- 变更命令的净化诊断可见性（评审修复）----

/// 脏索引下导入：返回条目携带 warnings（落盘即净化不得静默）。
#[test]
fn put_on_dirty_index_returns_warnings() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-bad", "../escape.png")]), "groups": by_id([]) }),
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

/// 只读告警态不得改写索引（评审修复，PR #33 第五轮）：删除日志异型时 list
/// 的读取走不落盘路径——library.json 保持原始字节（迁移待日志修复后再落），
/// 归一化视图与迁移警告照常返回（读不受限，写被暂停）。
#[test]
fn list_read_does_not_persist_index_in_journal_read_only_mode() {
    let (library, root) = temp_fixture();
    // 旧数组形状索引：正常路径下读取即迁移落盘
    write_index_raw(
        &library,
        &json!({ "assets": [entry("la-1", "assets/la-1.png")], "groups": [] }),
    );
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    // 异型删除日志根 → 整份恢复进入只读告警态
    fs::write(
        library.join(crate::library_journal::JOURNAL_FILE_NAME),
        b"{\"not\":\"array\"}",
    )
    .expect("写异型日志");
    let (index, warnings) = list_assets_with(&cap(&library)).expect("只读态列表仍可读");
    assert!(
        index["assets"]["byId"]["la-1"].is_object(),
        "条目应迁移进内存视图：{}",
        index["assets"]
    );
    assert!(
        warnings.iter().any(|w| w.contains("只读")),
        "只读告警应可见：{warnings:?}"
    );
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "只读态不得改写 library.json");
    cleanup(&root);
}

/// 改 kind 与成员编组冲突须拒绝（评审修复，PR #33 第九轮，§7.2「复验完整
/// 合并结果」）：资产带 groupId 时改 kind 若与组 kind 不一致，整次命令
/// 拒绝且不写盘——不得让一次成功的元信息编辑在下次读取时静默抹掉编组。
#[test]
fn update_meta_rejects_kind_change_conflicting_with_group() {
    let (library, root) = temp_fixture();
    let member = json!({
        "id": "la-1", "name": "x", "kind": "character",
        "mime": "image/png", "relPath": "assets/la-1.png",
        "source": "upload", "createdAt": "2026-01-01T00:00:00.000Z",
        "tags": [], "groupId": "g-1",
    });
    let group = json!({ "id": "g-1", "name": "女主", "kind": "character" });
    let index = json!({
        "assets": by_id([member]),
        "groups": by_id([group]),
    });
    write_index_raw(&library, &index);
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    let err = update_meta_with(&cap(&library), "la-1", &json!({ "kind": "location" }))
        .expect_err("与组 kind 冲突的更新应拒绝");
    assert!(
        err.contains("groupId") || err.contains("kind"),
        "意外诊断：{err}"
    );
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "拒绝更新不得写盘");
    cleanup(&root);
}

/// 对照：不带 groupId 的条目改 kind 正常成功（复验不误伤无编组条目）。
#[test]
fn update_meta_kind_change_without_group_succeeds() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    let updated = update_meta_with(&cap(&library), "la-1", &json!({ "kind": "location" }))
        .expect("无编组条目改 kind 应成功");
    assert_eq!(updated["kind"], "location");
    cleanup(&root);
}

/// update patch 值域运行时校验（评审修复，PR #33 第十轮，§7.2「字段一旦
/// 出现就先做运行时类型和值域校验」）：非字符串 view/name、非法 tags
/// （非数组/成员异型/空白/超长/重复/超 16 项）一律拒绝整次命令，不得
/// 静默截断或写盘后由读取归一化剥离。
#[test]
fn update_meta_rejects_patch_fields_outside_value_domain() {
    let (library, root) = temp_fixture();
    write_index_raw(
        &library,
        &json!({ "assets": by_id([entry("la-1", "assets/la-1.png")]), "groups": by_id([]) }),
    );
    let lib = cap(&library);
    for (patch, why) in [
        (json!({ "view": 1 }), "非字符串 view"),
        (json!({ "name": 42 }), "非字符串 name"),
        (json!({ "tags": "x" }), "非数组 tags"),
        (json!({ "tags": [1] }), "异型 tags 成员"),
        (json!({ "tags": ["  "] }), "空白 tags 成员"),
        (json!({ "tags": ["a", "a"] }), "重复 tags 成员"),
        (
            json!({ "tags": ["0123456789012345678901234567890123456789012345678901234567890123456789"] }),
            "超长 tags 成员",
        ),
    ] {
        let err = update_meta_with(&lib, "la-1", &patch).expect_err(&format!("{why} 应拒绝"));
        assert!(!err.is_empty(), "{why} 应携带诊断");
    }
    // 超过 16 项拒绝（不得静默截断）
    let many = json!({ "tags": (0..17).map(|i| format!("t{i}")).collect::<Vec<_>>() });
    update_meta_with(&lib, "la-1", &many).expect_err("超过 16 项 tags 应拒绝");
    // 对照：合法 tags 更新成功
    let ok = update_meta_with(&lib, "la-1", &json!({ "tags": [" hero ", "hero"] }))
        .expect_err("规范化后重复（hero）应拒绝");
    assert!(ok.contains("重复"), "规范化后重复应拒绝：{ok}");
    let updated = update_meta_with(&lib, "la-1", &json!({ "tags": [" hero "] }))
        .expect("带空白的合法 tags 应成功");
    assert_eq!(updated["tags"], json!(["hero"]));
    cleanup(&root);
}

/// groupId 补丁 verbatim（评审修复，PR #33 第十一轮）：非空补丁值必须原样
/// 过 id 值域——`" g "` 不得 trim 成 `g` 错接进组 g；仅 null/空白是清除
/// 标记。
#[test]
fn update_meta_rejects_padded_group_id_patch() {
    let (library, root) = temp_fixture();
    let member = {
        let mut e = entry("la-1", "assets/la-1.png");
        e["groupId"] = json!("g-1");
        e
    };
    let group = json!({ "id": "g-1", "name": "女主", "kind": "other" });
    write_index_raw(
        &library,
        &json!({ "assets": by_id([member]), "groups": by_id([group]) }),
    );
    let before = fs::read(library.join("library.json")).expect("读原始索引字节");
    let err = update_meta_with(&cap(&library), "la-1", &json!({ "groupId": " g-1 " }))
        .expect_err("带空白 groupId 补丁应拒绝");
    assert!(err.contains("groupId"), "意外诊断：{err}");
    let after = fs::read(library.join("library.json")).expect("读落盘索引字节");
    assert_eq!(before, after, "拒绝更新不得写盘");
    cleanup(&root);
}

/// 导入 id 防碰撞（评审修复，PR #33 第十二轮）：两次导入产出的条目 id 与
/// 媒体文件名必须唯一——旧 `la-{毫秒:x}-{大小}` 方案同毫秒同大小即碰撞，
/// Record insert 会覆盖首个条目、孤儿化其媒体。
#[test]
fn put_twice_produces_distinct_ids_and_filenames() {
    let (library, root) = temp_fixture();
    let e1 = put_asset_with(&cap(&library), "a.png", "image/png", "other", b"AA")
        .expect("第一次导入应成功");
    let e2 = put_asset_with(&cap(&library), "a.png", "image/png", "other", b"AA")
        .expect("第二次导入应成功");
    let id1 = e1["id"].as_str().expect("id 缺失");
    let id2 = e2["id"].as_str().expect("id 缺失");
    assert_ne!(id1, id2, "同毫秒同大小导入不得产生重复 id");
    assert_ne!(e1["relPath"], e2["relPath"], "媒体文件名不得碰撞");
    let (index, _w, _s) = crate::library_fs::read_index_capped(&cap(&library)).expect("索引可读");
    let by_id = index["assets"]["byId"]
        .as_object()
        .expect("assets.byId 对象");
    assert_eq!(by_id.len(), 2, "两条目都应保留：{by_id:?}");
    cleanup(&root);
}

/// 只读态诊断与实际行为一致（评审修复，PR #33 第十三轮）：journal 异型时
/// recover 不得报告「已重发」——只读态身份无法持久化，条目将被只读归一化
/// 隔离；诊断必须反映隔离而非声称重发。
#[test]
fn readonly_recovery_reports_isolation_not_false_reissue() {
    let (library, root) = temp_fixture();
    // 旧数组索引 + 空白 id 条目：可落盘路径会重发，只读态应隔离
    let mut blank = entry("la-1", "assets/la-1.png");
    blank["id"] = json!("  ");
    write_index_raw(&library, &json!({ "assets": [blank], "groups": [] }));
    fs::write(
        library.join(crate::library_journal::JOURNAL_FILE_NAME),
        b"{\"not\":\"array\"}",
    )
    .expect("写异型日志");
    let (index, warnings) = list_assets_with(&cap(&library)).expect("只读态列表仍可读");
    assert!(
        index["assets"]["byId"].as_object().unwrap().is_empty(),
        "只读态空白 id 条目应隔离：{}",
        index["assets"]
    );
    assert!(
        warnings.iter().any(|w| w.contains("只读")),
        "诊断应声称只读隔离：{warnings:?}"
    );
    assert!(
        !warnings.iter().any(|w| w.contains("已重发")),
        "只读态不得报告已重发：{warnings:?}"
    );
    cleanup(&root);
}
