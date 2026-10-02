//! issue #424 的 fn 参数类型门控、列表闭合与生产扫描恢复回归。

use super::module_graph_tests::edges;
use super::*;

/// 匿名/命名函数指针参数从类型状态跳过，泛型逗号不能泄漏测试依赖。
#[test]
fn test_function_pointer_parameters_do_not_create_production_cycles() {
    for item in [
        "type F = fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);",
        "type F = fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>);",
        "type F = fn(#[cfg(test)] arg: Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);",
        "type F = fn(#[cfg(test)] _: Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);",
        "type F = unsafe fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);",
        r#"type F = extern "C" fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);"#,
        r#"type F = for<'a> unsafe extern "C" fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, &'a u8);"#,
        "type F = fn(fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32), u8);",
        "type F = fn() -> fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32);",
        "type F = Wrapper<fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32)>;",
        "struct S { callback: fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, u32) }",
        "type F = fn(#[cfg(test)] (Pair<u8, [u8; { use crate::b::B; 1 }]>, u8), u32);",
        r#"type F = unsafe extern "C" fn(u8, #[cfg(test)] [u8; { use crate::b::B; 1 }], ...);"#,
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("{item} use crate::c::C;")),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert!(
            cycles_of(&graph).is_empty(),
            "测试函数指针参数不得制造假环：{item}"
        );
    }
}

/// 最后指针参数的闭合括号不属于门控元素，后续参数/返回类型必须可见。
#[test]
fn last_test_pointer_parameters_preserve_production_types() {
    for item in [
        "type F = fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>) -> [u8; { use crate::c::C; 1 }];",
        "type F = fn(u8, #[cfg(test)] arg: Pair<u8, [u8; { use crate::b::B; 1 }]>); const N: usize = { use crate::c::C; 1 };",
        "type F = fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>, [u8; { use crate::c::C; 1 }]);",
        "type F = fn(fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>), [u8; { use crate::c::C; 1 }]);",
        "struct S(fn(#[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>) -> [u8; { use crate::c::C; 1 }]);",
        r#"type F = unsafe extern "C" fn(u8, #[cfg(test)] [u8; { use crate::b::B; 1 }], ...) -> [u8; { use crate::c::C; 1 }];"#,
        r#"type F = for<'a> unsafe extern "C" fn(&'a u8, #[cfg(test)] Pair<u8, [u8; { use crate::b::B; 1 }]>) -> [u8; { use crate::c::C; 1 }];"#,
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", item),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "参数之后的生产真环必须检出：{item}");
    }
}

/// 普通函数/方法参数共享列表边界，最后门控参数不能吞掉生产正文。
#[test]
fn last_test_function_parameters_preserve_production_bodies() {
    for item in [
        "fn f(#[cfg(test)] probe: Pair<u8, [u8; { use crate::b::B; 1 }]>) { use crate::c::C; }",
        "fn f<T: Fn() -> u8>(#[cfg(test)] probe: Pair<u8, [u8; { use crate::b::B; 1 }]>) where T: Copy { use crate::c::C; }",
        "fn f(#[cfg(test)] (x, y): (Pair<u8, [u8; { use crate::b::B; 1 }]>, u8)) { use crate::c::C; }",
        "struct S; impl S { fn f(#[cfg(test)] &self) { use crate::c::C; } }",
        "trait T { fn f(#[cfg(test)] probe: Pair<u8, [u8; { use crate::b::B; 1 }]>); } use crate::c::C;",
        r#"unsafe extern "C" { fn f(#[cfg(test)] probe: [u8; { use crate::b::B; 1 }]); } use crate::c::C;"#,
        "fn f<T: Trait<{ use crate::c::C; 1 }>>(#[cfg(test)] probe: [u8; { use crate::b::B; 1 }]) { #[cfg(test)] let less = 1 < 2; use crate::c::C; }",
        "fn r#fn(#[cfg(test)] probe: [u8; { use crate::b::B; 1 }]) { use crate::c::C; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", item),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "函数参数之后的生产真环必须检出：{item}");
    }
}

/// 参数类型内的常量块及普通函数正文属性保持局部表达式态。
#[test]
fn parameter_const_attributes_preserve_expression_scanning() {
    for item in [
        "type F = fn([u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }]);",
        "type F = fn() -> [u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }];",
        "fn f() { const N: usize = { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }; }",
        "fn f<T: Trait<{ #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }>>() {}",
        "fn r#fn() { #[cfg(test)] let predicate = |x: u32| x < limit; use crate::c::C; }",
        "type F = fn([u8; { #[cfg(test)] let pair = (1, 2); use crate::c::C; 1 }]);",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod c;"),
            ("a.rs", item),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(
            cycles_of(&graph).len(),
            1,
            "局部属性后的生产真环必须检出：{item}"
        );
    }
}

/// 只蕴含 test 的参数属性才被门控；生产可达配置仍贡献依赖。
#[test]
fn production_capable_parameter_attributes_preserve_edges() {
    for item in [
        "type F = fn(#[cfg(any(test, unix))] [u8; { use crate::c::C; 1 }]);",
        "type F = fn(#[cfg(unix)] [u8; { use crate::c::C; 1 }]);",
        "fn f(#[cfg(any(test, unix))] probe: [u8; { use crate::c::C; 1 }]) {}",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod c;"),
            ("a.rs", item),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(
            cycles_of(&graph).len(),
            1,
            "生产可达参数不能被当成测试代码：{item}"
        );
    }
}
