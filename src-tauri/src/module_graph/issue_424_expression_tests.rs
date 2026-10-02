//! issue #424 的闭包后缀与值位置限定路径门控回归。

use super::module_graph_tests::edges;
use super::*;

/// 闭包/值块后缀的参数及后续操作数仍属测试表达式，不能制造假环。
#[test]
fn test_postfix_expressions_exclude_operand_dependencies() {
    for item in [
        "#[cfg(test)] || { 1u8 }.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || { |n: u8| n }({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || { [1u8] }[{ use crate::b::B; 0 }]; { use crate::c::C; }",
        "#[cfg(test)] || { (Some(1u8),) }.0.unwrap_or({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || { Some(1u8) }?.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] async move || { async { 1u8 } }.await.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || const { 1u8 }.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || { 1u8 }.checked_add({ use crate::b::B; 1 }).unwrap() + { use crate::b::B; 1 }; { use crate::c::C; }",
        "#[cfg(test)] || -> u8 { 1u8 }().checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || -> [u8; 1] { [1u8] }()[{ use crate::b::B; 0 }]; { use crate::c::C; }",
        "#[cfg(test)] let n = { |n: u8| n }({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] const { 1u8 }.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] match || 1u8 { _ => 1u8 }.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] if let f = || 1u8 { let _ = f; 1u8 } else { 2u8 }.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || { 1u8 }..{ use crate::b::B; 2 }; { use crate::c::C; }",
        "#[cfg(test)] || { s }.method::<[u8; { use crate::b::B; 1 }]>({ use crate::b::B; 1 }); { use crate::c::C; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}")),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert!(cycles_of(&graph).is_empty(), "测试依赖不得制造假环：{item}");
    }
}

/// 后缀链与外围控制流完整消费后恢复生产扫描，显式返回类型闭包也须恢复。
#[test]
fn postfix_expressions_preserve_following_production_cycles() {
    for item in [
        "#[cfg(test)] || { 1u8 }.checked_add({ use crate::b::B; 1 }).unwrap(); { use crate::c::C; }",
        "#[cfg(test)] || { [1u8] }[{ use crate::b::B; 0 }].checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] || -> u8 { 1u8 }().checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] if let f = || { 1u8 }.checked_add({ use crate::b::B; 1 }) { let _ = f; } { use crate::c::C; }",
        "#[cfg(test)] match || { [1u8] }[{ use crate::b::B; 0 }] { _ => () } { use crate::c::C; }",
        "#[cfg(test)] while let f = || { |n: u8| n }({ use crate::b::B; 1 }) { let _ = f; break; } { use crate::c::C; }",
        "#[cfg(test)] match || 1u8 { _ => Some(1u8) }?.checked_add({ use crate::b::B; 1 }); { use crate::c::C; }",
        "#[cfg(test)] let n = match || 1u8 { _ => [1u8] }[{ use crate::b::B; 0 }]; { use crate::c::C; }",
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

/// 无分号块/控制流后的调用形括号或数组仍属独立语句，声明体不获得后缀语义。
#[test]
fn postfix_scanning_preserves_statement_and_item_boundaries() {
    for item in [
        "#[cfg(test)] match || 1u8 { _ => () } ({ use crate::c::C; 1 });",
        "#[cfg(test)] if let f = || 1u8 { let _ = f; } [{ use crate::c::C; 1 }];",
        "#[cfg(test)] while let f = || 1u8 { let _ = f; break; } ({ use crate::c::C; 1 });",
        "#[cfg(test)] const {} [{ use crate::c::C; 1 }];",
        "#[cfg(test)] {} ({ use crate::c::C; 1 });",
        "#[cfg(test)] fn g() {} ({ use crate::c::C; 1 });",
        "#[cfg(test)] struct S {} [{ use crate::c::C; 1 }];",
        "#[cfg(test)] enum E { Test } ({ use crate::c::C; 1 });",
        "#[cfg(test)] match || 1u8 { _ => () } ..{ use crate::c::C; 1 };",
        "#[cfg(test)] if let f = || 1u8 { let _ = f; } -{ use crate::c::C; 1 };",
        "#[cfg(test)] || -> u8 { 1u8 }; ({ use crate::c::C; 1 });",
        "#[cfg(test)] { [1u8] }.len(); [{ use crate::c::C; 1 }];",
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

/// 值位置限定路径的嵌套泛型逗号、常量组与函数箭头不能泄漏测试依赖。
#[test]
fn test_qualified_initializers_exclude_type_dependencies() {
    for item in [
        "#[cfg(test)] const N: usize = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] static N: usize = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] || <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] move || <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] return <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] break 'outer <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        " enum E { #[cfg(test)] Test = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE, Production = 3 } { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<fn() -> u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]>>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait<fn() -> u8, u8>>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <<Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::Assoc as Other>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <&'static Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = 1 < <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE > 0; { use crate::c::C; }",
        "#[cfg(test)] let n = <[u8; { use crate::b::B; 1 }] as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::method::<[u8; { use crate::b::B; 1 }]>() + { use crate::b::B; 1 }; { use crate::c::C; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}")),
            ("b.rs", "use crate::a::A;"),
            ("c.rs", "pub struct C;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert!(cycles_of(&graph).is_empty(), "测试依赖不得制造假环：{item}");
    }
}

/// 限定类型组闭合后恢复值状态及生产语句，不吞掉其后的真实环。
#[test]
fn qualified_expressions_preserve_following_production_cycles() {
    for item in [
        "#[cfg(test)] const N: usize = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "#[cfg(test)] || <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE; { use crate::c::C; }",
        "enum E { #[cfg(test)] Test = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE, Production = { use crate::c::C; 3 } }",
        "#[cfg(test)] let n = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE < 2; { use crate::c::C; }",
        "#[cfg(test)] if let n = || <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE { let _ = n; } { use crate::c::C; }",
        "#[cfg(test)] match || <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE { _ => () } { use crate::c::C; }",
        "#[cfg(test)] let n = 1 + <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::VALUE + { use crate::b::B; 1 }; { use crate::c::C; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}

/// 普通比较与移位不获得限定路径类型态，后续生产块及类型仍须可见。
#[test]
fn qualified_path_recognition_preserves_comparison_boundaries() {
    for item in [
        "#[cfg(test)] let small = 1 < 2; { use crate::c::C; }",
        "#[cfg(test)] let small = left < right && right > left; { use crate::c::C; }",
        "#[cfg(test)] let small = left < right::LIMIT; { use crate::c::C; }",
        "#[cfg(test)] let n = 1 << 2; { use crate::c::C; }",
        "#[cfg(test)] let n = 4 >> 1; { use crate::c::C; }",
        "#[cfg(test)] || 1 < 2; { use crate::c::C; }",
        "#[cfg(test)] |x: u8| x < 2; { use crate::c::C; }",
        "#[cfg(test)] let small = 1 < { use crate::b::B; 2 }; { use crate::c::C; }",
        "#[cfg(test)] let small = 1 < 2; const N: usize = <Pair<u8, [u8; { use crate::c::C; 1 }]> as Trait>::VALUE;",
        "#[cfg(test)] let small = 1 < 2; fn g<T: Trait<{ use crate::c::C; 1 }>>() {}",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ 'outer: loop {{ {item} break; }} }}")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "生产真环必须保留：{item}");
    }
}

/// 生产可达后缀及限定路径属性继续贡献全部依赖与真实环。
#[test]
fn production_capable_expression_attributes_preserve_edges() {
    for item in [
        "#[cfg(any(test, unix))] || { 1u8 }.checked_add({ use crate::c::C; 1 });",
        "#[cfg(unix)] || { [1u8] }[{ use crate::c::C; 0 }];",
        "#[cfg(any(test, unix))] let n = <Pair<u8, [u8; { use crate::c::C; 1 }]> as Trait>::VALUE;",
        "#[cfg(unix)] const N: usize = <[u8; { use crate::c::C; 1 }] as Trait>::VALUE;",
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

/// 显式返回闭包的后缀先回值态，外围条件的比较不能误开类型角括号。
#[test]
fn explicit_return_postfixes_restore_enclosing_expression_context() {
    for item in [
        "#[cfg(test)] match || -> u8 { 1u8 }() < { use crate::b::B; 2 } { _ => () } { use crate::c::C; }",
        "#[cfg(test)] if let n = || -> u8 { 1u8 }() < { use crate::b::B; 2 } { let _ = n; } { use crate::c::C; }",
        "#[cfg(test)] while let n = || -> u8 { 1u8 }() < { use crate::b::B; 2 } { let _ = n; break; } { use crate::c::C; }",
        "#[cfg(test)] let n = match || -> u8 { 1u8 }() < { use crate::b::B; 2 } { _ => 1 }; { use crate::c::C; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod b; mod c;"),
            ("a.rs", &format!("fn f() {{ {item} }}")),
            ("b.rs", "pub struct B;"),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "后缀恢复值态后生产真环必须保留：{item}");
    }
}

/// 限定路径识别输出 :: 边界；未闭合类型组或缺少分隔符不能登记该边界。
/// token 契约：https://doc.rust-lang.org/reference/paths.html#qualified-paths。
#[test]
fn qualified_path_candidates_require_a_closed_type_group_and_separator() {
    for source in [
        "<T>::VALUE",
        "<Pair<T, U> as Trait>::VALUE",
        "<<T as Trait>::Assoc as Other>::VALUE",
        "<fn() -> u8 as Trait>::VALUE",
        "<Pair<[u8; { 1 < 2 }], fn() -> u8> as Trait<U>>::VALUE",
    ] {
        let tokens = tokenize(source);
        let end = qualified_path_end(&tokens, 0).expect("已配对的限定类型组必须识别");
        assert_eq!(tokens.get(end), Some(&"::"), "{source}");
    }
    for source in [
        "<T>",
        "<T> + 2",
        "<T><U>",
        "<Pair<T, U>",
        "<T as Trait::Assoc",
        "<Pair<[u8; { 1 < 2 }], fn() -> u8> as Trait",
    ] {
        assert_eq!(qualified_path_end(&tokenize(source), 0), None, "{source}");
    }
}
