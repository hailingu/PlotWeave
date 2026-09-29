//! module_graph 守卫的测试（issue #399）：#146 形态反例夹具自证检出、
//! 合法分层与门控排除不误报、fail-closed 语义、真实仓库无环断言。

use super::*;

/// 夹具图 → 环清单（构图失败直接 panic，与守卫 fail-closed 语义一致）。
fn cycles(files: &[(&str, &str)]) -> Vec<String> {
    let map = to_map(files);
    cycles_of(&build_graph(&map))
}

/// 夹具图 → 边集（解析完整性断言用）。
fn edges(files: &[(&str, &str)]) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    build_graph(&to_map(files))
}

/// (键, 源码) 列表 → 文件映射。
fn to_map(files: &[(&str, &str)]) -> BTreeMap<ModuleKey, String> {
    files
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

#[test]
fn detects_direct_module_cycle_like_issue_146() {
    // issue #146 当时形态的抽象：资产与图库模块互相 use，守卫必须在
    // 文件粒度报出环（当时的 8 条类型环路径已一次性修复，此处固化
    // 为常驻反例，防同类回归）
    let found = cycles(&[
        ("lib.rs", "mod assets;\nmod library;\n"),
        ("assets.rs", "use crate::library::LibraryError;\n"),
        ("library.rs", "use crate::assets::AssetsError;\n"),
    ]);
    assert_eq!(found.len(), 1, "互依两模块应恰构成一个环：{found:?}");
    assert!(
        found[0].contains("assets.rs") && found[0].contains("library.rs"),
        "环路径应定位到具体文件：{found:?}"
    );
}

#[test]
fn detects_cycle_through_nested_module_files() {
    // 深层环：a → b::c（mod.rs 形态的嵌套子模块）→ 回 a
    let found = cycles(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        ("a.rs", "use crate::b::c::C;\n"),
        ("b/mod.rs", "pub mod c;\n"),
        ("b/c.rs", "use crate::a::A;\n"),
    ]);
    assert_eq!(found.len(), 1, "嵌套模块互依赖构成环：{found:?}");
    assert!(
        found[0].contains("a.rs") && found[0].contains("b/c.rs"),
        "环路径应穿透 mod.rs 形态定位到子模块文件：{found:?}"
    );
}

#[test]
fn legal_layering_super_edges_and_brace_groups_pass() {
    // 合法分层 + super:: 边 + 花括号分组 + 组内 self + cfg(test) 门控
    // （文件 mod、inline 块、项级 fn）与宏体都不进图
    let graph = edges(&[
        (
            "lib.rs",
            "mod store;\nmod library;\nmod library_fs;\nmod isotime;\n",
        ),
        ("isotime.rs", "#[cfg(test)]\nuse crate::store::y;\n"),
        ("store/mod.rs", "mod persist;\nuse crate::isotime::now_iso;\n"),
        (
            "store/persist.rs",
            "macro_rules! atomic_io { ($o:expr) => {{ use crate::library_fs::w; $o }} }\npub(crate) use atomic_io;\n",
        ),
        (
            "library.rs",
            concat!(
                "pub(crate) mod diagnostics;\npub(crate) mod error;\npub(crate) mod group_commands;\n",
                "#[cfg(test)]\nmod helper;\n",
                "#[cfg(test)]\nmod tests {\n    use super::*;\n    use crate::store::persist::P;\n}\n",
                "use crate::library_fs::{read_index_capped, self};\n",
            ),
        ),
        ("library/helper.rs", "use crate::store::persist::P;\n"),
        (
            "library/group_commands.rs",
            "use super::diagnostics::with_snapshot;\nuse crate::library_fs::write_index as wi;\n",
        ),
        (
            "library/diagnostics.rs",
            "use super::error::LibraryError;\n",
        ),
        (
            "library/error.rs",
            "#[cfg(test)]\nfn fixture() { use crate::store::x; }\n",
        ),
        (
            "library_fs.rs",
            "pub fn atomic_write_with() {}\npub fn read_index_capped() {}\npub fn write_index() {}\n",
        ),
    ]);
    assert!(
        graph["store/mod.rs"].contains("isotime.rs"),
        "crate:: 边应入图：{:?}",
        graph["store/mod.rs"]
    );
    assert!(
        graph["library.rs"].contains("library_fs.rs"),
        "花括号分组与组内 self 都应解析到目标模块：{:?}",
        graph["library.rs"]
    );
    assert!(
        graph["library/group_commands.rs"].contains("library/diagnostics.rs"),
        "super:: 边应入图：{:?}",
        graph["library/group_commands.rs"]
    );
    // cfg(test) 文件 mod（helper.rs）、inline tests 块、项级 fn 与宏体
    // 内的 use 都不得产生边
    assert!(
        !graph.contains_key("library/helper.rs"),
        "cfg(test) 文件 mod 不入图"
    );
    assert!(
        !graph["library.rs"].contains("store/persist.rs"),
        "cfg(test) inline 块内的 use 不计边"
    );
    assert!(
        graph["library/error.rs"].is_empty(),
        "cfg(test) 项级 fn 体内的 use 不计边"
    );
    assert!(
        graph["store/persist.rs"].is_empty(),
        "macro_rules 体整块跳过（登记盲区），re-export 宏是裸路径不计边"
    );
}

#[test]
#[should_panic(expected = "找不到对应文件")]
fn missing_mod_file_fails_closed() {
    cycles(&[("lib.rs", "mod ghost;\n")]);
}

#[test]
#[should_panic(expected = "越过 crate 根")]
fn super_beyond_crate_root_fails_closed() {
    cycles(&[("lib.rs", "mod a;\n"), ("a.rs", "use super::super::x;\n")]);
}

#[test]
fn real_repository_module_graph_is_acyclic() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: BTreeMap<ModuleKey, String> = BTreeMap::new();
    load_sources(&dir, &mut files, "");
    assert!(files.len() >= 60, "src 文件数异常偏少：{}", files.len());
    let graph = build_graph(&files);
    // 解析完整性抽样：已知生产边必须在图中（防扫描器静默漏采）
    assert!(
        graph
            .get("media_protocol.rs")
            .is_some_and(|t| t.contains("library_fs.rs")),
        "media_protocol → library_fs 边缺失（扫描器漏采？）"
    );
    assert!(
        graph
            .get("library/group_commands.rs")
            .is_some_and(|t| t.contains("library/diagnostics.rs")),
        "group_commands → diagnostics 的 super:: 边缺失（扫描器漏采？）"
    );
    // 测试设施与二进制入口不入图
    for excluded in ["main.rs", "conf.rs", "testhttp.rs", "library/tests.rs"] {
        assert!(!graph.contains_key(excluded), "{excluded} 不应在生产图中");
    }
    let found = cycles_of(&graph);
    assert!(
        found.is_empty(),
        "src-tauri/src 模块图存在环（issue #399 守卫）：{found:?}"
    );
}
