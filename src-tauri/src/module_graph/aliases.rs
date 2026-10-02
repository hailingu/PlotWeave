//! module_graph 守卫的词法别名与 glob 解析层（issue #424/#469/#480；仅
//! 测试构建参与编译）：原始路径始终保留，当前模块子模块优先；别名按最深
//! 可见作用域取全部绑定，保留互斥平台声明的目标并集；别名链与链式
//! glob 前缀逐层递归展开（深度受限，issue #469：≥3 级链与 glob 链此前
//! 静默丢边）；glob 引入（`use <前缀>::*`）把前缀模块的直接子模块名
//! 带入裸路径解析。绑定与 glob 仅在其**声明模块**内可见——inline 子
//! 模块不继承父模块的引入（评审 5379907393），跨模块泄漏会把外部
//! crate 引用解析成内部边、误报环；glob 只带走**对使用处可见**的子模块
//! 名（私有/受限子模块不参与，评审 5380401098）。仅完整绑定目标命中
//! 模块时追加展开候选，符号尾段不得截断为祖先模块。显式位置前缀后
//! 的名字在指定模块的命名空间查别名/glob，不按字面子模块拼接
//!（评审 5381066396）；经过字面子模块或已展开别名后，尾段继续在
//! 新模块中解析（评审 4157263363）；普通块局部引入不属于该命名空间。
//! 显式类型导入占据类型命名空间（issue #480）：可见绑定的目标全部为
//! 类型命名空间项（扫描层 type_items）且无模块目标时，同名 glob 候选
//! 让位——值项与未知/外部目标不遮蔽，模块目标仍走保守并集口径；
//! cfg 门控的条件绑定一律不遮蔽（评审 5391647570：门控不成立的配置里
//! 绑定缺席、glob 模块是真实解析目标，移除边属漏检方向）。

use super::tree::ModuleTree;
use super::type_items;
use std::collections::BTreeMap;

use super::{FileScan, ModuleKey, UseStmt};

/// 词法重命名：本地名与原始目标路径，绑定于声明模块和普通块作用域。
/// 显式位置前缀只能访问模块级引入（评审 5381066396）。unconditional =
///无非 test cfg 门控（评审 5391647570）：条件存在的绑定不参与无条件
/// 类型遮蔽——门控不成立的配置里绑定缺席，同名 glob 模块是真实解析
/// 目标，边不得移除（漏检方向）。
pub(super) struct AliasBinding {
    pub(super) name: String,
    pub(super) segs: Vec<String>,
    pub(super) inline_stack: Vec<String>,
    pub(super) scope: Vec<usize>,
    pub(super) module_level: bool,
    pub(super) unconditional: bool,
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
/// 遮蔽语义），但按守卫「宁可误报环也不漏检」的口径与别名候选求并集
///（issue #480 例外：显式类型导入占据类型命名空间且无模块目标时，
/// glob 候选让位）。
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
    let targets = if matches!(first.as_str(), "crate" | "self" | "super") {
        qualified_paths(tree, scans, &segs, at, CHAIN_DEPTH)
    } else {
        bare_paths(tree, scans, scan, &segs, at)
    };
    for target in targets {
        let mut absolute = vec!["crate".to_string()];
        absolute.extend(target);
        candidates.push(absolute);
    }
    candidates
}

/// 裸路径首段先按原来的子模块优先/块词法规则选目标，再从该模块
/// 逐段遍历尾部；初始别名与 glob 候选仍取保守并集，不恢复遮蔽的绑定
///（issue #480 例外：显式类型导入占据类型命名空间且无模块目标时，
/// 同名 glob 子模块候选让位）。
fn bare_paths(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    segs: &[String],
    at: Lookup<'_>,
) -> Vec<Vec<String>> {
    let Some(first) = segs.first() else {
        return Vec::new();
    };
    let mut ctx = at.path.to_vec();
    ctx.extend(at.inline.iter().cloned());
    if tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        return namespace_paths(tree, scans, ctx, segs, CHAIN_DEPTH);
    }
    let bindings = aliases_visible_at(scan, at, first);
    let targets = resolve_alias_bindings(tree, scans, scan, &bindings, at.path, CHAIN_DEPTH);
    let glob_shadowed = targets.type_occupying && targets.positions.is_empty();
    let mut positions = Vec::new();
    for target in targets.positions {
        positions.extend(namespace_paths(
            tree,
            scans,
            target,
            &segs[1..],
            CHAIN_DEPTH,
        ));
    }
    if !glob_shadowed {
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
                CHAIN_DEPTH,
            ) {
                if tree
                    .children
                    .get(&prefix)
                    .is_some_and(|c| c.contains(first))
                    && glob_importable(tree, &prefix, first, &ctx)
                {
                    positions.extend(namespace_paths(tree, scans, prefix, segs, CHAIN_DEPTH));
                }
            }
        }
    }
    positions
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

/// 一组同名显式绑定的解析结论：positions = 精确命中的模块目标；
/// type_occupying = 绑定存在且全部解析都落在类型命名空间项上——显式
/// 类型导入占据了该名字的类型命名空间（issue #480）。
struct AliasTargets {
    positions: Vec<Vec<String>>,
    type_occupying: bool,
}

/// 逐绑定解析完整目标并归类（issue #480）：模块目标进 positions（模块
/// 目标出现即不遮蔽——模块别名与 glob 走既有保守并集口径）；无条件
/// 绑定的类型项维持 type_occupying；值/未知目标（fn/const/static、enum
/// 变体等项内路径、外部 crate 目标）与 cfg 门控的条件绑定（评审
/// 5391647570：门控不成立的配置里绑定缺席、glob 模块是真实目标）解除
/// 遮蔽——同名 glob 模块候选必须保留。递归查找回到绑定自身声明位置
///（文件模块路径 + 绑定的 inline 栈），保持深度上限与同名平台并集口径。
fn resolve_alias_bindings(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    bindings: &[&AliasBinding],
    path: &[String],
    depth: usize,
) -> AliasTargets {
    let mut targets = AliasTargets {
        positions: Vec::new(),
        type_occupying: !bindings.is_empty(),
    };
    for bound in bindings {
        for full in absolute_item_paths(
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
            depth,
        ) {
            match full_path_kind(tree, scans, &full) {
                FullPathKind::Module => {
                    targets.positions.push(full);
                    targets.type_occupying = false;
                }
                FullPathKind::TypeItem if bound.unconditional => {}
                _ => targets.type_occupying = false,
            }
        }
    }
    targets
}

/// 完整绑定目标路径的命名空间归类（issue #480）：模块目标；末段声明于
/// 父模块的类型命名空间项；或值/未知——父段不是已知模块（enum 变体
/// 等项内路径）或目标在外部 crate 时不可分类，保守归入不遮蔽。
enum FullPathKind {
    Module,
    TypeItem,
    ValueOrUnknown,
}

fn full_path_kind(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    full: &[String],
) -> FullPathKind {
    if tree.file_of.contains_key(full) {
        return FullPathKind::Module;
    }
    let Some((name, module)) = full.split_last() else {
        return FullPathKind::ValueOrUnknown;
    };
    if type_items::declares_type_item(tree, scans, module, name) {
        FullPathKind::TypeItem
    } else {
        FullPathKind::ValueOrUnknown
    }
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
    absolute_item_paths(tree, scans, scan, segs, at, depth)
        .into_iter()
        .filter(|p| tree.file_of.contains_key(p))
        .collect()
}

/// 路径段 → 完整绑定目标路径，不做模块资格过滤（issue #480）：末段
/// 允许停在类型/值项上，供类型命名空间占位判定与递归链展开使用；
/// 模块过滤由 absolute_module_paths 统一施加，保持既有调用方只取模块
/// 的口径。
fn absolute_item_paths(
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
        return qualified_paths(tree, scans, segs, at, depth);
    }
    let mut ctx = at.path.to_vec();
    ctx.extend(at.inline.iter().cloned());
    let direct_child = tree.children.get(&ctx).is_some_and(|c| c.contains(first));
    let expanded = if depth > 0 && !direct_child {
        introduced_positions(tree, scans, scan, first, at, depth)
    } else {
        Vec::new()
    };
    if direct_child {
        namespace_paths(tree, scans, ctx, segs, depth)
    } else if expanded.is_empty() {
        ctx.extend(segs.iter().cloned());
        vec![ctx]
    } else {
        expanded
            .into_iter()
            .flat_map(|target| namespace_paths(tree, scans, target, &segs[1..], depth - 1))
            .collect()
    }
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

/// 位置前缀指定起始命名空间，后续所有段共享逐段遍历；不能在
/// 遇到第一个字面模块后把余下别名一次性拼接（评审 4157263363）。
fn qualified_paths(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    segs: &[String],
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let (ctx, skip) = qualified_context(segs, at);
    namespace_paths(tree, scans, ctx, &segs[skip..], depth)
}

/// 从已知模块逐段消费尾部：字面子模块仅缩短剩余路径，别名/glob
/// 展开消耗递归预算后继续；未知符号尾部保留完整字面后缀，最终绑定
/// 仍须精确命中模块，不能截断 item 路径来虚构可追加的模块前缀。
fn namespace_paths(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    mut ctx: Vec<String>,
    rest: &[String],
    depth: usize,
) -> Vec<Vec<String>> {
    let Some(first) = rest.first() else {
        return vec![ctx];
    };
    if tree.children.get(&ctx).is_some_and(|c| c.contains(first)) {
        ctx.push(first.clone());
        return namespace_paths(tree, scans, ctx, &rest[1..], depth);
    }
    let positions = if depth > 0 {
        namespace_positions(tree, scans, &ctx, first, depth)
    } else {
        Vec::new()
    };
    if positions.is_empty() {
        ctx.extend(rest.iter().cloned());
        return vec![ctx];
    }
    positions
        .into_iter()
        .flat_map(|target| namespace_paths(tree, scans, target, &rest[1..], depth - 1))
        .collect()
}

/// 指定模块的全部平台文件所有者贡献模块级绑定；inline 模块通过
/// 规范文件路径定位声明栈，每次尾段进入的新模块都重新选择该命名空间。
fn namespace_positions(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    ctx: &[String],
    name: &str,
    depth: usize,
) -> Vec<Vec<String>> {
    let mut positions = Vec::new();
    for (path, key) in &tree.canonical {
        if !ctx.starts_with(path)
            || !tree
                .file_of
                .get(ctx)
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
        positions.extend(introduced_positions(
            tree,
            scans,
            &scans[key],
            name,
            lookup,
            depth,
        ));
    }
    positions
}

/// 可见引入的模块目标：别名优先、glob 兜底；递归查找始终回到绑定
/// 自身声明位置，保持深度上限、同名平台并集与符号尾段精确资格。
/// issue #480：显式绑定的目标全部为类型命名空间项时，该名字的类型
/// 命名空间已被显式导入占据，glob 兜底让位，不再补入通往同名 glob
/// 子模块的虚假边；值/未知目标照旧放行 glob。
fn introduced_positions(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    scan: &FileScan,
    name: &str,
    at: Lookup<'_>,
    depth: usize,
) -> Vec<Vec<String>> {
    let bindings = aliases_visible_at(scan, at, name);
    let targets = resolve_alias_bindings(tree, scans, scan, &bindings, at.path, depth - 1);
    if targets.type_occupying && targets.positions.is_empty() {
        return targets.positions;
    }
    let mut positions = targets.positions;
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
