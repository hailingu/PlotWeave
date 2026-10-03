//! issue #424 的泛型参数默认类型、值默认表达式与生产扫描恢复回归。

use super::dependency_fixture::{assert_production_cycle, assert_test_exclusion};
use super::module_graph_tests::edges;
use super::*;

/// 类型默认值的等号与内部泛型逗号不能泄漏被门控参数的依赖。
#[test]
fn test_generic_type_defaults_do_not_create_production_cycles() {
    for item in [
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>>(U, #[cfg(test)] T);",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>,>(U, #[cfg(test)] T);",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>, V = u8>(U, #[cfg(test)] T, V);",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> { u: U, #[cfg(test)] t: T }",
        "enum E<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> { U(U), #[cfg(test)] T(T) }",
        "trait Trait<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> {}",
        "union S<U: Copy, #[cfg(test)] T: Copy = Pair<u8, [u8; { use crate::b::B; 1 }]>> { u: U, #[cfg(test)] t: T }",
        "struct S<U, #[cfg(test)] T = [u8; { use crate::b::B; 1 }]>(U, #[cfg(test)] T);",
        "struct S<U, #[cfg(test)] T: Copy = Pair<u8, [u8; { use crate::b::B; 1 }]>>(U, #[cfg(test)] T);",
        "pub(crate) struct gen<U, #[cfg(test)] r#type = Pair<u8, [u8; { use crate::b::B; 1 }]>>(U, #[cfg(test)] r#type);",
        "struct S<U, #[cfg(test)] T = fn() -> Pair<u8, [u8; { use crate::b::B; 1 }]>>(U, #[cfg(test)] T);",
        "struct S<U, #[cfg(test)] T = <Pair<u8, [u8; { use crate::b::B; 1 }]> as Trait>::Assoc>(U, #[cfg(test)] T);",
        "struct S<U, #[allow(dead_code)] #[cfg(all(test, unix))] T = Wrapper<Pair<u8, [u8; { use crate::b::B; 1 }]>>>(U, #[cfg(test)] T);",
        "#[cfg(not(test))] type T = (); type Alias<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> = (U, T);",
    ] {
        assert_test_exclusion(&format!("{item} use crate::c::C;"), item);
    }
}

/// 最后泛型参数的关闭角括号留给主扫描器，字段/约束/正文生产边仍可见。
#[test]
fn last_test_generic_parameters_preserve_production_scanning() {
    for item in [
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> { u: U, #[cfg(test)] t: T, production: [u8; { use crate::c::C; 1 }] }",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>>(U, [u8; { use crate::c::C; 1 }], #[cfg(test)] T);",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>, const N: usize = { use crate::c::C; 1 }>(U, #[cfg(test)] T);",
        "enum E<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> { U(U), #[cfg(test)] T(T), Production([u8; { use crate::c::C; 1 }]) }",
        "union S<U: Copy, #[cfg(test)] T: Copy = Pair<u8, [u8; { use crate::b::B; 1 }]>> { u: U, #[cfg(test)] t: T, production: [u8; { use crate::c::C; 1 }] }",
        "trait Trait<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> { fn production() { use crate::c::C; } }",
        "struct S<U, #[cfg(test)] T = Pair<u8, [u8; { use crate::b::B; 1 }]>> where U: Trait<{ use crate::c::C; 1 }> { u: U, #[cfg(test)] t: T }",
        "fn f<#[cfg(test)] T>() { use crate::c::C; }",
        "#[cfg(not(test))] type T = (); impl<U, #[cfg(test)] T: Bound<Pair<u8, [u8; { use crate::b::B; 1 }]>>> Wrapper<U, T> { fn production() { use crate::c::C; } }",
        "fn f<#[cfg(test)] T: Fn() -> Pair<u8, [u8; { use crate::b::B; 1 }]>>() { use crate::c::C; }",
        "fn f<#[cfg(test)] T: Trait<[u8; { use crate::b::B; 1 }]>>() -> [u8; { use crate::c::C; 1 }] { [] }",
    ] {
        assert_production_cycle(item, item);
    }
}

/// const 等号仍开启值表达式，lifetime 及 const 末参数也不能吞生产代码。
#[test]
fn test_const_and_lifetime_parameters_preserve_production_scanning() {
    for item in [
        "struct S<U, #[cfg(test)] const N: usize = { use crate::b::B; 1 }>(U); use crate::c::C;",
        "struct S<#[cfg(test)] 'a, U>(&'static U, #[cfg(test)] &'a U); use crate::c::C;",
        "fn f<'b, #[cfg(test)] 'a: 'b>() { use crate::c::C; }",
        "fn f<#[cfg(test)] const N: usize>() { use crate::c::C; }",
        "#[cfg(not(test))] const N: usize = 1; impl<#[cfg(test)] const N: usize> Wrapper<N> { fn production() { use crate::c::C; } }",
        "impl<#[cfg(test)] 't> Wrapper { fn production(#[cfg(test)] _: &'t ()) { use crate::c::C; } }",
        "type Alias<#[cfg(test)] const N: usize = { use crate::b::B; 1 }> = u8; use crate::c::C;",
        "trait Trait<U, #[cfg(test)] const N: usize = { use crate::b::B; 1 }> { fn production() { use crate::c::C; } }",
        "struct S<U, #[cfg(test)] const FLAG: bool = { let less = 1 < 2; use crate::b::B; less }>(U); use crate::c::C;",
    ] {
        assert_production_cycle(item, item);
    }
}

/// 生产泛型默认值/约束内的局部属性仍按表达式扫描比较和括号组。
#[test]
fn generic_default_const_attributes_preserve_expression_scanning() {
    for item in [
        "struct S<U, T = Pair<u8, [u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }]>>(U, T);",
        "struct S<U, const N: usize = { #[cfg(test)] let pair = (1, 2); use crate::c::C; 1 }>(U);",
        "trait Trait<T = fn() -> [u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }]> {}",
        "fn f<T: Trait<{ #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }>>() {}",
        "struct S<U, T = <Pair<u8, [u8; { #[cfg(test)] let pair = (1, 2); use crate::c::C; 1 }]> as Trait>::Assoc>(U, T);",
        "fn f<#[cfg(test)] T>() { #[cfg(test)] let less = 1 < 2; use crate::c::C; }",
        "type Alias = <Pair<u8, [u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }]> as Trait>::Assoc;",
        "impl Trait<{ #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }> for S {}",
        "fn f() -> <Pair<u8, [u8; { #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }]> as Trait>::Assoc { value }",
        "struct S<T> where T: for<'a> Trait<{ #[cfg(test)] let less = 1 < 2; use crate::c::C; 1 }> { t: T }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod a; mod c;"),
            ("a.rs", item),
            ("c.rs", "use crate::a::A;"),
        ]);
        assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{item}");
        assert_eq!(cycles_of(&graph).len(), 1, "局部属性之后真环必须检出：{item}");
    }
}

/// 生产可达的泛型属性不能因类型默认值上下文而被加强为 test 门控。
#[test]
fn production_capable_generic_parameters_preserve_edges() {
    for item in [
        "struct S<U, #[cfg(any(test, unix))] T = Pair<u8, [u8; { use crate::c::C; 1 }]>>(U, T);",
        "trait Trait<#[cfg(unix)] const N: usize = { use crate::c::C; 1 }> {}",
        "fn f<#[cfg(any(test, unix))] T: Trait<[u8; { use crate::c::C; 1 }]>>() {}",
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
            "生产可达泛型必须保留依赖：{item}"
        );
    }
}

/// 上下文只属于可配对声明列表；非法缺失 close 和普通类型尖括号不造边界。
#[test]
fn generic_contexts_require_owned_closed_declarations() {
    for input in [
        "struct S<#[cfg(test)] T = Pair<u8>",
        "struct S<#[cfg(test)] T = Pair<u8, [u8; 1]",
        "type Alias = <Pair<u8, [u8; { #[cfg(test)] let less = 1 < 2; 1 }]> as Trait>::Assoc;",
        "impl Trait<{ #[cfg(test)] let less = 1 < 2; 1 }> for S {}",
        "fn f() -> <Pair<u8, [u8; { #[cfg(test)] let less = 1 < 2; 1 }]> as Trait>::Assoc { value }",
        "struct S<T> where T: for<'a> Trait<{ #[cfg(test)] let less = 1 < 2; 1 }> { t: T }",
    ] {
        let cleaned = strip_comments_and_literals(input);
        let tokens = tokenize(&cleaned);
        assert!(field_contexts(&tokens).is_empty(), "没有所属闭合声明列表：{input}");
    }
}
