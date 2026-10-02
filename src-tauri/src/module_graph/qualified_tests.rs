//! 评审 5381066396：显式位置前缀之后的别名/glob 仍须展开，且名字查找
//! 必须发生在指定模块的命名空间，而非使用点所在的普通块作用域。
//! 评审 4157263363：字面模块/已展开别名之后的尾段也必须逐段解析。

use super::module_graph_tests::edges;
use super::*;

/// 抓住 self::p 被当成字面子模块而丢失 a/b 边及其真实反向环。
#[test]
fn qualified_self_aliases_preserve_cycles() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X; use crate::user::U;"),
        (
            "user.rs",
            "pub struct U; use crate::a as p; use self::p::b as q; use q::X;",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("a/b.rs"),
        "self 别名链丢边：{:?}",
        graph["user.rs"]
    );
    assert_eq!(cycles_of(&graph).len(), 1, "self 别名链必须闭合真实环");
}

/// crate/super（含连续 super）须读取目标模块所属文件的绑定，不能沿用
/// 当前文件的同名别名；只修 self 分支会让这些等价合法入口继续漏检。
#[test]
fn qualified_root_and_parent_aliases_preserve_cycles() {
    for (prefix, nested) in [("crate", false), ("super", false), ("super::super", true)] {
        let user = format!("pub struct U; use {prefix}::p::b as q; use q::X;");
        let user_key = if nested { "outer/user.rs" } else { "user.rs" };
        let mut files = vec![
            ("lib.rs", "mod a; use crate::a as p; mod user;"),
            ("a/mod.rs", "pub mod b;"),
            ("a/b.rs", "pub struct X; use crate::user::U;"),
            (user_key, user.as_str()),
        ];
        if nested {
            files[0].1 = "mod a; use crate::a as p; mod outer;";
            files[2].1 = "pub struct X; use crate::outer::user::U;";
            files.push(("outer/mod.rs", "pub mod user;"));
        }
        let graph = edges(&files);
        assert!(
            graph[user_key].contains("a/b.rs"),
            "{prefix} 别名链丢边：{:?}",
            graph[user_key]
        );
        assert_eq!(cycles_of(&graph).len(), 1, "{prefix} 别名链必须闭合真实环");
    }
}

/// self/crate/super 后由 glob 引入的首段也须展开；链式 glob 最末目标
/// 应成边，不能仅保留显式前缀所属文件的边。
#[test]
fn qualified_glob_prefixes_preserve_cycles() {
    for prefix in ["self", "crate", "super"] {
        let imported = "use crate::a::*;";
        let user = if prefix == "self" {
            format!("pub struct U; {imported} use self::b::*; use c::X;")
        } else {
            format!("pub struct U; use {prefix}::b::*; use c::X;")
        };
        let lib = if prefix == "self" {
            "mod a; mod user;".to_string()
        } else {
            format!("mod a; mod user; {imported}")
        };
        let graph = edges(&[
            ("lib.rs", &lib),
            ("a/mod.rs", "pub mod b;"),
            ("a/b/mod.rs", "pub mod c;"),
            ("a/b/c.rs", "pub struct X; use crate::user::U;"),
            ("user.rs", &user),
        ]);
        assert!(
            graph["user.rs"].contains("a/b/c.rs"),
            "{prefix} glob 链丢边：{:?}",
            graph["user.rs"]
        );
        assert_eq!(cycles_of(&graph).len(), 1, "限定 glob 链必须闭合真实环");
    }
}

/// 显式 self 查模块命名空间：函数块里同名的别名不能遮蔽模块级 p。
#[test]
fn qualified_self_ignores_block_alias_shadowing() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod other; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X; use crate::user::U;"),
        ("other/mod.rs", "pub mod b;"),
        ("other/b.rs", "pub struct X; use crate::user::U;"),
        ("user.rs", "pub struct U; use crate::a as p; fn local() { use crate::other as p; use self::p::b as q; use q::X; }"),
    ]);
    assert!(
        graph["user.rs"].contains("a/b.rs"),
        "限定名字必须读取模块级别名"
    );
    assert!(
        !graph["user.rs"].contains("other/b.rs"),
        "块别名不能虚构限定模块边"
    );
    assert_eq!(cycles_of(&graph).len(), 1, "只保留模块级别名的真实环");
}

/// 指定父 inline 模块时可显式访问其绑定；bare 路径仍不继承父引入。
#[test]
fn qualified_parent_inline_aliases_use_the_declaring_namespace() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X; use crate::user::U;"),
        ("user.rs", "pub struct U; mod outer { use crate::a as p; mod inner { use super::p::b as q; use q::X; } }"),
    ]);
    assert!(
        graph["user.rs"].contains("a/b.rs"),
        "父 inline 模块别名未展开"
    );
    assert_eq!(cycles_of(&graph).len(), 1, "inline 位置解析必须保留真实环");
}

/// 同名平台绑定在限定命名空间下仍取并集；外部别名则不产生内部子边。
#[test]
fn qualified_aliases_keep_platform_union_and_external_boundaries() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod other; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X;"),
        ("other/mod.rs", "pub mod b;"),
        ("other/b.rs", "pub struct X;"),
        ("user.rs", "#[cfg(unix)] use crate::a as p; #[cfg(windows)] use crate::other as p; use self::p::b as q; use q::X; use std as ext; use self::ext::io as io;"),
    ]);
    assert_eq!(
        graph["user.rs"],
        BTreeSet::from([
            "a/mod.rs".into(),
            "a/b.rs".into(),
            "other/mod.rs".into(),
            "other/b.rs".into(),
        ]),
        "平台目标都保留，外部限定别名不引入虚边"
    );
}

/// 评审 4157263363：真实文件/inline 子模块之后的别名不能止于中间所有者。
#[test]
fn qualified_literals_then_aliases_preserve_cycles() {
    for prefix in ["crate", "super", "self"] {
        for suffix in ["p::b::X;", "p::b as q; use q::X;"] {
            let nested = if prefix == "self" {
                "mod m { pub(crate) use crate::a as p; }"
            } else {
                ""
            };
            let user = format!("pub struct U; {nested} use {prefix}::m::{suffix}");
            let lib = if prefix == "self" {
                "mod a; mod user;"
            } else {
                "mod a; mod m; mod user;"
            };
            let graph = edges(&[
                ("lib.rs", lib),
                ("a/mod.rs", "pub mod b;"),
                ("a/b.rs", "pub struct X; use crate::user::U;"),
                ("m.rs", "pub(crate) use crate::a as p;"),
                ("user.rs", &user),
            ]);
            assert!(
                graph["user.rs"].contains("a/b.rs"),
                "{prefix}::{suffix} 丢失目标边"
            );
            assert_eq!(cycles_of(&graph).len(), 1, "字面模块后的别名必须闭合真实环");
        }
    }
}

/// 指定模块命名空间中的 glob 在字面段之后仍可引入子模块。
#[test]
fn qualified_literals_then_globs_preserve_cycles() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod m; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X; use crate::user::U;"),
        ("m.rs", "pub(crate) use crate::a::*;"),
        ("user.rs", "pub struct U; use crate::m::b::X;"),
    ]);
    assert!(
        graph["user.rs"].contains("a/b.rs"),
        "字面模块后的 glob 不能丢边"
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "字面模块后的 glob 必须闭合真实环"
    );
}

/// 裸别名/限定入口的尾段都须跨过更多字面模块，逐次切换命名空间。
#[test]
fn qualified_alias_suffixes_cross_more_namespaces() {
    for imports in [
        "use crate::m::p::b::r::c::X;",
        "use crate::m as outer; use outer::p::b::r::c::X;",
    ] {
        let user = format!("pub struct U; {imports}");
        let graph = edges(&[
            ("lib.rs", "mod a; mod m; mod other; mod user;"),
            ("a/mod.rs", "pub mod b;"),
            ("a/b.rs", "pub(crate) use crate::other as r;"),
            ("m.rs", "pub(crate) use crate::a as p;"),
            ("other/mod.rs", "pub mod c;"),
            ("other/c.rs", "pub struct X; use crate::user::U;"),
            ("user.rs", &user),
        ]);
        assert!(
            graph["user.rs"].contains("other/c.rs"),
            "跨命名空间别名尾段丢边"
        );
        assert_eq!(
            cycles_of(&graph).len(),
            1,
            "每次切换命名空间都必须保留真实环"
        );
    }
}

/// 中途别名保持平台并集；同名函数绑定不可虚构模块后缀。
#[test]
fn qualified_literal_aliases_keep_platform_union_and_symbol_boundaries() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod m; mod other; mod values; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X;"),
        ("other/mod.rs", "pub mod b;"),
        ("other/b.rs", "pub struct X;"),
        ("values/mod.rs", "pub fn make() {} pub mod b;"),
        ("values/b.rs", "pub struct X;"),
        ("m.rs", "#[cfg(unix)] pub(crate) use crate::a as p; #[cfg(windows)] pub(crate) use crate::other as p; pub(crate) use crate::values::make as p;"),
        ("user.rs", "use crate::m::p::b as q; use q::X;"),
    ]);
    assert_eq!(
        graph["user.rs"],
        BTreeSet::from(["m.rs".into(), "a/b.rs".into(), "other/b.rs".into(),]),
        "中途别名保留两个精确模块目标，不扩展函数所有者的子模块"
    );
}

/// 字面段只缩短剩余路径，不消耗别名绑定递归预算。
#[test]
fn qualified_literal_depth_does_not_spend_alias_budget() {
    let names: Vec<_> = (0..9).map(|i| format!("n{i}")).collect();
    let m = format!(
        "{} pub(crate) use crate::a as p; {}",
        names
            .iter()
            .map(|n| format!("pub(crate) mod {n} {{ "))
            .collect::<String>(),
        "}".repeat(names.len())
    );
    let user = format!("pub struct U; use crate::m::{}::p::b::X;", names.join("::"));
    let graph = edges(&[
        ("lib.rs", "mod a; mod m; mod user;"),
        ("a/mod.rs", "pub mod b;"),
        ("a/b.rs", "pub struct X; use crate::user::U;"),
        ("m.rs", &m),
        ("user.rs", &user),
    ]);
    assert!(
        graph["user.rs"].contains("a/b.rs"),
        "深字面路径仍应展开短别名链"
    );
    assert_eq!(cycles_of(&graph).len(), 1, "字面段不能提前耗尽别名预算");
}
