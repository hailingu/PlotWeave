//! module_graph 的目标采集审计（issue #494；仅测试构建参与编译）。
//! 独立有限见证从原始扫描元数据与模块树推导必需 owner，不调用建边解析器；
//! 实际采集仍走建边解析器，逐路径比较具体 owner，祖先回退不能替代必需目标。
//! 见证覆盖字面模块及直接模块别名/glob；复杂链与同名显式绑定的 glob 仍是
//! 能力边界，resolved/external 只是解析分类指示器，零缺口不证明全图采集完整。
//! 共享扫描器/模块树的盲区仍适用；真实仓库断言另有 alias/glob 语法 canary。

use std::collections::{BTreeMap, BTreeSet};

use super::aliases::expand_segments;
use super::audit_witness::expected_owners;
use super::resolve_use;
use super::tree::ModuleTree;
use super::use_tree::use_tree_of;
use super::{FileScan, ModuleKey};

/// 采集审计结论：分类计数不证明完整性；缺口列出独立见证要求而实际采集
/// 遗漏的文件 owner（包含自文件 owner），非空即由建图入口 fail-closed。
pub(super) struct UseAudit {
    pub(super) resolved: usize,
    pub(super) external: usize,
    pub(super) unresolved_internal: Vec<String>,
}

/// 单条 use 路径的采集结论（纯决策步，独立单测）。
pub(super) enum UseOutcome {
    /// 解析到 ≥1 目标所有者（含指向当前文件的自环所有者）。
    Resolved,
    /// 无见证且无目标：按外部/未建模路径分类，不作为完整性结论。
    External,
    /// 独立见证要求的目标未采集到。
    InternalMiss,
}

/// 分类计数的决策；具体 owner 缺失先由集合比较处理，不能仅以非空目标通过。
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
    audit_collection_with(tree, scans, |path, key, u, segs| {
        let scan = &scans[key];
        expand_segments(tree, scans, scan, path, u, segs.to_vec())
            .into_iter()
            .flat_map(|candidate| resolve_use(tree, path, &u.inline_stack, &candidate))
            .collect()
    })
}

/// 以受控目标采集策略审计真实扫描产物，用于复现解析器丢边而不替换扫描器。
pub(super) fn audit_collection_with(
    tree: &ModuleTree,
    scans: &BTreeMap<ModuleKey, FileScan>,
    collect: impl Fn(&[String], &ModuleKey, &super::UseStmt, &[String]) -> BTreeSet<ModuleKey>,
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
                let targets = collect(path, key, u, &segs);
                let expected = expected_owners(tree, scans, path, key, u, &segs);
                record_path(key, &segs, &expected, &targets, &mut audit);
            }
        }
    }
    audit
}

/// 记录逐路径 owner 差集；即使实际目标非空也必须包含所有独立见证。
fn record_path(
    key: &ModuleKey,
    segs: &[String],
    expected: &BTreeSet<ModuleKey>,
    targets: &BTreeSet<ModuleKey>,
    audit: &mut UseAudit,
) {
    let missing: Vec<_> = expected.difference(targets).collect();
    if !missing.is_empty() {
        audit.unresolved_internal.push(format!(
            "{key}: use {}: missing owners {missing:?}; collected {targets:?}",
            segs.join("::")
        ));
        return;
    }
    match outcome_of(!expected.is_empty(), !targets.is_empty()) {
        UseOutcome::Resolved => audit.resolved += 1,
        UseOutcome::External => audit.external += 1,
        UseOutcome::InternalMiss => unreachable!("非空见证在上方已比较全部 owner"),
    }
}
