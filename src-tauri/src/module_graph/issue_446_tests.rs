//! issue #446 的 return/break 块值续接门控回归。

use super::dependency_fixture::{assert_production_cycle, assert_test_exclusion};

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
        "#[cfg(test)] break 'outer { p } as *const Ty<{ use crate::b::B; 1 }>;",
        "#[cfg(test)] break { 1u8 } as u16 + { use crate::b::B; 1 };",
        "#[cfg(test)] break 'outer { 1u8 } as [u8; { use crate::b::B; 1 }];",
        "#[cfg(test)] return match 1u8 { _ => 1u8 } as u16 * { use crate::b::B; 1 };",
    ] {
        assert_test_exclusion(
            &format!("fn f() {{ 'outer: loop {{ {item} use crate::c::C; break; }} }}"),
            item,
        );
    }
}

/// 跳转表达式在语句边界结束，其后独立生产语句的真环仍须检出。
#[test]
fn jump_block_values_preserve_following_production_cycles() {
    for item in [
        "#[cfg(test)] return { |x: u8| x }({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] break 'outer { 1u8 } + { use crate::b::B; 1 }; [{ use crate::c::C; 1 }];",
        "#[cfg(test)] break 'outer { p } as *const u8; { use crate::c::C; }",
        "#[cfg(test)] break { [1u8] }[{ use crate::b::B; 0 }]; ({ use crate::c::C; 1 });",
        "#[cfg(test)] return; ({ use crate::c::C; 1 });",
        "#[cfg(test)] break; [{ use crate::c::C; 1 }];",
        "#[cfg(test)] break 'outer; -{ use crate::c::C; 1 };",
        "#[cfg(test)] { [1u8] }.len(); [{ use crate::c::C; 1 }];",
        "#[cfg(test)] if true { } ({ use crate::c::C; 1 });",
    ] {
        assert_production_cycle(
            &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}"),
            item,
        );
    }
}

/// 无分号的尾位置跳转在外围块闭合处结束，不能吞掉其后的生产项。
#[test]
fn tail_jump_values_end_at_the_enclosing_block() {
    for source in [
        "fn f() { #[cfg(test)] return { use crate::b::B; } } use crate::c::C;",
        "fn f() { loop { #[cfg(test)] break { use crate::b::B; } } } use crate::c::C;",
        "fn f() { 'outer: loop { #[cfg(test)] break 'outer { 1u8 } + { use crate::b::B; 1 } } } use crate::c::C;",
        "fn f() -> u16 { #[cfg(test)] return { 1u8 } as u16 } use crate::c::C;",
        "fn f() { #[cfg(test)] return { |x: u8| x }({ use crate::b::B; 1 }) } use crate::c::C;",
        "fn f() { #[cfg(test)] return } use crate::c::C;",
        "fn f() { #[cfg(test)] return { use crate::b::B; } } fn g() { use crate::c::C; }",
    ] {
        assert_production_cycle(source, source);
    }
}

/// 生产可达或未门控的跳转块值续接继续贡献依赖与真实环。
#[test]
fn production_jump_block_values_preserve_edges() {
    for item in [
        "return { |x: u8| x }({ use crate::c::C; 1 });",
        "break 'outer { 1u8 } + { use crate::c::C; 1 };",
        "break 'outer { p } as *const Ty<{ use crate::c::C; 1 }>;",
        "#[cfg(unix)] return { [1u8] }[{ use crate::c::C; 0 }];",
        "#[cfg(any(test, unix))] break { |x: u8| x }({ use crate::c::C; 1 });",
    ] {
        assert_production_cycle(
            &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}"),
            item,
        );
    }
}
