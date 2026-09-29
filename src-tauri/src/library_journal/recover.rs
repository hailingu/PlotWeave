//! 删除事务的恢复内核（§7.2，issue #39 自 library_journal.rs 拆出）：恢复
//! 入口逐条消费日志，按「共享引用 → 索引仍引用 → 索引已去项」分支收敛——
//! 回迁/清理只动媒体与日志，不改 library.json 的权威索引状态。
//! 「索引已去项 + 隔离项身份核验一致 + 清理原语不可用」的终态条目在恢复
//! 时折叠退役并计入归档（issue #359）：隔离项与字节原样保留，日志条目
//! 退场，cleanupPending 折叠为单条摘要——恢复成本与响应大小不随历史
//! 删除总数线性增长；证据类条目与非权威视图期间不折叠（保守方向不变）。

use cap_std::fs::Dir as CapDir;
use serde_json::Value;

use crate::library::error::LibraryError;
use crate::library_fs::{assets_root, open_parent_dir};
use crate::store::new_id;

use super::archive::{read_archive, write_archive, ARCHIVE_COUNT_MAX};
use super::journal_io::{read_journal, write_journal, JournalEntry};
use super::trash::{
    ensure_trash_dir, fsync_dir, identity_bound_unlink, open_trash_dir, path_identity,
    restore_from_trash, verify_trash_identity, PathIdentity, TrashVerdict, TRASH_DIR,
};

/// cleanupPending 条目的机器可读分类（issue #229）：前端按 kind 决定
/// 呈现分区（routine 才可附 .trash 清理指引），不经中文文案前缀推导——
/// 展示措辞/本地化调整不改变分类。serde 序列化为小写蛇形字符串。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CleanupKind {
    /// 索引已提交、仅能力保留的待释放项——可给 .trash 目录级清理指引。
    Routine,
    /// 冲突/待核对的证据保留项（身份异常/不符/被占用、indexUncertain）——
    /// 绝不附删除指引。
    Evidence,
}

/// cleanupPending 条目（issue #229）：程序可判定的 kind + 展示文案；
/// 折叠摘要额外携带可选结构化 `count`（issue #359：该条目代表的累计
/// 保留数，前端待清理计数取各条目 count 之和、缺省按 1——不经文案推导，
/// 旧前端忽略该字段仍按单条展示）。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct CleanupPendingItem {
    pub(crate) kind: CleanupKind,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) count: Option<u64>,
}

impl CleanupPendingItem {
    pub(crate) fn routine(message: impl Into<String>) -> Self {
        Self {
            kind: CleanupKind::Routine,
            message: message.into(),
            count: None,
        }
    }
    /// 折叠摘要条目（issue #359）：kind 仍为 routine（可给清理指引），
    /// `count` 为该摘要代表的已核验保留项累计数。
    pub(crate) fn routine_counted(count: u64, message: impl Into<String>) -> Self {
        Self {
            kind: CleanupKind::Routine,
            message: message.into(),
            count: Some(count),
        }
    }
    pub(crate) fn evidence(message: impl Into<String>) -> Self {
        Self {
            kind: CleanupKind::Evidence,
            message: message.into(),
            count: None,
        }
    }
}

/// 恢复结果：warnings 为恢复过程产生的诊断；cleanup_pending 为保留在隔离
/// 区的未清理项；conflicted 为冲突期不可用的 assetId（列表标记 + 导入拒绝
/// 服务）；read_only 表示日志异型、所有库写入/删除暂停。
#[derive(Default, Debug)]
pub(crate) struct Recovery {
    pub warnings: Vec<String>,
    pub cleanup_pending: Vec<CleanupPendingItem>,
    pub conflicted: Vec<String>,
    pub read_only: bool,
}

/// 原 relPath 的已绑定父目录句柄与终点名（父目录缺失返回 None）。
fn original_parent(
    assets: &CapDir,
    rel_path: &str,
) -> Result<Option<(CapDir, String)>, LibraryError> {
    let suffix = rel_path
        .strip_prefix("assets/")
        .ok_or_else(|| LibraryError::invalid(format!("日志 relPath 越出 assets/：{rel_path}")))?;
    open_parent_dir(assets, suffix)
}

/// 日志条目在规范化索引中的引用态：索引是否仍含该 assetId、其他条目是否
/// 引用同一文件位置（同 relPath 即同一物理文件——库资产 relPath 一文一位）。
struct IndexRefs {
    index_has: bool,
    other_same_rel: bool,
}

fn index_refs(index: &Value, entry: &JournalEntry) -> IndexRefs {
    let mut refs = IndexRefs {
        index_has: false,
        other_same_rel: false,
    };
    if let Some(by_id) = index["assets"]["byId"].as_object() {
        for a in by_id.values() {
            let id = a.get("id").and_then(Value::as_str).unwrap_or_default();
            let rel = a.get("relPath").and_then(Value::as_str).unwrap_or_default();
            if id == entry.asset_id {
                refs.index_has = true;
            } else if rel == entry.rel_path {
                refs.other_same_rel = true;
            }
        }
    }
    refs
}

/// 单次恢复的日志收敛状态：`changed` 标记日志需要落盘的退役/闩锁复位，
/// `folded` 累计「身份核验一致但清理原语不可用」的折叠笔数（收尾时并入
/// 归档计数，issue #359）；`folded_ids` 为本趟已折叠、**延迟到收尾单次
/// 写盘**统一退役的条目（评审 5346509928：中途的重隔离预 rename 中间写
/// 不得把先前折叠的退役持久化——后续失败会让「条目已退役、计数未归档」
/// 跨条目复现；收尾写失败时这些条目仍在磁盘，下次恢复重新折叠）。
#[derive(Default)]
struct Convergence {
    changed: bool,
    folded: u64,
    folded_ids: Vec<String>,
}

/// 记录一笔折叠：条目保留在 `current` 中，退役延迟到收尾单次写盘。
fn record_fold(conv: &mut Convergence, entry: &JournalEntry) {
    conv.changed = true;
    conv.folded += 1;
    conv.folded_ids.push(entry.id.clone());
}

/// 身份绑定清理的三态结局（issue #359）：清理成功或隔离项缺失 → 日志条目
/// 退场；原语不可用但隔离项身份已核验 → 折叠退场（计入归档计数，不再
/// 逐条驻留日志/响应）；身份不符/被占用 → 保留现场与日志并记录证据项。
enum BoundCleanup {
    Retired,
    Folded,
    RetainedEvidence,
}

/// 隔离项按身份绑定能力清理，返回三态结局（见 [`BoundCleanup`]）。
fn try_bound_cleanup(
    trash: &CapDir,
    entry: &JournalEntry,
    recovery: &mut Recovery,
) -> Result<BoundCleanup, LibraryError> {
    match verify_trash_identity(trash, entry)? {
        TrashVerdict::IdentityOk(f) => match identity_bound_unlink(&f) {
            Ok(()) => {
                fsync_dir(trash)?;
                Ok(BoundCleanup::Retired)
            }
            // 唯一剩余步骤（§7.2 ④）无原语可执行且身份已核验：折叠退场
            Err(_) => Ok(BoundCleanup::Folded),
        },
        TrashVerdict::Missing => Ok(BoundCleanup::Retired), // 隔离项不存在：日志条目可清除
        TrashVerdict::Mismatch => {
            // 身份不符/被占用：保留现场与日志（评审修复：不得静默清除证据）
            recovery
                .cleanup_pending
                .push(CleanupPendingItem::evidence(format!(
                    "隔离项保留（身份不符或被占用）：{} / {}",
                    entry.asset_id, entry.trash_name
                )));
            Ok(BoundCleanup::RetainedEvidence)
        }
    }
}

/// 恢复入口（§7.2：启动及每次库列表/写入前调用）：重读规范化索引并逐条
/// 消费日志。日志当前状态以 `current` 持有，分支变更即时可落盘（重隔离的
/// 新映射在 rename 前耐久记录，评审修复）。只动日志与文件（回迁/清理），
/// 不改 library.json——索引的权威状态不受恢复影响。
pub(crate) fn recover(library: &CapDir) -> Result<Recovery, LibraryError> {
    // 锁由调用方在操作边界持有（library_op_lock）——recover 不再自持。
    // 先读索引（不落盘）+ 读日志，日志异型判定优先于索引迁移落盘（评审修复，
    // PR #33 第三轮）：journal 异型须进入只读告警态，不得先把 library.json
    // 迁移改写；迁移落盘推迟到日志确认非异型之后。迁移/归一化警告并入
    // recovery.warnings 随命令响应可见。
    let normalized = crate::library_fs::read_index_normalized(library)?;
    let index = normalized.index;
    let index_warnings = normalized.warnings;
    let migrated = normalized.migrated;
    let mut recovery = Recovery::default();
    let (mut entries, malformed) = read_journal(library, &mut recovery.warnings);
    if malformed {
        recovery.read_only = true;
        // 只读态诊断与实际行为一致（评审修复，PR #33 第十三轮）：journal 异型
        // 判定后即返回，只读归一化由 list/媒体/导入的只读分流各自执行——其
        // 诊断声称隔离（真实行为），本路径不再掺入上面可重发版本的「已重发」
        // 声明
        return Ok(recovery);
    }
    recovery.warnings.extend(index_warnings);
    if normalized.damaged {
        hold_uncertain_deletions(library, &index, &mut entries)?;
    }
    // 日志非异型：此刻才允许把索引迁移/修复原子落盘（重发 id 跨读稳定）
    if migrated {
        crate::library_fs::write_index(library, &index)?;
    }
    // 折叠计数为咨询性旁路（issue #359）：读取异型只告警并按 0 继续
    let mut archive_count = read_archive(library, &mut recovery.warnings);
    let mut conv = Convergence::default();
    if entries.is_empty() {
        finalize_cleanup_summary(library, conv.folded, &mut archive_count, &mut recovery);
        return Ok(recovery);
    }
    let assets = assets_root(library)?;
    let mut current = entries.clone();
    let view = IndexView {
        value: &index,
        authority: if normalized.damaged {
            Authority::Damaged
        } else if normalized.suspended {
            Authority::Suspended
        } else {
            Authority::Intact
        },
    };
    for entry in &entries {
        recover_entry(
            library,
            &assets,
            &view,
            entry,
            &mut recovery,
            &mut current,
            &mut conv,
        )?;
    }
    // 折叠退役只发生在收尾单次写盘（评审 5346397307/5346509928）：整趟
    // 期间折叠条目保留在 current——同趟后续条目的重隔离预 rename 中间写
    // 不得把先前折叠的退役持久化（那会让后续失败留下「条目已退役、计数
    // 未归档」的不可恢复窗口）；收尾写失败时全部折叠条目仍在磁盘，下次
    // 恢复重新折叠。退役先落日志、后落归档计数（issue #359）：崩溃窗口
    // 只会少计、不会重复计
    if conv.changed {
        current.retain(|e| !conv.folded_ids.contains(&e.id));
        write_journal(library, &current)?;
    }
    finalize_cleanup_summary(library, conv.folded, &mut archive_count, &mut recovery);
    Ok(recovery)
}

/// 折叠归档收尾（issue #359）：先持久化累计计数（fail-soft——日志退役已
/// 落盘，归档失败只告警、不回滚恢复结果）；计数 > 0 时复查隔离目录，
/// 整体不存在（用户已按指引清理 assets/.trash）即归零，仍 > 0 则折叠为
/// 单条 routine 摘要——cleanupPending 响应大小与历史删除总数无关。
/// 目录打开失败按「未知」处理并保留计数（fail-soft，计数为咨询性指标）。
fn finalize_cleanup_summary(
    library: &CapDir,
    folded: u64,
    count: &mut u64,
    recovery: &mut Recovery,
) {
    if folded > 0 {
        // 饱和累加并收敛进读取上限（评审 5346397307/5346909203）：读取侧
        // 已把脏计数截到合理上限、本笔折叠又受日志条数约束，正常不可达
        // 饱和点；防御性算术保证咨询性计数永不 panic（debug）或回绕隐藏
        // 保留项（release），且写入侧不得产出自己下次读取会判异型的值
        // ——上限处的合法折叠把计数钉在上限持续报告，而非归零失联
        *count = count.saturating_add(folded).min(ARCHIVE_COUNT_MAX);
        if let Err(e) = write_archive(library, *count) {
            recovery
                .warnings
                .push(format!("清理归档计数落盘失败（下次恢复按旧计数继续）：{e}"));
        }
    }
    if *count > 0 && trash_dir_absent(library) {
        *count = 0;
        if let Err(e) = write_archive(library, 0) {
            recovery
                .warnings
                .push(format!("清理归档计数归零落盘失败（下次恢复重试归零）：{e}"));
        }
    }
    if *count > 0 {
        recovery.cleanup_pending.push(CleanupPendingItem::routine_counted(
            *count,
            format!(
                "隔离区累计保留 {} 个已核验清理项（可人工清理 assets/.trash；整体移除后计数自动归零）",
                *count
            ),
        ));
    }
}

/// .trash 隔离目录是否整体不存在（计数归零判据）；任何错误按「未知」
/// 处理返回 false——归零漏判只延迟到用户完整清理后的下一次恢复。
fn trash_dir_absent(library: &CapDir) -> bool {
    let assets = match assets_root(library) {
        Ok(a) => a,
        Err(_) => return false,
    };
    matches!(open_trash_dir(&assets), Ok(None))
}

/// 本次恢复所依据的索引视图的权威性（issue #389）：
/// - [`Authority::Intact`]：可解析且迁移可落盘——按权威视图判定，
///   indexUncertain 条目复位闩锁并走正常收敛分支；
/// - [`Authority::Damaged`]：语法/编码损坏后的局部视图——保持冲突保守
///   并给修复指引；
/// - [`Authority::Suspended`]：可解析但迁移产物超限的只读局部视图
///   （PR #413 评审 4121700018）——写路径拒绝同一视图以防抹掉被隔离的
///   待重发条目，恢复判定同样不得以其为权威，保持冲突保守直至迁移可落盘。
#[derive(Clone, Copy, PartialEq, Eq)]
enum Authority {
    Intact,
    Damaged,
    Suspended,
}

struct IndexView<'a> {
    value: &'a Value,
    authority: Authority,
}

/// 在任何索引修复/媒体操作之前耐久标记无法判定的事务，防修复后误删媒体。
fn hold_uncertain_deletions(
    library: &CapDir,
    index: &Value,
    entries: &mut [JournalEntry],
) -> Result<(), LibraryError> {
    let mut changed = false;
    for entry in entries.iter_mut() {
        if index["assets"]["byId"].get(&entry.asset_id).is_none() && !entry.index_uncertain {
            entry.index_uncertain = true;
            changed = true;
        }
    }
    if changed {
        write_journal(library, entries)?;
    }
    Ok(())
}

/// 从当前日志状态移除事务条目（清理完成/未开始/回迁一致）。
fn retire_entry(current: &mut Vec<JournalEntry>, entry: &JournalEntry) {
    current.retain(|e| e.id != entry.id);
}

/// 单条日志恢复。分支次序对齐 §7.2：共享引用 → 索引仍引用 → 索引已去项。
/// `view.authority` 为 [`Authority::Intact`] 时当前索引是权威视图：indexUncertain
/// 条目复位闩锁并按当前索引走正常收敛分支（仍引用 → 回迁/未开始；已去项 →
/// 按已提交），资产不再因历史损坏永久 conflicted；损坏/迁移挂起期间保持
/// 冲突保守并按子态给出对应修复指引（issue #389）。
fn recover_entry(
    library: &CapDir,
    assets: &CapDir,
    view: &IndexView<'_>,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    conv: &mut Convergence,
) -> Result<(), LibraryError> {
    let re_adjudicated;
    let entry = if !entry.index_uncertain {
        entry
    } else if view.authority == Authority::Intact {
        re_adjudicated = release_uncertain_latch(current, entry, &mut conv.changed);
        &re_adjudicated
    } else {
        let why = match view.authority {
            Authority::Suspended => {
                "索引迁移挂起（迁移结果超大小上限，库写入已暂停），只读视图隔离了\
                 待重发条目、无法权威判定删除结果；须人工修整 library.json 条目使\
                 迁移结果可落盘，恢复后的图库操作将自动重新判定"
            }
            _ => {
                "索引曾损坏且尚未修复，删除结果无法确认；须先修复 library.json 为可解析 \
                 JSON（人工修整，或经任意图库写入自动替换为修复视图），修复后的图库操作\
                 将按当前索引自动重新判定"
            }
        };
        recovery
            .cleanup_pending
            .push(CleanupPendingItem::evidence(entry.trash_name.clone()));
        mark_conflict(entry, recovery, why);
        return Ok(());
    };
    let refs = index_refs(view.value, entry);
    let trash = open_trash_dir(assets)?;
    // 共享引用须以身份复核为准（评审修复）：relPath 字符串相等但占用者
    // 身份不符时，替换文件不得被当作共享引用方放行——继续走证据分支
    if refs.other_same_rel && original_binds_expected(assets, entry)? {
        return recover_shared_file(trash, entry, recovery, current, conv);
    }
    if refs.index_has {
        return recover_index_still_references(
            assets,
            entry,
            trash,
            recovery,
            current,
            &mut conv.changed,
        );
    }
    recover_index_committed(library, assets, entry, trash, recovery, current, conv)
}

/// 索引已恢复为可解析权威视图（issue #389）：复位 indexUncertain 闩锁并
/// 返回复位后的条目供分支使用（重隔离的新映射不得携带旧闩锁）。复位随
/// 本条目的分支变更一并落盘；中断后下次恢复按当前索引重新判定，不丢证据。
fn release_uncertain_latch(
    current: &mut [JournalEntry],
    entry: &JournalEntry,
    changed: &mut bool,
) -> JournalEntry {
    let mut released = entry.clone();
    released.index_uncertain = false;
    if let Some(e) = current.iter_mut().find(|e| e.id == entry.id) {
        e.index_uncertain = false;
    }
    *changed = true;
    released
}

/// 其他条目引用同一文件位置：不得移动/删除其当前目录项；隔离项存在时仅
/// 按身份绑定能力清理——清理成功/隔离项缺失清除日志，身份已核验但原语
/// 不可用则折叠退役（issue #359），身份不符保留证据；隔离项不存在清除日志。
fn recover_shared_file(
    trash: Option<CapDir>,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    conv: &mut Convergence,
) -> Result<(), LibraryError> {
    match trash {
        Some(trash) => {
            match try_bound_cleanup(&trash, entry, recovery)? {
                BoundCleanup::Retired => {
                    retire_entry(current, entry);
                    conv.changed = true;
                }
                BoundCleanup::Folded => record_fold(conv, entry),
                BoundCleanup::RetainedEvidence => {} // 证据条目保留在 current
            }
        }
        None => {
            retire_entry(current, entry);
            conv.changed = true;
        }
    }
    Ok(())
}

/// 标记冲突期不可用（§7.2）：日志条目保留在 current 并随列表返回警告。
fn mark_conflict(entry: &JournalEntry, recovery: &mut Recovery, why: &str) {
    recovery.conflicted.push(entry.asset_id.clone());
    recovery.warnings.push(format!(
        "资产 {} 删除事务冲突（{why}），标记为不可用",
        entry.asset_id
    ));
}

/// 原路径是否仍绑定事务预期身份（恢复分支共用判定）。
fn original_binds_expected(assets: &CapDir, entry: &JournalEntry) -> Result<bool, LibraryError> {
    Ok(match original_parent(assets, &entry.rel_path)? {
        Some((parent, last)) => matches!(
            path_identity(&parent, &last)?,
            PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
        ),
        None => false,
    })
}

/// 隔离项身份一致：原路径空缺则回迁（回到未开始态），被占用则冲突。
fn recover_restore_if_vacant(
    assets: &CapDir,
    entry: &JournalEntry,
    trash: &CapDir,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), LibraryError> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => {
            mark_conflict(entry, recovery, "原父目录缺失");
            return Ok(());
        }
    };
    match path_identity(&parent, &last)? {
        PathIdentity::Missing => {
            restore_from_trash(trash, entry, &parent, &last)?;
            retire_entry(current, entry);
            *changed = true; // 回到一致态：事务视为未开始
        }
        // 硬链接窗口恢复（评审修复）：hard_link 成功但 remove_file 失败或进程
        // 中断后，原名与隔离名同时绑定预期身份——原子移动失败残留。
        // 识别同一身份即清理隔离名并收敛，不标记冲突。
        PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino) => {
            let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
            // 耐久顺序（评审修复）：先让原名持久化，再释放隔离名——
            // 中断不致于隔离名已删而原名未持久
            fsync_dir(&parent)?;
            trash.remove_file(file_name).map_err(|e| {
                LibraryError::io(format!("清理硬链接残留失败（{}）", entry.asset_id), e)
            })?;
            fsync_dir(trash)?;
            retire_entry(current, entry);
            *changed = true;
        }
        _ => mark_conflict(entry, recovery, "原路径已被后来文件占用"),
    }
    Ok(())
}

/// 索引仍含 assetId：隔离项身份一致且原名空缺 → 回迁并清除日志；原名占用
/// 或身份不符/缺失 → 保留日志并标记冲突不可用；隔离项未生成且原路径仍绑
/// 定预期身份 → 清除未开始事务。
fn recover_index_still_references(
    assets: &CapDir,
    entry: &JournalEntry,
    trash: Option<CapDir>,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    changed: &mut bool,
) -> Result<(), LibraryError> {
    // 隔离项 Missing（目录缺失/条目缺失/rename 失败未生成）与无隔离目录
    // 同义：媒体仍绑定预期身份即未开始事务（评审修复：rename 失败残留的
    // 日志不得永久标记冲突）
    let verdict = match &trash {
        Some(trash) => verify_trash_identity(trash, entry)?,
        None => TrashVerdict::Missing,
    };
    match verdict {
        TrashVerdict::IdentityOk(_) => {
            let trash = trash.expect("IdentityOk 必有隔离目录");
            recover_restore_if_vacant(assets, entry, &trash, recovery, current, changed)
        }
        TrashVerdict::Missing => {
            if original_binds_expected(assets, entry)? {
                retire_entry(current, entry);
                *changed = true; // rename 失败的未开始事务：媒体原位且身份一致
            } else {
                mark_conflict(entry, recovery, "媒体缺失或身份不符");
            }
            Ok(())
        }
        TrashVerdict::Mismatch => {
            mark_conflict(entry, recovery, "隔离项身份不符");
            Ok(())
        }
    }
}

/// 索引已无 assetId：隔离项存在则仅尝试身份绑定清理——成功清除日志，
/// 身份已核验但原语不可用则折叠退役并计入归档（issue #359：不再逐条
/// 驻留日志，恢复成本与响应大小不随历史删除总数增长）；隔离项已不存在
/// 且原路径不再绑定预期身份 → 清理完成；原路径仍绑定预期身份 → 重新
/// 执行身份核验隔离，绝不按原名删除。
fn recover_index_committed(
    library: &CapDir,
    assets: &CapDir,
    entry: &JournalEntry,
    trash: Option<CapDir>,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    conv: &mut Convergence,
) -> Result<(), LibraryError> {
    let verdict = match &trash {
        Some(trash) => Some(verify_trash_identity(trash, entry)?),
        None => None,
    };
    match verdict {
        Some(TrashVerdict::IdentityOk(f)) => match identity_bound_unlink(&f) {
            Ok(()) => {
                fsync_dir(trash.as_ref().expect("trash"))?;
                retire_entry(current, entry);
                conv.changed = true;
            }
            Err(_) => {
                // 索引已提交且隔离项身份核验一致：唯一剩余步骤（④）无原语
                // 可执行——折叠退役（延迟到收尾单次写盘），证据（隔离项
                // 字节）原样保留
                record_fold(conv, entry);
            }
        },
        // 身份不符/被占用：保留现场与日志（不得静默清除证据）
        Some(TrashVerdict::Mismatch) => {
            recovery
                .cleanup_pending
                .push(CleanupPendingItem::evidence(format!(
                    "隔离项保留（身份不符或被占用）：{} / {}",
                    entry.asset_id, entry.trash_name
                )));
        }
        // 隔离项缺失（无隔离目录或该条目不存在）：复查原路径——仍绑定预期
        // 身份则重新隔离，否则清理完成（评审修复：此前 Missing 直接清日志，
        // 漏掉"媒体回到原位"的脏数据状态）
        Some(TrashVerdict::Missing) | None => {
            let original_bound = match original_parent(assets, &entry.rel_path)? {
                Some((parent, last)) => matches!(
                    path_identity(&parent, &last)?,
                    PathIdentity::Regular(d, i) if (d, i) == (entry.dev, entry.ino)
                ),
                None => false,
            };
            if original_bound {
                re_quarantine(library, assets, entry, recovery, current, conv)?;
            } else {
                retire_entry(current, entry);
            }
            conv.changed = true;
        }
    }
    Ok(())
}

/// 重新执行身份核验隔离（索引已去项但媒体仍在原位）：新映射先于 rename
/// 耐久记录进日志（评审修复：先改后记的窗口会让中断后的恢复按旧名收敛、
/// 永久孤儿化新隔离项），再 rename 并按能力清理。
#[cfg(unix)]
fn re_quarantine(
    library: &CapDir,
    assets: &CapDir,
    entry: &JournalEntry,
    recovery: &mut Recovery,
    current: &mut Vec<JournalEntry>,
    conv: &mut Convergence,
) -> Result<(), LibraryError> {
    let (parent, last) = match original_parent(assets, &entry.rel_path)? {
        Some(p) => p,
        None => {
            return Err(LibraryError::missing(format!(
                "重隔离失败：原父目录缺失（{}）",
                entry.rel_path
            )))
        }
    };
    let trash = ensure_trash_dir(assets)?;
    let txn = format!("t-{}", new_id());
    let mut updated = entry.clone();
    updated.trash_name = format!("{TRASH_DIR}/{txn}");
    retire_entry(current, entry);
    current.push(updated.clone());
    write_journal(library, current)?;
    parent
        .rename(&last, &trash, &txn)
        .map_err(|e| LibraryError::io(format!("重隔离失败（{}）", entry.asset_id), e))?;
    fsync_dir(&trash)?;
    fsync_dir(&parent)?;
    // 清理函数已按能力缺失或身份冲突报告唯一诊断；重隔离不再重复分类。
    // 折叠条目经 record_fold 延迟到收尾单次写盘统一退役（评审
    // 5346397307/5346509928）：此处立即落盘会让「退役已持久化、后续
    // 失败中断恢复」把该笔折叠的归档计数一并丢失；清理成功（Retired）
    // 的退役无计数义务，按既有收敛结果即时记入 current。
    let outcome = try_bound_cleanup(&trash, &updated, recovery)?;
    match outcome {
        BoundCleanup::Retired => {
            retire_entry(current, &updated);
            conv.changed = true;
        }
        BoundCleanup::Folded => record_fold(conv, &updated),
        BoundCleanup::RetainedEvidence => {}
    }
    Ok(())
}
