//! module_graph 守卫的词法别名与 glob 解析层（issue #424/#469；仅测试
//! 构建参与编译）：原始路径始终保留，当前模块子模块优先；别名按最深
//! 可见作用域取全部绑定，保留互斥平台声明的目标并集；别名链逐层递归
//! 展开（深度受限，issue #469：≥3 级链此前静默丢边）；glob 引入
//!（`use <前缀>::*`）把前缀模块的直接子模块名带入裸路径解析。仅完整
//! 绑定目标命中模块时追加展开候选，符号尾段不得截断为祖先模块。

use super::tree::ModuleTree;
use super::{AliasBinding, FileScan, GlobBinding, UseStmt};

/// 别名链递归展开的深度上限：真实链长 2~3；超过按不可解析处置返回空
///（登记边界——合法但超出建模深度，rustc 自身对循环引用也会拒绝）。
const ALIAS_CHAIN_DEPTH: usize = 8;

/// 一条 use 路径 → 原始路径、别名展开候选与 glob 展开候选。作用域内
/// 声明顺序不影响可见性；最深作用域全部同名绑定并行贡献候选，内层
/// 遮蔽全部外层绑定。glob 引入优先级最低（Rust 名字遮蔽语义），但
/// 按守卫「宁可误报环也不漏检」的口径与别名候选求并集。
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
        for mut target in module_of_binding(tree, scan, bound, &ctx) {
            target.extend(segs[1..].iter().cloned());
            candidates.push(target);
        }
    }
    for glob in globs_visible_at(scan, &u.scope) {
        let mut glob_ctx = path.to_vec();
        glob_ctx.extend(glob.inline_stack.iter().cloned());
        for prefix in absolute_module_paths(
            tree,
            scan,
            &glob.segs,
            &glob_ctx,
            &glob.scope,
            ALIAS_CHAIN_DEPTH,
        ) {
            if tree
                .children
                .get(&prefix)
                .is_some_and(|c| c.contains(first))
            {
                let mut cand = prefix;
                cand.extend(segs.iter().cloned());
                candidates.push(cand);
            }
        }
    }
    candidates
}

/// 按词法前缀筛选同名绑定，再仅保留最深可见作用域的全部平台候选。
fn visible_aliases<'a>(scan: &'a FileScan, u: &UseStmt, name: &str) -> Vec<&'a AliasBinding> {
    aliases_visible_at(scan, &u.scope, name)
}

/// 按词法前缀（声明作用域包含使用处）筛选同名绑定，再仅保留最深作用
/// 域的全部候选——链内名字查找复用同一规则（issue #469）。
fn aliases_visible_at<'a>(
    scan: &'a FileScan,
    scope: &[usize],
    name: &str,
) -> Vec<&'a AliasBinding> {
    let mut visible: Vec<_> = scan
        .renames
        .iter()
        .filter(|b| b.name == name && is_scope_prefix(&b.scope, scope))
        .collect();
    if let Some(depth) = visible.iter().map(|b| b.scope.len()).max() {
        visible.retain(|b| b.scope.len() == depth);
    }
    visible
}

/// 按词法前缀筛选在使用处可见的 glob 绑定（glob 不遮蔽，全部保留）。
fn globs_visible_at<'a>(scan: &'a FileScan, scope: &[usize]) -> Vec<&'a GlobBinding> {
    scan.globs
        .iter()
        .filter(|g| is_scope_prefix(&g.scope, scope))
        .collect()
}

/// 绑定目标 → 候选绝对模块路径集：别名链递归展开（issue #469），绑定
/// 位置取引用处 ctx——与单层展开的既有口径一致。
fn module_of_binding(
    tree: &ModuleTree,
    scan: &FileScan,
    bound: &AliasBinding,
    ctx: &[String],
) -> Vec<Vec<String>> {
    absolute_module_paths(
        tree,
        scan,
        &bound.segs,
        ctx,
        &bound.scope,
        ALIAS_CHAIN_DEPTH,
    )
}

/// 路径段集 → 候选绝对模块路径（多值：链中同名绑定的平台/多绑定并集）：
/// `crate` 重定到根、`self`/`super` 按声明位置解析；裸首段先按当前位置
/// 子模块（Rust 遮蔽语义：显式子模块优先），再按可见别名链递归展开
///（issue #469），无命中则按位置相对路径兜底。仅完整命中已知模块
///（file_of）的候选保留。
fn absolute_module_paths(
    tree: &ModuleTree,
    scan: &FileScan,
    segs: &[String],
    ctx: &[String],
    scope: &[usize],
    depth: usize,
) -> Vec<Vec<String>> {
    let Some(first) = segs.first().map(String::as_str) else {
        return Vec::new();
    };
    let mut skip = 0usize;
    let positions: Vec<Vec<String>> = match first {
        "crate" => {
            skip = 1;
            vec![Vec::new()]
        }
        "self" => {
            skip = 1;
            vec![ctx.to_vec()]
        }
        "super" => {
            let supers = segs.iter().take_while(|s| s.as_str() == "super").count();
            skip = supers;
            let mut position = ctx.to_vec();
            for _ in 0..supers {
                if position.pop().is_none() {
                    break;
                }
            }
            vec![position]
        }
        name => {
            let mut expanded: Vec<Vec<String>> = Vec::new();
            if !tree.children.get(ctx).is_some_and(|c| c.contains(name)) && depth > 0 {
                for bound in aliases_visible_at(scan, scope, name) {
                    expanded.extend(absolute_module_paths(
                        tree,
                        scan,
                        &bound.segs,
                        ctx,
                        &bound.scope,
                        depth - 1,
                    ));
                }
            }
            if expanded.is_empty() {
                vec![ctx.to_vec()]
            } else {
                skip = 1;
                expanded
            }
        }
    };
    positions
        .into_iter()
        .map(|mut p| {
            p.extend(segs[skip..].iter().cloned());
            p
        })
        .filter(|p| tree.file_of.contains_key(p))
        .collect()
}

/// 词法包含判定：a 是否为 b 的前缀（a 的块都是 b 的祖先块）。
fn is_scope_prefix(a: &[usize], b: &[usize]) -> bool {
    a.len() <= b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}
