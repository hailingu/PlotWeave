//! issue #424 的门控闭包操作数连续扫描与生产边界恢复回归。

use super::dependency_fixture::{assert_production_cycle, assert_test_exclusion};
use super::module_graph_tests::edges;
use super::*;

/// 裸/带前缀闭包的操作数块不能提前结束门控并泄漏后续测试依赖。
#[test]
fn bare_closure_operands_do_not_create_production_cycles() {
    for item in [
        "#[cfg(test)] |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| const { use crate::b::B; 1 } + const { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| { use crate::b::B; 1 } + const { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| const { use crate::b::B; 1 } * { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| const { use crate::b::B; 1 } == { use crate::b::B; 1 };",
        "#[cfg(test)] |_: ()| { use crate::b::B; 1 } != { use crate::b::B; 1 };",
        "#[cfg(test)] move |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] async move |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] let f = |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] return |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] break 'outer |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] &|_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] || const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(test)] || |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 };",
        "#[cfg(all(test, unix))] |_: ()| -const { use crate::b::B; 1 } + -{ use crate::b::B; 1 };",
    ] {
        assert_test_exclusion(&format!("fn f() {{ 'outer: loop {{ {item} use crate::c::C; break; }} }}"), item);
    }
}

/// 消费所有门控操作数后恢复生产语句；首普通块只更新自己的正文计数。
#[test]
fn closure_operand_statements_preserve_production_cycles() {
    for item in [
        "#[cfg(test)] |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 }; { use crate::c::C; }",
        "#[cfg(test)] |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 }; { use crate::c::C; }",
        "#[cfg(test)] let f = |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 }; { use crate::c::C; }",
        "#[cfg(test)] |_: ()| if true { use crate::b::B; 1 } else { use crate::b::B; 2 } + { use crate::b::B; 1 }; { use crate::c::C; }",
        "#[cfg(test)] const N: usize = { use crate::b::B; 1 } + { use crate::b::B; 1 }; use crate::c::C;",
        "#[cfg(test)] static N: usize = { use crate::b::B; 1 } + { use crate::b::B; 1 }; use crate::c::C;",
        "#[cfg(test)] let n = { use crate::b::B; 1 } + { use crate::b::B; 1 }; use crate::c::C;",
        "enum E { #[cfg(test)] Test = { use crate::b::B; 1 } + { use crate::b::B; 1 }, Production = { use crate::c::C; 3 } }",
        "struct S<#[cfg(test)] const N: usize = { const { use crate::b::B; 1 } + { use crate::b::B; 1 } }>; use crate::c::C;",
        "#[cfg(test)] if let f = |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { use crate::b::B; } { use crate::c::C; }",
        "#[cfg(test)] match |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { _ => { use crate::b::B; } } { use crate::c::C; }",
        "#[cfg(test)] while let f = |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { use crate::b::B; break; } { use crate::c::C; }",
    ] {
        assert_production_cycle(&format!("fn f() {{ {item} }}"), item);
    }
}

/// 单独 const/普通块、显式返回正文与类型元素不能借操作数规则吞生产边。
#[test]
fn operand_continuation_preserves_nonclosure_and_type_boundaries() {
    for item in [
        "#[cfg(test)] const {} { use crate::c::C; }",
        "#[cfg(test)] const { use crate::b::B; } { use crate::c::C; }",
        "#[cfg(test)] { use crate::b::B; } { use crate::c::C; }",
        "#[cfg(test)] |_: ()| -> u8 { use crate::b::B; 1 + { use crate::b::B; 1 } }; { use crate::c::C; }",
        "struct S { #[cfg(test)] field: [u8; { use crate::b::B; 1 }], production: [u8; { use crate::c::C; 1 }] }",
        "fn g(#[cfg(test)] arg: [u8; { use crate::b::B; 1 }]) { use crate::c::C; }",
        "struct S<U, #[cfg(test)] T = [u8; { use crate::b::B; 1 }]>(U, #[cfg(test)] T, [u8; { use crate::c::C; 1 }]);",
        "enum E { Test(#[cfg(test)] [u8; { use crate::b::B; 1 }], [u8; { use crate::c::C; 1 }]) }",
        "#[cfg(test)] fn g() { use crate::b::B; } { use crate::c::C; }",
        "#[cfg(test)] struct S { field: [u8; { use crate::b::B; 1 }] } { use crate::c::C; }",
    ] {
        assert_production_cycle(&format!("fn f() {{ {item} }}"), item);
    }
}

/// 生产可达的闭包属性保留所有操作数依赖及真实生产环。
#[test]
fn production_capable_closure_operands_preserve_edges() {
    for item in [
        "#[cfg(any(test, unix))] |_: ()| const { use crate::c::C; 1 } + { use crate::c::C; 1 };",
        "#[cfg(unix)] || { use crate::c::C; 1 } + const { use crate::c::C; 1 };",
        "#[cfg(any(test, unix))] let f = move |_: ()| const { use crate::c::C; 1 } + { use crate::c::C; 1 };",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod c;"),
            ("a.rs", &format!("fn f() {{ {item} }}")),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产操作数必须贡献依赖：{item}");
    }
}

/// 控制流语句结束后恢复独立一元表达式；值初始化中的 match 仍连续消费。
#[test]
fn completed_control_flow_preserves_unary_production_statements() {
    for item in [
        "#[cfg(test)] if let f = |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 } { let _ = f; } -{ use crate::c::C; 1 };",
        "#[cfg(test)] match |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 } { _ => () } -{ use crate::c::C; 1 };",
        "#[cfg(test)] while let f = |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 } { let _ = f; break; } !{ use crate::c::C; true };",
        "#[cfg(test)] if let f = |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { let _ = f; } else { } &{ use crate::c::C; 1 };",
        "#[cfg(test)] let n = match |_: ()| const { use crate::b::B; 1 } + { use crate::b::B; 1 } { _ => 1 } + { use crate::b::B; 1 }; -{ use crate::c::C; 1 };",
        "#[cfg(test)] return match |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { _ => 1 } + { use crate::b::B; 1 }; -{ use crate::c::C; 1 };",
        "#[cfg(test)] break 'outer match |_: ()| { use crate::b::B; 1 } + { use crate::b::B; 1 } { _ => 1 } + { use crate::b::B; 1 }; -{ use crate::c::C; 1 };",
    ] {
        assert_production_cycle(&format!("fn f() {{ 'outer: loop {{ {item} break; }} }}"), item);
    }
}
