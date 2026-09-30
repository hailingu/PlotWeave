//! issue #424 的泛型测试项排除、生产扫描恢复与平台别名并集回归。

use super::module_graph_tests::edges;
use super::*;

#[test]
fn generic_test_items_do_not_create_production_cycles() {
    // 泛型列表里的逗号不得让测试函数/impl 的 use 泄漏成生产依赖。
    for item in [
        "#[cfg(test)] fn helper<T, U>() { use crate::b::B; }",
        "#[cfg(all(test, unix))] fn helper<T: Into<(u8, u8)>, U>() { use crate::b::B; }",
        "#[cfg(test)] pub(crate) fn helper<T, U>() { use crate::b::B; }",
        "#[cfg(test)] impl<T, U> Pair<T, U> { fn helper() { use crate::b::B; } }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("{item} use crate::c::C;")),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]));
        assert!(cycles_of(&graph).is_empty(), "测试依赖不得制造生产环");
    }
}

#[test]
fn generic_test_fields_resume_at_the_next_field() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod b; mod c;"),
        (
            "a.rs",
            concat!(
                "struct S { #[cfg(test)] probe: Pair<(u8, u8), [u8; { use crate::c::C; 2 }]>, ",
                "production: [u8; { use crate::b::B; 1 }] }",
            ),
        ),
        ("b.rs", "pub struct B;"),
        ("c.rs", "pub struct C;"),
    ]);
    assert_eq!(graph["a.rs"], BTreeSet::from(["b.rs".into()]));
}

#[test]
fn grouped_test_item_headers_are_skipped_in_full() {
    for item in [
        "#[cfg(test)] fn helper(pair: (u8, u8), arr: [u8; 2]) { use crate::b::B; }",
        "#[cfg(test)] type Alias<T, U> = Pair<T, [u8; { use crate::b::B; 2 }]>;",
        "#[cfg(test)] struct Pair(u8, u8);",
        "#[cfg(test)] struct Pair<T, const N: usize = { use crate::b::B; 2 }> { value: T }",
        "#[cfg(test)] fn helper<T: Fn() -> Result<U, ()>, U>() { use crate::b::B; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("{item} use crate::c::C;")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]));
    }
}

#[test]
fn test_comparisons_do_not_swallow_following_production_uses() {
    for item in [
        "#[cfg(test)] let less = 1 < 2;",
        "#[cfg(test)] if 1 < 2 { use crate::b::B; } else { use crate::b::B; }",
        "#[cfg(test)] static LESS: bool = 1 < 2;",
        "#[cfg(test)] let predicate = |x: u32| x < limit;",
        "#[cfg(test)] 'retry: while attempt < limit { use crate::b::B; }",
        "#[cfg(test)] let value = make::<u8, u16>();",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ {item} use crate::c::C; }}")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]));
    }
}

#[test]
fn platform_alias_union_is_independent_of_declaration_order() {
    let a = "#[cfg(unix)] use crate::a as dep;";
    let b = "#[cfg(windows)] use crate::b as dep;";
    for aliases in [format!("{a} {b}"), format!("{b} {a}")] {
        for (a_child, b_child) in [
            ("use crate::host::H;", "pub struct X;"),
            ("pub struct X;", "use crate::host::H;"),
        ] {
            let graph = edges(&[
                ("lib.rs", "mod a; mod b; mod host;"),
                ("a/mod.rs", "mod child;"),
                ("a/child.rs", a_child),
                ("b/mod.rs", "mod child;"),
                ("b/child.rs", b_child),
                ("host.rs", &format!("use dep::child::X; {aliases}")),
            ]);
            assert_eq!(
                graph["host.rs"],
                BTreeSet::from([
                    "a/mod.rs".into(),
                    "b/mod.rs".into(),
                    "a/child.rs".into(),
                    "b/child.rs".into(),
                ]),
            );
            assert_eq!(cycles_of(&graph).len(), 1, "任一平台的反向边均应成环");
        }
    }
}

#[test]
fn inner_alias_union_shadows_all_outer_candidates() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod b; mod c; mod d; mod host;"),
        ("a/mod.rs", "mod child;"),
        ("a/child.rs", "pub struct X;"),
        ("b/mod.rs", "mod child;"),
        ("b/child.rs", "pub struct X;"),
        ("c/mod.rs", "mod child;"),
        ("c/child.rs", "pub struct X;"),
        ("d/mod.rs", "mod child;"),
        ("d/child.rs", "pub struct X;"),
        (
            "host.rs",
            concat!(
                "#[cfg(unix)] use crate::a as dep; #[cfg(windows)] use crate::b as dep;",
                "fn f() { use dep::child::X;",
                "#[cfg(unix)] use crate::c as dep; #[cfg(windows)] use crate::d as dep; }",
            ),
        ),
    ]);
    assert_eq!(
        graph["host.rs"],
        BTreeSet::from([
            "a/mod.rs".into(),
            "b/mod.rs".into(),
            "c/mod.rs".into(),
            "d/mod.rs".into(),
            "c/child.rs".into(),
            "d/child.rs".into(),
        ])
    );
}

#[test]
fn test_only_platform_aliases_do_not_join_production_union() {
    let graph = edges(&[
        ("lib.rs", "mod a; mod b; mod host;"),
        ("a/mod.rs", "mod child;"),
        ("a/child.rs", "pub struct X;"),
        ("b/mod.rs", "mod child;"),
        ("b/child.rs", "pub struct X;"),
        (
            "host.rs",
            concat!(
                "#[cfg(all(test, unix))] use crate::a as dep;",
                "#[cfg(windows)] use crate::b as dep; use dep::child::X;",
            ),
        ),
    ]);
    assert_eq!(
        graph["host.rs"],
        BTreeSet::from(["b/mod.rs".into(), "b/child.rs".into()])
    );
}
