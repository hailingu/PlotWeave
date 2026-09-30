//! module_graph 守卫的测试（issue #399）：#146 形态反例夹具自证检出、
//! 合法分层与门控排除不误报、fail-closed 语义、真实仓库无环断言。

use super::*;

/// 夹具图 → 环清单（构图失败直接 panic，与守卫 fail-closed 语义一致）。
fn cycles(files: &[(&str, &str)]) -> Vec<String> {
    let map = to_map(files);
    cycles_of(&build_graph(&map))
}

/// 夹具图 → 边集（解析完整性断言用）。
pub(super) fn edges(files: &[(&str, &str)]) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
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
                "#[cfg(test)]\n#[path = \"anywhere.rs\"]\nmod pathed;\n",
                "#[cfg(all(test, unix))]\nmod unix_only_tests;\n",
                "#[cfg(any(test, feature = \"diag\"))]\nmod diag_extras;\n",
                "#[cfg(test)]\nmod tests {\n    use super::*;\n    use crate::store::persist::P;\n}\n",
                "use crate::library_fs::{read_index_capped, self};\n",
            ),
        ),
        ("library/helper.rs", "use crate::store::persist::P;\n"),
        (
            "library/unix_only_tests.rs",
            "use crate::store::persist::P;\n",
        ),
        (
            "library/diag_extras.rs",
            "use crate::isotime::now_iso;\n",
        ),
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
    // 评审 5347759049：all(test, unix) 蕴含 test → 不入图；any(test,
    // feature) 不蕴含（feature 成立时仍生产）→ 保守计入并保留其边
    assert!(
        !graph.contains_key("library/unix_only_tests.rs"),
        "cfg(all(test, unix)) 蕴含 test，不得入图"
    );
    assert!(
        graph["library/diag_extras.rs"].contains("isotime.rs"),
        "cfg(any(test, feature)) 按平台并集保守计入：{:?}",
        graph["library/diag_extras.rs"]
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
fn raw_identifiers_do_not_swallow_following_uses() {
    // 评审 5347759049：r#type 是裸标识符而非 raw string 起点，此前被
    // 误判后整段抹到文件尾，后续 mod/use 静默失采（漏环比误报危险）；
    // 真 raw string 内容中的 mod/use 文本仍须被抹除、不产生假边
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            concat!(
                "fn f() { let r#type = 1; }\n",
                "let r#use = 1;\n",
                "use crate::b::B;\n",
                "let s = r#\"mod ghost; use crate::ghost::G;\"#;\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "裸标识符后的 use 必须仍被采集：{:?}",
        graph["a.rs"]
    );
    assert_eq!(
        graph["a.rs"].len(),
        1,
        "raw string 内容中的 mod/use 文本不得产生边：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn cfg_test_macro_does_not_leak_gating_to_following_items() {
    // 评审 5349783070：#[cfg(test)] macro_rules! 后的生产 use 不得继承
    // 门控（泄漏会静默漏采，真环对守卫隐形）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            "#[cfg(test)]\nmacro_rules! probe { () => {} }\nuse crate::b::B;\n",
        ),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "宏后的生产 use 必须照常入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn file_mod_inside_inline_module_resolves_nested_directory() {
    // 评审 5349783070：`mod outer { mod child; }` 的 child 文件在
    // outer 对应的嵌套子目录（foo/outer/child.rs），且挂在 outer 路径下
    let graph = edges(&[
        ("lib.rs", "mod foo;\nuse crate::foo::outer::child::C;\n"),
        ("foo.rs", "mod outer { pub mod child; }\n"),
        ("foo/outer/child.rs", "pub struct C;\n"),
    ]);
    assert!(
        graph["lib.rs"].contains("foo/outer/child.rs"),
        "inline 模块内的文件子模块应解析到嵌套目录：{:?}",
        graph["lib.rs"]
    );
    assert!(
        graph.contains_key("foo/outer/child.rs"),
        "嵌套子模块文件应在图中作为节点"
    );
}

#[test]
fn cfg_test_statement_attributes_do_not_leak_gating() {
    // 评审 5349970852：#[cfg(test)] let 语句门控不得泄漏到其后的生产
    // use（漏采会让依赖该边的真环对守卫隐形）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            concat!(
                "fn probe() {\n",
                "    #[cfg(test)]\n",
                "    let marker = 1;\n",
                "    use crate::b::B;\n",
                "}\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "门控语句之后的生产 use 必须照常入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn raw_identifier_module_names_resolve_normalized() {
    // 评审 5349970852：mod r#type 的文件是 type.rs；use crate::r#type::T
    // 须按裸名匹配模块树，不得对合法 Rust fail-closed
    let graph = edges(&[
        ("lib.rs", "mod r#type;\nuse crate::r#type::Thing;\n"),
        ("type.rs", "pub struct Thing;\n"),
    ]);
    assert!(
        graph["lib.rs"].contains("type.rs"),
        "裸标识符模块名应归一化解析：{:?}",
        graph["lib.rs"]
    );
}

#[test]
fn imports_targeting_inline_modules_resolve_to_containing_file() {
    // 评审 5350168645：use crate::foo::inner::T 的目标是 inline 模块，
    // 其身份 = 声明文件 foo.rs——漏采该边会让 foo → b → foo 的环隐形
    let found = cycles(&[
        ("lib.rs", "mod foo;\nmod b;\n"),
        ("foo.rs", "mod inner { pub struct T; }\nuse crate::b::B;\n"),
        ("b.rs", "use crate::foo::inner::T;\n"),
    ]);
    assert_eq!(
        found.len(),
        1,
        "指向 inline 模块的依赖应成边构成环：{found:?}"
    );
    assert!(
        found[0].contains("foo.rs") && found[0].contains("b.rs"),
        "环路径应定位到声明文件：{found:?}"
    );
}

#[test]
fn cfg_test_if_else_statement_skips_all_arms() {
    // 评审 5350168645：#[cfg(test)] if/else 只跳首个块会把 else 臂当
    // 生产代码误采（测试专属依赖可能制造假环阻断 cargo test）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\nmod c;\n"),
        (
            "a.rs",
            concat!(
                "#[cfg(test)]\n",
                "if flag { let x = 1; } else { use crate::c::C2; }\n",
                "use crate::b::B;\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
        ("c.rs", "pub struct C2;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "else 臂之后的生产 use 必须照常入图：{:?}",
        graph["a.rs"]
    );
    assert!(
        !graph["a.rs"].contains("c.rs"),
        "else 臂内 cfg(test) 的 use 不得入生产图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn mutually_exclusive_platform_declarations_coalesce() {
    // 评审 5350168645：#[cfg(unix)] 与 #[cfg(windows)] 声明同一模块是
    // 合法跨平台形态，平台并集口径应合并而非判重复 panic
    let graph = edges(&[
        (
            "lib.rs",
            "#[cfg(unix)]\nmod platform;\n#[cfg(windows)]\nmod platform;\nmod user;\n",
        ),
        ("platform.rs", "pub struct P;\n"),
        ("user.rs", "use crate::platform::P;\n"),
    ]);
    assert!(
        graph["user.rs"].contains("platform.rs"),
        "合并后的平台模块应正常解析：{:?}",
        graph["user.rs"]
    );
}

#[test]
fn inline_alias_paths_do_not_rescan_containing_file() {
    // 评审 5350339687：inline 别名只用于解析目标，不得以别名路径重扫
    // 所在文件——use 的栈快照叠加到已抬高的路径会虚构错误边：此处
    // outer 别名扫描会把 use super::sibling 解析到 outer 内同名的
    // foo/outer/sibling.rs（rustc 实图是 foo/sibling.rs），与该文件对
    // crate::foo 的正常依赖组合成 rustc 图中不存在的假环
    let found = cycles(&[
        ("lib.rs", "mod foo;\n"),
        (
            "foo.rs",
            concat!(
                "mod sibling;\n",
                "mod outer {\n",
                "    mod sibling;\n",
                "    use super::sibling::X;\n",
                "}\n",
            ),
        ),
        ("foo/sibling.rs", "pub struct X;\n"),
        ("foo/outer/sibling.rs", "use crate::foo::T;\n"),
    ]);
    assert!(
        found.is_empty(),
        "别名路径重扫虚构的边不得成环（真实目标为 foo/sibling.rs）：{found:?}"
    );
    let graph = edges(&[
        ("lib.rs", "mod foo;\n"),
        (
            "foo.rs",
            concat!(
                "mod sibling;\n",
                "mod outer {\n",
                "    mod sibling;\n",
                "    use super::sibling::X;\n",
                "}\n",
            ),
        ),
        ("foo/sibling.rs", "pub struct X;\n"),
        ("foo/outer/sibling.rs", "use crate::foo::T;\n"),
    ]);
    assert!(
        graph["foo.rs"].contains("foo/sibling.rs"),
        "规范扫描应把 use super::sibling 解析到 foo/sibling.rs：{:?}",
        graph["foo.rs"]
    );
}

#[test]
fn mixed_inline_and_file_backed_platform_variants_coexist() {
    // 评审 5350339687：#[cfg(unix)] mod platform {…} 与
    // #[cfg(windows)] mod platform; 是合法互斥变体——逻辑路径保留双
    // 所有者（平台并集口径），不得 panic 或静默覆盖掉文件变体
    let graph = edges(&[
        (
            "lib.rs",
            "#[cfg(unix)]\nmod platform { pub struct P; }\n#[cfg(windows)]\nmod platform;\nmod user;\n",
        ),
        ("platform.rs", "pub struct P;\n"),
        ("user.rs", "use crate::platform::P;\n"),
    ]);
    assert!(
        graph["user.rs"].contains("platform.rs"),
        "文件变体所有者不得被 inline 变体覆盖：{:?}",
        graph["user.rs"]
    );
    assert!(
        graph["lib.rs"].is_empty(),
        "inline 变体的载体就是声明文件，不产生额外边：{:?}",
        graph["lib.rs"]
    );
}

#[test]
fn inner_cfg_test_attribute_gates_the_whole_file() {
    // 评审 5350627153：#![cfg(test)] 是内属性，作用于整个外层模块——
    // 只挂起给首项会泄漏，同文件其余测试声明误入生产图（假环方向）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            "#![cfg(test)]\nuse crate::b::B;\nfn helper() {}\nuse crate::b::C;\n",
        ),
        ("b.rs", "pub struct B;\npub struct C;\n"),
    ]);
    assert!(
        graph["a.rs"].is_empty(),
        "内属性门控的文件内容整体不入生产图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn inner_cfg_test_attribute_in_inline_module_gates_its_body() {
    // 评审 5350627153 的 inline 形态：mod 体首的内属性门控该模块体，
    // 其后的生产声明照常入图
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\nmod c;\n"),
        (
            "a.rs",
            concat!(
                "mod gated {\n",
                "    #![cfg(test)]\n",
                "    use crate::c::C;\n",
                "}\n",
                "use crate::b::B;\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
        ("c.rs", "pub struct C;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "门控 inline 模块之后的生产 use 照常入图：{:?}",
        graph["a.rs"]
    );
    assert!(
        !graph["a.rs"].contains("c.rs"),
        "内属性门控的 inline 模块体内的 use 不得入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn brace_rooted_use_trees_expand() {
    // 评审 5350627153：`use {crate::a::A, crate::b::B};` 是合法 use 树，
    // 根级花括号须展开而非对首 token fail-closed panic
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\nmod c;\n"),
        ("a.rs", "use {crate::b::B, crate::c::C};\n"),
        ("b.rs", "pub struct B;\n"),
        ("c.rs", "pub struct C;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs") && graph["a.rs"].contains("c.rs"),
        "根级分组应展开为两条边：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn bare_imports_of_child_modules_resolve() {
    // 评审 5351210423：2018+ uniform paths——裸首段先按当前模块的直接
    // 子模块解析（library_journal.rs / store/mod.rs 的 facade→child 边
    // 即此形态），未命中才视为外部 crate；此前一律当外部丢弃会漏边，
    // 经该边闭合的环对守卫隐形
    let found = cycles(&[
        ("lib.rs", "mod parent;\n"),
        ("parent/mod.rs", "mod child;\nuse child::C;\n"),
        ("parent/child.rs", "use super::P;\n"),
    ]);
    assert_eq!(found.len(), 1, "裸路径子模块导入应成边构成环：{found:?}");
    let graph = edges(&[("lib.rs", "mod a;\n"), ("a.rs", "use serde_json::Value;\n")]);
    assert!(
        graph["a.rs"].is_empty(),
        "未命中子模块的裸路径仍是外部 crate，不入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn macro_rules_bracket_and_paren_bodies_are_skipped() {
    // 评审 5351210423：macro_rules 的 [ … ] 与 ( … ) 定界形态同样合法，
    // 宏体内的 use 不得记为真实生产依赖（假环方向）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            concat!(
                "macro_rules! probe [ ($o:expr) => { use crate::b::B; $o } ];\n",
                "macro_rules! probe2 ( ($o:expr) => { use crate::b::B2; $o } );\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert!(
        graph["a.rs"].is_empty(),
        "三种定界符的宏体内的 use 都不得入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn inner_attribute_in_nested_block_gates_only_that_block() {
    // 评审 5351437161：fn 体内的 #![cfg(test)] 只门控该块——此前按栈顶
    // inline 模块跳闭合会从更深的深度起算，吞掉其后全部生产代码（漏检）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\nmod c;\n"),
        (
            "a.rs",
            concat!(
                "mod outer {\n",
                "    fn probe() {\n",
                "        #![cfg(test)]\n",
                "        use crate::c::H;\n",
                "    }\n",
                "    use crate::b::B;\n",
                "}\n",
                "use crate::b::C;\n",
            ),
        ),
        ("b.rs", "pub struct B;\n"),
        ("c.rs", "pub struct H;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs"),
        "块外（inline 模块体与文件级）的生产 use 必须照常入图：{:?}",
        graph["a.rs"]
    );
    assert!(
        !graph["a.rs"].contains("c.rs"),
        "块内 cfg(test) 的 use 不得入图：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn leading_colon_external_imports_are_ignored() {
    // 评审 5351437161：use ::std::io; 前导冒号是合法绝对外部路径，
    // 不得 fail-closed panic，也不得入图
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        ("a.rs", "use ::std::io;\nuse crate::b::B;\n"),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert_eq!(
        graph["a.rs"].len(),
        1,
        "外部 ::std 不入图、本地边照常：{:?}",
        graph["a.rs"]
    );
    assert!(graph["a.rs"].contains("b.rs"));
}

#[test]
fn bare_imports_through_local_aliases_resolve() {
    // 评审 5351437161：use crate::a as alias 后 use alias::child::X 应
    // 解析到 a/child.rs——别名裸路径被当外部丢弃会漏边，环隐形
    let found = cycles(&[
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a/mod.rs", "mod child;\n"),
        ("a/child.rs", "use crate::user::U;\n"),
        ("user.rs", "use crate::a as alias;\nuse alias::child::X;\n"),
    ]);
    assert_eq!(found.len(), 1, "经别名的子模块导入应成边构成环：{found:?}");
}

#[test]
fn block_scoped_aliases_do_not_shadow_module_children() {
    // 评审 5351722665：fn 内 use crate::other as child 不得改写更早的
    // 模块级 use child::X——别名展开是替换而非叠加，误替换会让
    // host ↔ child 的真环对守卫隐形；子模块优先于别名
    let found = cycles(&[
        ("lib.rs", "mod host;\n"),
        (
            "host/mod.rs",
            concat!(
                "mod child;\n",
                "use child::X;\n",
                "fn f() { use crate::other::O as child; let _ = child::PATH; }\n",
            ),
        ),
        ("host/child.rs", "use crate::host::H;\n"),
    ]);
    assert_eq!(
        found.len(),
        1,
        "子模块 child 的边不得被块内别名替换丢失：{found:?}"
    );
    // 块内别名先声明后使用（别名名非子模块）仍照常展开
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a.rs", "pub struct T;\n"),
        (
            "user.rs",
            "fn f() { use crate::a as alias; use alias::T; }\n",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("a.rs"),
        "块内别名+块内使用按原能力展开：{:?}",
        graph["user.rs"]
    );
}

#[test]
fn alias_resolution_respects_lexical_scope() {
    // 评审 5352172371：两个作用域复用同一别名名，文件级首匹配会把
    // fn g 的 dep 错绑到 fn f 的 crate::a——b::child 边丢失、真环隐形；
    // 按词法可见性（作用域前缀 + 声明序在前）取最近声明的绑定
    let found = cycles(&[
        ("lib.rs", "mod host;\nmod a;\nmod b;\n"),
        ("a/mod.rs", "mod child;\n"),
        ("a/child.rs", "pub struct X;\n"),
        ("b/mod.rs", "mod child;\n"),
        ("b/child.rs", "use crate::host::H;\n"),
        (
            "host.rs",
            concat!(
                "fn f() { use crate::a as dep; let _ = dep::child::X; }\n",
                "fn g() { use crate::b as dep; use dep::child::X; }\n",
            ),
        ),
    ]);
    assert_eq!(
        found.len(),
        1,
        "fn g 的 dep 应绑定到 crate::b，与 b/child 的反向依赖成环：{found:?}"
    );
}

#[test]
#[should_panic(expected = "#[path]")]
fn path_attribute_mods_fail_closed() {
    // 评审 5352172371：#[path = "…"] 改变模块文件位置，清洗层不保留
    // 字面量值无法解析——生产 mod fail-closed 拒绝并给出明确诊断，
    // 优于静默探默认位置（误报或扫错文件）
    cycles(&[
        ("lib.rs", "#[path = \"alternate.rs\"]\nmod imp;\n"),
        ("alternate.rs", "pub struct I;\n"),
    ]);
}

#[test]
fn alias_visibility_spans_the_whole_scope() {
    // 评审 5353024715：use 引入的名字在整个包围作用域可见（含声明
    // 之前）——声明序过滤会把「先引用后声明」的合法形态错当外部，
    // a::child 边丢失、真环隐形
    let found = cycles(&[
        ("lib.rs", "mod host;\nmod a;\n"),
        ("a/mod.rs", "mod child;\n"),
        ("a/child.rs", "use crate::host::H;\n"),
        (
            "host.rs",
            "fn f() { use dep::child::X; use crate::a as dep; }\n",
        ),
    ]);
    assert_eq!(found.len(), 1, "先引用后声明的别名应正确绑定：{found:?}");
}

#[test]
fn empty_use_groups_are_accepted() {
    // 评审 5353024715：use crate::b::{}; 与 use {}; 是合法空组，
    // 不得 fail-closed panic，也不产生边
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        ("a.rs", "use crate::b::{};\nuse {};\nuse crate::b::B;\n"),
        ("b.rs", "pub struct B;\n"),
    ]);
    assert!(graph["a.rs"].contains("b.rs"));
    assert_eq!(graph["a.rs"].len(), 1, "空组不产生边：{:?}", graph["a.rs"]);
}

#[test]
fn cfg_test_field_does_not_swallow_following_code() {
    // 评审 5353260028：#[cfg(test)] 修饰的逗号终止元素（struct 字段、
    // enum 变体、元组元素、顶层 static）只跳过到其逗号/分号——不识别
    // 会把字段后的生产 use 吞掉（漏检方向，真环隐形）
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod b;\n"),
        (
            "a.rs",
            concat!(
                "struct S {\n",
                "    #[cfg(test)]\n",
                "    probe: u8,\n",
                "}\n",
                "use crate::b::B;\n",
                "#[cfg(test)]\n",
                "static FIX: u8 = 1,;\n",
                "use crate::b::C;\n",
            ),
        ),
        ("b.rs", "pub struct B;\npub struct C;\n"),
    ]);
    assert!(
        graph["a.rs"].contains("b.rs") && graph["a.rs"].len() == 1,
        "字段/静态后的生产 use 照常入图且各折叠为一条边：{:?}",
        graph["a.rs"]
    );
}

#[test]
fn leaf_bindings_without_as_resolve() {
    // 评审 5353260028：use crate::a::dep 不带 as 也把 dep 引入作用域，
    // 后续 use dep::child::X 须解析到 a/dep/child.rs——不登记裸绑定会漏边，
    // 反向依赖构成的环隐形
    let found = cycles(&[
        ("lib.rs", "mod host;\nmod a;\n"),
        ("a/mod.rs", "pub mod dep;\n"),
        ("a/dep/mod.rs", "pub mod child;\n"),
        ("a/dep/child.rs", "pub struct X; use crate::host;\n"),
        ("host.rs", "use crate::a::dep;\nuse dep::child::X;\n"),
    ]);
    assert_eq!(
        found.len(),
        1,
        "裸叶子绑定的后续引用应成边构成环：{found:?}"
    );
}

#[test]
fn raw_identifier_alias_names_normalize() {
    // 评审 5353260028：use crate::a as r#type 的别名名与 use r#type::x
    // 的路径段都按裸名 type 归一化，两边才能命中
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a.rs", "pub struct T;\n"),
        ("user.rs", "use crate::a as r#type;\nuse r#type::T;\n"),
    ]);
    assert!(
        graph["user.rs"].contains("a.rs"),
        "裸标识符别名应归一化命中：{:?}",
        graph["user.rs"]
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
    for excluded in [
        "main.rs",
        "conf.rs",
        "testhttp.rs",
        "library/tests.rs",
        // 评审 5347759049 的活触发点：cfg(all(test, unix)) 蕴含 test
        "prefs/read_boundary_tests.rs",
    ] {
        assert!(!graph.contains_key(excluded), "{excluded} 不应在生产图中");
    }
    let found = cycles_of(&graph);
    assert!(
        found.is_empty(),
        "src-tauri/src 模块图存在环（issue #399 守卫）：{found:?}"
    );
}
