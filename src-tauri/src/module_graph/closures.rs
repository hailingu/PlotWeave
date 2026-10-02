//! 门控测试表达式的闭包头与控制流正文边界（issue #424）。
//!
//! 输入为既有词法 token，输出为闭包正文入口及类型/表达式状态。只识别
//! 稳定前缀和直接 let 初始化，不解析完整 Rust AST；括号组使用主扫描器
//! 的平衡规则。match arms 以同层 => 或空组识别；操作数块不消耗外围正文。

use super::{skip_braced, skip_delimited};

/// 闭包头之后的扫描状态；正文计数只属于当前被门控的控制流表达式。
pub(super) struct ClosureHeaders {
    /// 首个正文或显式返回类型 token。
    pub(super) next: usize,
    /// 当前入口是否处于显式返回类型或调用方字段类型中。
    pub(super) type_header: bool,
    /// 闭包正文或 return/break 操作数是否使用表达式态（issue #446）。
    pub(super) initializer: bool,
    matches: usize,
    blocks: usize,
    /// 直接控制流语句的最终正文结束即交还扫描；值包装仍可接二元操作数。
    statement_control_flow: bool,
    /// 当前门控表达式已识别闭包头；显式返回类型后的后缀属于闭包值。
    has_closure: bool,
}

/// 消费一个正文组后，继续同一测试表达式或交还生产扫描。
pub(super) enum BodyStep {
    /// 后续正文入口及其类型/表达式态。
    Continue(usize, bool, bool),
    /// 完整被门控表达式之后的位置。
    End(usize),
}

/// 跨过 let 模式/可选类型标注，只在同层等号后识别初始化表达式。
fn initializer_start(tokens: &[&str], mut at: usize) -> Option<usize> {
    while at < tokens.len() {
        at = match tokens[at] {
            "=" => return Some(at + 1),
            ";" | "}" => return None,
            "(" => skip_delimited(tokens, at, "(", ")"),
            "[" => skip_delimited(tokens, at, "[", "]"),
            "{" => skip_braced(tokens, at),
            _ => at + 1,
        };
    }
    None
}

/// 沿稳定表达式前缀找到闭包参数，保留外围 match 与 let 条件正文数。
/// 指针/引用字段类型停在类型 token；yield/const 闭包不在稳定语法内。
fn parameter_open(tokens: &[&str], mut open: usize) -> Option<(usize, usize, usize)> {
    let (mut matches, mut blocks) = (0, 0);
    while open < tokens.len() {
        match tokens[open] {
            "|" => return Some((open, matches, blocks)),
            "return" | "async" | "move" | "*" => open += 1,
            "match" => {
                matches += 1;
                open += 1;
            }
            "if" | "while" if tokens.get(open + 1) == Some(&"let") => {
                blocks += 1;
                open = initializer_start(tokens, open + 2)?;
            }
            "let" => open = initializer_start(tokens, open + 1)?,
            "&" => {
                open += 1;
                open += usize::from(tokens.get(open) == Some(&"mut"));
            }
            "break" => {
                open += 1;
                if tokens.get(open) == Some(&"'") {
                    open += 2;
                }
            }
            _ => return None,
        }
    }
    None
}

/// 整体跨过闭包参数；模式或类型组中的 | 不充当参数列表的终点。
fn parameter_end(tokens: &[&str], start: usize) -> Option<(usize, usize, usize)> {
    let (open, matches, blocks) = parameter_open(tokens, start)?;
    let mut at = open + 1;
    while at < tokens.len() {
        at = match tokens[at] {
            "|" => return Some((at + 1, matches, blocks)),
            "(" => skip_delimited(tokens, at, "(", ")"),
            "[" => skip_delimited(tokens, at, "[", "]"),
            "{" => skip_braced(tokens, at),
            _ => at + 1,
        };
    }
    Some((at, matches, blocks))
}

/// 跨过闭包正文的值前缀，以识别其后属于闭包的控制流正文。
fn body_start(tokens: &[&str], mut at: usize) -> usize {
    while let Some(token) = tokens.get(at) {
        match *token {
            "return" | "*" | "!" | "-" => at += 1,
            "&" => {
                at += 1;
                at += usize::from(tokens.get(at) == Some(&"mut"));
            }
            _ => break,
        }
    }
    at
}

/// 消费连续项首闭包头；未找到闭包时保持原字段上下文和扫描位置。
pub(super) fn skip_closure_headers(
    tokens: &[&str],
    start: usize,
    type_header: bool,
) -> ClosureHeaders {
    let mut headers = ClosureHeaders {
        next: start,
        type_header,
        initializer: matches!(tokens.get(start), Some(&"return" | &"break")),
        matches: 0,
        blocks: 0,
        statement_control_flow: matches!(tokens.get(start), Some(&"match" | &"if" | &"while")),
        has_closure: false,
    };
    while let Some((body, matches, blocks)) = parameter_end(tokens, headers.next) {
        headers.has_closure = true;
        headers.next = body;
        headers.type_header = tokens.get(body) == Some(&"-") && tokens.get(body + 1) == Some(&">");
        headers.initializer = !headers.type_header;
        headers.matches += matches;
        headers.blocks += blocks;
    }
    if headers.matches + headers.blocks > 0 {
        let body = if headers.type_header {
            headers.next
        } else {
            body_start(tokens, headers.next)
        };
        match tokens.get(body).copied() {
            Some("match") => headers.matches += 1,
            Some("{") => headers.blocks += usize::from(body == headers.next),
            Some("if" | "loop" | "while" | "for" | "unsafe" | "async" | "'") => headers.blocks += 1,
            _ => headers.blocks += usize::from(headers.type_header),
        }
    }
    headers
}

/// 同层 => 或空组标识 match arms；空 arms 可用于不可实例化的 scrutinee。
fn is_match_arms(tokens: &[&str], open: usize) -> bool {
    if tokens.get(open + 1) == Some(&"}") {
        return true;
    }
    let mut at = open + 1;
    while at < tokens.len() {
        at = match tokens[at] {
            "=" if tokens.get(at + 1) == Some(&">") => return true,
            "}" => return false,
            "(" => skip_delimited(tokens, at, "(", ")"),
            "[" => skip_delimited(tokens, at, "[", "]"),
            "{" => skip_braced(tokens, at),
            _ => at + 1,
        };
    }
    false
}

/// 值前缀、运算符或 const 后的块是操作数，不消耗外围控制流正文。
fn is_operand_block(tokens: &[&str], open: usize, body: usize, type_header: bool) -> bool {
    if type_header || open == body {
        return false;
    }
    let previous = open.checked_sub(1).and_then(|at| tokens.get(at)).copied();
    matches!(previous, Some("const" | "return")) || is_expression_operator(previous)
}

/// 既有操作数字符口径：同时识别块前运算符和块后继续表达式的二元运算符。
/// 多字符运算符由分词器拆成字符，例如 != 的首字符是 !。
fn is_expression_operator(token: Option<&str>) -> bool {
    matches!(
        token,
        Some("+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "!" | "<" | ">" | "=")
    )
}

impl ClosureHeaders {
    /// 后缀点/问号附着于值；调用/索引只在值上下文延续，不能吞独立语句。
    /// 显式返回类型的正文结束后可对闭包值应用后缀、二元运算与 as 转型；
    /// 点点范围与 as 转型只在值态延续。
    /// 语句歧义契约：https://doc.rust-lang.org/reference/statements.html#expression-statements。
    fn body_continues(
        &self,
        tokens: &[&str],
        end: usize,
        type_header: bool,
        initializer: bool,
    ) -> bool {
        let token = tokens.get(end).copied();
        let value = initializer || self.has_closure;
        let postfix = match token {
            Some(".") => tokens.get(end + 1) != Some(&"."),
            Some("?") => true,
            Some("(" | "[") => {
                value && (!self.statement_control_flow || self.matches + self.blocks > 0)
            }
            _ => false,
        };
        // 门控项内带类型头的闭包正文只来自显式返回类型，其后是闭包值（issue #447）。
        if type_header && !self.has_closure {
            return false;
        }
        if postfix {
            return true;
        }
        value
            && !self.statement_control_flow
            && (is_expression_operator(token) || matches!(token, Some("." | "as")))
    }

    /// 操作数先整体跨过；普通正文先更新计数，再决定是否沿二元表达式继续。
    /// 入口控制流保留独立语句边界；已附着后缀在正文计数归零后交还值态。
    pub(super) fn step_after_body(
        &mut self,
        tokens: &[&str],
        open: usize,
        type_header: bool,
        initializer: bool,
    ) -> BodyStep {
        let end = skip_braced(tokens, open);
        if (self.matches + self.blocks > 0 || initializer)
            && is_operand_block(tokens, open, self.next, type_header)
        {
            return BodyStep::Continue(end, type_header, initializer);
        }
        if tokens.get(end) == Some(&"else") {
            let following = skip_closure_headers(tokens, end + 1, type_header);
            if following.next != end + 1 {
                self.has_closure |= following.has_closure;
                self.matches += following.matches;
                self.blocks += following.blocks.saturating_sub(1);
                return BodyStep::Continue(
                    following.next,
                    following.type_header,
                    following.initializer,
                );
            }
            return BodyStep::Continue(end + 1, type_header, initializer);
        }
        if self.matches > 0 && is_match_arms(tokens, open) {
            self.matches -= 1;
        } else {
            self.blocks = self.blocks.saturating_sub(1);
        }
        if self.body_continues(tokens, end, type_header, initializer) {
            BodyStep::Continue(end, false, true)
        } else if self.matches + self.blocks > 0 {
            BodyStep::Continue(end, type_header, initializer)
        } else {
            BodyStep::End(end + usize::from(tokens.get(end) == Some(&";")))
        }
    }
}
