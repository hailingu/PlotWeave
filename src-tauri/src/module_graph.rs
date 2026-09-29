//! Rust 侧模块依赖图无环守卫（issue #399 缺口一；仅测试构建参与编译）。
//!
//! 前端自 issue #106 起由 `src/moduleGraph.test.ts` 从 TypeScript AST 构建
//! 非测试模块的相对导入图并断言无环；Rust 侧此前没有对等守卫（issue
//! #146 的资产/图库互依是一次性修复，未沉淀为常驻断言）。本模块补齐对
//! 等物：文本扫描 `src-tauri/src` 生产模块的 `mod` 声明与 `use` 路径，
//! 构建文件粒度依赖图并断言无环，与前端守卫共同构成跨语言的无环不变量。
//!
//! 构图口径：
//! - 节点 = 自 `lib.rs` 沿**非 `#[cfg(test)]`** 的 `mod` 声明可达的文件
//!   （`NAME.rs`/`NAME/mod.rs` 双形态）。仅测试构建参与的文件（`*_tests.rs`、
//!   `testutil.rs` 等）经此口径天然不进图；二进制入口 `main.rs` 无库内
//!   依赖同样不在图内。`#[cfg(target_os)]` 等平台门控按并集计入（覆盖
//!   目标平台全集，不只当前编译目标）。
//! - 边 = `use crate::…` / `use super::…` / `use self::…` 解析出的目标
//!   模块文件（花括号分组展开、`as` 剥除、`*` 按前缀计、组内 `self` 指
//!   前缀模块；`pub use` 同采，函数体内局部 `use` 也是文件依赖；平台
//!   混合变体的路径可有多个所有者文件）。外部 crate 与裸路径不参与；
//!   不经 `use` 的全限定调用不采集——与前端守卫只采 import/export 边
//!   同口径。同文件 inline 引用解析回自身，不计自环边。
//! - fail-closed：`mod` 声明找不到对应文件（`NAME.rs` 与 `NAME/mod.rs`
//!   均缺失或并存）、`super::` 越过 crate 根、use 语句缺分号或花括号分组
//!   残缺，均直接判失败——构图不健全比漏检更危险（与前端
//!   `resolveEdgeKeys` 的失败语义一致）。
//! - 已知盲区（登记而非静默）：`macro_rules!` 体整块跳过（现存唯一生产
//!   宏 `atomic_io` 体内无 `use`）；非 ASCII 标识符会被分词层拆散（本仓无）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

mod cycles;
mod lexer;
use cycles::cycles_of;
use lexer::{strip_comments_and_literals, tokenize};

/// 图节点键 = 相对 src 根的 posix 路径（失败信息可读，与前端守卫口径一致）。
type ModuleKey = String;

/// 单文件扫描产物：非 cfg(test) mod 声明（含声明位置的 inline 栈，评审
/// 5349783070：`mod outer { mod child; }` 的 child 须挂在 outer 下、其
/// 文件在 outer 对应子目录）与 use（栈快照 + 路径 token）。
struct FileScan {
    mods: Vec<ModDecl>,
    uses: Vec<(Vec<String>, Vec<String>)>,
}

/// 一条 mod 声明：inline_path = 声明位置的外层 inline 模块栈（文件模块
/// 路径之后的段）；file_backed = 外部文件声明（`mod x;`），否则 inline 块。
struct ModDecl {
    inline_path: Vec<String>,
    name: String,
    file_backed: bool,
}

/// 解析自 tokens[i] == "#" 起的属性（`#!` 为内属性，另行返回标志），返回
/// 消费后下标、是否 cfg(test) 门控与是否内属性。门控语义：cfg(…) 组
/// 是否 cfg(test) 门控：cfg(…) 组**蕴含** test 才门控（裸 `test` 或
/// `all(test, …)`；`any(test, feature)` 不蕴含，按并集保守计入。评审
/// 5347759049：此前只认深度 1 裸 test，`all(test, unix)` 被漏判）。组内
/// 字符串已在清洗层抹除，不产生假 token。
fn parse_attr(tokens: &[&str], i: usize) -> (usize, bool, bool) {
    let mut j = i + 1;
    let mut is_inner = false;
    if tokens.get(j) == Some(&"!") {
        is_inner = true;
        j += 1;
    }
    if tokens.get(j) != Some(&"[") {
        return (j, false, is_inner);
    }
    j += 1;
    let mut depth = 1usize;
    let mut is_test = false;
    while j < tokens.len() && depth > 0 {
        match tokens[j] {
            "[" | "(" => depth += 1,
            "]" | ")" => depth -= 1,
            "cfg" if depth == 1 && tokens.get(j + 1) == Some(&"(") => {
                if let Some(close) = find_group_close(tokens, j + 2) {
                    if cfg_implies_test(&tokens[j + 2..close]) {
                        is_test = true;
                    }
                }
            }
            _ => {}
        }
        j += 1;
    }
    (j, is_test, is_inner)
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

/// 自 tokens[open] == "{" 起跳过整块（含嵌套），返回闭合 "}" 之后的下标。
fn skip_braced(tokens: &[&str], open: usize) -> usize {
    let mut depth = 0usize;
    let mut k = open;
    while k < tokens.len() {
        match tokens[k] {
            "{" => depth += 1,
            "}" => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return k + 1;
        }
        k += 1;
    }
    k
}

/// 深度回落到栈顶 entry 时弹出该 inline 模块（scan_tokens 的 } 臂）。
fn pop_inline(inline: &mut Vec<(String, usize)>, depth: usize) {
    if inline.last().is_some_and(|(_, d)| *d == depth) {
        inline.pop();
    }
}

/// 蕴含 test 的内属性（`#![cfg(test)]`）处置：作用于整个外层模块——
/// inline 模块体内 → Some(跳至该模块闭合的下标)；文件级 → None（整文件
/// 视为测试代码）；块内（fn 体等罕见形态）→ Some(原下标) 退化为挂起。
fn inner_test_gate(
    tokens: &[&str],
    next: usize,
    depth: usize,
    inline: &[(String, usize)],
) -> Option<usize> {
    if let Some(entry) = inline.last().map(|(_, d)| *d) {
        return Some(skip_to_module_close(tokens, next, depth, entry));
    }
    if depth == 0 {
        None
    } else {
        Some(next)
    }
}

/// 跳到「进入深度为 entry 的 inline 模块」的闭合 "}" 之前（不消费该括号，
/// 交回主循环弹栈）：以 k 为起点、depth 为当前全局深度做局部平衡扫描。
fn skip_to_module_close(tokens: &[&str], mut k: usize, depth: usize, entry: usize) -> usize {
    let mut delta = 0usize;
    while k < tokens.len() {
        match tokens[k] {
            "{" => delta += 1,
            "}" => {
                if depth + delta == entry {
                    return k;
                }
                delta = delta.saturating_sub(1);
            }
            _ => {}
        }
        k += 1;
    }
    k
}

/// 跳过 macro_rules 定义的宏体：自名字位置起按其后的组定界符
///（`{`、`[`、`(` 三种合法形态）跳过整组，返回组后的下标。
fn skip_macro_body(tokens: &[&str], name_at: usize) -> usize {
    match tokens.get(name_at + 1).copied() {
        Some("{") => skip_delimited(tokens, name_at + 1, "{", "}"),
        Some("[") => skip_delimited(tokens, name_at + 1, "[", "]"),
        Some("(") => skip_delimited(tokens, name_at + 1, "(", ")"),
        // 畸形（非法 Rust）：无害推进，fail-closed 由下游解析兜底
        _ => name_at + 1,
    }
}

/// 自 tokens[open]（为 open_tok）起跳过整组（同种定界符嵌套平衡），
/// 返回闭合 token 之后的下标。
fn skip_delimited(tokens: &[&str], open: usize, open_tok: &str, close_tok: &str) -> usize {
    let mut depth = 0usize;
    let mut k = open;
    while k < tokens.len() {
        if tokens[k] == open_tok {
            depth += 1;
        } else if tokens[k] == close_tok {
            depth -= 1;
            if depth == 0 {
                return k + 1;
            }
        }
        k += 1;
    }
    k
}

/// 带属性项的开头判定（消费挂起 cfg(test) 并整条跳过）。
fn item_keyword(tok: &str) -> bool {
    // pub/unsafe/async 是修饰符而非项首——不消费，等真项关键字到来
    //（`#[cfg(test)] pub mod` 仍须被门控）；其余任何 token（含 let、
    // 表达式语句首）都视为带属性项的开头并整条跳过（评审 5349970852：
    // 只认固定清单会让 `#[cfg(test)] let …;` 的门控泄漏到其后的生产
    // use/mod，真环隐形）
    !matches!(tok, "pub" | "unsafe" | "async")
}

/// 跳过 cfg(test) 项/语句的完整剩余部分：推进到首个 "{"（跳块）或 ";"；
/// 其后的 else/else if 复合臂与结尾分号一并消费（评审 5350168645：只跳
/// 首个块会把 else 臂当生产代码误采）。
fn skip_test_item(tokens: &[&str], mut k: usize) -> usize {
    while k < tokens.len() {
        match tokens[k] {
            "{" => {
                k = skip_braced(tokens, k);
                if tokens.get(k) == Some(&"else") {
                    k += 1;
                    continue;
                }
                if tokens.get(k) == Some(&";") {
                    k += 1;
                }
                return k;
            }
            ";" => return k + 1,
            _ => {}
        }
        k += 1;
    }
    k
}

/// 扫描单文件 token：产出非 cfg(test) 的 mod 声明与 use 路径；inline 模块入栈供 `super::` 解析，门控项与宏体跳过。
fn scan_tokens(tokens: &[&str]) -> FileScan {
    let mut mods = Vec::new();
    let mut uses = Vec::new();
    let mut cfg_test = false;
    let mut inline: Vec<(String, usize)> = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "#" => {
                let (next, is_test, is_inner) = parse_attr(tokens, i);
                // 内属性作用于整个外层模块（评审 5350627153）：只挂起会给
                // 首项消费后泄漏，其余测试声明误入生产图（假环方向）。
                // 文件级（无 inline 栈且不在块内）→ 整文件视为测试代码；
                // inline 模块体内 → 跳至该模块闭合
                if is_inner && is_test {
                    match inner_test_gate(tokens, next, depth, &inline) {
                        Some(resumed) => i = resumed,
                        None => {
                            return FileScan {
                                mods: Vec::new(),
                                uses: Vec::new(),
                            }
                        }
                    }
                    continue;
                }
                cfg_test |= is_test;
                i = next;
            }
            "{" => {
                depth += 1;
                i += 1;
            }
            "}" => {
                pop_inline(&mut inline, depth);
                depth = depth.saturating_sub(1);
                i += 1;
            }
            "mod" => {
                i = scan_mod_decl(tokens, i, cfg_test, &mut mods, &mut inline, &mut depth);
                cfg_test = false;
            }
            "use" => {
                i = scan_use_stmt(tokens, i, cfg_test, &inline, &mut uses);
                cfg_test = false;
            }
            "macro_rules" if tokens.get(i + 1) == Some(&"!") => {
                // 跳过宏体（{、[、( 三种合法定界符，评审 5351210423）的
                // 同时消费挂起的 cfg(test)：宏之后的项是另一项，不得继承
                // 门控（评审 5349783070：泄漏会漏采其后的生产声明）
                i = skip_macro_body(tokens, i + 2);
                cfg_test = false;
            }
            t if cfg_test && item_keyword(t) => {
                i = skip_test_item(tokens, i + 1);
                cfg_test = false;
            }
            _ => i += 1,
        }
    }
    FileScan { mods, uses }
}

/// mod 声明分派（scan_tokens 的 mod 臂）：外部（`;`）或 inline（`{`）；
/// cfg(test) 门控时整体跳过。返回消费后的下标。
fn scan_mod_decl(
    tokens: &[&str],
    i: usize,
    cfg_test: bool,
    mods: &mut Vec<ModDecl>,
    inline: &mut Vec<(String, usize)>,
    depth: &mut usize,
) -> usize {
    let name = strip_raw_ident(tokens.get(i + 1).copied().unwrap_or(""));
    let stack: Vec<String> = inline.iter().map(|(n, _)| n.clone()).collect();
    match tokens.get(i + 2) {
        Some(&";") => {
            if !cfg_test && !name.is_empty() {
                mods.push(ModDecl {
                    inline_path: stack,
                    name: name.to_string(),
                    file_backed: true,
                });
            }
            i + 3
        }
        Some(&"{") => {
            if cfg_test {
                return skip_braced(tokens, i + 2);
            }
            if name.is_empty() {
                panic!("mod 声明缺少名字");
            }
            *depth += 1;
            inline.push((name.to_string(), *depth));
            mods.push(ModDecl {
                inline_path: stack,
                name: name.to_string(),
                file_backed: false,
            });
            i + 3
        }
        // mod 名后既非 ; 也非 {：非法 Rust，fail-closed
        _ => panic!("mod 声明形态异常：mod {name}"),
    }
}

/// use 语句采集（scan_tokens 的 use 臂）：推进到分号，非门控时记录
/// inline 栈快照与路径 token。返回消费后的下标。
fn scan_use_stmt(
    tokens: &[&str],
    i: usize,
    cfg_test: bool,
    inline: &[(String, usize)],
    uses: &mut Vec<(Vec<String>, Vec<String>)>,
) -> usize {
    let mut j = i + 1;
    while j < tokens.len() && tokens[j] != ";" {
        j += 1;
    }
    if j >= tokens.len() {
        panic!("use 语句缺少分号（token 残缺）");
    }
    if !cfg_test {
        let stack = inline.iter().map(|(n, _)| n.clone()).collect();
        let path = tokens[i + 1..j].iter().map(|s| s.to_string()).collect();
        uses.push((stack, path));
    }
    j + 1
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
fn strip_raw_ident(tok: &str) -> &str {
    tok.strip_prefix("r#").unwrap_or(tok)
}

/// 解析一个 use 树元素追加到 paths：组内 `self` 指前缀模块、`as` 剥除、`*` 按前缀计。
fn parse_use_tree(
    prefix: &[String],
    tokens: &[String],
    i: &mut usize,
    paths: &mut Vec<Vec<String>>,
) {
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
        if tokens.get(*i).map(String::as_str) == Some("as") {
            *i += 2;
        }
        match tokens.get(*i).map(String::as_str) {
            Some("::") => {
                *i += 1;
                match tokens.get(*i).map(String::as_str) {
                    Some("{") => {
                        *i += 1;
                        parse_use_group(&path, tokens, i, paths);
                        return;
                    }
                    Some("*") => {
                        *i += 1;
                        paths.push(path);
                        return;
                    }
                    Some(_) => {}
                    None => panic!("use 路径意外截断：{tokens:?}"),
                }
            }
            _ => {
                paths.push(path);
                return;
            }
        }
    }
}

/// 解析花括号分组内的元素序列（逗号分隔，允许尾逗号）。
fn parse_use_group(
    prefix: &[String],
    tokens: &[String],
    i: &mut usize,
    paths: &mut Vec<Vec<String>>,
) {
    loop {
        parse_use_tree(prefix, tokens, i, paths);
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

/// use 语句 token → 完整路径段列表集（花括号分组递归展开）。
fn use_tree_paths(tokens: &[String]) -> Vec<Vec<String>> {
    let mut paths = Vec::new();
    let mut i = 0;
    // 根级花括号（`use {crate::a::A, crate::b::B};`）同样是合法 use 树
    //（评审 5350627153）：入口先判组再要求路径段
    if tokens.first().map(String::as_str) == Some("{") {
        i = 1;
        parse_use_group(&[], tokens, &mut i, &mut paths);
        return paths;
    }
    parse_use_tree(&[], tokens, &mut i, &mut paths);
    paths
}

/// 模块树：模块路径段（crate 根为空）→ 文件键，与各模块的子模块名集。
struct ModuleTree {
    /// 逻辑模块路径 → 文件所有者集（评审 5350339687：平台混合变体——
    /// `#[cfg(unix)] mod platform {…}` 与 `#[cfg(windows)] mod platform;`
    /// ——并集口径保留双方）。
    file_of: BTreeMap<Vec<String>, BTreeSet<ModuleKey>>,
    children: BTreeMap<Vec<String>, BTreeSet<String>>,
    /// 规范迭代源：每个物理文件恰一次，配其规范包含路径——inline 别名
    /// 只用于解析目标（评审 5350339687：别名路径重扫会虚构错误边）。
    canonical: BTreeSet<(Vec<String>, ModuleKey)>,
}

/// 声明文件的子模块目录（不带尾斜杠；根为空）：`lib.rs`/`mod.rs` 的子模块
/// 在同级目录，`NAME.rs` 的在 `NAME/` 子目录（与 rustc 的路径规则一致）。
fn child_dir_of(file_key: &str) -> String {
    let file = file_key.rsplit('/').next().unwrap_or(file_key);
    let dir = match file_key.rfind('/') {
        Some(p) => &file_key[..p],
        None => "",
    };
    if file == "lib.rs" || file == "mod.rs" {
        dir.to_string()
    } else {
        let stem = file.strip_suffix(".rs").unwrap_or(file);
        if dir.is_empty() {
            stem.to_string()
        } else {
            format!("{dir}/{stem}")
        }
    }
}

/// 声明文件子目录 + inline 栈各段 → 子模块文件所在目录（根为空）。
fn sub_dir(dir: &str, inline_path: &[String]) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if !dir.is_empty() {
        parts.push(dir);
    }
    parts.extend(inline_path.iter().map(String::as_str));
    parts.join("/")
}

/// 子模块声明的文件键：`NAME.rs` 与 `NAME/mod.rs` 恰存在其一，缺失或并存
/// 均失败（并存本就是非法 Rust，fail-closed 而非任选）。
fn child_file_key(files: &BTreeMap<ModuleKey, String>, dir: &str, name: &str) -> ModuleKey {
    let sibling = if dir.is_empty() {
        format!("{name}.rs")
    } else {
        format!("{dir}/{name}.rs")
    };
    let nested = if dir.is_empty() {
        format!("{name}/mod.rs")
    } else {
        format!("{dir}/{name}/mod.rs")
    };
    match (files.contains_key(&sibling), files.contains_key(&nested)) {
        (true, false) => sibling,
        (false, true) => nested,
        (true, true) => panic!("mod {name} 同时存在 {sibling} 与 {nested}（非法 Rust）"),
        (false, false) => panic!("mod {name} 找不到对应文件（{sibling} / {nested} 均缺失）"),
    }
}

impl ModuleTree {
    /// 自 lib.rs 沿非 cfg(test) mod 声明构建可达模块树并缓存扫描产物。
    fn build(
        files: &BTreeMap<ModuleKey, String>,
        scans: &mut BTreeMap<ModuleKey, FileScan>,
    ) -> ModuleTree {
        let mut tree = ModuleTree {
            file_of: BTreeMap::new(),
            children: BTreeMap::new(),
            canonical: BTreeSet::new(),
        };
        let root = ModuleKey::from("lib.rs");
        assert!(files.contains_key(&root), "src 根缺少 lib.rs");
        tree.file_of
            .entry(Vec::new())
            .or_default()
            .insert(root.clone());
        tree.canonical.insert((Vec::new(), root.clone()));
        let mut queue = vec![(Vec::<String>::new(), root)];
        while let Some((path, key)) = queue.pop() {
            if !scans.contains_key(&key) {
                let source = &files[&key];
                let scan = scan_tokens(&tokenize(&strip_comments_and_literals(source)));
                scans.insert(key.clone(), scan);
            }
            let scan = &scans[&key];
            let dir = child_dir_of(&key);
            for decl in &scan.mods {
                let mut mod_path = path.clone();
                mod_path.extend(decl.inline_path.iter().cloned());
                tree.children
                    .entry(mod_path.clone())
                    .or_default()
                    .insert(decl.name.clone());
                // inline 模块的「文件」= 声明文件（评审 5350168645：use
                // 目标是 inline 模块时须解析回所在文件，否则该边漏采、
                // 真环隐形）；不入队——该文件本就按自身路径扫描
                if !decl.file_backed {
                    mod_path.push(decl.name.clone());
                    tree.file_of
                        .entry(mod_path)
                        .or_default()
                        .insert(key.clone());
                    continue;
                }
                // 外部文件子模块的目录 = 声明文件子目录 + inline 栈各段
                //（与 rustc 的目录归属规则一致）
                let child_dir = sub_dir(&dir, &decl.inline_path);
                let child_key = child_file_key(files, &child_dir, &decl.name);
                let mut child_path = mod_path;
                child_path.push(decl.name.clone());
                // 同路径的多个目标专属所有者都登记（评审 5350168645/
                // 5350339687）；文件只在首次声明时入队与进规范迭代源
                let owners = tree.file_of.entry(child_path.clone()).or_default();
                let first = owners.insert(child_key.clone());
                if first {
                    tree.canonical
                        .insert((child_path.clone(), child_key.clone()));
                    queue.push((child_path, child_key));
                }
            }
        }
        tree
    }
}

/// 解析单条 use 完整路径 → 目标文件所有者集：`crate::` 重定到根、`super::`
/// 逐个弹出（越过根即失败）、`self::` 就地；未命中子模块的段视为 item 停在
/// 最近模块。外部路径返回空集；平台混合变体返回多个所有者。
fn resolve_use(
    tree: &ModuleTree,
    file_path: &[String],
    inline: &[String],
    segs: &[String],
) -> Vec<ModuleKey> {
    let mut ctx: Vec<String> = file_path.to_vec();
    ctx.extend(inline.iter().cloned());
    let mut it = 0;
    match segs.first().map(String::as_str) {
        Some("crate") => {
            ctx.clear();
            it = 1;
        }
        Some("self") => it = 1,
        Some("super") => {
            while segs.get(it).map(String::as_str) == Some("super") {
                if ctx.pop().is_none() {
                    panic!("super:: 越过 crate 根：{}", segs.join("::"));
                }
                it += 1;
            }
        }
        _ => {
            // uniform paths（2018+）：裸首段可解析为当前模块的直接子模块
            //（评审 5351210423：library_journal/store 的 facade→child 边
            // 此前被当外部 crate 丢弃）；未命中才视为外部
            let first = segs.first().map(String::as_str);
            let is_child =
                first.is_some_and(|f| tree.children.get(&ctx).is_some_and(|c| c.contains(f)));
            if !is_child {
                return Vec::new();
            }
        }
    }
    while let Some(seg) = segs.get(it) {
        let known = tree.children.get(&ctx).is_some_and(|c| c.contains(seg));
        if !known {
            break;
        }
        ctx.push(seg.clone());
        it += 1;
    }
    tree.file_of
        .get(&ctx)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// 全图构建：模块树 + use 边（自环剔除、BTreeSet 去重排序），
/// 节点集 = 全部生产模块文件。
fn build_graph(files: &BTreeMap<ModuleKey, String>) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    let mut scans: BTreeMap<ModuleKey, FileScan> = BTreeMap::new();
    let tree = ModuleTree::build(files, &mut scans);
    let mut edges: BTreeMap<ModuleKey, BTreeSet<ModuleKey>> = BTreeMap::new();
    for (_, key) in &tree.canonical {
        edges.entry(key.clone()).or_default();
    }
    for (path, key) in &tree.canonical {
        for target in use_targets_of(&tree, &scans, path, key) {
            edges
                .get_mut(key)
                .expect("节点集在建边前已初始化")
                .insert(target);
        }
    }
    edges
}

/// 单文件的 use 边收集（build_graph 的内层）：展开分组逐条解析目标，
/// 剔除自环（同文件 inline 模块引用不成环）。
fn use_targets_of(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    path: &[String],
    key: &ModuleKey,
) -> Vec<ModuleKey> {
    let mut targets = Vec::new();
    for (inline, use_toks) in &scans[key].uses {
        for segs in use_tree_paths(use_toks) {
            for target in resolve_use(tree, path, inline, &segs) {
                if &target != key {
                    targets.push(target);
                }
            }
        }
    }
    targets
}

/// 递归读取 dir 下全部 .rs 文件（键 = 相对 posix 路径）。main.rs 与测试
/// 文件经「不可达即不入图」口径自然出局，不做显式排除。
fn load_sources(dir: &Path, out: &mut BTreeMap<ModuleKey, String>, prefix: &str) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("读取目录 {} 失败：{e}", dir.display()))
        .map(|e| e.expect("目录项读取失败"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        if path.is_dir() {
            load_sources(&path, out, &rel);
        } else if name.ends_with(".rs") {
            let content =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {rel} 失败：{e}"));
            out.insert(rel, content);
        }
    }
}

/// 反例夹具与真实仓库断言（issue #399；仅测试构建参与编译）。
#[cfg(test)]
mod module_graph_tests;
