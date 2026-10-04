//! module_graph 守卫的模块树构建层（issue #399；仅测试构建参与编译）：
//! 自 lib.rs 沿非 cfg(test) 的 mod 声明构建可达模块树（NAME.rs 与
//! NAME/mod.rs 双形态、inline 栈目录归属、平台并集多所有者）。

use std::collections::{BTreeMap, BTreeSet};

use super::scan_tokens;
use super::strip_comments_and_literals;
use super::tokenize;
use super::visibility;
use super::{FileScan, ModuleKey};

/// 模块树：模块路径段（crate 根为空）→ 文件键，与各模块的子模块名集。
pub(super) struct ModuleTree {
    /// 逻辑模块路径 → 文件所有者集（评审 5350339687：平台混合变体——
    /// `#[cfg(unix)] mod platform {…}` 与 `#[cfg(windows)] mod platform;`
    /// ——并集口径保留双方）。
    pub(super) file_of: BTreeMap<Vec<String>, BTreeSet<ModuleKey>>,
    pub(super) children: BTreeMap<Vec<String>, BTreeSet<String>>,
    /// (声明模块路径, 子模块名) → 可见子树根（评审 5380401098：glob 引入
    /// 只带走对使用处可见的子模块）；无条目或 None = pub/pub(crate) 的
    /// crate 内任意可见。平台并集下同名多声明保留更宽松的根，任一 pub
    /// 变体永久置 None（评审 5380788578）。
    pub(super) child_vis: BTreeMap<(Vec<String>, String), Option<Vec<String>>>,
    /// 规范迭代源：每个物理文件恰一次，配其规范包含路径——inline 别名
    /// 只用于解析目标（评审 5350339687：别名路径重扫会虚构错误边）。
    pub(super) canonical: BTreeSet<(Vec<String>, ModuleKey)>,
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

/// 登记子模块的可见子树根（评审 5380401098）：平台并集下同名多声明
/// 保留更短（更宽松）的根；pub/pub(crate) 变体永久置 None，与声明次序
/// 无关（评审 5380788578）。
fn register_child_vis(
    tree: &mut ModuleTree,
    mod_path: &[String],
    name: &str,
    vis: &visibility::ModVis,
) {
    let root = visibility::subtree_root(vis, mod_path);
    let key = (mod_path.to_vec(), name.to_string());
    let entry = tree.child_vis.entry(key).or_insert_with(|| root.clone());
    match (entry.as_ref(), root) {
        (Some(_), None) => *entry = None,
        (Some(cur), Some(new)) if new.len() < cur.len() => *entry = Some(new),
        _ => {}
    }
}

impl ModuleTree {
    /// 自 lib.rs 沿非 cfg(test) mod 声明构建可达模块树并缓存扫描产物。
    pub(super) fn build(
        files: &BTreeMap<ModuleKey, String>,
        scans: &mut BTreeMap<ModuleKey, FileScan>,
    ) -> ModuleTree {
        let mut tree = ModuleTree {
            file_of: BTreeMap::new(),
            children: BTreeMap::new(),
            child_vis: BTreeMap::new(),
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
                register_child_vis(&mut tree, &mod_path, &decl.name, &decl.vis);
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
