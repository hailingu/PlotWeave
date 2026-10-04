//! PR #488 评审 5393324118：生产图固定 test=false，生产恒真的属性不得
//! 禁用显式类型遮蔽；未知配置仍保留 glob 边。通过真实构图同时检查裸
//! 路径与限定路径，覆盖导入、声明、inline 继承及 cfg_attr 包装入口。

use super::module_graph_tests::edges;
use super::*;

/// 搭建 enum 别名遮蔽 glob 模块的图：a/p 反向依赖 m 与 user，虚假
/// glob 边会立即闭环。三个属性位置分别控制绑定、类型声明及 inline 继承。
fn shadow_graph(
    import_attr: &str,
    decl_attr: &str,
    inline_attr: &str,
) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    shadow_graph_with_values(
        import_attr,
        &format!("{inline_attr} pub mod inner {{ {decl_attr} pub enum E {{ V }} }}"),
    )
}

/// 同一命名空间允许以 cfg 互斥的 enum/static 表达类型存在性变化。
fn shadow_graph_with_values(
    import_attr: &str,
    values: &str,
) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    edges(&[
        (
            "lib.rs",
            "pub mod values; pub mod a; pub mod m; pub mod user;",
        ),
        ("values.rs", values),
        ("a/mod.rs", "pub mod p; pub fn aux() {}"),
        (
            "a/p.rs",
            concat!(
                "use crate::m::Marker; use crate::user::User;",
                "pub struct V; pub fn take(_: Marker, _: User) {}",
            ),
        ),
        (
            "m.rs",
            &format!(
                "{import_attr} pub use crate::values::inner::E as p;\n\
                 pub use crate::a::*; pub use p::V;\n\
                 pub struct Marker; pub fn run() {{ aux(); }}"
            ),
        ),
        ("user.rs", "pub use crate::m::p; pub struct User;"),
    ])
}

/// 同时断言两种入口的边与环；真实所有者边和反向边始终保留。
fn assert_shadowing(import_attr: &str, decl_attr: &str, inline_attr: &str, shadows: bool) {
    let graph = shadow_graph(import_attr, decl_attr, inline_attr);
    assert_graph_shadowing(
        &graph,
        shadows,
        &format!("import={import_attr}, declaration={decl_attr}, inline={inline_attr}"),
    );
}

/// 比较真实依赖边和环，不依赖属性解析器自身计算期望值。
fn assert_graph_shadowing(
    graph: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
    shadows: bool,
    context: &str,
) {
    for source in ["m.rs", "user.rs"] {
        assert_eq!(
            graph[source].contains("a/p.rs"),
            !shadows,
            "{source}: {context}"
        );
        assert!(graph["a/p.rs"].contains(source));
    }
    assert!(graph["user.rs"].contains("m.rs"));
    assert!(graph["m.rs"].contains("values.rs"));
    assert_eq!(cycles_of(graph).is_empty(), shadows);
}

/// 若属性解析把生产恒真谓词按条件登记，导入或声明任一侧都会恢复假环。
#[test]
fn production_true_cfg_bindings_and_declarations_shadow_globs() {
    for predicate in [
        "not(test)",
        "any(not(test), feature = \"typed\")",
        "not(all(test, feature = \"typed\"))",
        "all(not(test), any(feature = \"typed\", not(test)))",
        "not(not(not(test)))",
        "all()",
    ] {
        let attr = format!("#[cfg({predicate})]");
        assert_shadowing(&attr, "", "", true);
        assert_shadowing("", &attr, "", true);
    }
}

/// inline 模块的生产恒真门控不能经继承把内部声明变成条件声明。
#[test]
fn production_true_inline_cfg_preserves_type_shadowing() {
    assert_shadowing("", "", "#[cfg(not(test))]", true);
}

/// cfg_attr 只可能施加生产恒真 cfg，或其谓词生产恒假时，不改变占位。
#[test]
fn production_true_cfg_attr_preserves_type_shadowing() {
    for attr in [
        "#[cfg_attr(feature = \"typed\", cfg(not(test)))]",
        "#[cfg_attr(test, cfg(feature = \"typed\"))]",
        "#[cfg_attr(not(test), cfg(not(test)))]",
        "#[cfg_attr(feature = \"typed\", cfg_attr(test, cfg(test)))]",
        "#[cfg_attr(not(test), cfg_attr(feature = \"typed\", cfg(not(test))))]",
    ] {
        assert_shadowing(attr, "", "", true);
        assert_shadowing("", attr, "", true);
        assert_shadowing("", "", attr, true);
    }
}

/// 不能由出现 not(test) 就断言恒真；未知合取、否定和叠加属性仍保留真环。
#[test]
fn production_unknown_cfg_keeps_glob_cycles() {
    for attr in [
        "#[cfg(not(feature = \"typed\"))]",
        "#[cfg(all(not(test), feature = \"typed\"))]",
        "#[cfg(not(any(test, feature = \"typed\")))]",
        "#[cfg(not(test))] #[cfg(feature = \"typed\")]",
        "#[cfg(feature = \"typed\")] #[cfg(not(test))]",
        "#[cfg_attr(not(test), cfg(feature = \"typed\"))]",
        "#[cfg_attr(feature = \"typed\", cfg(test))]",
        "#[cfg_attr(not(test), cfg_attr(feature = \"typed\", cfg(test)))]",
        "#[cfg_attr(not(test), cfg(not(test)), cfg(feature = \"typed\"))]",
    ] {
        assert_shadowing(attr, "", "", false);
    }
}

/// 无条件导入可以在不同配置指向 enum 或 static；生产恒真外层条件
/// 不能清除声明或 inline 模块仍依赖 feature 的条件性。
#[test]
fn production_unknown_type_and_inline_cfg_keep_glob_cycles() {
    for values in [
        concat!(
            "#[cfg(not(test))] pub mod inner {",
            "#[cfg(feature = \"typed\")] pub enum E { V }",
            "#[cfg(not(feature = \"typed\"))] pub static E: u8 = 0; }",
        ),
        concat!(
            "#[cfg(feature = \"typed\")] pub mod inner {",
            "#[cfg(not(test))] pub enum E { V } }",
            "#[cfg(not(feature = \"typed\"))] pub mod inner { pub static E: u8 = 0; }",
        ),
    ] {
        let graph = shadow_graph_with_values("", values);
        assert_graph_shadowing(&graph, false, values);
    }
}
