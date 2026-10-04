//! module_graph 守卫的清洗与分词层（issue #399；仅测试构建参与编译）：
//! 把 Rust 源码文本变成「标识符成段、标点单字符、`::` 合并」的 token 序列，
//! 注释与字面量内容先行抹除——上层项扫描（mod/use/属性/花括号配对）只面对
//! 干净 token，不被字面量内的关键字与括号干扰。

/// 源码清洗：注释与字符串/字符/raw string 字面量的内容替换为空白，长度
/// 与换行结构不变——token 扫描不被字面量内的 `mod`/`use`/花括号干扰；
/// 属性不在字面量内，保持可检。生命周期（`'a`）不闭合引号，原样保留。
pub(super) fn strip_comments_and_literals(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if i + 1 < b.len() && b[i + 1] == b'/' => {
                while i < b.len() && b[i] != b'\n' {
                    out[i] = b' ';
                    i += 1;
                }
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => i = blank_block_comment(b, &mut out, i),
            b'"' => i = blank_plain_string(b, &mut out, i),
            b'r' | b'b' if is_raw_string_start(b, i) => i = blank_raw_string(b, &mut out, i),
            b'\'' => i = blank_char_literal(b, &mut out, i),
            _ => i += 1,
        }
    }
    String::from_utf8(out).expect("清洗只以空格替换字面量内容，UTF-8 结构不变")
}

/// 块注释（含嵌套）抹除：返回注释结束后的下标。
fn blank_block_comment(b: &[u8], out: &mut [u8], start: usize) -> usize {
    let mut i = start;
    let mut depth = 0;
    while i < b.len() {
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            depth += 1;
            i = blank_two(out, i);
        } else if i + 1 < b.len() && b[i] == b'*' && b[i + 1] == b'/' {
            depth -= 1;
            i = blank_two(out, i);
            if depth == 0 {
                break;
            }
        } else {
            out[i] = b' ';
            i += 1;
        }
    }
    i
}

/// 抹除位置 i 与 i+1 两字节并前进两格（注释定界符共用）。
fn blank_two(out: &mut [u8], i: usize) -> usize {
    out[i] = b' ';
    out[i + 1] = b' ';
    i + 2
}

/// 普通字符串（含 `b"…"` 的引号段与转义）抹除：返回闭引号后的下标。
fn blank_plain_string(b: &[u8], out: &mut [u8], start: usize) -> usize {
    let mut i = start;
    out[i] = b' ';
    i += 1;
    while i < b.len() && b[i] != b'"' {
        if b[i] == b'\\' {
            out[i] = b' ';
            i += 1;
        }
        if i < b.len() {
            out[i] = b' ';
            i += 1;
        }
    }
    if i < b.len() {
        out[i] = b' ';
        i += 1;
    }
    i
}

/// `r"`/`r#"`/`br#"` 等 raw string 抹除：闭引号后须跟同数 `#`。
fn blank_raw_string(b: &[u8], out: &mut [u8], start: usize) -> usize {
    let body = if b[start] == b'b' { start + 1 } else { start };
    let (hashes, open_quote) = raw_open_prefix(b, body);
    let end = raw_close(b, open_quote + 1, hashes);
    for slot in &mut out[start..end] {
        *slot = b' ';
    }
    end
}

/// raw string 开头的 `#`* 前缀计数：返回哈希数与开引号下标。
fn raw_open_prefix(b: &[u8], body: usize) -> (usize, usize) {
    let mut hashes = 0;
    let mut j = body + 1;
    while j < b.len() && b[j] == b'#' {
        hashes += 1;
        j += 1;
    }
    (hashes, j)
}

/// 自开引号后扫描闭引号（后随同数 `#`）；未闭合时防御性到文件尾。
fn raw_close(b: &[u8], from: usize, hashes: usize) -> usize {
    let mut k = from;
    while k < b.len() {
        if b[k] == b'"' && hash_run_len(b, k + 1) == hashes {
            return k + 1 + hashes;
        }
        k += 1;
    }
    b.len()
}

/// 自 from 起的连续 `#` 数。
fn hash_run_len(b: &[u8], from: usize) -> usize {
    let mut n = 0;
    let mut m = from;
    while m < b.len() && b[m] == b'#' {
        n += 1;
        m += 1;
    }
    n
}

/// `r"`/`r#"`/`br#"` 起点判定：`r` 后须为 `#`* 再跟**开引号**才构成 raw
/// string——只认 `r#` 前缀会把裸标识符 `r#type` 误判为 raw string 并把
/// 其后整段抹到文件尾、令后续 mod/use 静默失采（评审 5347759049）。
/// `b` 前缀仅在紧随 `r` 时成立。
fn is_raw_string_start(b: &[u8], i: usize) -> bool {
    let start = if b[i] == b'r' {
        i
    } else if b.get(i + 1) == Some(&b'r') {
        i + 1
    } else {
        return false;
    };
    let mut j = start + 1;
    while j < b.len() && b[j] == b'#' {
        j += 1;
    }
    b.get(j) == Some(&b'"')
}

/// 字符字面量（`'x'`、`'\n'`、`'\''`）抹除；生命周期不闭合，仅前进一字节。
fn blank_char_literal(b: &[u8], out: &mut [u8], start: usize) -> usize {
    let next = b.get(start + 1).copied();
    let is_char = match next {
        Some(b'\\') => b.get(start + 3) == Some(&b'\''),
        Some(c) if c != b'\'' => b.get(start + 2) == Some(&b'\''),
        _ => false,
    };
    if !is_char {
        return start + 1;
    }
    let end = if next == Some(b'\\') {
        start + 3
    } else {
        start + 2
    };
    for slot in &mut out[start..=end] {
        *slot = b' ';
    }
    end + 1
}

/// 清洗文本 → token 序列：ASCII 标识符成段、标点单字符，空白与非 ASCII
/// 丢弃；路径分隔 `::` 合并为单 token 供 use 解析按段重组。
pub(super) fn tokenize(cleaned: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < cleaned.len() {
        i = token_step(cleaned, &mut tokens, &mut start, i);
    }
    if let Some(s) = start {
        tokens.push(&cleaned[s..]);
    }
    tokens
}

/// `r#ident` 裸标识符的终点（None = 非该形态）：r 后恰一个 `#` 再跟
/// 标识符起始。清洗层已抹除 raw string（`r#\"` 序列不复存在），分词层
/// 见到的 `r#` + 字母必为裸标识符，须整体成单 token——拆散会把 `r#use`
/// 里的 use 误读为导入并对后续 token fail-closed（评审 5349783070）。
fn raw_ident_end(cleaned: &str, i: usize) -> Option<usize> {
    let bytes = cleaned.as_bytes();
    if bytes.get(i) != Some(&b'r') || bytes.get(i + 1) != Some(&b'#') {
        return None;
    }
    let head = *bytes.get(i + 2)?;
    if !(head.is_ascii_alphabetic() || head == b'_') {
        return None;
    }
    let mut j = i + 3;
    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
        j += 1;
    }
    Some(j)
}

/// 单步分词（tokenize 的循环体）：返回下一个待处理下标。
fn token_step<'a>(
    cleaned: &'a str,
    tokens: &mut Vec<&'a str>,
    start: &mut Option<usize>,
    i: usize,
) -> usize {
    if let Some(end) = raw_ident_end(cleaned, i) {
        tokens.push(&cleaned[i..end]);
        return end;
    }
    let byte = cleaned.as_bytes()[i];
    if byte.is_ascii_alphanumeric() || byte == b'_' {
        if start.is_none() {
            *start = Some(i);
        }
        return i + 1;
    }
    if let Some(s) = start.take() {
        tokens.push(&cleaned[s..i]);
    }
    if byte == b':' && cleaned.as_bytes().get(i + 1) == Some(&b':') {
        tokens.push(&cleaned[i..i + 2]);
        return i + 2;
    }
    if byte.is_ascii_punctuation() {
        tokens.push(&cleaned[i..i + 1]);
    }
    i + 1
}
