//! module_graph 守卫的采集完整性审计层（issue #469；仅测试构建参与
//! 编译）：守卫以「src-tauri/src 模块图无环」为声明不变量，本层证明其
//! 采集完整性——对每条入图 use 路径分类：解析到 ≥1 目标所有者（含指向
//! 当前文件的自环所有者，自环边由建边层剔除）计 resolved；首段未命中
//! 任何内部模块名者按外部 crate 计数（external）；首段命中内部模块名
//!（当前模块子模块、根模块，或 crate/self/super 前缀的结构性命中）却
//! 零目标者记为缺口——build_graph 建边前对非空缺口 fail-closed，防
//! issue #426 式「静默丢边 → 假无环」复发。真实仓库断言见
//! issue_469_tests。

use std::collections::BTreeMap;

use super::aliases::expand_segments;
use super::resolve_use;
use super::tree::ModuleTree;
use super::use_tree::use_tree_of;
use super::{FileScan, ModuleKey};

/// 采集审计结论：resolved / external 为分类计数（按展开后的完整路径
/// 逐条计，供真实仓库断言与诊断输出）；unresolved_internal 非空即守卫
/// 不变量破坏，不计数、直接 fail-closed。
pub(super) struct UseAudit {
    pub(super) resolved: usize,
    pub(super) external: usize,
    pub(super) unresolved_internal: Vec<String>,
}

/// 单条 use 路径的采集结论（纯决策步，独立单测）。
pub(super) enum UseOutcome {
    /// 解析到 ≥1 目标所有者（含指向当前文件的自环所有者）。
    Resolved,
    /// 首段未命中内部模块名：外部 crate / 外部符号，不入图。
    External,
    /// 首段命中内部模块名却零目标：采集完整性缺口。
    InternalMiss,
}

/// 分类决策（issue #469 建议修复一）：命中内部模块名且零目标 →
/// InternalMiss；有目标 → Resolved；未命中且零目标 → External。
pub(super) fn outcome_of(first_hits_internal: bool, resolved: bool) -> UseOutcome {
    match (first_hits_internal, resolved) {
        (true, false) => UseOutcome::InternalMiss,
        (_, true) => UseOutcome::Resolved,
        (false, false) => UseOutcome::External,
    }
}

/// 全图采集审计：逐生产文件逐展开路径分类（build_graph 建边前调用，
/// unresolved_internal 非空即 fail-closed）。
pub(super) fn audit_collection(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
) -> UseAudit {
    let mut audit = UseAudit {
        resolved: 0,
        external: 0,
        unresolved_internal: Vec::new(),
    };
    for (path, key) in &tree.canonical {
        let scan = &scans[key];
        for u in &scan.uses {
            for segs in use_tree_of(&u.tokens).paths {
                classify_use_path(tree, scan, path, key, u, &segs, &mut audit);
            }
        }
    }
    audit
}

/// 单条展开路径分类（audit_collection 的内层）：任一展开候选解析出目标
/// 即 resolved；否则按首段是否命中内部模块名二分（issue #469）。
fn classify_use_path(
    tree: &ModuleTree,
    scan: &FileScan,
    path: &[String],
    key: &ModuleKey,
    u: &super::UseStmt,
    segs: &[String],
    audit: &mut UseAudit,
) {
    let mut resolved = false;
    for cand in expand_segments(tree, scan, path, u, segs.to_vec()) {
        if !resolve_use(tree, path, &u.inline_stack, &cand).is_empty() {
            resolved = true;
            break;
        }
    }
    let hits = first_segment_hits_internal(tree, path, &u.inline_stack, segs);
    match outcome_of(hits, resolved) {
        UseOutcome::Resolved => audit.resolved += 1,
        UseOutcome::External => audit.external += 1,
        UseOutcome::InternalMiss => audit
            .unresolved_internal
            .push(format!("{key}: use {}", segs.join("::"))),
    }
}

/// 首段是否命中内部模块名：crate/self/super 前缀结构性命中（其后必有
/// 模块所有者）；裸首段按当前位置子模块或根模块子模块判定——与
/// resolve_use 的裸路径口径一致（issue #426）。
fn first_segment_hits_internal(
    tree: &ModuleTree,
    path: &[String],
    inline: &[String],
    segs: &[String],
) -> bool {
    let Some(first) = segs.first().map(String::as_str) else {
        return false;
    };
    if matches!(first, "crate" | "self" | "super") {
        return true;
    }
    let mut ctx = path.to_vec();
    ctx.extend(inline.iter().cloned());
    tree.children.get(&ctx).is_some_and(|c| c.contains(first))
        || tree
            .children
            .get(&Vec::<String>::new())
            .is_some_and(|c| c.contains(first))
}
