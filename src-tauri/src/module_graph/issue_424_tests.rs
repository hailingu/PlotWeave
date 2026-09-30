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
fn tuple_test_fields_exclude_generic_dependencies() {
    // 丢失字段类型上下文会让测试常量里的 use 制造假环。
    let ty = "Pair<u8, [u8; { use crate::c::C; 1 }]>";
    let gated = format!("#[cfg(test)] {ty}");
    let named = format!("#[cfg(test)] probe: {ty}");
    let production = "[u8; { use crate::b::B; 1 }]";
    for item in [
        format!("struct S({gated}, {production});"),
        format!("struct S({gated}, {production},);"),
        format!("struct S(#[allow(dead_code)] {gated}, {production});"),
        format!("struct S(#[cfg(test)] pub {ty}, {production});"),
        format!("struct S(#[cfg(test)] pub(crate) {ty}, {production});"),
        format!("struct S(#[cfg(test)] pub(in crate::a) {ty}, {production});"),
        format!("struct S(#[cfg(test)] ({ty},), {production});"),
        format!("struct S(#[cfg(test)] [{ty}; 1], {production});"),
        format!("struct S(#[cfg(test)] &'static {ty}, {production});"),
        format!("struct S<T>({gated}, T, {production}) where T: Fn() -> Result<u8, u16>;"),
        format!("enum E {{ V({gated}, {production}), Unit }}"),
        format!("enum E {{ V({gated}, {production}) }}"),
        format!("enum E<T> where T: Fn() -> Result<u8, u16> {{ V({gated}, T, {production}) }}"),
        format!("enum E {{ V {{ {named}, production: {production} }} }}"),
        format!("struct S<T> where T: Fn() -> Result<u8, u16> {{ {named}, marker: T, production: {production} }}"),
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &item),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["b.rs".into()]), "{item}");
        assert!(cycles_of(&graph).is_empty(), "测试字段不得制造生产假环：{item}");
    }
}

#[test]
fn last_test_fields_preserve_following_production_cycles() {
    // 最后一个测试字段/变体无尾逗号时仍必须恢复在列表闭合处。
    for item in [
        "struct S(#[cfg(test)] Pair<u8, [u8; { use crate::c::C; 1 }]>);",
        "struct S(#[cfg(test)] pub(crate) Pair<u8, [u8; { use crate::c::C; 1 }]>);",
        "struct S(#[cfg(test)] (Pair<u8, [u8; { use crate::c::C; 1 }]>));",
        "struct S(#[cfg(test)] [u8; { use crate::c::C; 1 }]);",
        "struct S { #[cfg(test)] probe: Pair<u8, [u8; { use crate::c::C; 1 }]> }",
        "enum E { V(#[cfg(test)] Pair<u8, [u8; { use crate::c::C; 1 }]>) }",
        "enum E { V { #[cfg(test)] probe: Pair<u8, [u8; { use crate::c::C; 1 }]> } }",
        "enum E { #[cfg(test)] V(Pair<u8, [u8; { use crate::c::C; 1 }]>) }",
        "enum E { #[cfg(test)] V { probe: [u8; { use crate::c::C; 1 }] } }",
        "enum E { #[cfg(test)] Unit }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("{item} use crate::b::B;")),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["b.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "后续生产真环必须检出：{item}");
    }
}

#[test]
fn test_field_const_expressions_preserve_production_uses() {
    // 字段常量块里的测试语句是表达式，不能继承外层字段类型状态。
    for expression in [
        "#[cfg(test)] value < limit;",
        "#[cfg(test)] |x: u32| x < limit;",
        "#[cfg(test)] let less = value < limit;",
        "#[cfg(test)] 'label: loop { use crate::c::C; break 'label; }",
    ] {
        for declaration in [
            format!("struct S([u8; {{ {expression} use crate::b::B; 1 }}]);"),
            format!("enum E {{ V([u8; {{ {expression} use crate::b::B; 1 }}]) }}"),
        ] {
            let graph = edges(&[
                ("lib.rs", "mod a; mod b; mod c;"),
                ("a.rs", &declaration),
                ("b.rs", "use crate::a::A;"),
                ("c.rs", "pub struct C;"),
            ]);
            assert_eq!(
                graph["a.rs"],
                BTreeSet::from(["b.rs".into()]),
                "{declaration}"
            );
            assert_eq!(cycles_of(&graph).len(), 1, "{declaration}");
        }
    }
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
fn bare_test_closures_preserve_following_production_cycles() {
    // 闭包参数和返回类型内的分隔符不得泄漏测试边，也不得吞掉后续真环。
    for item in [
        "#[cfg(test)] |x: u32| x < limit;",
        "#[cfg(test)] move |x: u32| x < limit;",
        "#[cfg(test)] async |x: u32| x < limit;",
        "#[cfg(test)] async move |x: u32| x < limit;",
        "#[cfg(test)] |x, y| { use crate::b::B; x + y };",
        "#[cfg(test)] || { use crate::b::B; };",
        "#[cfg(test)] move || { use crate::b::B; };",
        "#[cfg(test)] |x: Result<u32, ()>, y: (u8, u8)| { use crate::b::B; };",
        "#[cfg(test)] |x: [u8; { use crate::b::B; 1 | 2 }]| { use crate::b::B; };",
        "#[cfg(test)] |x: u32| -> Result<u32, ()> { use crate::b::B; Ok(x) };",
        "#[cfg(test)] |x: u32| -> [u8; { use crate::b::B; 2 }] { use crate::b::B; [0; 2] };",
        "#[cfg(test)] |(Ok(x) | Err(x)): Result<u32, u32>| { use crate::b::B; };",
        "#[cfg(test)] |x: u32| x < limit || x > limit;",
        "#[cfg(test)] |x: u32| x | limit;",
        "#[cfg(test)] |x: u32| make::<u8, u16>(x);",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ {item} use crate::c::C; }}")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(
            cycles_of(&graph).len(),
            1,
            "闭包之后的生产真环必须检出：{item}"
        );
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
