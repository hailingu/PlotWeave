//! struct / enum 的直接字段与变体门控上下文（PR #445 评审 5363739640）。
//!
//! 只给直接元素的属性入口登记类型状态与列表闭合边界；类型内常量块的
//! 属性仍由普通表达式扫描处理。这里识别声明头和字段列表，不解析通用
//! Rust AST；未闭合列表不登记上下文，已有模块/use 扫描继续负责其契约。

use std::collections::BTreeMap;

use super::{item_keyword, parse_attr, skip_delimited};

/// 带属性直接元素的扫描边界：字段从类型状态开始，enum 变体仅限定终点。
#[derive(Clone, Copy)]
pub(super) struct FieldContext {
    /// 所属字段/变体列表的闭合 token 下标；留给主扫描循环消费。
    pub(super) close: usize,
    /// 只有字段是类型入口，变体判别式保留表达式比较语义。
    pub(super) type_header: bool,
}

/// 按主扫描器消费挂起属性的项首下标，登记 struct / enum 的直接元素上下文。
/// 可见性 pub 后的 `(` 是实际扫描入口；嵌套类型/常量组不登记为外层字段。
pub(super) fn field_contexts(tokens: &[&str]) -> BTreeMap<usize, FieldContext> {
    let mut contexts = BTreeMap::new();
    for (i, token) in tokens.iter().enumerate() {
        let variant_list = match *token {
            "struct" => false,
            "enum" => true,
            _ => continue,
        };
        if let Some((open, close)) = declaration_fields(tokens, i + 2, variant_list) {
            collect_elements(tokens, open, close, variant_list, &mut contexts);
        }
    }
    contexts
}

/// 跨过泛型与 where 约束，定位声明自己的字段列表；Fn() 不充当 tuple 头。
fn declaration_fields(tokens: &[&str], mut i: usize, variant_list: bool) -> Option<(usize, usize)> {
    let mut where_clause = false;
    while i < tokens.len() {
        match tokens[i] {
            ";" => return None,
            "where" => where_clause = true,
            "<" => {
                i = skip_type_arguments(tokens, i, tokens.len());
                continue;
            }
            "(" if !variant_list && !where_clause => {
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

/// 类型参数中的组整体跨过；函数返回箭头的 > 不闭合泛型。
fn skip_type_arguments(tokens: &[&str], open: usize, end: usize) -> usize {
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
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// 每次只检查列表的直接元素前缀；跳过整条类型或判别式后才检查下一个。
fn collect_elements(
    tokens: &[&str],
    open: usize,
    close: usize,
    variant_list: bool,
    contexts: &mut BTreeMap<usize, FieldContext>,
) {
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
        collect_elements(tokens, open, close, false, contexts);
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
                i = skip_type_arguments(tokens, i, close);
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    i
}
