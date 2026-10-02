//! module_graph 守卫的类型命名空间声明层（issue #480；仅测试构建参与
//! 编译）：扫描模块级 struct/enum/union/trait/type 别名声明，供别名
//! 解析层判定「显式类型导入已占据类型命名空间」。Rust 名字解析中，
//! 显式 use 引入的类型命名空间名字遮蔽同名 glob 引入的子模块——守卫
//! 若丢失该占位信息，会从 glob 补入通往子模块文件的虚假边、误报
//! rustc 不存在的环。值命名空间项（fn/const/static）与 enum 变体不
//! 登记：它们不占据类型命名空间，与同名模块合法共存，glob 模块候选
//! 必须保留（宁可误报环也不漏检）。宏调用 token 树（括号/方括号定界）
//! 内的关键字是宏 DSL 文本，不登记（评审 5391647570）。cfg 门控（含
//! cfg_attr 嵌套）的条件声明与门控 inline 模块体内的声明登记
//! unconditional = false：cfg 互斥的 struct/static 形态会让无条件再导出
//! 在部分配置指向值项（评审 5392007894），条件声明不构成无条件类型
//! 占位。外部 crate 的目标声明不可见，按不遮蔽保守处置（登记边界，
//! 见 module_graph.rs 模块文档）。

use std::collections::BTreeMap;

use super::tree::ModuleTree;
use super::use_tree::{is_path_seg, strip_raw_ident};
use super::{fields, FileScan, ModuleKey, ScanState};

/// 一条模块级类型命名空间项声明：名字、声明位置的 inline 模块栈
///（文件模块路径之后的段，与 mod/use 声明的定位口径一致）与条件性
///（评审 5392007894：cfg 互斥的 struct/static 可让无条件再导出在部分
/// 配置指向值项——条件声明不构成无条件类型占位）。
pub(super) struct TypeItemDecl {
    pub(super) name: String,
    pub(super) inline_stack: Vec<String>,
    pub(super) unconditional: bool,
}

/// 采集模块级类型命名空间项声明（scan_tokens 的 struct/enum/trait/
/// type/union 臂）：名字取关键字后的 token（可见性与属性在关键字之前，
/// 已由主循环消费），inline 栈定位声明模块，返回消费后的下标。union
/// 是上下文关键字，需经声明形态判定；非模块级、定界组内（宏 token
/// 树，评审 5391647570）或名字形态异常时仅推进不登记、不 fail-closed
/// ——本层服务于保守遮蔽判定，不是构图健全性的一部分。
pub(super) fn scan_type_decl(tokens: &[&str], i: usize, st: &mut ScanState) -> usize {
    let is_union = tokens[i] == "union";
    let name = tokens.get(i + 1).copied().unwrap_or("");
    if st.at_module_level()
        && st.parens == 0
        && (!is_union || fields::is_union_declaration(tokens, i))
        && is_path_seg(name)
    {
        st.type_items.push(TypeItemDecl {
            name: strip_raw_ident(name).to_string(),
            inline_stack: st.inline.iter().map(|m| m.name.clone()).collect(),
            unconditional: !st.conditionally_gated(),
        });
        return i + 2;
    }
    i + 1
}

/// 指定模块路径下是否声明了同名类型命名空间项（issue #480 的遮蔽判定
/// 查询）：模块的全部平台所有者文件都**无条件**声明为类型项才成立——
/// 并集口径下任一所有者的同名项是值项、缺失或条件声明（评审
/// 5392007894），都按不遮蔽保守处置，glob 候选保留。所有者文件对模块
/// 路径的 inline 前缀由规范登记的文件模块路径推得。
pub(super) fn declares_type_item(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    module: &[String],
    name: &str,
) -> bool {
    let Some(owners) = tree.file_of.get(module) else {
        return false;
    };
    !owners.is_empty()
        && owners.iter().all(|key| {
            tree.canonical.iter().any(|(path, owner)| {
                owner == key
                    && module.starts_with(path)
                    && scans[key].type_items.iter().any(|t| {
                        t.name == name && t.unconditional && t.inline_stack == module[path.len()..]
                    })
            })
        })
}
