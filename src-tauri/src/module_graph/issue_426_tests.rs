//! issue #426：Rust 2018 裸路径 `use <子模块>::…` 必须成边，经该类边闭合的环必须被检出。

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

/// `NAME/mod.rs` facade 以裸路径再导出多个子模块（含 `as` 重命名与分组）时，每个被引用的子模块都成边；
/// 未被引用的子模块与外部 crate 不成边。
#[test]
fn bare_facade_reexports_reach_every_imported_child() {
    let graph = edges(&[
        ("lib.rs", "mod store;"),
        (
            "store/mod.rs",
            "mod commands;\nmod persist;\nmod types;\n\
             pub use commands::{create_project, delete_project};\n\
             pub(crate) use persist::faults as atomic_write_faults;\n\
             pub(crate) use persist::{asset_identity, write_atomic};\n\
             use serde_json::Value;\n",
        ),
        ("store/commands.rs", "pub fn create_project() {}\n"),
        ("store/persist.rs", "pub fn write_atomic() {}\n"),
        ("store/types.rs", "pub struct Project;\n"),
    ]);
    assert_eq!(
        graph["store/mod.rs"],
        BTreeSet::from(["store/commands.rs".into(), "store/persist.rs".into()])
    );
}

/// inline 模块内以裸路径引用其文件子模块，同样成边并闭合经 `super::super::` 回指的环。
#[test]
fn bare_imports_inside_inline_modules_close_cycles() {
    let graph = edges(&[
        ("lib.rs", "mod a;"),
        (
            "a.rs",
            "mod outer {\n    mod child;\n    use child::C;\n}\npub struct A;\n",
        ),
        ("a/outer/child.rs", "use super::super::A;\npub struct C;\n"),
    ]);
    assert_eq!(graph["a.rs"], BTreeSet::from(["a/outer/child.rs".into()]));
    assert_eq!(cycles_of(&graph).len(), 1, "inline 作用域裸路径边须闭合环");
}
