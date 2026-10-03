//! 模块图语法回归的共享拓扑与语义断言（issue #504）；不替代具体输入用例。

use super::module_graph_tests::edges;
use super::*;

/// 测试项不得贡献 a→b；b→a 的反向边用于暴露错误采集产生的假环。
pub(super) fn assert_test_exclusion(source: &str, context: &str) {
    assert_dependencies(source, ("use crate::a::A;", "pub struct C;"), 0, context);
}

/// 后续生产 a→c 必须保留，与 c→a 恰构成一个真环；测试 a→b 不得泄漏。
pub(super) fn assert_production_cycle(source: &str, context: &str) {
    assert_dependencies(source, ("pub struct B;", "use crate::a::A;"), 1, context);
}

/// 三模块场景共同断言 a 只指向 c；反向依赖和预期环数由语义入口明确指定。
fn assert_dependencies(source: &str, reverse: (&str, &str), cycles: usize, context: &str) {
    let graph = edges(&[
        ("lib.rs", "mod a; mod b; mod c;"),
        ("a.rs", source),
        ("b.rs", reverse.0),
        ("c.rs", reverse.1),
    ]);
    assert_eq!(graph["a.rs"], BTreeSet::from(["c.rs".into()]), "{context}");
    assert_eq!(cycles_of(&graph).len(), cycles, "生产环数：{context}");
}

/// user→glob 子模块→user 拓扑；值声明、别名绑定和消费者源码由各用例拥有。
pub(super) fn user_glob_graph(
    values: &str,
    aliases: &str,
    user: &str,
) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    glob_graph(
        values,
        &[
            (
                "lib.rs",
                "pub mod values;\npub mod a;\npub mod m;\npub mod user;\n",
            ),
            ("m.rs", aliases),
            ("user.rs", user),
        ],
        "use crate::user::User;\n\npub fn take(u: User) {\n    let _ = u;\n}\n",
    )
}

/// host 的局部绑定/glob 拓扑；cfg 和命名空间预期边仍在具体用例显式断言。
pub(super) fn host_glob_graph(
    values: &str,
    host: &str,
) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    glob_graph(
        values,
        &[
            ("lib.rs", "pub mod values;\npub mod a;\npub mod host;\n"),
            ("host.rs", host),
        ],
        "use crate::host::H;\n\npub fn take(h: H) {\n    let _ = h;\n}\n",
    )
}

/// 共享 glob 提供者与反向边；保留调用方传入的模块声明和全部场景源码。
fn glob_graph(
    values: &str,
    peers: &[(&str, &str)],
    reverse: &str,
) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    let mut files = peers.to_vec();
    files.extend([
        ("values.rs", values),
        ("a/mod.rs", "pub mod p;\n\npub fn aux() {}\n"),
        ("a/p.rs", reverse),
    ]);
    edges(&files)
}
