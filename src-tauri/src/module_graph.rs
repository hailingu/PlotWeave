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

mod aliases;
mod cycles;
mod lexer;
mod tree;
mod use_tree;
use aliases::expand_segments;
use cycles::cycles_of;
use lexer::{strip_comments_and_literals, tokenize};
use tree::ModuleTree;
use use_tree::{strip_raw_ident, use_tree_of};

/// 图节点键 = 相对 src 根的 posix 路径（失败信息可读，与前端守卫口径一致）。
type ModuleKey = String;

/// 单文件扫描产物：非 cfg(test) mod 声明（含声明位置的 inline 栈，评审
/// 5349783070：`mod outer { mod child; }` 的 child 须挂在 outer 下、其
/// 文件在 outer 对应子目录）与 use（栈快照 + 路径 token）。
struct FileScan {
    mods: Vec<ModDecl>,
    uses: Vec<UseStmt>,
    renames: Vec<AliasBinding>,
}

/// 一条 use 语句：inline 栈与花括号作用域快照（块开括号的 token 下标
/// 序列，词法包含 = 前缀关系）。
struct UseStmt {
    inline_stack: Vec<String>,
    tokens: Vec<String>,
    scope: Vec<usize>,
}

/// 一条 `as` 重命名绑定：本地名 → 路径段，附声明处作用域（评审
/// 5352172371：平行作用域复用同一别名名时须按词法可见性绑定）。
struct AliasBinding {
    name: String,
    segs: Vec<String>,
    scope: Vec<usize>,
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
fn parse_attr(tokens: &[&str], i: usize) -> AttrInfo {
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
/// `#!` 内属性；has_path = 属性内出现 `path =`（评审 5352172371）。
#[derive(Default)]
struct AttrInfo {
    next: usize,
    is_test: bool,
    is_inner: bool,
    has_path: bool,
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
    match inline.last().map(|(_, d)| *d) {
        // 直接处于 inline 模块体顶层 → 门控整个模块，跳至其闭合
        Some(entry) if depth == entry => Some(skip_to_module_close(tokens, next, depth, entry)),
        // 文件顶层 → 整文件视为测试代码
        None if depth == 0 => None,
        // 嵌套块内（如 fn 体，评审 5351437161）→ 只门控当前块：此前按
        // 栈顶模块跳闭合会从更深的深度起算，吞掉其后全部生产代码（漏检）
        _ => Some(skip_to_module_close(tokens, next, depth, depth)),
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

/// 跳过 cfg(test) 项/元素：组内逗号与分号不终止项，泛型里的常量块
/// 也不视为项体。角括号仅在类型头或 turbofish 中平衡，避免把表达式
/// 比较误当泛型；箭头的 > 不闭合泛型。else 链与结尾分号一并消费。
fn skip_test_item(tokens: &[&str], mut k: usize) -> usize {
    let mut angles = 0usize;
    let mut type_header = false;
    let mut initializer = false;
    let mut type_alias = false;
    let labelled = tokens.get(k) == Some(&"\'");
    while k < tokens.len() {
        match tokens[k] {
            "type" if !initializer => {
                type_alias = true;
                type_header = true;
            }
            "fn" | "struct" | "enum" | "trait" | "impl" if !initializer => {
                type_header = true;
            }
            ":" if !initializer && !labelled => type_header = true,
            "=" if angles == 0 && !type_alias => {
                initializer = true;
                type_header = false;
            }
            "(" => {
                k = skip_delimited(tokens, k, "(", ")");
                continue;
            }
            "[" => {
                k = skip_delimited(tokens, k, "[", "]");
                continue;
            }
            "<" if type_header || angles > 0 || tokens.get(k.wrapping_sub(1)) == Some(&"::") => {
                angles += 1;
            }
            ">" if tokens.get(k.wrapping_sub(1)) != Some(&"-") => {
                angles = angles.saturating_sub(1);
            }
            "{" if angles > 0 => {
                k = skip_braced(tokens, k);
                continue;
            }
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
            ";" | "," if angles == 0 => return k + 1,
            _ => {}
        }
        k += 1;
    }
    k
}

/// 扫描单文件 token：产出非 cfg(test) 的 mod 声明与 use 路径；inline
/// 模块入栈供 `super::` 解析，花括号作用域快照供词法可见性判定（评审
/// 5352172371），门控项与宏体跳过，`#[path]` 模块 fail-closed 拒绝
///（评审 5352172371：清洗层不保留字面量内容，无法解析 path 值——
/// 响亮失败优于静默扫错位置）。
struct ScanState {
    mods: Vec<ModDecl>,
    uses: Vec<UseStmt>,
    renames: Vec<AliasBinding>,
    inline: Vec<(String, usize)>,
    scope: Vec<usize>,
    depth: usize,
    cfg_test: bool,
    pending_path: bool,
}

fn scan_tokens(tokens: &[&str]) -> FileScan {
    let mut st = ScanState {
        mods: Vec::new(),
        uses: Vec::new(),
        renames: Vec::new(),
        inline: Vec::new(),
        scope: Vec::new(),
        depth: 0,
        cfg_test: false,
        pending_path: false,
    };
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "#" => {
                let attr = parse_attr(tokens, i);
                // 内属性作用于整个外层模块（评审 5350627153）：文件级 →
                // 整文件测试代码；模块体顶层 → 门控整个模块；块内 → 只
                // 门控当前块
                if attr.is_inner && attr.is_test {
                    match inner_test_gate(tokens, attr.next, st.depth, &st.inline) {
                        Some(resumed) => i = resumed,
                        None => {
                            return FileScan {
                                mods: Vec::new(),
                                uses: Vec::new(),
                                renames: Vec::new(),
                            }
                        }
                    }
                    continue;
                }
                st.cfg_test |= attr.is_test;
                st.pending_path |= attr.has_path;
                i = attr.next;
            }
            "{" => {
                st.scope.push(i);
                st.depth += 1;
                i += 1;
            }
            "}" => {
                pop_inline(&mut st.inline, st.depth);
                st.scope.pop();
                st.depth = st.depth.saturating_sub(1);
                i += 1;
            }
            "mod" => {
                i = scan_mod_decl(tokens, i, &mut st);
                st.cfg_test = false;
                st.pending_path = false;
            }
            "use" => {
                i = scan_use_stmt(tokens, i, &mut st);
                st.cfg_test = false;
            }
            "macro_rules" if tokens.get(i + 1) == Some(&"!") => {
                // 跳过宏体（{、[、( 三种定界符）并消费挂起标志（评审
                // 5349783070：泄漏会漏采其后的生产声明）
                i = skip_macro_body(tokens, i + 2);
                st.cfg_test = false;
                st.pending_path = false;
            }
            t if st.cfg_test && item_keyword(t) => {
                i = skip_test_item(tokens, i);
                st.cfg_test = false;
                st.pending_path = false;
            }
            _ => i += 1,
        }
    }
    FileScan {
        mods: st.mods,
        uses: st.uses,
        renames: st.renames,
    }
}

/// mod 声明分派（scan_tokens 的 mod 臂）：外部（`;`）或 inline（`{`）；
/// cfg(test) 门控时整体跳过。返回消费后的下标。
fn scan_mod_decl(tokens: &[&str], i: usize, st: &mut ScanState) -> usize {
    let name = strip_raw_ident(tokens.get(i + 1).copied().unwrap_or(""));
    let stack: Vec<String> = st.inline.iter().map(|(n, _)| n.clone()).collect();
    // #[path] 改变模块文件位置，清洗层不保留字面量内容无法解析——
    // 生产代码 fail-closed 拒绝（登记边界）；cfg(test) 门控的整体跳过
    // 优先（本仓唯一 #[path] 即此形态）
    if st.pending_path && !st.cfg_test {
        panic!("mod {name} 携带 #[path]，issue #399 守卫不支持（请用标准文件布局）");
    }
    match tokens.get(i + 2) {
        Some(&";") => {
            if !st.cfg_test && !name.is_empty() {
                st.mods.push(ModDecl {
                    inline_path: stack,
                    name: name.to_string(),
                    file_backed: true,
                });
            }
            i + 3
        }
        Some(&"{") => {
            if st.cfg_test {
                return skip_braced(tokens, i + 2);
            }
            if name.is_empty() {
                panic!("mod 声明缺少名字");
            }
            st.depth += 1;
            st.scope.push(i + 2);
            st.inline.push((name.to_string(), st.depth));
            st.mods.push(ModDecl {
                inline_path: stack,
                name: name.to_string(),
                file_backed: false,
            });
            i + 3
        }
        // mod 名后既非 ; 也非 {：非法 Rust，fail-closed
        _ => panic!("mod 声明形态异常（mod 声明缺少名字或位置非法）：mod {name}"),
    }
}

/// use 语句采集（scan_tokens 的 use 臂）：推进到分号，非门控时记录
/// inline 栈快照与路径 token。返回消费后的下标。
fn scan_use_stmt(tokens: &[&str], i: usize, st: &mut ScanState) -> usize {
    let mut j = i + 1;
    while j < tokens.len() && tokens[j] != ";" {
        j += 1;
    }
    if j >= tokens.len() {
        panic!("use 语句缺少分号（token 残缺）");
    }
    if !st.cfg_test {
        let stack = st.inline.iter().map(|(n, _)| n.clone()).collect();
        let scope = st.scope.clone();
        let path = tokens[i + 1..j]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        for (name, segs) in use_tree_of(&path).renames {
            st.renames.push(AliasBinding {
                name,
                segs,
                scope: scope.clone(),
            });
        }
        st.uses.push(UseStmt {
            inline_stack: stack,
            tokens: path,
            scope,
        });
    }
    j + 1
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
    eprintln!("RU-IN segs={:?}", segs);
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
            // uniform paths（2018+）：裸首段优先按当前模块的直接子模块
            // 解析（评审 5351210423）；未命中时仍须继续下钻——路径可能来自
            // 别名展开的绝对模块路径（评审 5353260028），此时首段是 crate
            // 根的子模块而非当前模块的子模块（位置解析已由调用方完成）。
            // 仅当路径既非当前子模块也非根下可达模块时才视为外部返回空
            let first = segs.first().map(String::as_str);
            let is_local_child =
                first.is_some_and(|f| tree.children.get(&ctx).is_some_and(|c| c.contains(f)));
            if !is_local_child {
                // 非当前子模块：若是根模块的子模块则从根下钻（别名展开的
                // 绝对路径；评审 5353260028），否则视为外部返回空
                let is_root_module = first.is_some_and(|f| {
                    tree.children
                        .get(&Vec::new())
                        .is_some_and(|c| c.contains(f))
                });
                if !is_root_module {
                    return Vec::new();
                }
                ctx.clear();
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
    let out: Vec<ModuleKey> = tree
        .file_of
        .get(&ctx)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    eprintln!("RU-OUT segs={:?} ctx={:?} out={:?}", segs, ctx, out);
    out
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
    let scan = &scans[key];
    let mut targets = Vec::new();
    for u in &scan.uses {
        for segs in use_tree_of(&u.tokens).paths {
            for cand in expand_segments(tree, scan, path, u, segs) {
                for target in resolve_use(tree, path, &u.inline_stack, &cand) {
                    if &target != key {
                        eprintln!("DBG-TARGET key={:?} target={:?}", key, target);
                        targets.push(target);
                    }
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

/// issue #424 的泛型项与平台别名并集回归夹具。
#[cfg(test)]
mod issue_424_tests;
