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
//!   （`NAME.rs` 与 `NAME/mod.rs` 两种形态都支持）。仅测试构建参与的文件
//!   （`conf.rs`、`testhttp.rs`、`*_tests.rs`、`testutil.rs` 等）经此口径
//!   天然不进入图；二进制入口 `main.rs` 只调用 `plotweave_lib::run()`，
//!   无库内依赖，同样不在图内。`#[cfg(target_os)]` 等平台门控按并集计入
//!   （守卫覆盖目标平台全集，不只当前编译目标）。
//! - 边 = `use crate::…` / `use super::…` / `use self::…` 解析出的目标
//!   模块文件（花括号分组递归展开、`as` 重命名剥除、`*` 通配按前缀路径
//!   计、组内 `self` 指前缀模块自身；`pub use` 同采，函数体内的局部
//!   `use` 也是文件依赖）。外部 crate 与 2018+ 裸路径（`use serde…`）
//!   不参与；不经 `use` 的全限定调用不采集——与前端守卫只采
//!   import/export 边同口径。同文件 inline 模块内的引用解析回自身文件，
//!   不构成文件粒度的环，不计自环边。
//! - fail-closed：`mod` 声明找不到对应文件（`NAME.rs` 与 `NAME/mod.rs`
//!   均缺失或并存）、`super::` 越过 crate 根、use 语句缺分号或花括号分组
//!   残缺，均直接判失败——构图不健全比漏检更危险（与前端
//!   `resolveEdgeKeys` 的失败语义一致）。
//! - 已知盲区（登记而非静默）：`macro_rules!` 体整块跳过（现存唯一生产宏
//!   `store/persist.rs` 的 `atomic_io` 体内无 `use`）；非 ASCII 标识符
//!   会被分词层拆散（本仓无此形态）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

mod lexer;
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

/// 解析自 tokens[i] == "#" 起的属性（含 `#!` 形态），返回消费后下标与
/// 是否 cfg(test) 门控：cfg(…) 组**蕴含** test 才门控（裸 `test` 或
/// `all(test, …)` 等；`any(test, feature)` 不蕴含——其余条件成立时仍进入
/// 生产构建，按平台并集口径保守计入。评审 5347759049：此前只认深度 1
/// 的裸 test，`all(test, unix)` 被漏判、prefs/read_boundary_tests 误入图）。
/// 组内字符串已在清洗层抹除，不产生假 token。
fn parse_attr(tokens: &[&str], i: usize) -> (usize, bool) {
    let mut j = i + 1;
    if tokens.get(j) == Some(&"!") {
        j += 1;
    }
    if tokens.get(j) != Some(&"[") {
        return (j, false);
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
    (j, is_test)
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

/// cfg(…) 组是否蕴含 test（即绝不出现在生产构建）：裸 `test`；`all(…)`
/// 的某个合取项蕴含；`any(…)` 的全部析取项都蕴含。其他谓词（feature、
/// target_os、not(test) 等）不蕴含——判不蕴含时保守计入生产图，宁可
/// 多检（可能误报环）也不漏检（漏环比误报危险）。
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

/// 带属性项的开头判定（消费挂起 cfg(test) 并整条跳过）。
fn item_keyword(tok: &str) -> bool {
    // pub/unsafe/async 是修饰符而非项首——不消费，等真项关键字到来
    //（`#[cfg(test)] pub mod` 仍须被门控）；其余任何 token（含 let、
    // 表达式语句首）都视为带属性项的开头并整条跳过（评审 5349970852：
    // 只认固定清单会让 `#[cfg(test)] let …;` 的门控泄漏到其后的生产
    // use/mod，真环隐形）
    !matches!(tok, "pub" | "unsafe" | "async")
}

/// 跳过 cfg(test) 项/语句的完整剩余部分：签名或条件表达式推进到首个
/// "{"（跳过其块）或 ";"；块后若还有 else/else if 复合臂或结尾分号，
/// 一并消费（评审 5350168645：只跳首个块会把 else 臂当生产代码误采）。
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
                let (next, is_test) = parse_attr(tokens, i);
                cfg_test |= is_test;
                i = next;
            }
            "{" => {
                depth += 1;
                i += 1;
            }
            "}" => {
                if inline.last().is_some_and(|(_, d)| *d == depth) {
                    inline.pop();
                }
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
            "macro_rules" if tokens.get(i + 1) == Some(&"!") && tokens.get(i + 3) == Some(&"{") => {
                // 跳过宏体的同时消费挂起的 cfg(test)：宏之后的项是另一项，
                // 不得继承门控（评审 5349783070：泄漏会把后续生产 use/mod
                // 误判为测试代码而漏采，真环对守卫隐形）
                i = skip_braced(tokens, i + 3);
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
    parse_use_tree(&[], tokens, &mut i, &mut paths);
    paths
}

/// 模块树：模块路径段（crate 根为空）→ 文件键，与各模块的子模块名集。
struct ModuleTree {
    file_of: BTreeMap<Vec<String>, ModuleKey>,
    children: BTreeMap<Vec<String>, BTreeSet<String>>,
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
        };
        let root = ModuleKey::from("lib.rs");
        assert!(files.contains_key(&root), "src 根缺少 lib.rs");
        tree.file_of.insert(Vec::new(), root.clone());
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
                    tree.file_of.insert(mod_path, key.clone());
                    continue;
                }
                // 外部文件子模块的目录 = 声明文件子目录 + inline 栈各段
                //（与 rustc 的目录归属规则一致）
                let child_dir = sub_dir(&dir, &decl.inline_path);
                let child_key = child_file_key(files, &child_dir, &decl.name);
                let mut child_path = mod_path;
                child_path.push(decl.name.clone());
                if let Some(existing) = tree.file_of.get(&child_path) {
                    // 平台并集下互斥 cfg 的同名声明指向同一文件 → 合并
                    //（评审 5350168645：判重复会拒合法跨平台代码）；
                    // 首次声明已入队，不必重复
                    if existing != &child_key {
                        panic!("模块路径重复声明：{}", child_path.join("::"));
                    }
                    continue;
                }
                tree.file_of.insert(child_path.clone(), child_key.clone());
                queue.push((child_path, child_key));
            }
        }
        tree
    }
}

/// 解析单条 use 完整路径 → 目标文件键：`crate::` 重定到根、`super::` 逐个弹出
/// （越过根即失败）、`self::` 就地；未命中子模块的段视为 item 停在最近模块。
/// 外部 crate/裸路径返回 None。
fn resolve_use(
    tree: &ModuleTree,
    file_path: &[String],
    inline: &[String],
    segs: &[String],
) -> Option<ModuleKey> {
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
        _ => return None,
    }
    while let Some(seg) = segs.get(it) {
        let known = tree.children.get(&ctx).is_some_and(|c| c.contains(seg));
        if !known {
            break;
        }
        ctx.push(seg.clone());
        it += 1;
    }
    tree.file_of.get(&ctx).cloned()
}

/// 全图构建：模块树 + use 边（自环剔除、BTreeSet 去重排序），
/// 节点集 = 全部生产模块文件。
fn build_graph(files: &BTreeMap<ModuleKey, String>) -> BTreeMap<ModuleKey, BTreeSet<ModuleKey>> {
    let mut scans: BTreeMap<ModuleKey, FileScan> = BTreeMap::new();
    let tree = ModuleTree::build(files, &mut scans);
    let mut edges: BTreeMap<ModuleKey, BTreeSet<ModuleKey>> = BTreeMap::new();
    for key in tree.file_of.values() {
        edges.entry(key.clone()).or_default();
    }
    for (path, key) in &tree.file_of {
        for target in use_targets_of(&tree, &scans, path, key) {
            edges
                .get_mut(key)
                .expect("节点集在建边前已初始化")
                .insert(target);
        }
    }
    edges
}

/// 单文件的 use 边收集（build_graph 的内层）：展开花括号分组逐条解析
/// 目标模块文件，剔除自环（同文件 inline 模块引用不成环）。
fn use_targets_of(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    path: &[String],
    key: &ModuleKey,
) -> Vec<ModuleKey> {
    let mut targets = Vec::new();
    for (inline, use_toks) in &scans[key].uses {
        for segs in use_tree_paths(use_toks) {
            if let Some(target) = resolve_use(tree, path, inline, &segs) {
                if &target != key {
                    targets.push(target);
                }
            }
        }
    }
    targets
}

/// Tarjan 强连通分量（递归；图仅数十节点无栈风险）：仅产出非平凡 SCC。
/// Tarjan 状态机（strong_components 的载体，模块级定义——嵌套函数的
/// 复杂度会计入外层）。
struct Tarjan<'a> {
    edges: &'a BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
    index: BTreeMap<ModuleKey, usize>,
    low: BTreeMap<ModuleKey, usize>,
    on_stack: BTreeSet<ModuleKey>,
    stack: Vec<ModuleKey>,
    sccs: Vec<Vec<ModuleKey>>,
    counter: usize,
}

impl Tarjan<'_> {
    /// 标准 Tarjan 递归体：入栈 v、下钻未访问邻居、回填 low，根节点弹栈。
    fn strongconnect(&mut self, v: &ModuleKey) {
        self.index.insert(v.clone(), self.counter);
        self.low.insert(v.clone(), self.counter);
        self.counter += 1;
        self.stack.push(v.clone());
        self.on_stack.insert(v.clone());
        let neighbors: Vec<ModuleKey> = self.edges[v].iter().cloned().collect();
        for w in neighbors {
            if !self.index.contains_key(&w) {
                self.strongconnect(&w);
                let lifted = self.low[&w].min(self.low[v]);
                self.low.insert(v.clone(), lifted);
            } else if self.on_stack.contains(&w) {
                let lifted = self.index[&w].min(self.low[v]);
                self.low.insert(v.clone(), lifted);
            }
        }
        if self.low[v] == self.index[v] {
            let mut scc: Vec<ModuleKey> = Vec::new();
            while let Some(top) = self.stack.pop() {
                self.on_stack.remove(&top);
                scc.push(top.clone());
                if &top == v {
                    break;
                }
            }
            if scc.len() > 1 {
                self.sccs.push(scc);
            }
        }
    }
}

/// Tarjan 强连通分量（递归；图仅数十节点无栈风险）：仅产出非平凡 SCC。
fn strong_components(edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>) -> Vec<Vec<ModuleKey>> {
    let mut tarjan = Tarjan {
        edges,
        index: BTreeMap::new(),
        low: BTreeMap::new(),
        on_stack: BTreeSet::new(),
        stack: Vec::new(),
        sccs: Vec::new(),
        counter: 0,
    };
    let roots: Vec<ModuleKey> = edges.keys().cloned().collect();
    for root in roots {
        if !tarjan.index.contains_key(&root) {
            tarjan.strongconnect(&root);
        }
    }
    tarjan.sccs
}

/// 全图中的环：每个非平凡 SCC 给一条可读环路径（成员内 DFS 找回路）。
fn cycles_of(edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>) -> Vec<String> {
    let mut cycles = Vec::new();
    for scc in strong_components(edges) {
        let members: BTreeSet<ModuleKey> = scc.iter().cloned().collect();
        let start = scc[0].clone();
        cycles.push(cycle_path(&start, &members, edges).join(" → "));
    }
    cycles.sort();
    cycles
}

/// 在 SCC 成员内部自 start 找一条回到起点的具体路径。
fn cycle_path(
    start: &ModuleKey,
    members: &BTreeSet<ModuleKey>,
    edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
) -> Vec<ModuleKey> {
    let mut path = vec![start.clone()];
    let mut visited: BTreeSet<ModuleKey> = BTreeSet::from([start.clone()]);
    match dfs_cycle(start, start, members, edges, &mut path, &mut visited) {
        Some(closed) => closed,
        None => members.iter().cloned().collect(),
    }
}

/// cycle_path 的递归体：沿成员内边推进，回到 start 即闭合成环。
fn dfs_cycle(
    start: &ModuleKey,
    node: &ModuleKey,
    members: &BTreeSet<ModuleKey>,
    edges: &BTreeMap<ModuleKey, BTreeSet<ModuleKey>>,
    path: &mut Vec<ModuleKey>,
    visited: &mut BTreeSet<ModuleKey>,
) -> Option<Vec<ModuleKey>> {
    let neighbors: Vec<ModuleKey> = edges[node].iter().cloned().collect();
    for next in neighbors {
        if !members.contains(&next) {
            continue;
        }
        if &next == start {
            let mut closed = path.clone();
            closed.push(start.clone());
            return Some(closed);
        }
        if visited.contains(&next) {
            continue;
        }
        visited.insert(next.clone());
        path.push(next.clone());
        let found = dfs_cycle(start, &next, members, edges, path, visited);
        if found.is_some() {
            return found;
        }
        path.pop();
    }
    None
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
