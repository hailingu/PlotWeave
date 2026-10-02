//! issue #424 的别名目标资格回归：符号绑定不得虚构模块子路径与依赖环。

use super::module_graph_tests::edges;
use super::*;

/// 捕获函数别名被截为祖先模块后拼接 child，制造不存在的文件依赖与环。
#[test]
fn namespace_disjoint_aliases_exclude_false_child_edges() {
    let function = "use crate::a::f as dep;";
    let module = "use crate::b as dep;";
    for aliases in [
        format!("{function} {module}"),
        format!("{module} {function}"),
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod host;"),
            ("a/mod.rs", "pub fn f() {} pub mod child;"),
            ("a/child.rs", "use crate::host::H; pub struct X;"),
            ("b/mod.rs", "pub mod child;"),
            ("b/child.rs", "pub struct X;"),
            (
                "host.rs",
                &format!("pub struct H; use dep::child::X; {aliases}"),
            ),
        ]);
        assert_eq!(
            graph["host.rs"],
            BTreeSet::from(["a/mod.rs".into(), "b/mod.rs".into(), "b/child.rs".into()]),
            "函数导入保留所有者边，但不得重定向到 a/child",
        );
        assert!(cycles_of(&graph).is_empty(), "函数别名不得制造假环");
    }
}

/// 捕获资格过滤误删真实模块候选：其反向依赖必须继续形成可检测的环。
#[test]
fn namespace_disjoint_aliases_preserve_module_cycles() {
    let function = "use crate::a::f as dep;";
    let module = "use crate::b as dep;";
    for aliases in [
        format!("{function} {module}"),
        format!("{module} {function}"),
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod host;"),
            ("a/mod.rs", "pub fn f() {} pub mod child;"),
            ("a/child.rs", "use crate::host::H; pub struct X;"),
            ("b/mod.rs", "pub mod child;"),
            ("b/child.rs", "use crate::host::H; pub struct X;"),
            (
                "host.rs",
                &format!("pub struct H; use dep::child::X; {aliases}"),
            ),
        ]);
        assert_eq!(
            graph["host.rs"],
            BTreeSet::from(["a/mod.rs".into(), "b/mod.rs".into(), "b/child.rs".into()]),
        );
        assert_eq!(cycles_of(&graph).len(), 1, "仅真实模块依赖形成环");
    }
}

/// 捕获 self/super 位置解析退化：完整模块别名保留真实边，符号尾段不展开。
#[test]
fn relative_namespace_aliases_resolve_exact_modules() {
    for imports in [
        "use self::f as dep; use self::b as dep; use dep::child::X;",
        "mod inner { use super::f as dep; use super::b as dep; use dep::child::X; }",
        "mod outer { mod inner { use super::super::f as dep; use super::super::b as dep; use dep::child::X; } }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod host;"),
            (
                "host/mod.rs",
                &format!("pub struct H; pub fn f() {{}} pub mod b; pub mod child; {imports}"),
            ),
            ("host/child.rs", "use crate::host::H; pub struct X;"),
            ("host/b/mod.rs", "pub mod child;"),
            ("host/b/child.rs", "use crate::host::H; pub struct X;"),
        ]);
        assert_eq!(
            graph["host/mod.rs"],
            BTreeSet::from(["host/b/mod.rs".into(), "host/b/child.rs".into()]),
        );
        assert_eq!(cycles_of(&graph).len(), 1, "相对模块别名的真环必须检出");
    }
}

/// 捕获先过滤非模块再选作用域的错误：内层 enum 别名不得复活外层模块。
#[test]
fn inner_type_aliases_do_not_restore_outer_module_candidates() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod b; mod host;"),
        ("a/mod.rs", "pub enum Thing { Child } pub mod Child;"),
        ("a/Child.rs", "use crate::host::H;"),
        ("b/mod.rs", "pub mod Child;"),
        ("b/Child.rs", "use crate::host::H;"),
        (
            "host.rs",
            concat!(
                "pub struct H; use crate::b as dep;",
                "fn inner() { use crate::a::Thing as dep; use dep::Child; }",
            ),
        ),
    ]);
    assert_eq!(
        graph["host.rs"],
        BTreeSet::from(["a/mod.rs".into(), "b/mod.rs".into()]),
    );
    assert!(cycles_of(&graph).is_empty(), "内层类型不得引入外层模块候选");
}
