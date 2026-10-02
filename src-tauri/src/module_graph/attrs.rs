//! module_graph 守卫的属性解析层（issue #399；仅测试构建参与编译）：
//! 自 `#` token 起解析属性（`#[…]`/`#![…]`），产出 cfg(test) 门控、
//! 内属性与 `#[path]` 标志（评审 5352172371）及括号组工具。自
//! module_graph.rs 原样迁出（issue #480 变更需在主文件留出版面），
//! 语义与既有口径一致：cfg(…) 组**蕴含** test 才门控，`any(test, …)`
//! 按并集保守计入。

/// 解析自 tokens[i] == "#" 起的属性（`#!` 为内属性，另行返回标志），返回
/// 消费后下标、是否 cfg(test) 门控与是否内属性。门控语义：cfg(…) 组
/// 是否 cfg(test) 门控：深度 1 的 cfg(…) 组**蕴含** test 才门控（裸
/// `test` 或 `all(test, …)`；`any(test, feature)` 不蕴含，按并集保守计入。
/// 评审 5347759049：此前只认深度 1 裸 test，`all(test, unix)` 被漏判）；
/// 其余 cfg 仅在 test=false 下无法证明恒真时按条件存在登记；cfg_attr
/// 同样只登记可能改变生产存在性的施加属性（评审 5393324118）。
/// doc(cfg(…)) 等元数据参数不改变存在条件（评审 5392529793）。
/// 组内字符串已在清洗层抹除，不产生假 token。
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
            "cfg" | "cfg_attr" if depth == 1 && tokens.get(j + 1) == Some(&"(") => {
                classify_cfg_group(tokens, j, &mut info);
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
/// is_conditional = 生产存在性仍受配置影响（feature/平台门控，评审
/// 5391647570）；生产恒真如 not(test) 不设置该位（评审 5393324118）。
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

/// 在生产图的 test=false 前提下求值：未知 feature/平台返回 None，
/// all/any/not 仅组合确定值，不猜测未知谓词间的相关性。本结果只用于
/// 无条件类型占位，既有 cfg_implies_test 的排除边界保持不变。
fn production_cfg_value(tokens: &[&str]) -> Option<bool> {
    if tokens == ["test"] {
        return Some(false);
    }
    let operator = *tokens.first()?;
    if !matches!(operator, "all" | "any" | "not") || tokens.get(1) != Some(&"(") {
        return None;
    }
    let close = find_group_close(tokens, 2)?;
    if close + 1 != tokens.len() {
        return None;
    }
    let parts = split_top_level_commas(&tokens[2..close]);
    if operator == "not" {
        return match parts.as_slice() {
            [part] => production_cfg_value(part).map(|value| !value),
            _ => None,
        };
    }
    let values: Vec<_> = parts
        .iter()
        .map(|part| production_cfg_value(part))
        .collect();
    let decisive = operator == "any";
    if values.contains(&Some(decisive)) {
        Some(decisive)
    } else if values.iter().all(|value| *value == Some(!decisive)) {
        Some(!decisive)
    } else {
        None
    }
}

/// 深度 1 的 cfg / cfg_attr 门控归类：沿用 test 专属排除；生产恒真
/// 不影响类型占位，其他可能缺席的项按条件保守入图（评审 5393324118）。
/// 嵌套 cfg(test) 不升级为 test 排除，保留既有 cfg_attr 并集边界。
fn classify_cfg_group(tokens: &[&str], j: usize, info: &mut AttrInfo) {
    let Some(close) = find_group_close(tokens, j + 2) else {
        return;
    };
    let group = &tokens[j + 2..close];
    if tokens[j] == "cfg_attr" {
        info.is_conditional |= attr_part_gates_cfg(&tokens[j..=close]);
        return;
    }
    if cfg_implies_test(group) {
        info.is_test = true;
    } else if production_cfg_value(group) != Some(true) {
        info.is_conditional = true;
    }
}

/// 属性是否可能改变生产存在性：生产恒真的 cfg、生产恒假谓词下的
/// cfg_attr 与 doc(cfg(…)) 元数据均无影响；其他施加属性递归判断。
fn attr_part_gates_cfg(part: &[&str]) -> bool {
    if part.first() == Some(&"cfg") && part.get(1) == Some(&"(") {
        return find_group_close(part, 2)
            .is_none_or(|close| production_cfg_value(&part[2..close]) != Some(true));
    }
    if part.first() == Some(&"cfg_attr") && part.get(1) == Some(&"(") {
        if let Some(close) = find_group_close(part, 2) {
            let parts = split_top_level_commas(&part[2..close]);
            if parts
                .first()
                .is_some_and(|p| production_cfg_value(p) == Some(false))
            {
                return false;
            }
            return parts.iter().skip(1).copied().any(attr_part_gates_cfg);
        }
    }
    false
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
