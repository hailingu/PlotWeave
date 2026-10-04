//! issue #494 的独立有限采集见证：只从扫描产物与模块树推导必需的文件
//! 所有者，不调用建边解析器。字面路径及直接指向模块的 alias/glob 可以
//! 建立见证；复杂引入链不在本层展开。存在最深显式绑定时不为同名 glob
//! 建立见证，避免重新实现类型命名空间遮蔽。原始字面路径的非字面后缀
//! 停在最深模块；alias/glob 后缀遇到可能再次引入的名字则不建立见证，
//! 不宣称证明后续引入的完整性。

use std::collections::{BTreeMap, BTreeSet};

use super::aliases::AliasBinding;
use super::tree::ModuleTree;
use super::{FileScan, ModuleKey, UseStmt};

/// 独立推导当前 use 的必需所有者子集；保留同文件所有者供采集审计，
/// 自环剔除仍由建边层负责。未建立见证不表示该路径一定属于外部 crate。
pub(super) fn expected_owners(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    path: &[String],
    key: &ModuleKey,
    u: &UseStmt,
    segs: &[String],
) -> BTreeSet<ModuleKey> {
    let scan = &scans[key];
    let mut site = path.to_vec();
    site.extend(u.inline_stack.iter().cloned());
    if let Some((start, skip)) = literal_start(tree, &site, segs) {
        let (position, _) = walk_modules(tree, start, &segs[skip..]);
        return owners_at(tree, &position);
    }
    let Some(first) = segs.first() else {
        return BTreeSet::new();
    };
    let bindings = visible_aliases(scan, u, first);
    if !bindings.is_empty() {
        return alias_owners(tree, scans, &site, &bindings, &segs[1..]);
    }
    let mut owners = BTreeSet::new();
    for glob in &scan.globs {
        if glob.inline_stack != u.inline_stack || !u.scope.starts_with(&glob.scope) {
            continue;
        }
        let Some(prefix) = literal_module(tree, &site, &glob.segs) else {
            continue;
        };
        if has_child(tree, &prefix, first) && glob_child_visible(tree, &prefix, first, &site) {
            owners.extend(introduced_owners(tree, scans, prefix, segs));
        }
    }
    owners
}

/// 只采用同声明模块、词法包含使用点且位于最深作用域的全部显式绑定；
/// 声明次序与平台门控不缩小候选并集，inline 子模块不继承父模块绑定。
fn visible_aliases<'a>(scan: &'a FileScan, u: &UseStmt, name: &str) -> Vec<&'a AliasBinding> {
    let mut bindings: Vec<_> = scan
        .renames
        .iter()
        .filter(|binding| {
            binding.name == name
                && binding.inline_stack == u.inline_stack
                && u.scope.starts_with(&binding.scope)
        })
        .collect();
    if let Some(depth) = bindings.iter().map(|binding| binding.scope.len()).max() {
        bindings.retain(|binding| binding.scope.len() == depth);
    }
    bindings
}

/// 只有完整字面绑定目标属于模块时才追加后缀；类型/值项与复杂别名链
/// 不截断为祖先模块，避免为不成立的模块 alias 虚构必需所有者。
fn alias_owners(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    site: &[String],
    bindings: &[&AliasBinding],
    suffix: &[String],
) -> BTreeSet<ModuleKey> {
    let mut owners = BTreeSet::new();
    for binding in bindings {
        let Some(target) = literal_module(tree, site, &binding.segs) else {
            continue;
        };
        owners.extend(introduced_owners(tree, scans, target, suffix));
    }
    owners
}

/// 引入目标后的字面后缀只在终止名字不可能再次由模块级引入解析时
/// 建立见证；否则实际展开可跳往另一文件，祖先所有者不再是必需结果。
fn introduced_owners(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    start: Vec<String>,
    rest: &[String],
) -> BTreeSet<ModuleKey> {
    let (position, consumed) = walk_modules(tree, start, rest);
    if let Some(name) = rest.get(consumed) {
        if namespace_has_introductions(tree, scans, &position, name) {
            return BTreeSet::new();
        }
    }
    owners_at(tree, &position)
}

/// 根据全部平台所有者及 inline 声明栈排除可能再次展开的名字；只观察
/// 原始模块级 alias/glob 元数据，不解析其目标，不让块局部绑定造成歧义。
fn namespace_has_introductions(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    position: &[String],
    name: &str,
) -> bool {
    for (path, key) in &tree.canonical {
        if !position.starts_with(path)
            || !tree
                .file_of
                .get(position)
                .is_some_and(|owners| owners.contains(key))
        {
            continue;
        }
        let inline = &position[path.len()..];
        let scan = &scans[key];
        if scan.renames.iter().any(|binding| {
            binding.module_level && binding.inline_stack == inline && binding.name == name
        }) || scan
            .globs
            .iter()
            .any(|glob| glob.module_level && glob.inline_stack == inline)
        {
            return true;
        }
    }
    false
}

/// 依据显式位置前缀或当前模块直接子模块确定字面走查起点；裸路径不
/// 回退到 crate 根。越根的 super 不建立见证，由实际采集器继续拒绝。
fn literal_start(
    tree: &ModuleTree,
    site: &[String],
    segs: &[String],
) -> Option<(Vec<String>, usize)> {
    let first = segs.first()?.as_str();
    match first {
        "crate" => Some((Vec::new(), 1)),
        "self" => Some((site.to_vec(), 1)),
        "super" => {
            let skip = segs
                .iter()
                .take_while(|segment| *segment == "super")
                .count();
            let parent_len = site.len().checked_sub(skip)?;
            Some((site[..parent_len].to_vec(), skip))
        }
        _ if has_child(tree, site, first) => Some((site.to_vec(), 0)),
        _ => None,
    }
}

/// 精确字面模块资格：每一段均须匹配声明模块，不能把 item 后缀截断后
/// 当成 alias/glob 的模块目标，也不递归解析引入链。
fn literal_module(tree: &ModuleTree, site: &[String], segs: &[String]) -> Option<Vec<String>> {
    let (start, skip) = literal_start(tree, site, segs)?;
    let rest = &segs[skip..];
    let (position, consumed) = walk_modules(tree, start, rest);
    (consumed == rest.len() && tree.file_of.contains_key(&position)).then_some(position)
}

/// 消费连续字面子模块并返回最深模块及已消费段数；遇到 item 或引入名
/// 即停止，保持有限见证与完整绑定资格判定的边界。
fn walk_modules(
    tree: &ModuleTree,
    mut position: Vec<String>,
    rest: &[String],
) -> (Vec<String>, usize) {
    let mut consumed = 0;
    for segment in rest {
        if !has_child(tree, &position, segment) {
            break;
        }
        position.push(segment.clone());
        consumed += 1;
    }
    (position, consumed)
}

/// 字面子模块只取树登记的直接声明，不把 alias 或 glob 当作声明模块。
fn has_child(tree: &ModuleTree, position: &[String], name: &str) -> bool {
    tree.children
        .get(position)
        .is_some_and(|children| children.contains(name))
}

/// 按树内可见子树元数据独立筛选 glob 子模块；私有/受限声明只在对应
/// 子树内建立见证，任一公开平台变体的合并元数据允许 crate 内访问。
fn glob_child_visible(tree: &ModuleTree, prefix: &[String], name: &str, site: &[String]) -> bool {
    match tree.child_vis.get(&(prefix.to_vec(), name.to_string())) {
        None | Some(None) => true,
        Some(Some(root)) => site.starts_with(root),
    }
}

/// 返回逻辑模块的全部文件所有者，包括平台变体与同文件 inline 所有者。
fn owners_at(tree: &ModuleTree, position: &[String]) -> BTreeSet<ModuleKey> {
    tree.file_of.get(position).cloned().unwrap_or_default()
}
