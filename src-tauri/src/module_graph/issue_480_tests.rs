//! issue #480：显式类型导入须遮蔽同名 glob 模块——守卫解析显式绑定时
//! 以精确模块资格过滤目标，非模块类型目标被过滤为空后 `positions.is_empty`
//! 仍触发 glob 兜底，丢失「显式导入已占据类型命名空间」的信息，虚构
//! 通往 glob 子模块文件的依赖边、误报 rustc 不存在的环。修复后该信息
//! 保留：全部显式解析落在类型命名空间项（struct/enum/union/trait/type
//! 别名）上时 glob 候选让位；值命名空间项（fn 等）与未知/外部目标仍
//! 放行 glob，保持值/模块同名共存与「宁可误报环也不漏检」的既有口径。

use super::module_graph_tests::edges;
use super::*;

/// issue #480 的最小 rustc-clean 复现（评审 5387169022 的命名形态）：
/// values::Thing 为 struct（类型命名空间），m 以显式 `as p` 引入并叠加
/// `use crate::a::*`（glob 暴露子模块 a::p），user 经 `use crate::m::p`
/// 取 Thing——rustc 解析到显式导入而非 glob 模块；a/p 反向依赖 user。
/// 修复前守卫把 user→a/p 误判为边、报出 rustc 不存在的环；修复后虚假
/// 边消失、user→m 所有者边保留、全图零环。夹具内容以
/// `rustc --edition 2021 --crate-type lib` 验证可编译且零警告。
#[test]
fn explicit_type_import_shadows_glob_module_no_false_cycle() {
    let graph = edges(&[
        ("lib.rs", "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n"),
        ("values.rs", "pub struct Thing;\n"),
        ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
        ("a/p.rs", "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n"),
        (
            "m.rs",
            "pub use crate::values::Thing as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        ),
        (
            "user.rs",
            "use crate::m::p;\n\npub struct User;\n\npub fn make() -> p {\n    p\n}\n",
        ),
    ]);
    assert!(
        !graph["user.rs"].contains("a/p.rs"),
        "显式类型导入遮蔽同名 glob 模块，不得虚构 user→a/p 边：{:?}",
        graph["user.rs"]
    );
    assert!(
        graph["user.rs"].contains("m.rs"),
        "use crate::m::p 的所有者边（user→m）应保留：{:?}",
        graph["user.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "反向依赖 a/p→user 存在时不得误报环：{:?}",
        cycles_of(&graph)
    );
}

/// 值命名空间共存（issue #480 验收：不能简单让所有非模块别名阻断
/// glob）：values::helper 为 fn（仅值命名空间），m 显式 `as p` 引入并
/// 叠加 glob 后，类型命名空间仍由 glob 提供 a::p——rustc 把限定路径中的
/// p 按模块解析，边必须保留；配合 a/p→user 反向依赖构成可检出的环。
/// 夹具同样经 `rustc --edition 2021 --crate-type lib` 验证零警告。
#[test]
fn value_alias_and_glob_module_coexist_edge_stays() {
    let graph = edges(&[
        ("lib.rs", "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n"),
        ("values.rs", "pub fn helper() -> u8 {\n    0\n}\n"),
        ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
        ("a/p.rs", "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n"),
        (
            "m.rs",
            "pub use crate::values::helper as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        ),
        (
            "user.rs",
            "use crate::m::p;\n\npub struct User;\n\npub fn call() -> u8 {\n    p()\n}\n",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("a/p.rs"),
        "值命名空间别名不遮蔽同名 glob 模块，user→a/p 边应保留：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "值共存形态下 a/p→user 反向依赖须闭合可检出的环：{:?}",
        cycles_of(&graph)
    );
}

/// enum 变体经类型别名导入（`use p::V`，p 为 enum 别名）是合法路径
/// 形态：p 占据类型命名空间，同名 glob 模块不得顶替——裸路径臂的 glob
/// 候选同样让位（issue #480 的裸路径形态），否则 host→a/p 虚假边与
/// a/p→host 反向依赖误报环。夹具经 rustc 验证零警告。
#[test]
fn enum_variant_through_type_alias_shadows_glob_bare_path() {
    let graph = edges(&[
        ("lib.rs", "pub mod values;\npub mod a;\npub mod host;\n"),
        ("values.rs", "pub enum E {\n    V,\n}\n"),
        ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
        (
            "a/p.rs",
            "use crate::host::H;\n\npub fn take(h: H) {\n    let _ = h;\n}\n",
        ),
        (
            "host.rs",
            concat!(
                "pub use crate::values::E as p;\n",
                "pub use crate::a::*;\n",
                "pub fn go() {\n    aux();\n}\n",
                "use p::V;\n",
                "pub struct H;\n",
                "pub fn v() -> p {\n    V\n}\n",
            ),
        ),
    ]);
    assert!(
        !graph["host.rs"].contains("a/p.rs"),
        "enum 别名占据类型命名空间，裸路径 glob 候选不得虚构 host→a/p 边：{:?}",
        graph["host.rs"]
    );
    assert!(
        graph["host.rs"].contains("values.rs"),
        "别名声明自身的所有者边保留：{:?}",
        graph["host.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "反向依赖 a/p→host 存在时不得误报环：{:?}",
        cycles_of(&graph)
    );
}

/// trait、type 别名与 inline 模块内声明的类型项同属类型命名空间遮蔽
/// 范围（issue #480 的声明形态覆盖）：绑定目标路径深入 inline 模块栈
/// 时，按所有者文件的 inline 栈前缀正确归类。
#[test]
fn trait_type_alias_and_inline_declared_types_shadow_glob() {
    for (decl, item, ty_use) in [
        ("pub trait Seal {}", "Seal", "pub fn sealed<T: p>() {}"),
        ("pub type Num = u8;", "Num", "pub fn take(x: p) {}"),
    ] {
        let graph = edges(&[
            ("lib.rs", "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n"),
            ("values.rs", &format!("{decl}\n")),
            ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
            ("a/p.rs", "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n"),
            (
                "m.rs",
                &format!(
                "pub use crate::values::{item} as p;\npub use crate::a::*;\n\npub fn run() {{\n    aux();\n}}\n"
            ),
            ),
            (
                "user.rs",
                &format!("use crate::m::p;\n\npub struct User;\n\n{ty_use}\n"),
            ),
        ]);
        assert!(
            !graph["user.rs"].contains("a/p.rs"),
            "{decl} 目标应遮蔽同名 glob 模块，不得虚构 user→a/p 边：{:?}",
            graph["user.rs"]
        );
        assert!(
            cycles_of(&graph).is_empty(),
            "{decl} 形态下不得误报环：{:?}",
            cycles_of(&graph)
        );
    }
    let graph = edges(&[
        ("lib.rs", "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n"),
        ("values.rs", "pub mod inner {\n    pub struct Thing;\n}\n"),
        ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
        ("a/p.rs", "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n"),
        (
            "m.rs",
            "pub use crate::values::inner::Thing as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        ),
        (
            "user.rs",
            "use crate::m::p;\n\npub struct User;\n\npub fn make() -> p {\n    p\n}\n",
        ),
    ]);
    assert!(
        !graph["user.rs"].contains("a/p.rs"),
        "inline 模块内声明的类型项同样遮蔽同名 glob 模块：{:?}",
        graph["user.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "inline 声明形态下不得误报环：{:?}",
        cycles_of(&graph)
    );
}
