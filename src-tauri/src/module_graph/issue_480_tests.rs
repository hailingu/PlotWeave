//! issue #480：显式类型导入须遮蔽同名 glob 模块——守卫解析显式绑定时
//! 以精确模块资格过滤目标，非模块类型目标被过滤为空后 `positions.is_empty`
//! 仍触发 glob 兜底，丢失「显式导入已占据类型命名空间」的信息，虚构
//! 通往 glob 子模块文件的依赖边、误报 rustc 不存在的环。修复后该信息
//! 保留：全部显式解析落在类型命名空间项（struct/enum/union/trait/type
//! 别名）上时 glob 候选让位；值命名空间项（fn 等）与未知/外部目标仍
//! 放行 glob，保持值/模块同名共存与「宁可误报环也不漏检」的既有口径。

use super::dependency_fixture::{host_glob_graph, user_glob_graph};
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
    let graph = user_glob_graph(
        "pub struct Thing;\n",
        "pub use crate::values::Thing as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        "use crate::m::p;\n\npub struct User;\n\npub fn make() -> p {\n    p\n}\n",
    );
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
    let graph = user_glob_graph(
        "pub fn helper() -> u8 {\n    0\n}\n",
        "pub use crate::values::helper as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        "use crate::m::p;\n\npub struct User;\n\npub fn call() -> u8 {\n    p()\n}\n",
    );
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
    let graph = host_glob_graph(
        "pub enum E {\n    V,\n}\n",
        concat!(
            "pub use crate::values::E as p;\n",
            "pub use crate::a::*;\n",
            "pub fn go() {\n    aux();\n}\n",
            "use p::V;\n",
            "pub struct H;\n",
            "pub fn v() -> p {\n    V\n}\n",
        ),
    );
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
        let graph = user_glob_graph(
            &format!("{decl}\n"),
            &format!(
                "pub use crate::values::{item} as p;\npub use crate::a::*;\n\npub fn run() {{\n    aux();\n}}\n"
            ),
            &format!("use crate::m::p;\n\npub struct User;\n\n{ty_use}\n"),
        );
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
    let graph = user_glob_graph(
        "pub mod inner {\n    pub struct Thing;\n}\n",
        "pub use crate::values::inner::Thing as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        "use crate::m::p;\n\npub struct User;\n\npub fn make() -> p {\n    p\n}\n",
    );
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

/// 评审 5391647570（PR #488）P2：cfg 门控（非 test）的类型别名绑定不得
/// 按无条件遮蔽处置——门控不成立的配置里该绑定不存在，`m::p` 实际解析
/// 到 glob 模块，边漏采会让经该边闭合的真环对守卫隐形（漏检方向）。
/// 门控绑定不贡献类型占位，glob 候选保守保留（宁可误报环也不漏检）。
/// 夹具以 rustc 带/不带 `--cfg feature="typed"` 两种配置验证可编译零警告。
#[test]
fn cfg_gated_type_binding_keeps_glob_module_edge() {
    let graph = user_glob_graph(
        "pub struct Thing;\n",
        concat!(
            "#[cfg(feature = \"typed\")]\n",
            "pub use crate::values::Thing as p;\n",
            "pub use crate::a::*;\n",
            "\n",
            "pub fn run() {\n",
            "    aux();\n",
            "}\n",
        ),
        "pub use crate::m::p;\n\npub struct User;\n",
    );
    assert!(
        graph["user.rs"].contains("a/p.rs"),
        "cfg 门控的类型绑定在禁用配置不成立，glob 模块边须保守保留：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "禁用配置下 user→a/p→user 的真环须可检出：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5391647570（PR #488）P2：宏调用 token 树（括号/方括号定界）里
/// 的 `struct` 文本是宏 DSL 而非模块命名空间声明——误登记会把同名值
/// 别名（fn）的目标错判为类型项、移除真实 glob 模块边（漏检方向）。
/// 类型项采集排除定界组内的关键字。夹具经 rustc 验证零警告（宏展开
/// 为空，不引入名字冲突）。
#[test]
fn macro_token_tree_types_do_not_shadow() {
    let graph = user_glob_graph(
        concat!(
                "macro_rules! swallow {\n",
                "    ($($t:tt)*) => {}\n",
                "}\n",
                "swallow!(struct helper);\n",
                "swallow![struct helper];\n",
                "pub fn helper() -> u8 {\n",
                "    0\n",
                "}\n",
            ),
        "pub use crate::values::helper as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        "use crate::m::p;\n\npub struct User;\n\npub fn call() -> u8 {\n    p()\n}\n",
    );
    assert!(
        graph["user.rs"].contains("a/p.rs"),
        "宏 token 树里的 struct 文本不得登记为类型项，值别名与 glob 模块的共存边须保留：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "值共存形态下 a/p→user 反向依赖须闭合可检出的环：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5391647570（PR #488）P2 的门控继承形态：cfg 门控**函数体内**的
/// 类型别名引入同样按条件登记（外层项的门控对体内引入持续有效，模块级
/// `}` 才终结）——被误判为无条件时其类型占位会移除 glob 模块候选
///（漏检方向）。守卫不建模配置相关性，边按保守并集保留。夹具以
/// rustc 带/不带 `--cfg feature="gated"` 两种配置验证可编译零警告
///（门控函数体在禁用配置整体缺席）。
#[test]
fn cfg_gated_function_body_binding_inherits_gating() {
    let graph = host_glob_graph(
        "pub enum E {\n    V,\n}\n",
        concat!(
            "pub struct H;\n",
            "#[cfg(feature = \"gated\")]\n",
            "pub fn gated() {\n",
            "    use crate::values::E as p;\n",
            "    use crate::a::*;\n",
            "    use p::V;\n",
            "    let _ = V;\n",
            "    aux();\n",
            "}\n",
        ),
    );
    assert!(
        graph["host.rs"].contains("a/p.rs"),
        "门控函数体内的类型别名按条件登记，glob 模块边须保守保留：{:?}",
        graph["host.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "保守并集下 host→a/p→host 的环须按可检出处置（不因条件绑定移除边）：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392007894（PR #488）P2：cfg_attr 包装的嵌套 cfg 不得漏判条件
/// 存在——`#[cfg_attr(gate, cfg(typed))]` 在 gate∧¬typed 配置里引入
/// 缺席、同名 glob 模块是真实目标，边漏采即漏检（解析器此前只识别
/// 深度 1 的直接 cfg）。嵌套 cfg 一律按条件登记（含嵌套 cfg(test)：
/// 谓词不成立时它是生产代码，不得按 test 门控跳过）。夹具以 rustc
/// （gate, typed 双特性声明）在 (gate off) 与 (gate on ∧ typed off)
/// 两种配置验证可编译零警告。
#[test]
fn cfg_attr_nested_cfg_marks_binding_conditional() {
    let graph = user_glob_graph(
        "pub struct Thing;\n",
        concat!(
            "#[cfg_attr(feature = \"gate\", cfg(feature = \"typed\"))]\n",
            "pub use crate::values::Thing as p;\n",
            "pub use crate::a::*;\n",
            "\n",
            "pub fn run() {\n",
            "    aux();\n",
            "}\n",
        ),
        "pub use crate::m::p;\n\npub struct User;\n",
    );
    assert!(
        graph["user.rs"].contains("a/p.rs"),
        "cfg_attr 嵌套 cfg 的绑定按条件登记，gate∧¬typed 配置的 glob 模块边须保守保留：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "gate∧¬typed 配置下 user→a/p→user 的真环须可检出：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392007894（PR #488）P2：模块级分号终结的项须消费自身挂起的
/// 门控——条件 use 之后的无条件类型导入被泄漏的 cfg_cond 误判为条件，
/// 其类型占位失效、glob 边保留，与反向依赖组合成**误报环**、阻断合法
/// 代码（issue #480 同类危害）。门控继承改由 inline 模块栈承载后，
/// 分号清理不破坏继承（见下一用例）。夹具以 rustc 双配置验证零警告。
#[test]
fn module_level_semicolon_items_consume_pending_gating() {
    let graph = edges(&[
        (
            "lib.rs",
            "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n",
        ),
        (
            "values.rs",
            "pub struct Thing;\n\npub fn helper() -> u8 {\n    0\n}\n",
        ),
        ("a/mod.rs", "pub mod q;\n\npub fn aux() {}\n"),
        (
            "a/q.rs",
            "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n",
        ),
        (
            "m.rs",
            concat!(
                "#[cfg(feature = \"old\")]\n",
                "pub use crate::values::helper as p;\n",
                "pub use crate::values::Thing as q;\n",
                "pub use crate::a::*;\n",
                "\n",
                "pub fn run() {\n",
                "    aux();\n",
                "}\n",
            ),
        ),
        (
            "user.rs",
            "use crate::m::q;\n\npub struct User;\n\npub fn make() -> q {\n    q\n}\n",
        ),
    ]);
    assert!(
        !graph["user.rs"].contains("a/q.rs"),
        "无条件类型导入 q 的遮蔽须生效，不得因前置条件 use 的门控泄漏保留 glob 边：{:?}",
        graph["user.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "门控泄漏造成的 user→a/q→user 误报环不得存在：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392007894（PR #488）P2 的继承护栏：门控 inline 模块**体内**的
/// 分号项清理自身泄漏，不得终结模块声明的门控继承——体内后续引入仍按
/// 条件登记、glob 边保守保留（清理点若错误地按裸布尔泄漏实现，本用例
/// 与上一用例无法同时成立）。夹具以 rustc 双配置验证零警告。
#[test]
fn gated_inline_module_keeps_inheritance_across_semicolon_items() {
    let graph = host_glob_graph(
        "pub enum E {\n    V,\n}\n",
        concat!(
            "pub struct H;\n",
            "#[cfg(feature = \"gated\")]\n",
            "pub mod zone {\n",
            "    static WARM: u8 = 0;\n",
            "    pub fn warm() -> u8 {\n",
            "        WARM\n",
            "    }\n",
            "    pub use crate::values::E as p;\n",
            "    pub use crate::a::*;\n",
            "    use p::V;\n",
            "    pub fn v() -> p {\n",
            "        V\n",
            "    }\n",
            "    pub fn go() {\n",
            "        aux();\n",
            "    }\n",
            "}\n",
        ),
    );
    assert!(
        graph["host.rs"].contains("a/p.rs"),
        "门控 inline 模块体内的类型别名经分号项后仍按条件登记，glob 边须保守保留：{:?}",
        graph["host.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "保守并集下 host→a/p→host 的环须按可检出处置：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392007894（PR #488）P2：类型项声明自身携带条件性——cfg 互斥的
/// `struct Thing` / `static Thing` 让**无条件**再导出在禁用配置指向值项，
/// 类型命名空间实际未被占据、glob 模块是真实目标；无条件登记该类型项
/// 会移除真实边（漏检）。所有平台所有者的声明均无条件为类型项才参与
/// 遮蔽。夹具以 rustc 双配置验证可编译零警告。
#[test]
fn conditional_type_declarations_do_not_occupy_unconditionally() {
    let graph = user_glob_graph(
        concat!(
                "#[cfg(feature = \"typed\")]\n",
                "pub struct Thing;\n",
                "#[cfg(not(feature = \"typed\"))]\n",
                "#[allow(non_upper_case_globals)]\n",
                "pub static Thing: u8 = 0;\n",
            ),
        "pub use crate::values::Thing as p;\npub use crate::a::*;\n\npub fn run() {\n    aux();\n}\n",
        "use crate::m::p;\n\npub struct User;\n\npub fn touch() {\n    let _ = p;\n}\n",
    );
    assert!(
        graph["user.rs"].contains("a/p.rs"),
        "条件声明的类型项不构成无条件类型占位，禁用配置的 glob 模块边须保留：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "禁用配置下 user→a/p→user 的真环须可检出：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392529793（PR #488）P2：嵌套 cfg 只在**由 cfg_attr 施加**时才算
/// 条件门控——`doc(cfg(feature))` 是文档元数据，不改变项的存在条件；
/// 误判条件会禁用无条件类型占位、保留 Rust 实际遮蔽的 glob 边，与反向
/// 依赖组合成**误报环**（与 issue #480 同类危害）。夹具经 rustc 验证
///（docsrs 双配置）零警告。
#[test]
fn doc_wrapped_cfg_does_not_mark_item_conditional() {
    let graph = user_glob_graph(
        "pub struct Thing;\n",
        concat!(
            "#[cfg_attr(docsrs, doc(cfg(feature = \"typed\")))]\n",
            "pub use crate::values::Thing as p;\n",
            "pub use crate::a::*;\n",
            "\n",
            "pub fn run() {\n",
            "    aux();\n",
            "}\n",
        ),
        "use crate::m::p;\n\npub struct User;\n\npub fn make() -> p {\n    p\n}\n",
    );
    assert!(
        !graph["user.rs"].contains("a/p.rs"),
        "doc 元数据不改变存在条件，无条件类型导入的遮蔽须生效、无虚假 glob 边：{:?}",
        graph["user.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "doc 包裹 cfg 误判造成的 user→a/p→user 误报环不得存在：{:?}",
        cycles_of(&graph)
    );
}

/// 评审 5392908916（PR #488）P2：同一作用域经**命名空间不相交**的同名
/// 导入合法共存（E0252 按命名空间判重——enum 仅占类型命名空间，fn 仅
/// 占值命名空间）：显式类型仍遮蔽 glob 提供的同名模块，值绑定不得解除
/// 该占位。「全部绑定都是类型」的 AND 语义会错误恢复 glob 候选、与
/// 反向依赖闭合成**误报环**（issue #480 同类危害）；类型占位改为
/// 「存在无条件类型绑定」语义。夹具经 rustc 验证零警告。
#[test]
fn value_binding_does_not_release_type_namespace_occupancy() {
    let graph = host_glob_graph(
        "pub enum E {\n    W,\n}\n\npub fn f() -> u8 {\n    0\n}\n",
        concat!(
            "use crate::values::E as p;\n",
            "use crate::values::f as p;\n",
            "use crate::a::*;\n",
            "use p::W;\n",
            "pub struct H;\n",
            "pub fn use_type(x: p) {\n",
            "    let _ = x;\n",
            "}\n",
            "pub fn go() {\n",
            "    aux();\n",
            "}\n",
            "pub fn use_value() -> u8 {\n",
            "    p()\n",
            "}\n",
            "pub fn use_variant() -> p {\n",
            "    W\n",
            "}\n",
        ),
    );
    assert!(
        !graph["host.rs"].contains("a/p.rs"),
        "值绑定不解除类型命名空间占位，显式 enum 遮蔽 glob 模块、无虚假边：{:?}",
        graph["host.rs"]
    );
    assert!(
        cycles_of(&graph).is_empty(),
        "host→a/p→host 误报环不得存在：{:?}",
        cycles_of(&graph)
    );
}
