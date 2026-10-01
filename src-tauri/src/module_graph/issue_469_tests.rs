//! issue #469：模块图守卫的采集完整性——glob 引入与别名链两类合法
//! use 形态不得静默丢边，真实仓库「首段命中内部模块名却零边」计数为 0。

use super::module_graph_tests::edges;
use super::*;

/// glob 引入的模块名（`use super::*` 后 `use helper::H`）必须成边；经该边
/// 闭合的兄弟环必须被检出（修复前 helper 边被当外部 crate 静默丢弃、环
/// 对守卫隐形——issue #469 复现第 3(a) 步）。
#[test]
fn glob_imported_module_names_close_sibling_cycles() {
    let files = [
        ("lib.rs", "mod p;\n"),
        ("p/mod.rs", "pub mod inner;\npub mod helper;\n"),
        ("p/inner.rs", "use super::*;\nuse helper::H;\n"),
        ("p/helper.rs", "use super::inner::I;\n"),
    ];
    let graph = edges(&files);
    assert!(
        graph["p/inner.rs"].contains("p/helper.rs"),
        "glob 引入的 helper 边丢失（静默丢边）：{:?}",
        graph["p/inner.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "glob 引入的模块边须闭合兄弟环：{:?}",
        cycles_of(&graph)
    );
}

/// glob 前缀自身的边保持（`use super::*` 仍指向父模块文件），且 glob 不
/// 引入虚边：指向当前文件的 glob 候选按自环剔除。
#[test]
fn glob_prefix_edges_stay_and_self_targets_drop() {
    let graph = edges(&[
        ("lib.rs", "mod p;\n"),
        ("p/mod.rs", "pub mod inner;\n"),
        (
            "p/inner.rs",
            "use super::*;\nuse inner::Item;\npub struct Item;\n",
        ),
    ]);
    assert!(
        graph["p/inner.rs"].contains("p/mod.rs"),
        "glob 前缀自身的边应保留：{:?}",
        graph["p/inner.rs"]
    );
    assert_eq!(
        graph["p/inner.rs"].len(),
        1,
        "glob 引入的当前文件目标按自环剔除，不得引入其他边：{:?}",
        graph["p/inner.rs"]
    );
}

/// ≥3 级别名链（p→crate::a、q→p::b、r→q::c）的尾端引用必须解析到深层
/// 模块并成边（修复前链在第二跳后被静默丢弃——issue #469 复现第 3(b) 步）。
#[test]
fn chained_aliases_resolve_deep_module_edges() {
    let files = [
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a/mod.rs", "mod b;\n"),
        ("a/b/mod.rs", "mod c;\n"),
        ("a/b/c.rs", "use crate::user::U;\n"),
        (
            "user.rs",
            "use crate::a as p;\nuse p::b as q;\nuse q::c as r;\nuse r::X;\n",
        ),
    ];
    let graph = edges(&files);
    assert!(
        graph["user.rs"].contains("a/b/c.rs"),
        "别名链尾端 r 的目标边丢失（静默丢边）：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "别名链解析出的深模块边须闭合环：{:?}",
        cycles_of(&graph)
    );
}

/// 链中每一跳的 use 自身也成边：`use p::b as q;` 与 `use q::c as r;` 的
/// 路径按展开候选解析到中间模块文件。
#[test]
fn chained_alias_hops_keep_intermediate_edges() {
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a/mod.rs", "mod b;\n"),
        ("a/b/mod.rs", "mod c;\npub struct C;\n"),
        ("a/b/c.rs", "pub struct X;\n"),
        (
            "user.rs",
            "use crate::a as p;\nuse p::b as q;\nuse q::c as r;\nuse r::X;\n",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("a/b/mod.rs") && graph["user.rs"].contains("a/b/c.rs"),
        "链中每一跳的展开候选都应成边：{:?}",
        graph["user.rs"]
    );
}

/// 别名链经外部 crate（serde_json as sj 后 use sj::Value）正确终止于
/// 外部：不入图、不误报（链目标非内部模块时不产生候选）。
#[test]
fn chained_aliases_through_external_crates_stay_external() {
    let graph = edges(&[
        ("lib.rs", "mod a;\nmod user;\n"),
        ("a.rs", "pub struct A;\n"),
        (
            "user.rs",
            "use serde_json as sj;\nuse sj::Value;\nuse crate::a::A;\n",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("a.rs"),
        "非链内路径照常解析：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        graph["user.rs"].len(),
        1,
        "经外部 crate 的别名链不得引入边：{:?}",
        graph["user.rs"]
    );
}

/// 夹具文件列表 → 采集审计结论。
fn audit(files: &[(&str, &str)]) -> audit::UseAudit {
    let map: BTreeMap<ModuleKey, String> = files
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    let mut scans = BTreeMap::new();
    let tree = ModuleTree::build(&map, &mut scans);
    audit::audit_collection(&tree, &scans)
}

/// 采集审计分类：内部解析（含 glob 引入与自环所有者）计入 resolved、
/// 外部 crate 计入 external，缺口为空——issue #469 的分类计数口径。
#[test]
fn use_audit_classifies_resolved_and_external() {
    let found = audit(&[
        ("lib.rs", "mod a;\n"),
        ("a.rs", "use crate::a::A;\nuse serde_json::Value;\n"),
    ]);
    assert_eq!(
        found.resolved, 1,
        "指向自身文件的自环所有者按已解析计：resolved={} external={}",
        found.resolved, found.external
    );
    assert_eq!(
        found.external, 1,
        "外部 crate 裸路径按外部计数：resolved={} external={}",
        found.resolved, found.external
    );
    assert!(found.unresolved_internal.is_empty());
    let found = audit(&[
        ("lib.rs", "mod p;\n"),
        ("p/mod.rs", "pub mod inner;\npub mod helper;\n"),
        ("p/inner.rs", "use super::*;\nuse helper::H;\n"),
        ("p/helper.rs", "pub struct H;\n"),
    ]);
    assert_eq!(
        found.resolved, 2,
        "glob 前缀与 glob 引入名都按已解析计：resolved={} external={}",
        found.resolved, found.external
    );
    assert_eq!(found.external, 0);
    assert!(found.unresolved_internal.is_empty());
}

/// 分类决策真值表：命中内部模块名却零目标是唯一的缺口形态
///（issue #469：其余组合分别为已解析与外部）。
#[test]
fn internal_miss_requires_internal_hit_without_targets() {
    assert!(matches!(
        audit::outcome_of(true, false),
        audit::UseOutcome::InternalMiss
    ));
    assert!(matches!(
        audit::outcome_of(true, true),
        audit::UseOutcome::Resolved
    ));
    assert!(matches!(
        audit::outcome_of(false, true),
        audit::UseOutcome::Resolved
    ));
    assert!(matches!(
        audit::outcome_of(false, false),
        audit::UseOutcome::External
    ));
}

/// 真实仓库采集完整性（issue #469）：首段命中内部模块名的 use 路径解析
/// 缺口恒为 0；同时恢复真实图上的裸路径 facade 边采样（#426 修复后仅剩
/// 自包含夹具，df650db 移除了真实源码采样——本用例补回语义级采样）。
#[test]
fn real_repository_use_collection_is_complete() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: BTreeMap<ModuleKey, String> = BTreeMap::new();
    load_sources(&dir, &mut files, "");
    let mut scans = BTreeMap::new();
    let tree = ModuleTree::build(&files, &mut scans);
    let found = audit::audit_collection(&tree, &scans);
    assert!(
        found.unresolved_internal.is_empty(),
        "use 静默丢边（issue #469）：{:?}（resolved={} external={}）",
        found.unresolved_internal,
        found.resolved,
        found.external
    );
    assert!(
        found.resolved >= 1 && found.external >= 1,
        "分类计数异常：resolved={} external={}",
        found.resolved,
        found.external
    );
    let graph = build_graph(&files);
    assert!(
        graph
            .get("store/mod.rs")
            .is_some_and(|t| t.contains("store/validate.rs")),
        "store/mod.rs → validate 的裸路径 facade 边缺失（扫描器漏采？）"
    );
}
