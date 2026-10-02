//! module_graph 守卫的属性解析层（issue #399；仅测试构建参与编译）：
//! 自 `#` token 起解析属性（`#[…]`/`#![…]`），产出 cfg(test) 门控、
//! 内属性与 `#[path]` 标志（评审 5352172371）及括号组工具。自
//! module_graph.rs 原样迁出（issue #480 变更需在主文件留出版面），
//! 语义与既有口径一致：cfg(…) 组**蕴含** test 才门控，`any(test, …)`
//! 按并集保守计入。

/// 解析自 tokens[i] == "#" 起的属性（`#!` 为内属性，另行返回标志），返回
/// 消费后下标、是否 cfg(test) 门控与是否内属性。门控语义：cfg(…) 组
/// 是否 cfg(test) 门控：cfg(…) 组**蕴含** test 才门控（裸 `test` 或
/// `all(test, …)`；`any(test, feature)` 不蕴含，按并集保守计入。评审
/// 5347759049：此前只认深度 1 裸 test，`all(test, unix)` 被漏判）。组内
/// 字符串已在清洗层抹除，不产生假 token。
pub(super) fn parse_attr(tokens: &[&str], i: usize) -> AttrInfo {
    let mut j = i + 1;
    let mut info = AttrInfo::default();
    if tokens.get(j) == Some(&"!") {
        info.is_inner = true;
        j += 1;
    }
    if tokens.get(j) != Some(&"[") {
        info.next = j;
        return info;
    }
    j += 1;
    let mut depth = 1usize;
    while j < tokens.len() && depth > 0 {
        match tokens[j] {
            "[" | "(" => depth += 1,
            "]" | ")" => depth -= 1,
            "cfg" if depth == 1 && tokens.get(j + 1) == Some(&"(") => {
                if let Some(close) = find_group_close(tokens, j + 2) {
                    if cfg_implies_test(&tokens[j + 2..close]) {
                        info.is_test = true;
                    } else {
                        // 非 test 蕴含的 cfg（feature/平台门控）：项保留进图
                        //（并集保守），但按条件存在登记（评审 5391647570：
                        // 条件类型绑定不得按无条件遮蔽 glob 模块处置）
                        info.is_conditional = true;
                    }
                }
            }
            // 属性括号内任意深度出现 `path =`（含 cfg_attr 包装）即视为
            // path 属性——清洗层已抹除字面量值，调用方对生产 mod fail-closed
            "path" if tokens.get(j + 1) == Some(&"=") => info.has_path = true,
            _ => {}
        }
        j += 1;
    }
    info.next = j;
    info
}

/// 属性解析结论：next = 消费后下标；is_test = cfg 蕴含 test；is_inner =
/// `#!` 内属性；has_path = 属性内出现 `path =`（评审 5352172371）；
/// is_conditional = 存在不蕴含 test 的 cfg 组（feature/平台门控，评审
/// 5391647570：条件存在的项仍入图，但其引入不参与无条件遮蔽判定）。
#[derive(Default)]
pub(super) struct AttrInfo {
    pub(super) next: usize,
    pub(super) is_test: bool,
    pub(super) is_inner: bool,
    pub(super) has_path: bool,
    pub(super) is_conditional: bool,
}

/// 自开括号下标起找配对闭括号（含嵌套）；未闭合返回 None。
fn find_group_close(tokens: &[&str], open: usize) -> Option<usize> {
    let mut depth = 1usize;
    let mut k = open;
    while k < tokens.len() {
        match tokens[k] {
            "(" => depth += 1,
            ")" => {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

/// cfg(…) 组是否蕴含 test（绝不出现在生产构建）：裸 `test`；`all(…)`
/// 的某个合取项蕴含；`any(…)` 的全部析取项都蕴含。其余谓词不蕴含——
/// 保守计入生产图：宁可误报环也不漏检（漏检更危险）。
fn cfg_implies_test(tokens: &[&str]) -> bool {
    if tokens == ["test"] {
        return true;
    }
    let is_all = tokens.first() == Some(&"all");
    let is_any = tokens.first() == Some(&"any");
    if !(is_all || is_any) || tokens.get(1) != Some(&"(") {
        return false;
    }
    let Some(close) = find_group_close(tokens, 2) else {
        return false;
    };
    let parts = split_top_level_commas(&tokens[2..close]);
    if parts.is_empty() {
        return false;
    }
    let implied: Vec<bool> = parts.iter().map(|p| cfg_implies_test(p)).collect();
    if is_all {
        implied.iter().any(|b| *b)
    } else {
        implied.iter().all(|b| *b)
    }
}

/// 顶层（括号深度 0）逗号切分；尾逗号产生的空段被忽略。
fn split_top_level_commas<'a>(tokens: &'a [&'a str]) -> Vec<&'a [&'a str]> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (k, tok) in tokens.iter().enumerate() {
        match *tok {
            "(" | "[" => depth += 1,
            ")" | "]" => depth = depth.saturating_sub(1),
            "," if depth == 0 => {
                parts.push(&tokens[start..k]);
                start = k + 1;
            }
            _ => {}
        }
    }
    parts.push(&tokens[start..]);
    parts.retain(|p| !p.is_empty());
    parts
}
