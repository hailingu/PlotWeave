//! #494：真实扫描产物在受控漏边采集下必须产生可观察的审计缺口。

use super::*;

/// 带独立预期的审计拓扑：user 经直接别名或 glob 引用 p/child 文件。
fn audit_fixture(source: &str) -> (ModuleTree, BTreeMap<ModuleKey, FileScan>) {
    let files = BTreeMap::from([
        ("lib.rs".into(), "mod p; mod user;".into()),
        ("p/mod.rs".into(), "pub mod child;".into()),
        ("p/child.rs".into(), "pub struct Item;".into()),
        ("user.rs".into(), source.into()),
    ]);
    let mut scans = BTreeMap::new();
    let tree = ModuleTree::build(&files, &mut scans);
    (tree, scans)
}

/// 删除裸路径别名/glob 展开会让实际 resolver 返回零目标；审计须独立识别。
#[test]
fn missing_bare_alias_and_glob_targets_are_audit_failures() {
    for source in [
        "use crate::p as alias; use alias::child::Item;",
        "use crate::p::*; use child::Item;",
    ] {
        let (tree, scans) = audit_fixture(source);
        let found = audit::audit_collection_with(&tree, &scans, |path, _, u, segs| {
            resolve_use(&tree, path, &u.inline_stack, segs)
                .into_iter()
                .collect()
        });
        assert!(
            !found.unresolved_internal.is_empty(),
            "漏边不得被归为外部：{source}"
        );
        assert!(
            found
                .unresolved_internal
                .iter()
                .any(|gap| gap.contains("p/child.rs")),
            "缺口须指出实际遗漏的 owner：{:?}",
            found.unresolved_internal
        );
    }
}

/// 实际采集只留下祖先 owner 也不能满足子模块 owner 的采集不变量。
#[test]
fn ancestor_owner_does_not_mask_a_missing_child_owner() {
    let (tree, scans) = audit_fixture("use crate::p::child::Item;");
    let found = audit::audit_collection_with(&tree, &scans, |_, _, _, _| {
        BTreeSet::from(["p/mod.rs".into()])
    });
    assert!(
        !found.unresolved_internal.is_empty(),
        "非空祖先目标不能掩盖漏边"
    );
}

/// 真实仓库暂无生产 alias/glob 消费形态；显式语法 canary 保证它们也经过
/// 同一审计入口。预期 owner 为手工确认的 fixture 契约，不由建边解析器推导。
pub(super) fn assert_import_canaries() {
    for source in [
        "use crate::p as alias; use alias::child::Item;",
        "use crate::p::*; use child::Item;",
    ] {
        let (tree, scans) = audit_fixture(source);
        let path = vec!["user".into()];
        let scan = &scans["user.rs"];
        let u = &scan.uses[1];
        let segs = use_tree_of(&u.tokens).paths.remove(0);
        assert_eq!(
            audit_witness::expected_owners(&tree, &scans, &path, &"user.rs".into(), u, &segs),
            BTreeSet::from(["p/child.rs".into()]),
            "独立见证须包含 canary 的字面 owner"
        );
        let found = audit::audit_collection(&tree, &scans);
        assert!(
            found.unresolved_internal.is_empty(),
            "alias/glob 语法 canary 漏边：{:?}",
            found.unresolved_internal
        );
    }
}

/// 正常采集不应虚构缺口，别名/glob canary 与真实仓库断言共享语义入口。
#[test]
fn complete_alias_and_glob_collection_satisfies_witnesses() {
    assert_import_canaries();
}

/// 原始扫描输入 → 树与扫描产物；期望所有者仍由各用例字面指定。
fn scan_fixture(files: &[(&str, &str)]) -> (ModuleTree, BTreeMap<ModuleKey, FileScan>) {
    let files = files
        .iter()
        .map(|(key, source)| (key.to_string(), source.to_string()))
        .collect();
    let mut scans = BTreeMap::new();
    let tree = ModuleTree::build(&files, &mut scans);
    (tree, scans)
}

/// 同文件所有者也属于独立审计集合；丢自环仅属于建边阶段。
#[test]
fn missing_self_owner_is_an_audit_failure() {
    let (tree, scans) = audit_fixture("use crate::user::Thing;");
    let found = audit::audit_collection_with(&tree, &scans, |_, _, _, _| BTreeSet::new());
    assert_eq!(found.unresolved_internal.len(), 1);
    assert!(found.unresolved_internal[0].contains("user.rs"));
    assert!(audit::audit_collection(&tree, &scans)
        .unresolved_internal
        .is_empty());
}

/// 平台并集需保留每个 owner，不能以其中一个已采集 owner 满足全部见证。
#[test]
fn partial_platform_owner_union_is_an_audit_failure() {
    let (tree, scans) = scan_fixture(&[
        (
            "lib.rs",
            "#[cfg(unix)] mod p {} #[cfg(windows)] mod p; mod user;",
        ),
        ("p.rs", "pub struct Item;"),
        ("user.rs", "use crate::p::Item;"),
    ]);
    let found =
        audit::audit_collection_with(&tree, &scans, |_, _, _, _| BTreeSet::from(["p.rs".into()]));
    assert_eq!(found.unresolved_internal.len(), 1);
    assert!(found.unresolved_internal[0].contains("lib.rs"));
    assert!(audit::audit_collection(&tree, &scans)
        .unresolved_internal
        .is_empty());
}

/// 父引入、块遮蔽和私有 glob 不应把外部裸名提升为必需 owner。
#[test]
fn scope_and_visibility_boundaries_do_not_invent_witnesses() {
    for (provider, user) in [
        (
            "pub mod child;",
            "use crate::p::*; mod nested { use child::Item; }",
        ),
        (
            "pub mod child;",
            "use crate::p as alias; mod nested { use alias::child::Item; }",
        ),
        (
            "pub mod child;",
            "use crate::p as alias; fn f(){use std as alias; use alias::child::Item;}",
        ),
        ("mod child;", "use crate::p::*; use child::Item;"),
        (
            "pub(in crate::p) mod child;",
            "use crate::p::*; use child::Item;",
        ),
    ] {
        let (tree, scans) = scan_fixture(&[
            ("lib.rs", "mod p; mod user;"),
            ("p/mod.rs", provider),
            ("p/child.rs", "pub struct Item;"),
            ("user.rs", user),
        ]);
        let found = audit::audit_collection_with(&tree, &scans, |path, _, u, segs| {
            resolve_use(&tree, path, &u.inline_stack, segs)
                .into_iter()
                .collect()
        });
        assert!(
            found.unresolved_internal.is_empty(),
            "虚构缺口：{user}: {:?}",
            found.unresolved_internal
        );
    }
}

/// 显式类型占据同名命名空间时 glob 独立见证保守让位，既有 #480 解析不回退。
#[test]
fn explicit_type_binding_does_not_create_a_glob_witness() {
    let (tree, scans) = scan_fixture(&[
        ("lib.rs", "mod p; mod values; mod user;"),
        ("p/mod.rs", "pub mod child;"),
        ("p/child.rs", "pub struct Item;"),
        ("values.rs", "pub enum Value { Item }"),
        (
            "user.rs",
            "use crate::p::*; use crate::values::Value as child; use child::Item;",
        ),
    ]);
    let found = audit::audit_collection_with(&tree, &scans, |path, _, u, segs| {
        resolve_use(&tree, path, &u.inline_stack, segs)
            .into_iter()
            .collect()
    });
    assert!(found.unresolved_internal.is_empty());
}

/// 裸 alias 后进入其他命名空间的引入名不建立字面祖先见证；实际可合法只指向
/// 更深/另一模块 owner，有限见证不能因复杂尾段虚报缺口。
#[test]
fn introduced_suffixes_remain_outside_independent_witnesses() {
    for (provider, user) in [
        (
            "pub use crate::q as tail;",
            "use crate::p as alias; use alias::tail::Item;",
        ),
        (
            "pub use crate::q as tail;",
            "use crate::*; use p::tail::Item;",
        ),
        (
            "pub use crate::q::*;",
            "use crate::p as alias; use alias::child::Item;",
        ),
    ] {
        let (tree, scans) = scan_fixture(&[
            ("lib.rs", "pub mod p; pub mod q; mod user;"),
            ("p.rs", provider),
            ("q/mod.rs", "pub mod child; pub struct Item;"),
            ("q/child.rs", "pub struct Item;"),
            ("user.rs", user),
        ]);
        assert!(audit::audit_collection(&tree, &scans)
            .unresolved_internal
            .is_empty());
    }
}
