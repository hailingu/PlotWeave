//! 对已抽离内核与 FFI 的生产根应用同一模块图守卫，保持跨 crate 迁移后的无环约束。

use super::*;

/// 每个宿主无关 crate 都从自身 lib 根收集真实生产依赖；核心已知边不得漏采。
#[test]
fn extracted_kernel_and_ffi_module_graphs_are_acyclic() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates");
    for name in ["plotweave-core", "plotweave-ffi"] {
        let mut files = BTreeMap::new();
        load_sources(&crates.join(name).join("src"), &mut files, "");
        let mut scans = BTreeMap::new();
        let tree = ModuleTree::build(&files, &mut scans);
        let audit = audit::audit_collection(&tree, &scans);
        assert!(
            audit.unresolved_internal.is_empty(),
            "{name} 存在遗漏的有限依赖见证：{:?}",
            audit.unresolved_internal
        );
        let graph = build_graph(&files);
        assert!(graph.contains_key("lib.rs"), "{name} 缺失 crate 根");
        if name == "plotweave-core" {
            assert!(
                graph
                    .get("store/commands.rs")
                    .is_some_and(|targets| targets.contains("store/persist.rs")),
                "抽离内核的持久化依赖不可漏采"
            );
        }
        let found = cycles_of(&graph);
        assert!(found.is_empty(), "{name} 生产模块图存在环：{found:?}");
    }
}
