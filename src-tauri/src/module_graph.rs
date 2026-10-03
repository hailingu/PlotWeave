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
//!   混合变体的路径可有多个所有者文件）。Rust 2018 裸路径 `use x::…`
//!   的首段仅按当前模块的直接子模块解析，不按 crate 根下钻——rustc 把
//!   命中 extern-prelude 的裸首段判为外部 crate（`mod std;` 不捕获兄弟
//!   模块的 `use std::…`）、对不在作用域的模块名报 E0432，根模块回退会
//!   在「根模块名 == 外部 crate 名」时虚构内部边与假环（issue #470）；
//!   别名展开的中间产物以 `crate::` 前缀经 crate 臂从根下钻；再经可见
//!   别名链与链式 glob 前缀逐层递归展开（issue
//!   #469：≥3 级链与 glob 链此前静默丢边）、经可见 glob 引入（`use
//!   <前缀>::*` 把前缀模块的直接子模块名带入作用域；绑定仅在声明模块
//!   内可见，inline 子模块不继承父模块引入——评审 5379907393；且只带走
//!   **对使用处可见**的子模块名——私有/受限子模块不参与，评审
//!   5380401098；显式类型导入占据类型命名空间——目标为类型命名空间项
//!   （struct/enum/union/trait/type 别名）时同名 glob 子模块候选让位，
//!   不虚构边与假环，issue #480；值项与未知目标不遮蔽）；显式位置前缀
//!   之后的首段也在指定模块的模块级
//!   命名空间查别名/glob（评审 5381066396），均未命中才视为外部 crate 不入图
//!   （issue #426）；不经 `use` 的全限定调用不采集——与前端守卫只采
//!   import/export 边同口径。同文件 inline 引用解析回自身，不计自环边。
//! - 采集完整性（issue #469）：`build_graph` 建边前经审计层对每条展开
//!   路径分类——首段命中内部模块名（当前模块子模块，或 crate/self/super
//!   前缀的结构性命中；裸首段不按根模块判定，issue #470——与
//!   resolve_use 口径一致）却零目标所有者即 fail-closed；
//!   未命中者按外部 crate 分类计数（resolved/external，供真实仓库断言
//!   与诊断），防 #426 式「静默丢边 → 假无环」复发。
//! - fail-closed：`mod` 声明找不到对应文件（`NAME.rs` 与 `NAME/mod.rs`
//!   均缺失或并存）、`super::` 越过 crate 根、use 语句缺分号或花括号分组
//!   残缺，均直接判失败——构图不健全比漏检更危险（与前端
//!   `resolveEdgeKeys` 的失败语义一致）。
//! - 已知盲区（登记而非静默）：`macro_rules!` 体整块跳过（现存唯一生产
//!   宏 `atomic_io` 体内无 `use`）；非 ASCII 标识符会被分词层拆散（本仓无）；
//!   裸首段命中根模块名（非当前模块子模块）一律按外部 crate 处置——
//!   rustc 把命中 extern-prelude 的裸名字判为外部、对不在作用域的模块
//!   名报 E0432，守卫不建模根模块回退以免假环
//!   （issue #470；别名展开产物经 crate 臂保持根锚定，不受影响）；
//!   glob 只解析前缀模块的**直接**子模块——经 `pub use` 再导出进入 glob
//!   目标的名字不解析（本仓生产代码无文件级 glob 引入）；别名/glob
//!   解析链超过 8 层按不可解析处置（真实链长 2~3）；类型命名空间遮蔽
//!   只在绑定目标**直接**声明为类型项的一跳生效，不沿再导出别名链
//!   传播，外部 crate 目标不可分类——两者一律按不遮蔽保守放行 glob
//!   （issue #480 登记边界）；在 test=false 下不能证明恒真的 cfg 门控
//!   （含 cfg_attr 嵌套）使绑定与类型项声明按**条件存在**登记，不参与
//!   无条件遮蔽——门控不成立时同名 glob 模块是真实解析目标（评审 5391647570/
//!   5392007894）；门控继承由 inline 模块栈承载，模块级分号项消费
//!   自身挂起门控（fn 体等普通块内不清理，该过度近似方向保守）。
//!   not(test) 等生产恒真条件不禁用遮蔽；不求未知配置间的相关性，
//!   cfg_attr 仅施加恒真 cfg 或生产不施加时同样不禁用（评审 5393324118）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

mod aliases;
mod attrs;
mod audit;
mod closures;
mod cycles;
mod fields;
mod lexer;
mod tree;
mod type_items;
mod use_tree;
mod visibility;
use aliases::{expand_segments, AliasBinding, GlobBinding};
use attrs::parse_attr;
use closures::{skip_closure_headers, BodyStep};
use cycles::cycles_of;
use fields::{field_contexts, is_union_declaration, qualified_path_end, FieldContext};
use lexer::{strip_comments_and_literals, tokenize};
use tree::ModuleTree;
use use_tree::{strip_raw_ident, use_tree_of};

/// 图节点键 = 相对 src 根的 posix 路径（失败信息可读，与前端守卫口径一致）。
type ModuleKey = String;

/// 单文件扫描产物：非 cfg(test) mod 声明（含声明位置的 inline 栈，评审
/// 5349783070：`mod outer { mod child; }` 的 child 须挂在 outer 下、其
/// 文件在 outer 对应子目录）、use（栈快照 + 路径 token）与模块级类型
/// 命名空间项声明（issue #480，供显式类型导入的遮蔽判定）。
struct FileScan {
    mods: Vec<ModDecl>,
    uses: Vec<UseStmt>,
    renames: Vec<AliasBinding>,
    globs: Vec<GlobBinding>,
    type_items: Vec<type_items::TypeItemDecl>,
}

/// 一条 use 语句：inline 栈与花括号作用域快照（块开括号的 token 下标
/// 序列，词法包含 = 前缀关系）。
struct UseStmt {
    inline_stack: Vec<String>,
    tokens: Vec<String>,
    scope: Vec<usize>,
}

/// 一条 mod 声明：inline_path = 声明位置的外层 inline 模块栈（文件模块
/// 路径之后的段）；file_backed = 外部文件声明（`mod x;`），否则 inline
/// 块；vis = 声明处可见性（评审 5380401098：glob 引入只带走对使用处
/// 可见的子模块）。
struct ModDecl {
    inline_path: Vec<String>,
    name: String,
    file_backed: bool,
    vis: visibility::ModVis,
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
fn pop_inline(inline: &mut Vec<InlineModule>, depth: usize) {
    if inline.last().is_some_and(|m| m.depth == depth) {
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
    inline: &[InlineModule],
) -> Option<usize> {
    match inline.last().map(|m| m.depth) {
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
/// 比较误当泛型；直接元素由调用方初始化类型态、默认值语法和列表边界。
/// where 约束的同层逗号仍属于声明头；箭头的 > 不闭合泛型。
/// else 链与结尾分号一并消费。
fn skip_test_item(tokens: &[&str], k: usize, context: Option<&FieldContext>) -> usize {
    let type_header = context.is_some_and(|c| c.type_header);
    let mut closures = skip_closure_headers(tokens, k, type_header);
    let mut k = closures.next;
    let (mut type_header, mut initializer) = (closures.type_header, closures.initializer);
    let mut angles = 0usize;
    let mut type_default = context.is_some_and(|c| c.type_default);
    let mut where_clause = false;
    let labelled = tokens.get(k) == Some(&"\'");
    while k < tokens.len() {
        match tokens[k] {
            "type" if !initializer => {
                type_default = true;
                type_header = true;
            }
            "fn" | "struct" | "enum" | "trait" | "impl" if !initializer => {
                type_header = true;
            }
            "union" if !initializer && is_union_declaration(tokens, k) => type_header = true,
            "where" if type_header => where_clause = true,
            ":" if !initializer && !labelled => type_header = true,
            "=" if angles == 0 && !type_default => {
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
            "<" => {
                if let Some(end) = qualified_path_end(tokens, k) {
                    k = end;
                    continue;
                }
            }
            ">" if tokens.get(k.wrapping_sub(1)) != Some(&"-") => {
                angles = angles.saturating_sub(1);
            }
            "{" if angles > 0 => {
                k = skip_braced(tokens, k);
                continue;
            }
            "{" => match closures.step_after_body(tokens, k, type_header, initializer) {
                BodyStep::Continue(next, next_type, next_initializer) => {
                    (k, type_header, initializer) = (next, next_type, next_initializer);
                    continue;
                }
                BodyStep::End(next) => return next,
            },
            ";" if angles == 0 => return k + 1,
            "," if angles == 0 && !where_clause => return k + 1,
            // 自有块均整体跨过，此处 } 只能是外围块闭合：尾表达式在此结束
            "}" => return k,
            _ => {}
        }
        k += 1;
    }
    k
}

/// inline 模块栈条目：名字、进入深度与门控继承（评审 5392007894）——
/// gated 表示该模块在非 test cfg 门控下进入，体内引入按条件登记；
/// 继承编码在栈上，不随体内分号项的自身门控清理终结。
struct InlineModule {
    name: String,
    depth: usize,
    gated: bool,
}

/// 扫描单文件 token：产出非 cfg(test) 的 mod 声明与 use 路径；inline
/// 模块入栈供 `super::` 解析，花括号作用域快照供词法可见性判定（评审
/// 5352172371），门控项与宏体跳过，`#[path]` 模块 fail-closed 拒绝
///（评审 5352172371：清洗层不保留字面量内容，无法解析 path 值——
/// 响亮失败优于静默扫错位置）。
#[derive(Default)]
struct ScanState {
    mods: Vec<ModDecl>,
    uses: Vec<UseStmt>,
    renames: Vec<AliasBinding>,
    globs: Vec<GlobBinding>,
    type_items: Vec<type_items::TypeItemDecl>,
    inline: Vec<InlineModule>,
    scope: Vec<usize>,
    depth: usize,
    cfg_test: bool,
    pending_path: bool,
    /// 挂起的非 test cfg 门控（feature/平台，评审 5391647570）：条件存在
    /// 的项仍入图（并集保守），其引入按条件登记、不参与无条件类型遮蔽。
    cfg_cond: bool,
    /// 定界组（括号/方括号）深度：宏调用 token 树里的关键字是宏 DSL
    /// 文本，不是模块命名空间声明（评审 5391647570）。
    parens: usize,
}

impl ScanState {
    /// 当前 token 是否处于模块级（文件顶层或 inline 模块体顶层）：与 use
    /// 采集的 module_level 同判定——fn/trait/impl 体等普通块内声明的项不
    /// 进入模块命名空间，不参与类型遮蔽判定。
    fn at_module_level(&self) -> bool {
        self.depth == self.inline.last().map_or(0, |m| m.depth)
    }

    /// 当前位置是否存在生效的非 test cfg 门控：自身挂起（直接属性，含
    /// cfg_attr 嵌套）或任一外层 inline 模块按门控进入（继承）。条件
    /// 存在的引入与声明不参与无条件类型遮蔽（评审 5391647570/5392007894）。
    fn conditionally_gated(&self) -> bool {
        self.cfg_cond || self.inline.iter().any(|m| m.gated)
    }

    /// 模块级终结挂起的非 test cfg 门控：项自身或其闭合已消费门控，其后
    /// 的模块级引入回归无条件（评审 5391647570/5392007894）。外层门控
    /// inline 模块的**继承**由栈条目承载，不受本清理影响；非模块级
    ///（fn 体等普通块内）不清——外层项的门控对同块后续引入持续有效
    ///（该过度近似只把无条件引入高估为条件，方向保守：顶多少遮蔽、
    /// 多保留边，不漏检）。
    fn clear_conditional_at_module_level(&mut self) {
        if self.at_module_level() {
            self.cfg_cond = false;
        }
    }
}

fn scan_tokens(tokens: &[&str]) -> FileScan {
    let field_contexts = field_contexts(tokens);
    let mut st = ScanState::default();
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "#" => match scan_attribute(tokens, i, &mut st) {
                ScanStep::Advance(next) => i = next,
                ScanStep::SkipFile => return empty_scan(),
            },
            // 门控块交给下面的整项跳过入口，空块也在开花括号消费属性。
            "{" if !st.cfg_test => {
                st.scope.push(i);
                st.depth += 1;
                i += 1;
            }
            "}" => {
                pop_inline(&mut st.inline, st.depth);
                st.scope.pop();
                st.depth = st.depth.saturating_sub(1);
                st.clear_conditional_at_module_level();
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
                st.clear_conditional_at_module_level();
            }
            "macro_rules" if tokens.get(i + 1) == Some(&"!") => {
                // 跳过宏体（{、[、( 三种定界符）并消费挂起标志（评审
                // 5349783070：泄漏会漏采其后的生产声明）
                i = skip_macro_body(tokens, i + 2);
                st.cfg_test = false;
                st.pending_path = false;
                st.clear_conditional_at_module_level();
            }
            t if st.cfg_test && item_keyword(t) => {
                let context = field_contexts.get(&i);
                let end = context.map_or(tokens.len(), |c| c.close);
                i = skip_test_item(&tokens[..end], i, context);
                st.cfg_test = false;
                st.pending_path = false;
                st.clear_conditional_at_module_level();
            }
            // 模块级分号终结的项消费自身挂起门控——继承由 inline 模块栈
            // 承载，不受影响（评审 5392007894：条件 use 后的无条件类型
            // 导入不得被泄漏的门控误判为条件而保留假环方向的 glob 边）
            ";" if st.at_module_level() => {
                st.cfg_cond = false;
                i += 1;
            }
            // 定界组深度供类型项采集排除宏 token 树（评审 5391647570）；
            // 属性括号与被整块跳过的组不经过主循环，不干扰计数
            "(" | "[" => {
                st.parens += 1;
                i += 1;
            }
            ")" | "]" => {
                st.parens = st.parens.saturating_sub(1);
                i += 1;
            }
            // 模块级类型命名空间项声明（issue #480）：门控项已被上一臂
            // 整条跳过，这里只采集生产声明的名字供遮蔽判定
            "struct" | "enum" | "trait" | "type" | "union" => {
                i = type_items::scan_type_decl(tokens, i, &mut st);
            }
            _ => i += 1,
        }
    }
    FileScan {
        mods: st.mods,
        uses: st.uses,
        renames: st.renames,
        globs: st.globs,
        type_items: st.type_items,
    }
}

/// 空扫描产物：文件级 `#![cfg(test)]` 内属性把整文件按测试代码处置。
fn empty_scan() -> FileScan {
    FileScan {
        mods: Vec::new(),
        uses: Vec::new(),
        renames: Vec::new(),
        globs: Vec::new(),
        type_items: Vec::new(),
    }
}

/// 属性分派结论（scan_tokens 的 # 臂）：推进到消费后下标，或整个文件按
/// 测试代码处置（文件级 `#![cfg(test)]` 内属性）。
enum ScanStep {
    Advance(usize),
    SkipFile,
}

/// 属性分派（scan_tokens 的 # 臂）：内属性蕴含 test 时按位置门控——
/// 文件级返回 SkipFile（整文件测试代码；模块体顶层跳至模块闭合，块内
/// 只门控当前块，见 inner_test_gate）；否则合并挂起标志（cfg(test) 门控、
/// `#[path]`、非 test cfg 的条件存在）并推进到属性之后。
fn scan_attribute(tokens: &[&str], i: usize, st: &mut ScanState) -> ScanStep {
    let attr = parse_attr(tokens, i);
    if attr.is_inner && attr.is_test {
        return match inner_test_gate(tokens, attr.next, st.depth, &st.inline) {
            Some(resumed) => ScanStep::Advance(resumed),
            None => ScanStep::SkipFile,
        };
    }
    st.cfg_test |= attr.is_test;
    st.pending_path |= attr.has_path;
    st.cfg_cond |= attr.is_conditional;
    ScanStep::Advance(attr.next)
}

/// mod 声明分派（scan_tokens 的 mod 臂）：外部（`;`）或 inline（`{`）；
/// cfg(test) 门控时整体跳过。返回消费后的下标。
fn scan_mod_decl(tokens: &[&str], i: usize, st: &mut ScanState) -> usize {
    let name = strip_raw_ident(tokens.get(i + 1).copied().unwrap_or(""));
    let stack: Vec<String> = st.inline.iter().map(|m| m.name.clone()).collect();
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
                    vis: visibility::parse_mod_vis(tokens, i),
                });
            }
            // 文件承载声明（含其分号）消费自身挂起门控——非模块级时保留
            // 外层项的门控（评审 5392007894）
            st.clear_conditional_at_module_level();
            i + 3
        }
        Some(&"{") => {
            if st.cfg_test {
                st.clear_conditional_at_module_level();
                return skip_braced(tokens, i + 2);
            }
            if name.is_empty() {
                panic!("mod 声明缺少名字");
            }
            st.depth += 1;
            st.scope.push(i + 2);
            // 门控进入的 inline 模块：继承编码进栈条目，自身挂起清零——
            // 体内分号项清理不再终结继承（评审 5392007894）
            st.inline.push(InlineModule {
                name: name.to_string(),
                depth: st.depth,
                gated: st.cfg_cond,
            });
            st.cfg_cond = false;
            st.mods.push(ModDecl {
                inline_path: stack,
                name: name.to_string(),
                file_backed: false,
                vis: visibility::parse_mod_vis(tokens, i),
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
        let stack: Vec<String> = st.inline.iter().map(|m| m.name.clone()).collect();
        let scope = st.scope.clone();
        let unconditional = !st.conditionally_gated();
        let path = tokens[i + 1..j]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let parsed = use_tree_of(&path);
        let module_level = st.at_module_level();
        for (name, segs) in parsed.renames {
            st.renames.push(AliasBinding {
                name,
                segs,
                inline_stack: stack.clone(),
                scope: scope.clone(),
                module_level,
                unconditional,
            });
        }
        for segs in parsed.globs {
            st.globs.push(GlobBinding {
                segs,
                inline_stack: stack.clone(),
                scope: scope.clone(),
                module_level,
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
            // uniform paths（2018+）：裸首段仅按当前模块的直接子模块解析
            //（评审 5351210423、issue #426）。不按 crate 根下钻：rustc 把
            // 命中 extern-prelude 的裸首段判为外部 crate（`mod std;` 不捕获
            // 兄弟模块的 `use std::…`，issue #470 复现），对不在作用域的裸
            // 模块名报 E0432——根模块回退会把「根模块名 == 外部 crate 名」
            // 的外部引用误判为内部边、产出 rustc 不存在的假环（issue #470）。
            // 别名展开的中间产物以 `crate::` 前缀进入（aliases.rs 的
            // expand_segments），经 crate 臂从根下钻，评审 5353260028 的
            // 根锚定需求由该路径承接，不依赖本分支。
            let first = segs.first().map(String::as_str);
            let is_local_child =
                first.is_some_and(|f| tree.children.get(&ctx).is_some_and(|c| c.contains(f)));
            if !is_local_child {
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

/// 全图构建：模块树 + 采集完整性审计（issue #469，缺口 fail-closed）
/// + use 边（自环剔除、BTreeSet 去重排序），节点集 = 全部生产模块文件。
fn build_graph(files: &BTreeMap<ModuleKey, String>) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    let mut scans: BTreeMap<ModuleKey, FileScan> = BTreeMap::new();
    let tree = ModuleTree::build(files, &mut scans);
    // 采集完整性（issue #469）：首段命中内部模块名的 use 必须解析出目标
    // 所有者——静默丢边会让经该边闭合的真环对守卫隐形（#426 的成因）
    let audit = audit::audit_collection(&tree, &scans);
    if !audit.unresolved_internal.is_empty() {
        panic!(
            "use 采集完整性缺口（issue #469）：首段命中内部模块却零目标：{:?}",
            audit.unresolved_internal
        );
    }
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
            for cand in expand_segments(tree, scans, scan, path, u, segs) {
                for target in resolve_use(tree, path, &u.inline_stack, &cand) {
                    if &target != key {
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

/// issue #424 的同名非模块符号与模块别名展开回归夹具。
#[cfg(test)]
mod issue_424_alias_tests;

/// issue #424 的函数指针类型参数门控与扫描恢复回归夹具。
#[cfg(test)]
mod issue_424_function_pointer_tests;

/// 泛型参数默认类型排除及列表闭合恢复回归（issue #424）。
#[cfg(test)]
mod issue_424_generic_parameter_tests;

/// 门控闭包操作数连续扫描和独立生产边界回归（issue #424）。
#[cfg(test)]
mod issue_424_operand_tests;

/// 门控后缀表达式、限定路径与生产恢复边界回归（issue #424）。
#[cfg(test)]
mod issue_424_expression_tests;

/// return/break 块值续接门控回归（issue #446）。
#[cfg(test)]
mod issue_446_tests;

/// 门控闭包 as 转型续接回归（issue #447）。
#[cfg(test)]
mod issue_447_tests;

/// 裸路径子模块导入成边与真实图报环回归（issue #426）。
#[cfg(test)]
mod issue_426_tests;

/// 采集完整性：glob 引入与别名链成边、审计分类与真实仓库零缺口（issue #469）。
#[cfg(test)]
mod issue_469_tests;

/// 裸首段命中根模块名按外部处置、不虚构内部边与假环的回归（issue #470）。
#[cfg(test)]
mod issue_470_tests;

/// 显式类型导入遮蔽同名 glob 模块、不虚构边与假环的回归（issue #480）。
#[cfg(test)]
mod issue_480_tests;

/// 生产恒真 cfg 的类型遮蔽与未知配置真环回归（评审 5393324118）。
#[cfg(test)]
mod issue_480_cfg_tests;

/// 评审 5381066396 的位置限定别名与 glob 命名空间回归。
#[cfg(test)]
mod qualified_tests;

/// #504 共享测试夹具的声明所有权守卫。
#[cfg(test)]
mod fixture_ownership_tests;

/// #504 模块图回归的共享拓扑与语义断言。
#[cfg(test)]
mod dependency_fixture;
