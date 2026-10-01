//! module_graph 守卫的词法别名与 glob 解析层（issue #424/#469；仅测试
//! 构建参与编译）：原始路径始终保留，当前模块子模块优先；别名按最深
//! 可见作用域取全部绑定，保留互斥平台声明的目标并集；别名链与链式
//! glob 前缀逐层递归展开（深度受限，issue #469：≥3 级链与 glob 链此前
//! 静默丢边）；glob 引入（`use <前缀>::*`）把前缀模块的直接子模块名
//! 带入裸路径解析。绑定与 glob 仅在其**声明模块**内可见——inline 子
//! 模块不继承父模块的引入（评审 5379907393），跨模块泄漏会把外部
//! crate 引用解析成内部边、误报环；glob 只带走**对使用处可见**的子模块
//! 名（私有/受限子模块不参与，评审 5380401098）。仅完整绑定目标命中
//! 模块时追加展开候选，符号尾段不得截断为祖先模块。显式位置前缀后
//! 的名字在指定模块的命名空间查别名/glob，不按字面子模块拼接
//!（评审 5381066396）；普通块的局部引入不属于该命名空间。

use super::tree::ModuleTree;
use std::collections::BTreeMap;

use super::{FileScan, ModuleKey, UseStmt};

/// 词法重命名：本地名与原始目标路径，绑定于声明模块和普通块作用域。
/// 显式位置前缀只能访问模块级引入（评审 5381066396）。
pub(super) struct AliasBinding {
    pub(super) name: String,
    pub(super) segs: Vec<String>,
    pub(super) inline_stack: Vec<String>,
    pub(super) scope: Vec<usize>,
    pub(super) module_level: bool,
}

/// glob 前缀及其声明位置；模块级标志区分限定名字查找与块词法查找。
pub(super) struct GlobBinding {
    pub(super) segs: Vec<String>,
    pub(super) inline_stack: Vec<String>,
    pub(super) scope: Vec<usize>,
    pub(super) module_level: bool,
}

/// 名字查找位置：文件模块路径 + inline 模块路径 + 普通块作用域；
/// namespace 为真时仅取指定模块级绑定，排除使用点的块局部遮蔽。
#[derive(Clone, Copy)]
struct Lookup<'a> {
    path: &'a [String],
    inline: &'a [String],
    scope: &'a [usize],
    namespace: bool,
}

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
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    path: &[String],
    u: &UseStmt,
    segs: Vec<String>,
) -> Vec<Vec<String>> {
    let mut candidates = vec![segs.clone()];
    let Some(first) = segs.first() else {
        return candidates;
    };
    let at = Lookup {
        path,
        inline: &u.inline_stack,
        scope: &u.scope,
        namespace: false,
    };
    if matches!(first.as_str(), "crate" | "self" | "super") {
        for target in qualified_paths(tree, scans, &segs, at, CHAIN_DEPTH) {
            let mut absolute = vec!["crate".to_string()];
            absolute.extend(target);
            candidates.push(absolute);
        }
        return candidates;
    }
    let mut ctx = path.to_vec();
    ctx.extend(u.inline_stack.iter().cloned());
    if tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        return candidates;
    }
    for bound in aliases_visible_at(scan, at, first) {
        for mut target in module_of_binding(tree, scans, scan, bound, path) {
            target.extend(segs[1..].iter().cloned());
            candidates.push(target);
        }
    }
    for glob in globs_visible_at(scan, at) {
        for prefix in absolute_module_paths(
            tree,
            scans,
            scan,
            &glob.segs,
            Lookup {
                path,
                inline: &glob.inline_stack,
                scope: &glob.scope,
                namespace: false,
            },
            CHAIN_DEPTH,
        ) {
            if tree
                .children
                .get(&prefix)
                .is_some_and(|c| c.contains(first))
                && glob_importable(tree, &prefix, first, &ctx)
            {
                let mut cand = prefix;
                cand.extend(segs.iter().cloned());
                candidates.push(cand);
            }
        }
    }
    candidates
}

/// glob 候选子模块名对使用处是否可见（评审 5380401098）：私有/受限
///（pub(super)/pub(in …)）子模块的名字不参与 glob 展开——真实 Rust 的
/// glob 只带走对使用处可见的项，同名裸路径在子树外解析到外部 crate，
/// 虚构内部边会误报环。可见性以树登记的「可见子树根是使用处模块路径
/// 的前缀」判定；无登记即 pub/pub(crate) 的 crate 内任意可见。
fn glob_importable(tree: &ModuleTree, prefix: &[String], child: &str, use_site: &[String]) -> bool {
    match tree.child_vis.get(&(prefix.to_vec(), child.to_string())) {
        None | Some(None) => true,
        Some(Some(root)) => {
            root.len() <= use_site.len() && root.iter().zip(use_site).all(|(r, u)| r == u)
        }
    }
}

/// 绑定在使用处（声明模块 inline 栈 + 块作用域定位）是否可见：须与
/// 使用处同处一个声明模块（inline 栈相等——子模块不继承父模块引入，
/// 评审 5379907393），且绑定块词法包含使用点；再仅保留最深作用域的
/// 全部候选——链内名字查找复用同一规则（issue #469）。
fn aliases_visible_at<'a>(scan: &'a FileScan, at: Lookup<'_>, name: &str) -> Vec<&'a AliasBinding> {
    let mut visible: Vec<_> = scan
        .renames
        .iter()
        .filter(|b| {
            b.name == name
                && b.inline_stack.as_slice() == at.inline
                && if at.namespace {
                    b.module_level
                } else {
                    is_scope_prefix(&b.scope, at.scope)
                }
        })
        .collect();
    if let Some(depth) = visible.iter().map(|b| b.scope.len()).max() {
        visible.retain(|b| b.scope.len() == depth);
    }
    visible
}

/// 模块限定查找只取模块级 glob；裸名字仍按原来的块词法包含判定。
fn globs_visible_at<'a>(scan: &'a FileScan, at: Lookup<'_>) -> Vec<&'a GlobBinding> {
    scan.globs
        .iter()
        .filter(|g| {
            g.inline_stack.as_slice() == at.inline
                && if at.namespace {
                    g.module_level
                } else {
                    is_scope_prefix(&g.scope, at.scope)
                }
        })
        .collect()
}

/// 绑定目标 → 候选绝对模块路径集：别名链与链式 glob 递归展开
///（issue #469）；位置前缀与名字查找均取**声明处**（文件模块路径 +
/// 绑定的 inline 栈），不再近似为引用处。
fn module_of_binding(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    bound: &AliasBinding,
    path: &[String],
) -> Vec<Vec<String>> {
    absolute_module_paths(
        tree,
        scans,
        scan,
        &bound.segs,
        Lookup {
            path,
            inline: &bound.inline_stack,
            scope: &bound.scope,
            namespace: false,
        },
        CHAIN_DEPTH,
    )
}

/// 路径段 → 精确模块目标。位置前缀先指定命名空间，再解析该处的
/// 别名/glob；裸名字保留直接子模块优先和最深词法绑定的既有口径。
fn absolute_module_paths(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    segs: &[String],
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let Some(first) = segs.first() else {
        return Vec::new();
    };
    if matches!(first.as_str(), "crate" | "self" | "super") {
        return qualified_paths(tree, scans, segs, at, depth)
            .into_iter()
            .filter(|p| tree.file_of.contains_key(p))
            .collect();
    }
    let mut ctx = at.path.to_vec();
    ctx.extend(at.inline.iter().cloned());
    let mut expanded = Vec::new();
    if depth > 0 && !tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        expanded = introduced_positions(tree, scans, scan, first, at, depth);
    }
    let skip = usize::from(!expanded.is_empty());
    if expanded.is_empty() {
        expanded.push(ctx);
    }
    expanded
        .into_iter()
        .map(|mut p| {
            p.extend(segs[skip..].iter().cloned());
            p
        })
        .filter(|p| tree.file_of.contains_key(p))
        .collect()
}

/// 消费 crate/self/连续 super，得到指定模块及剩余段的起点；越根仍
/// fail-closed，不把无效父位置当成 crate 根（与 resolve_use 同契约）。
fn qualified_context(segs: &[String], at: Lookup<'_>) -> (Vec<String>, usize) {
    let mut ctx = at.path.to_vec();
    ctx.extend(at.inline.iter().cloned());
    match segs.first().map(String::as_str) {
        Some("crate") => (Vec::new(), 1),
        Some("self") => (ctx, 1),
        Some("super") => {
            let skip = segs.iter().take_while(|s| s.as_str() == "super").count();
            for _ in 0..skip {
                assert!(
                    ctx.pop().is_some(),
                    "super:: 越过 crate 根：{}",
                    segs.join("::")
                );
            }
            (ctx, skip)
        }
        _ => unreachable!("只对显式位置前缀消费上下文"),
    }
}

/// 指定模块的全部平台文件所有者分别贡献其模块级绑定；inline 模块
/// 通过规范文件路径定位同一文件中的声明栈。返回绝对路径（可含 item
/// 后缀），绑定目标资格由 absolute_module_paths 的精确过滤维护。
fn qualified_paths(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    segs: &[String],
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let (ctx, skip) = qualified_context(segs, at);
    let rest = &segs[skip..];
    let Some(first) = rest.first() else {
        return vec![ctx];
    };
    if tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        let mut target = ctx;
        target.extend(rest.iter().cloned());
        return vec![target];
    }
    if depth == 0 {
        return Vec::new();
    }
    let mut positions = Vec::new();
    for (path, key) in &tree.canonical {
        if !ctx.starts_with(path)
            || !tree
                .file_of
                .get(&ctx)
                .is_some_and(|owners| owners.contains(key))
        {
            continue;
        }
        let lookup = Lookup {
            path,
            inline: &ctx[path.len()..],
            scope: &[],
            namespace: true,
        };
        for mut target in introduced_positions(tree, scans, &scans[key], first, lookup, depth) {
            target.extend(rest[1..].iter().cloned());
            positions.push(target);
        }
    }
    positions
}

/// 可见引入的模块目标：别名优先、glob 兜底；递归查找始终回到绑定
/// 自身声明位置，保持深度上限、同名平台并集与符号尾段精确资格。
fn introduced_positions(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    name: &str,
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let mut positions = Vec::new();
    for bound in aliases_visible_at(scan, at, name) {
        positions.extend(absolute_module_paths(
            tree,
            scans,
            scan,
            &bound.segs,
            Lookup {
                path: at.path,
                inline: &bound.inline_stack,
                scope: &bound.scope,
                namespace: false,
            },
            depth - 1,
        ));
    }
    if positions.is_empty() {
        positions.extend(glob_positions(tree, scans, scan, name, at, depth));
    }
    positions
}

/// 可见 glob 的直接子模块目标；前缀绝对化递归复用别名/glob 链，
/// 可见性仍以 glob 声明命名空间作为使用处判定，保持私有子模块边界。
fn glob_positions(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    name: &str,
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let mut use_site = at.path.to_vec();
    use_site.extend(at.inline.iter().cloned());
    let mut positions = Vec::new();
    for glob in globs_visible_at(scan, at) {
        for prefix in absolute_module_paths(
            tree,
            scans,
            scan,
            &glob.segs,
            Lookup {
                path: at.path,
                inline: &glob.inline_stack,
                scope: &glob.scope,
                namespace: false,
            },
            depth - 1,
        ) {
            if tree.children.get(&prefix).is_some_and(|c| c.contains(name))
                && glob_importable(tree, &prefix, name, &use_site)
            {
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
