//! module_graph 守卫的 mod 声明可见性层（issue #469 评审 5380401098；
//! 仅测试构建参与编译）：glob 引入只带走**对使用处可见**的项——私有或
//! 受限（`pub(super)`/`pub(in …)`）子模块的名字不会经 glob 进入作用域，
//! 同名裸路径在真实 Rust 中解析到外部 crate。本层解析声明处可见性修饰
//! 并换算成「可见子树根」，供树构建登记、glob 候选过滤。

use super::use_tree::{is_path_seg, strip_raw_ident};

/// mod 声明的可见性（自 mod 关键字向前回看修饰符解析）。
pub(super) enum ModVis {
    /// `pub` / `pub(crate)`：crate 内任意可见（守卫单 crate 扫描口径，
    /// 两者等价）。
    Public,
    /// `pub(super)`：声明模块的父模块子树（根由声明位置在树构建期解析）。
    ParentOfDeclaring,
    /// `pub(in <路径>)`：限定子树——`crate`/前导 `::` 绝对定位，`self`
    /// 相对声明模块，前导 `super` 计入 up 沿声明模块上溯（评审
    /// 5380788578；segs 为去定界后的路径段）。
    InPath {
        segs: Vec<String>,
        from_crate_root: bool,
        up: usize,
    },
    /// 无可见性修饰：仅声明模块及其后代可见。
    Private,
}

/// 自 mod 关键字（tokens[mod_at] == "mod"）向前解析可见性修饰：`pub`、
/// `pub(crate)`、`pub(super)`、`pub(in …)`；无可解析修饰按私有处置
///（畸形修饰只出现在非法 Rust 中，私有方向对 glob 过滤保守）。
pub(super) fn parse_mod_vis(tokens: &[&str], mod_at: usize) -> ModVis {
    let Some(prev) = mod_at.checked_sub(1).and_then(|k| tokens.get(k)) else {
        return ModVis::Private;
    };
    if *prev == "pub" {
        return ModVis::Public;
    }
    if *prev != ")" {
        return ModVis::Private;
    }
    let Some(open) = matching_paren_back(tokens, mod_at - 1) else {
        return ModVis::Private;
    };
    if tokens.get(open.wrapping_sub(1)).copied() != Some("pub") {
        return ModVis::Private;
    }
    match &tokens[open + 1..mod_at - 1] {
        ["crate"] => ModVis::Public,
        ["super"] => ModVis::ParentOfDeclaring,
        group => in_path_of(group).unwrap_or(ModVis::Private),
    }
}

/// 自 close（tokens[close] == ")"）向前找配对 "(" 的下标；未闭合返回 None。
fn matching_paren_back(tokens: &[&str], close: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut k = close;
    while k < tokens.len() {
        match tokens[k] {
            ")" => depth += 1,
            "(" => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(k);
                }
            }
            _ => {}
        }
        k = k.checked_sub(1)?;
    }
    None
}

/// `in <路径>` 组 → InPath：`crate` 或前导 `::` 绝对定位、`self` 相对声明
/// 模块；其余段须为路径段（花括号等属非法修饰，按私有兜底）。
fn in_path_of(group: &[&str]) -> Option<ModVis> {
    if group.first().copied() != Some("in") {
        return None;
    }
    let mut rest = &group[1..];
    let mut from_crate_root = false;
    match rest.first().copied() {
        Some("crate" | "::") => {
            from_crate_root = true;
            rest = &rest[1..];
        }
        Some("self") => rest = &rest[1..],
        _ => {}
    }
    let mut segs = Vec::new();
    let mut up = 0usize;
    for tok in rest {
        match *tok {
            "::" => {}
            "super" if !from_crate_root && segs.is_empty() => up += 1,
            t if is_path_seg(t) => segs.push(strip_raw_ident(t).to_string()),
            _ => return None,
        }
    }
    Some(ModVis::InPath {
        segs,
        from_crate_root,
        up,
    })
}

/// 可见性 → 可见子树根（declaring = 声明模块路径）：None = crate 内任意
/// 可见（无需登记）；Private → 声明模块子树；ParentOfDeclaring → 父子树
///（声明处即 crate 根的 `pub(super)` 是非法 Rust，fail-closed）；InPath
/// 按绝对/相对定位。
pub(super) fn subtree_root(vis: &ModVis, declaring: &[String]) -> Option<Vec<String>> {
    match vis {
        ModVis::Public => None,
        ModVis::Private => Some(declaring.to_vec()),
        ModVis::ParentOfDeclaring => {
            let mut root = declaring.to_vec();
            if root.pop().is_none() {
                panic!(
                    "pub(super) 位于 crate 根（非法 Rust）：{}",
                    declaring.join("::")
                );
            }
            Some(root)
        }
        ModVis::InPath {
            segs,
            from_crate_root,
            up,
        } => {
            if *from_crate_root {
                return Some(segs.clone());
            }
            let Some(keep) = declaring.len().checked_sub(*up) else {
                panic!(
                    "pub(in super…) 越过 crate 根（非法 Rust）：{}",
                    declaring.join("::")
                );
            };
            let mut root = declaring[..keep].to_vec();
            root.extend(segs.iter().cloned());
            Some(root)
        }
    }
}
