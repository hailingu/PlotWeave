//! module_graph 守卫的 use 树解析层（issue #399；仅测试构建参与编译）：
//! use 语句 token → 完整路径段集合。花括号分组递归展开（含根级分组与前导
//! `::` 两种合法入口）、`as` 重命名剥除并另行登记（供裸路径别名解析）、
//! `*` 通配按前缀计并另行登记 glob 前缀（issue #469：供后续裸路径按 glob
//! 引入的模块名解析）、组内 `self` 指前缀模块自身。

/// use 树解析产物：paths = 展开后的完整路径集；renames = `as` 绑定
///（本地名 → 被重命名路径的段，评审 5351437161：后续裸路径经别名引用
/// 子模块时按此展开）；globs = `*` 通配的前缀段（issue #469：前缀模块的
/// 直接子模块名经 glob 进入作用域，供裸路径首段解析）。
pub(super) struct UseTree {
    pub(super) paths: Vec<Vec<String>>,
    pub(super) renames: Vec<(String, Vec<String>)>,
    pub(super) globs: Vec<Vec<String>>,
}

/// use 语句 token → 解析产物。前导 `::` 是合法的绝对路径入口（评审
/// 5351437161：`use ::std::io;` 不得 fail-closed panic），跳过后按普通
/// 树解析——外部 crate 自然返回空解析目标。
pub(super) fn use_tree_of(tokens: &[String]) -> UseTree {
    let mut tree = UseTree {
        paths: Vec::new(),
        renames: Vec::new(),
        globs: Vec::new(),
    };
    let mut i = 0;
    if tokens.first().map(String::as_str) == Some("{") {
        i = 1;
        parse_use_group(&[], tokens, &mut i, &mut tree);
        return tree;
    }
    if tokens.first().map(String::as_str) == Some("::") {
        i = 1;
    }
    parse_use_tree(&[], tokens, &mut i, &mut tree);
    tree
}

/// use 树元素是否为路径段（标识符/关键字；`as` 与标点不是）。
fn is_path_seg(tok: &str) -> bool {
    let mut chars = strip_raw_ident(tok).chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// 剥掉裸标识符的 `r#` 前缀：`mod r#type;` 的文件是 `type.rs`，use 路径
/// 段与声明统一按裸名参与模块树匹配（评审 5349970852：拒绝 `#` 会让
/// `use crate::r#type::Thing` 对合法 Rust fail-closed panic）。
pub(super) fn strip_raw_ident(tok: &str) -> &str {
    tok.strip_prefix("r#").unwrap_or(tok)
}

/// 叶子路径终点：登记无 as 的裸绑定（叶子名剥 r# 前缀，评审
/// 5353260028）并收进路径集。通配与组内元素同样经此。
fn push_path(tree: &mut UseTree, tokens: &[String], i: &mut usize, path: Vec<String>) {
    if tokens.get(*i).map(String::as_str) != Some("as") {
        if let Some(name) = path.last() {
            tree.renames
                .push((strip_raw_ident(name).to_string(), path.clone()));
        }
    }
    tree.paths.push(path);
}

/// 叶子段后的 as 重命名：登记（本地名 → 当前路径）并跳过 as 与新名。
fn consume_as(tree: &mut UseTree, tokens: &[String], i: &mut usize, path: &[String]) {
    if tokens.get(*i).map(String::as_str) != Some("as") {
        return;
    }
    if let Some(name) = tokens.get(*i + 1) {
        // 名字剥 r# 前缀（评审 5353260028：as r#type 须按裸名归一化，
        // 否则与已归一化的路径段永不匹配）
        tree.renames
            .push((strip_raw_ident(name).to_string(), path.to_vec()));
    }
    *i += 2;
}

/// 解析一个 use 树元素追加到 paths：组内 `self` 指前缀模块、`as` 剥除、`*` 按前缀计。
fn parse_use_tree(prefix: &[String], tokens: &[String], i: &mut usize, tree: &mut UseTree) {
    let mut path = prefix.to_vec();
    loop {
        match tokens.get(*i) {
            Some(t) if is_path_seg(t) => {
                let bare_self = t == "self"
                    && path.len() == prefix.len()
                    && tokens.get(*i + 1).map(String::as_str) != Some("::");
                if !bare_self {
                    path.push(strip_raw_ident(t).to_string());
                }
                *i += 1;
            }
            _ => panic!(
                "use 路径形态异常（期望段，得 {:?}）：{tokens:?}",
                tokens.get(*i)
            ),
        }
        consume_as(tree, tokens, i, &path);
        match tokens.get(*i).map(String::as_str) {
            Some("::") => {
                *i += 1;
                match tokens.get(*i).map(String::as_str) {
                    Some("{") => {
                        *i += 1;
                        parse_use_group(&path, tokens, i, tree);
                        return;
                    }
                    Some("*") => {
                        *i += 1;
                        tree.paths.push(path.clone());
                        tree.globs.push(path);
                        return;
                    }
                    Some(_) => {}
                    None => panic!("use 路径意外截断：{tokens:?}"),
                }
            }
            _ => {
                push_path(tree, tokens, i, path);
                return;
            }
        }
    }
}

/// 解析花括号分组内的元素序列（逗号分隔，允许尾逗号）。
fn parse_use_group(prefix: &[String], tokens: &[String], i: &mut usize, tree: &mut UseTree) {
    loop {
        // 空组（评审 5353024715）：`use crate::a::{};` / `use {};` 的首
        // token 即闭合括号，直接消费返回，不要求路径段
        if tokens.get(*i).map(String::as_str) == Some("}") {
            *i += 1;
            return;
        }
        parse_use_tree(prefix, tokens, i, tree);
        match tokens.get(*i).map(String::as_str) {
            Some(",") => {
                *i += 1;
                if tokens.get(*i).map(String::as_str) == Some("}") {
                    *i += 1;
                    return;
                }
            }
            Some("}") => {
                *i += 1;
                return;
            }
            _ => panic!("use 花括号分组残缺：{tokens:?}"),
        }
    }
}
