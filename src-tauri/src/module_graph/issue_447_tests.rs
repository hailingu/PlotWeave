//! issue #447 的门控闭包 as 转型续接回归。

use super::module_graph_tests::edges;
use super::*;

/// 构造 a 内含给定语句、c 回指 a 的三模块图；b 仅供测试导入。
fn graph_with(item: &str, b: &str, c: &str) -> BTreeMap<String, BTreeSet<String>> {
    edges(&[
        ("lib.rs", "mod a; mod b; mod c;"),
        ("a.rs", &format!("fn f() {{ {item} use crate::c::C; }}")),
        ("b.rs", b),
        ("c.rs", c),
    ])
}

/// 闭包正文后的 as 转型及其目标类型、后续操作数仍属门控表达式，不能制造假环。
#[test]
fn closure_cast_continuations_exclude_test_dependencies() {
    for item in [
        "#[cfg(test)] || { 1u8 } as u16 + { use crate::b::B; 1u16 };",
        "#[cfg(test)] move || { 1u8 } as u16 * { use crate::b::B; 1u16 };",
        "#[cfg(test)] |x: u8| { x } as u16 - { use crate::b::B; 1u16 };",
        "#[cfg(test)] || { p } as *const Ty<{ use crate::b::B; 1 }>;",
        "#[cfg(test)] let v = || { 1u8 } as u16 + { use crate::b::B; 1u16 };",
        "#[cfg(test)] || -> u8 { 1 } as fn() -> Ty<{ use crate::b::B; 1 }>;",
        "#[cfg(test)] let g = || -> u8 { 1 } as fn() -> Ty<{ use crate::b::B; 1 }>;",
        "#[cfg(test)] || -> u8 { 1 } + { use crate::b::B; 1 };",
    ] {
        let graph = graph_with(item, "use crate::a::A;", "pub struct C;");
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert!(cycles_of(&graph).is_empty(), "测试依赖不得制造假环：{item}");
    }
}

/// 转型表达式在语句边界结束，其后独立生产语句的真环仍须检出。
#[test]
fn closure_casts_preserve_following_production_cycles() {
    for item in [
        "#[cfg(test)] || { 1u8 } as u16; { use crate::c::C; }",
        "#[cfg(test)] || { 1u8 } as u16 + { use crate::b::B; 1u16 }; [{ use crate::c::C; 1 }];",
        "#[cfg(test)] || -> u8 { 1 } as fn() -> u8; ({ use crate::c::C; 1 });",
        "#[cfg(test)] let v = || { 1u8 } as u16; -{ use crate::c::C; 1 };",
        "#[cfg(test)] |_: ()| -> u8 { 1 }; -{ use crate::c::C; 1 };",
    ] {
        let graph = graph_with(item, "pub struct B;", "use crate::a::A;");
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}

/// 未门控或生产可达的闭包转型续接继续贡献依赖与真实环。
#[test]
fn production_closure_casts_preserve_edges() {
    for item in [
        "|| { 1u8 } as u16 + { use crate::c::C; 1u16 };",
        "|| -> u8 { 1 } as fn() -> Ty<{ use crate::c::C; 1 }>;",
        "#[cfg(unix)] || { 1u8 } as u16 + { use crate::c::C; 1u16 };",
        "#[cfg(any(test, unix))] || { p } as *const Ty<{ use crate::c::C; 1 }>;",
    ] {
        let graph = graph_with(item, "pub struct B;", "use crate::a::A;");
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}
