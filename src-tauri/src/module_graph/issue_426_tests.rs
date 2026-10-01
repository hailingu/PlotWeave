//! issue #426：Rust 2018 裸路径 `use <子模块>::…` 必须成边，真实图无环断言对该类边不得空过。

use super::module_graph_tests::edges;
use super::*;

/// 父模块以裸路径（含 pub/pub(crate)、花括号分组）引用子模块、子模块以 `super::` 回指父模块，
/// 即 diagnostics.rs ↔ recovery_events.rs 的历史环形态，必须被检出。
#[test]
fn bare_child_imports_close_parent_child_cycles() {
    for import in [
        "use recovery_events::{with_observations, RecoverySnapshot};",
        "pub(crate) use recovery_events::{publish_recovery, with_recovery_snapshot};",
        "pub use recovery_events::*;",
        "fn f() { use recovery_events::RecoverySnapshot; }",
    ] {
        let graph = edges(&[
            ("lib.rs", "mod library;"),
            ("library.rs", "mod diagnostics;"),
            (
                "library/diagnostics.rs",
                &format!(
                    "mod recovery_events;\n{import}\npub(crate) static LAST_REVISION: u64 = 0;\n"
                ),
            ),
            (
                "library/diagnostics/recovery_events.rs",
                "use super::{reserve_revision, LAST_REVISION};\n",
            ),
        ]);
        assert_eq!(
            graph["library/diagnostics.rs"],
            BTreeSet::from(["library/diagnostics/recovery_events.rs".into()]),
            "{import}"
        );
        assert_eq!(
            cycles_of(&graph).len(),
            1,
            "裸路径父→子边须闭合环：{import}"
        );
    }
}

/// 加载真实 `src-tauri/src` 生产源码（键 = 相对 posix 路径）。
fn real_sources() -> BTreeMap<ModuleKey, String> {
    let mut files = BTreeMap::new();
    load_sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
        "",
    );
    files
}

/// 真实仓库中以裸路径书写的 facade → 子模块依赖必须出现在图中。
#[test]
fn real_repository_bare_child_imports_are_edges() {
    let graph = build_graph(&real_sources());
    for (from, to) in [
        (
            "library/diagnostics.rs",
            "library/diagnostics/recovery_events.rs",
        ),
        ("store/mod.rs", "store/commands.rs"),
        ("store/mod.rs", "store/persist.rs"),
    ] {
        assert!(
            graph.get(from).is_some_and(|t| t.contains(to)),
            "{from} → {to} 的裸路径边缺失（扫描器漏采？）"
        );
    }
}

/// 在真实源码上重建历史回指边，真实图的无环断言必须转为报环（证明其不对裸路径边空过）。
#[test]
fn real_repository_reintroduced_bare_path_cycle_is_reported() {
    let mut files = real_sources();
    files
        .get_mut("library/diagnostics/recovery_events.rs")
        .expect("recovery_events.rs 应存在")
        .push_str("\nuse super::LAST_REVISION;\n");
    let found = cycles_of(&build_graph(&files));
    assert!(
        found
            .iter()
            .any(|c| c.contains("library/diagnostics/recovery_events.rs")
                && c.contains("library/diagnostics.rs")),
        "重建的 diagnostics ↔ recovery_events 环未被检出：{found:?}"
    );
}
