//! module_graph 守卫的词法别名与 glob 解析层（issue #424/#469；仅测试
//! 构建参与编译）：原始路径始终保留，当前模块子模块优先；别名按最深
//! 可见作用域取全部绑定，保留互斥平台声明的目标并集；别名链与链式
//! glob 前缀逐层递归展开（深度受限，issue #469：≥3 级链与 glob 链此前
//! 静默丢边）；glob 引入（`use <前缀>::*`）把前缀模块的直接子模块名
//! 带入裸路径解析。绑定与 glob 仅在其**声明模块**内可见——inline 子
//! 模块不继承父模块的引入（评审 5379907393），跨模块泄漏会把外部
//! crate 引用解析成内部边、误报环。仅完整绑定目标命中模块时追加展开
//! 候选，符号尾段不得截断为祖先模块。

use super::tree::ModuleTree;
use super::{AliasBinding, FileScan, GlobBinding, UseStmt};

/// 别名与 glob 解析链的递归深度上限：真实链长 2~3；超过按不可解析处置
/// 返回空（登记边界——合法但超出建模深度；链中自引用经此自然终止，
/// rustc 自身对循环引用也会拒绝）。
const CHAIN_DEPTH: usize = 8;

/// 一条 use 路径 → 原始路径、别名展开候选与 glob 展开候选。作用域内
/// 声明顺序不影响可见性；同一声明模块内最深作用域的全部同名绑定并行
/// 贡献候选，内层遮蔽全部外层绑定。glob 引入优先级最低（Rust 名字
/// 遮蔽语义），但按守卫「宁可误报环也不漏检」的口径与别名候选求并集。
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
    for bound in aliases_visible_at(scan, &u.inline_stack, &u.scope, first) {
        for mut target in module_of_binding(tree, scan, bound, path) {
            target.extend(segs[1..].iter().cloned());
            candidates.push(target);
        }
    }
    for glob in globs_visible_at(scan, &u.inline_stack, &u.scope) {
        for prefix in absolute_module_paths(
            tree,
            scan,
            &glob.segs,
            path,
            &glob.inline_stack,
            &glob.scope,
            CHAIN_DEPTH,
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

/// 绑定在使用处（声明模块 inline 栈 + 块作用域定位）是否可见：须与
/// 使用处同处一个声明模块（inline 栈相等——子模块不继承父模块引入，
/// 评审 5379907393），且绑定块词法包含使用点；再仅保留最深作用域的
/// 全部候选——链内名字查找复用同一规则（issue #469）。
fn aliases_visible_at<'a>(
    scan: &'a FileScan,
    inline: &[String],
    scope: &[usize],
    name: &str,
) -> Vec<&'a AliasBinding> {
    let mut visible: Vec<_> = scan
        .renames
        .iter()
        .filter(|b| {
            b.name == name
                && b.inline_stack.as_slice() == inline
                && is_scope_prefix(&b.scope, scope)
        })
        .collect();
    if let Some(depth) = visible.iter().map(|b| b.scope.len()).max() {
        visible.retain(|b| b.scope.len() == depth);
    }
    visible
}

/// 筛选在使用处可见的 glob 绑定：同一声明模块 + 词法包含（glob 不遮蔽，
/// 全部保留；子模块不继承父模块的 glob，评审 5379907393）。
fn globs_visible_at<'a>(
    scan: &'a FileScan,
    inline: &[String],
    scope: &[usize],
) -> Vec<&'a GlobBinding> {
    scan.globs
        .iter()
        .filter(|g| g.inline_stack.as_slice() == inline && is_scope_prefix(&g.scope, scope))
        .collect()
}

/// 绑定目标 → 候选绝对模块路径集：别名链与链式 glob 递归展开
///（issue #469）；位置前缀与名字查找均取**声明处**（文件模块路径 +
/// 绑定的 inline 栈），不再近似为引用处。
fn module_of_binding(
    tree: &ModuleTree,
    scan: &FileScan,
    bound: &AliasBinding,
    path: &[String],
) -> Vec<Vec<String>> {
    absolute_module_paths(
        tree,
        scan,
        &bound.segs,
        path,
        &bound.inline_stack,
        &bound.scope,
        CHAIN_DEPTH,
    )
}

/// 路径段集 → 候选绝对模块路径（多值：链中同名绑定的平台/多绑定并集）：
/// `crate` 重定到根、`self`/`super` 按声明位置（path + 声明处 inline 栈）
/// 解析；裸首段先按声明位置子模块（Rust 遮蔽语义：显式子模块优先），
/// 再按可见别名链、可见 glob 链（显式别名遮蔽 glob 引入；链式 glob
/// 前缀——评审 5379907393——经此展开）递归解析，无命中则按位置相对
/// 路径兜底。仅完整命中已知模块（file_of）的候选保留。
fn absolute_module_paths(
    tree: &ModuleTree,
    scan: &FileScan,
    segs: &[String],
    path: &[String],
    inline: &[String],
    scope: &[usize],
    depth: usize,
) -> Vec<Vec<String>> {
    let Some(first) = segs.first().map(String::as_str) else {
        return Vec::new();
    };
    let mut ctx = path.to_vec();
    ctx.extend(inline.iter().cloned());
    let mut skip = 0usize;
    let positions: Vec<Vec<String>> = match first {
        "crate" => {
            skip = 1;
            vec![Vec::new()]
        }
        "self" => {
            skip = 1;
            vec![ctx]
        }
        "super" => {
            let supers = segs.iter().take_while(|s| s.as_str() == "super").count();
            skip = supers;
            for _ in 0..supers {
                if ctx.pop().is_none() {
                    break;
                }
            }
            vec![ctx]
        }
        name => {
            let mut expanded = Vec::new();
            if depth > 0 && !tree.children.get(&ctx).is_some_and(|c| c.contains(name)) {
                expanded = introduced_positions(tree, scan, name, path, inline, scope, depth);
            }
            if expanded.is_empty() {
                vec![ctx]
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

/// 裸名经可见引入解析出的候选位置集：别名链优先、glob 链兜底（显式
/// 别名遮蔽 glob 引入的 Rust 名字语义）；无命中为空，由调用方按位置
/// 相对路径兜底。
fn introduced_positions(
    tree: &ModuleTree,
    scan: &FileScan,
    name: &str,
    path: &[String],
    inline: &[String],
    scope: &[usize],
    depth: usize,
) -> Vec<Vec<String>> {
    let mut positions = Vec::new();
    for bound in aliases_visible_at(scan, inline, scope, name) {
        positions.extend(absolute_module_paths(
            tree,
            scan,
            &bound.segs,
            path,
            &bound.inline_stack,
            &bound.scope,
            depth - 1,
        ));
    }
    if positions.is_empty() {
        positions.extend(glob_positions(tree, scan, name, path, inline, scope, depth));
    }
    positions
}

/// 经可见 glob 解析裸名（评审 5379907393 的链式前缀）：名字须是某个
/// 可见 glob 前缀模块的直接子模块；前缀自身的绝对化递归复用别名/glob
/// 链，返回「前缀模块路径 + 该名字」的候选位置集（并集；对 glob 的
/// 显式别名遮蔽由调用方的先别名后 glob 次序保证）。
fn glob_positions(
    tree: &ModuleTree,
    scan: &FileScan,
    name: &str,
    path: &[String],
    inline: &[String],
    scope: &[usize],
    depth: usize,
) -> Vec<Vec<String>> {
    let mut positions = Vec::new();
    for glob in globs_visible_at(scan, inline, scope) {
        for prefix in absolute_module_paths(
            tree,
            scan,
            &glob.segs,
            path,
            &glob.inline_stack,
            &glob.scope,
            depth - 1,
        ) {
            if tree.children.get(&prefix).is_some_and(|c| c.contains(name)) {
                let mut position = prefix;
                position.push(name.to_string());
                positions.push(position);
            }
        }
    }
    positions
}

/// 词法包含判定：a 是否为 b 的前缀（a 的块都是 b 的祖先块）。
fn is_scope_prefix(a: &[usize], b: &[usize]) -> bool {
    a.len() <= b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}
