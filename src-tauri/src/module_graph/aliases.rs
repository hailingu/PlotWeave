//! module_graph 守卫的词法别名解析层（issue #424；仅测试构建参与编译）：
//! 原始路径始终保留，当前模块子模块优先；别名按最深可见作用域取全部
//! 绑定，保留互斥平台声明的目标并集。绑定目标按既有模块前缀规则单层
//! 展开；无法定位模块时不追加候选，链式别名推断仍属已登记边界。

use super::tree::ModuleTree;
use super::{AliasBinding, FileScan, UseStmt};

/// 一条 use 路径 → 原始路径与单层别名展开候选。作用域内声明顺序不影响
/// 可见性；最深作用域全部同名绑定并行贡献候选，内层遮蔽全部外层绑定。
pub(super) fn expand_segments(
    tree: &ModuleTree,
    scan: &FileScan,
    path: &[String],
    u: &UseStmt,
    segs: Vec<String>,
) -> Vec<Vec<String>> {
    let mut candidates = vec![segs.clone()];
    let Some(first) = segs.first() else {
        return candidates;
    };
    let mut ctx = path.to_vec();
    ctx.extend(u.inline_stack.iter().cloned());
    if tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        return candidates;
    }
    for bound in visible_aliases(scan, u, first) {
        let mut expanded = module_of_binding(tree, bound, &ctx);
        if !expanded.is_empty() {
            expanded.extend(segs[1..].iter().cloned());
            candidates.push(expanded);
        }
    }
    candidates
}

/// 按词法前缀筛选同名绑定，再仅保留最深可见作用域的全部平台候选。
fn visible_aliases<'a>(scan: &'a FileScan, u: &UseStmt, name: &str) -> Vec<&'a AliasBinding> {
    let mut visible: Vec<_> = scan
        .renames
        .iter()
        .filter(|b| b.name == name && is_scope_prefix(&b.scope, &u.scope))
        .collect();
    if let Some(depth) = visible.iter().map(|b| b.scope.len()).max() {
        visible.retain(|b| b.scope.len() == depth);
    }
    visible
}

/// 绑定目标按 crate/self/super 或当前模块位置绝对化，再截到已知模块前缀。
fn module_of_binding(tree: &ModuleTree, bound: &AliasBinding, ctx: &[String]) -> Vec<String> {
    let first = bound.segs.first().map(String::as_str);
    let position = match first {
        Some("crate") => Vec::new(),
        Some("self") => ctx.to_vec(),
        Some("super") => {
            let mut c = ctx.to_vec();
            for seg in &bound.segs {
                if seg == "super" {
                    if c.pop().is_none() {
                        break;
                    }
                } else {
                    break;
                }
            }
            c
        }
        _ => ctx.to_vec(),
    };
    let skip = match first {
        Some("crate" | "self") => 1,
        Some("super") => bound
            .segs
            .iter()
            .take_while(|s| s.as_str() == "super")
            .count(),
        _ => 0,
    };
    let mut absolute = position;
    absolute.extend(bound.segs[skip..].iter().cloned());
    module_prefix_of(tree, &absolute)
}

/// 绑定路径逐段回退到首个存在的模块路径（剔除 fn/struct 等 item 叶子）。
fn module_prefix_of(tree: &ModuleTree, segs: &[String]) -> Vec<String> {
    let mut prefix = segs.to_vec();
    while !prefix.is_empty() {
        if tree.file_of.contains_key(&prefix) {
            return prefix;
        }
        prefix.pop();
    }
    prefix
}

/// 词法包含判定：a 是否为 b 的前缀（a 的块都是 b 的祖先块）。
fn is_scope_prefix(a: &[usize], b: &[usize]) -> bool {
    a.len() <= b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}
