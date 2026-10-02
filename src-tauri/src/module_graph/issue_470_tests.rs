//! issue #470：守卫的裸路径解析不得比 rustc 宽——裸首段命中**根模块名**
//! 但不在当前作用域时，rustc 把命中 extern-prelude 的名字判为外部 crate
//!（`mod std;` 不捕获兄弟模块的 `use std::…`）、对不在作用域的模块名报
//! E0432，守卫须按外部处置，不得虚构内部边与 rustc 不存在的假环；别名
//! 展开的 `crate::` 前缀中间产物保持从根下钻的锚定能力。

use super::module_graph_tests::edges;
use super::*;

/// issue #470 复现第 2 步的最小 rustc-clean crate：根声明 `mod std;`，
/// a.rs 裸 `use std::collections::HashMap;`（rustc 解析到**外部** std），
/// std.rs 以 `crate::` 指回 a——修复前守卫把 a→std 误判内部边并报出
/// rustc 不存在的环；修复后 a.rs 零出边、全图零环、std→a 真边保留。
#[test]
fn root_named_bare_path_stays_external_no_false_cycle() {
    let graph = edges(&[
        ("lib.rs", "mod std;\nmod a;\n"),
        ("std.rs", "use crate::a::A;\n"),
        ("a.rs", "use std::collections::HashMap;\n"),
    ]);
    assert!(
        graph["a.rs"].is_empty(),
        "rustc 判外部的裸首段不得产出内部边：{:?}",
        graph["a.rs"]
    );
    assert!(
        graph["std.rs"].contains("a.rs"),
        "crate:: 真实内部边不受影响：{:?}",
        graph["std.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        0,
        "守卫不得在 rustc-clean 代码上报环：{:?}",
        cycles_of(&graph)
    );
}

/// 审计口径与 resolve_use 同步：裸首段命中根模块名（非当前模块子模块）
/// 的 use 路径按 external 分类计数，不得落入 InternalMiss fail-closed
///（否则 #470 修复后守卫会把 rustc 判外部的引用当成采集缺口直接 panic）。
#[test]
fn audit_classifies_root_named_bare_path_as_external() {
    let mut files: BTreeMap<ModuleKey, String> = BTreeMap::new();
    for (k, v) in [
        ("lib.rs", "mod std;\nmod a;\n"),
        ("std.rs", "pub struct S;\n"),
        ("a.rs", "use std::collections::HashMap;\n"),
    ] {
        files.insert(k.to_string(), v.to_string());
    }
    let mut scans = BTreeMap::new();
    let tree = ModuleTree::build(&files, &mut scans);
    let found = audit::audit_collection(&tree, &scans);
    assert!(
        found.unresolved_internal.is_empty(),
        "裸首段根模块名不得记为采集缺口：{:?}",
        found.unresolved_internal
    );
    assert_eq!(found.resolved, 0, "无内部解析目标被计入 resolved");
    assert_eq!(found.external, 1, "该 use 路径须按外部 crate 分类");
}

/// 回退收窄不伤别名展开：别名绑定的目标首段是根模块时，展开产物以
/// `crate::` 前缀进入解析、经 crate 臂从根下钻成边——评审 5353260028
/// 为别名展开保留的根锚定能力由该路径承接，与裸首段回退无关。
#[test]
fn alias_expansion_still_drills_from_root() {
    let graph = edges(&[
        ("lib.rs", "mod root_mod;\nmod user;\n"),
        ("root_mod.rs", "pub mod deep;\n"),
        ("root_mod/deep.rs", "use crate::user::U;\n"),
        (
            "user.rs",
            "use crate::root_mod as alias_mod;\nuse alias_mod::deep::D;\n",
        ),
    ]);
    assert!(
        graph["user.rs"].contains("root_mod/deep.rs"),
        "别名展开的根锚定路径仍须成边：{:?}",
        graph["user.rs"]
    );
    assert_eq!(
        cycles_of(&graph).len(),
        1,
        "别名展开边与 deep→user 边须闭合真环：{:?}",
        cycles_of(&graph)
    );
}
