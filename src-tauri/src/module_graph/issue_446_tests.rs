//! issue #446 的 return/break 块值续接门控回归。

use super::module_graph_tests::edges;
use super::*;

/// return/break 块值后的调用、索引与二元续接仍属门控表达式，不能制造假环。
#[test]
fn jump_block_value_continuations_exclude_test_dependencies() {
    for item in [
        "#[cfg(test)] return { |x: u8| x }({ use crate::b::B; 1 });",
        "#[cfg(test)] return { [1u8] }[{ use crate::b::B; 0 }];",
        "#[cfg(test)] return { 1u8 } + { use crate::b::B; 1 };",
        "#[cfg(test)] return { 1u8 }.checked_add({ use crate::b::B; 1 });",
        "#[cfg(test)] return { |x: u8| x }({ use crate::b::B; 1 }) + { use crate::b::B; 1 };",
        "#[cfg(test)] break { |x: u8| x }({ use crate::b::B; 1 });",
        "#[cfg(test)] break { [1u8] }[{ use crate::b::B; 0 }];",
        "#[cfg(test)] break { 1u8 } + { use crate::b::B; 1 };",
        "#[cfg(test)] break 'outer { |x: u8| x }({ use crate::b::B; 1 });",
        "#[cfg(test)] break 'outer { [1u8] }[{ use crate::b::B; 0 }];",
        "#[cfg(test)] break 'outer { 1u8 } * { use crate::b::B; 1 };",
        "#[cfg(test)] return if true { 1u8 } else { 2u8 } + { use crate::b::B; 1 };",
        "#[cfg(test)] break 'outer match 1u8 { _ => [1u8] }[{ use crate::b::B; 0 }];",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            (
                "a.rs",
                &format!("fn f() {{ 'outer: loop {{ {item} use crate::c::C; break; }} }}"),
            ),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert!(cycles_of(&graph).is_empty(), "测试依赖不得制造假环：{item}");
    }
}

/// 跳转表达式在语句边界结束，其后独立生产语句的真环仍须检出。
#[test]
fn jump_block_values_preserve_following_production_cycles() {
    for item in [
        "#[cfg(test)] return { |x: u8| x }({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] break 'outer { 1u8 } + { use crate::b::B; 1 }; [{ use crate::c::C; 1 }];",
        "#[cfg(test)] break { [1u8] }[{ use crate::b::B; 0 }]; ({ use crate::c::C; 1 });",
        "#[cfg(test)] return; ({ use crate::c::C; 1 });",
        "#[cfg(test)] break; [{ use crate::c::C; 1 }];",
        "#[cfg(test)] break 'outer; -{ use crate::c::C; 1 };",
        "#[cfg(test)] { [1u8] }.len(); [{ use crate::c::C; 1 }];",
        "#[cfg(test)] if true { } ({ use crate::c::C; 1 });",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            (
                "a.rs",
                &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}"),
            ),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}

/// 生产可达或未门控的跳转块值续接继续贡献依赖与真实环。
#[test]
fn production_jump_block_values_preserve_edges() {
    for item in [
        "return { |x: u8| x }({ use crate::c::C; 1 });",
        "break 'outer { 1u8 } + { use crate::c::C; 1 };",
        "#[cfg(unix)] return { [1u8] }[{ use crate::c::C; 0 }];",
        "#[cfg(any(test, unix))] break { |x: u8| x }({ use crate::c::C; 1 });",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            (
                "a.rs",
                &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}"),
            ),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}
