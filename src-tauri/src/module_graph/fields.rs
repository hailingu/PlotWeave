//! 声明的泛型参数、struct / enum / union 元素与 fn 参数门控上下文（issue #424）。
//!
//! 只给直接元素的属性入口登记类型状态与列表闭合边界；类型内常量块的
//! 属性仍由普通表达式扫描处理。这里识别声明头和字段/参数列表，不解析通用
//! Rust AST；未闭合列表不登记上下文，已有模块/use 扫描继续负责其契约。
//! 值位置限定路径复用同一类型组平衡器，只接受组后紧接 :: 的候选。

use std::collections::BTreeMap;

use super::{item_keyword, parse_attr, skip_delimited, strip_raw_ident};

/// Rust 2021 的 strict / reserved keywords：普通声明名不得占用这些词。
/// gen 自 2024 edition 才保留，本仓 2021 grammar 允许该名字；union 等弱关键字
/// 也可作名字。来源：https://doc.rust-lang.org/reference/keywords.html。
const RESERVED_DECLARATION_NAMES: &[&str] = &[
    "_", "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
    "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
    "type", "unsafe", "use", "where", "while", "abstract", "become", "box", "do", "final", "macro",
    "override", "priv", "try", "typeof", "unsized", "virtual", "yield",
];

/// 直接元素的语法决定类型入口、变体判别式与泛型默认类型的处理。
#[derive(Clone, Copy)]
enum ElementKind {
    Type,
    Variant,
    Generic,
}

/// 带属性直接元素的扫描边界：类型元素从类型态开始，变体仅限定终点。
#[derive(Clone, Copy)]
pub(super) struct FieldContext {
    /// 所属字段/变体/函数或泛型参数列表的闭合 token；留给主循环消费。
    pub(super) close: usize,
    /// 字段和参数是类型入口，变体判别式保留表达式比较语义。
    pub(super) type_header: bool,
    /// 仅泛型类型参数的等号 RHS 是类型；const 参数仍进入值表达式。
    pub(super) type_default: bool,
}

/// union 仅在 `union NAME` 后接泛型、where 或字段体时作为声明关键字。
/// NAME 遵循本仓 Rust 2021 的 ASCII / raw identifier 口径，避免将弱关键字
/// 比较、as 转型或 in 迭代误判为类型头；来源：Rust Reference §Identifiers。
pub(super) fn is_union_declaration(tokens: &[&str], at: usize) -> bool {
    tokens.get(at) == Some(&"union")
        && tokens
            .get(at + 1)
            .is_some_and(|name| declaration_name(name))
        && matches!(tokens.get(at + 2).copied(), Some("<" | "{" | "where"))
}

/// 声明名采用已有 ASCII 分词边界；raw 名允许保留词，但排除语言禁止的五个名。
/// 2021 identifier grammar：https://doc.rust-lang.org/reference/identifiers.html。
fn declaration_name(token: &str) -> bool {
    let name = strip_raw_ident(token);
    let mut chars = name.chars();
    let identifier = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !identifier {
        return false;
    }
    if token.starts_with("r#") {
        return !matches!(name, "_" | "crate" | "self" | "Self" | "super");
    }
    !RESERVED_DECLARATION_NAMES.contains(&name)
}

/// 按主扫描器的属性项首下标，登记泛型/记录/fn 参数的类型态与列表边界。
/// 可见性 pub 后的 `(` 是实际扫描入口；嵌套类型/常量组不登记为外层字段。
pub(super) fn field_contexts(tokens: &[&str]) -> BTreeMap<usize, FieldContext> {
    let mut contexts = BTreeMap::new();
    for (i, token) in tokens.iter().enumerate() {
        if let Some((open, close)) = generic_parameters(tokens, i) {
            collect_elements(tokens, open, close, ElementKind::Generic, &mut contexts);
        }
        if *token == "fn" {
            if let Some((open, close)) = function_parameters(tokens, i) {
                collect_elements(tokens, open, close, ElementKind::Type, &mut contexts);
            }
            continue;
        }
        let (kind, allow_tuple) = match *token {
            "struct" => (ElementKind::Type, true),
            "enum" => (ElementKind::Variant, false),
            "union" if is_union_declaration(tokens, i) => (ElementKind::Type, false),
            _ => continue,
        };
        if let Some((open, close)) = declaration_fields(tokens, i + 2, allow_tuple) {
            collect_elements(tokens, open, close, kind, &mut contexts);
        }
    }
    contexts
}

/// 只登记声明直接泛型列表；impl 没有名字，其余声明验证名字后检查 <。
/// 返回类型、where/HRTB 与类型实参不属于该列表；未闭合列表不登记。
fn generic_parameters(tokens: &[&str], at: usize) -> Option<(usize, usize)> {
    let open = match tokens.get(at).copied()? {
        "impl" => at + 1,
        "fn" | "struct" | "enum" | "trait" | "type" => {
            if !tokens
                .get(at + 1)
                .is_some_and(|name| declaration_name(name))
            {
                return None;
            }
            at + 2
        }
        "union" if is_union_declaration(tokens, at) => at + 2,
        _ => return None,
    };
    if tokens.get(open) != Some(&"<") {
        return None;
    }
    Some((open, skip_type_arguments(tokens, open, tokens.len())? - 1))
}

/// 函数指针直接以 fn( 开启参数；普通函数名及泛型头沿已有声明解析定位。
/// 仅接受圆括号候选，不能把返回类型或正文当成参数列表。
fn function_parameters(tokens: &[&str], at: usize) -> Option<(usize, usize)> {
    let next = at + 1;
    if tokens.get(next) == Some(&"(") {
        return group_close(tokens, next, "(", ")").map(|close| (next, close));
    }
    if !tokens.get(next).is_some_and(|name| declaration_name(name)) {
        return None;
    }
    declaration_fields(tokens, at + 2, true).filter(|(open, _)| tokens.get(*open) == Some(&"("))
}

/// 跨过泛型与 where 约束，定位声明自己的字段列表；Fn() 不充当 tuple 头。
fn declaration_fields(tokens: &[&str], mut i: usize, allow_tuple: bool) -> Option<(usize, usize)> {
    let mut where_clause = false;
    while i < tokens.len() {
        match tokens[i] {
            ";" => return None,
            "where" => where_clause = true,
            "<" => {
                i = skip_type_arguments(tokens, i, tokens.len())?;
                continue;
            }
            "(" if allow_tuple && !where_clause => {
                return group_close(tokens, i, "(", ")").map(|close| (i, close));
            }
            "{" => return group_close(tokens, i, "{", "}").map(|close| (i, close)),
            "(" | "[" => {
                i = skip_group(tokens, i);
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 闭合组的 token 下标；缺失闭合 token 时不把后续源码归入该字段列表。
fn group_close(tokens: &[&str], open: usize, left: &str, right: &str) -> Option<usize> {
    let close = skip_delimited(tokens, open, left, right).saturating_sub(1);
    (tokens.get(close) == Some(&right)).then_some(close)
}

/// 三种嵌套组整体前进，组内逗号、比较符与属性不影响直接元素边界。
fn skip_group(tokens: &[&str], open: usize) -> usize {
    match tokens[open] {
        "(" => skip_delimited(tokens, open, "(", ")"),
        "[" => skip_delimited(tokens, open, "[", "]"),
        "{" => skip_delimited(tokens, open, "{", "}"),
        _ => open + 1,
    }
}

/// 类型参数中的组整体跨过；箭头的 > 不闭合泛型，缺少列表终点返回 None。
fn skip_type_arguments(tokens: &[&str], open: usize, end: usize) -> Option<usize> {
    let mut angles = 1usize;
    let mut i = open + 1;
    while i < end {
        match tokens[i] {
            "(" | "[" | "{" => {
                i = skip_group(tokens, i);
                continue;
            }
            "<" => angles += 1,
            ">" if tokens.get(i.wrapping_sub(1)) != Some(&"-") => {
                angles -= 1;
                if angles == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 值位置的 <…>:: 限定路径：复用类型组平衡，未配对或缺少 :: 返回 None。
/// 调用方提供 < 的下标；组内逗号/常量及箭头不影响路径类型边界。
/// 语法契约：https://doc.rust-lang.org/reference/paths.html#qualified-paths。
pub(super) fn qualified_path_end(tokens: &[&str], open: usize) -> Option<usize> {
    skip_type_arguments(tokens, open, tokens.len()).filter(|&end| tokens.get(end) == Some(&"::"))
}

/// 每次只检查列表的直接元素前缀；跳过整条类型或判别式后才检查下一个。
fn collect_elements(
    tokens: &[&str],
    open: usize,
    close: usize,
    kind: ElementKind,
    contexts: &mut BTreeMap<usize, FieldContext>,
) {
    let variant_list = matches!(kind, ElementKind::Variant);
    let mut i = open + 1;
    while i < close {
        let mut attributed = false;
        while tokens.get(i) == Some(&"#") {
            attributed = true;
            i = parse_attr(tokens, i).next;
        }
        let item = (i..close).find(|&k| item_keyword(tokens[k]));
        if let Some(item) = item.filter(|_| attributed) {
            contexts.insert(
                item,
                FieldContext {
                    close,
                    type_header: !variant_list,
                    type_default: matches!(kind, ElementKind::Generic)
                        && !matches!(tokens[item], "const" | "'"),
                },
            );
        }
        if variant_list {
            collect_variant_fields(tokens, i, close, contexts);
        }
        i = element_end(tokens, i, close, variant_list);
    }
}

/// enum 直接变体名后的圆/花括号才是字段列表，判别式中的组不作为字段。
fn collect_variant_fields(
    tokens: &[&str],
    name: usize,
    end: usize,
    contexts: &mut BTreeMap<usize, FieldContext>,
) {
    let open = name + 1;
    let delimiter = match tokens.get(open) {
        Some(&"(") => ("(", ")"),
        Some(&"{") => ("{", "}"),
        _ => return,
    };
    if let Some(close) = group_close(tokens, open, delimiter.0, delimiter.1).filter(|c| *c <= end) {
        collect_elements(tokens, open, close, ElementKind::Type, contexts);
    }
}

/// 返回下一个直接元素的起点；字段泛型与变体 turbofish 跨过内部逗号。
fn element_end(tokens: &[&str], mut i: usize, close: usize, variant_list: bool) -> usize {
    while i < close {
        match tokens[i] {
            "," => return i + 1,
            "(" | "[" | "{" => {
                i = skip_group(tokens, i);
                continue;
            }
            "<" if !variant_list || tokens.get(i.wrapping_sub(1)) == Some(&"::") => {
                i = skip_type_arguments(tokens, i, close).unwrap_or(close);
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    i
}
