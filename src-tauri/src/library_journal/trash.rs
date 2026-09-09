//! `assets/.trash/` 隔离区与身份绑定原语（issue #39 自 library_journal.rs
//! 拆出）：no-follow 打开/创建隔离目录、路径身份三态判别、隔离项身份复核
//! 与 no-replace 回迁——恢复分支与事务步骤共用的底层能力。

use cap_std::fs::Dir as CapDir;

use crate::store::open_dir_bound;

use super::journal_io::JournalEntry;

pub(super) const TRASH_DIR: &str = "assets/.trash";

/// 身份绑定删除原语（§7.2 步骤④）：当前受支持平台均未提供不经名字解析、
/// 直接绑定已打开 inode 的删除系统调用——Linux 的 `/proc/self/fd/<fd>` 是
/// procfs 符号链接，unlink 不解引用最终符号链接（EPERM），不得伪装修复。
/// 按契约统一报告能力缺失：保留隔离项与日志并记录 cleanupPending，索引
/// 不回滚；未来接入等价原语（如内核提供的 funlink）时在此收口。
pub(super) fn identity_bound_unlink(_file: &cap_std::fs::File) -> Result<(), String> {
    Err("平台缺少身份绑定删除原语".into())
}

/// 目录持久性屏障（Unix）。
#[cfg(unix)]
pub(super) fn fsync_dir(dir: &CapDir) -> Result<(), String> {
    dir.open_dir(".")
        .and_then(|d| d.into_std_file().sync_all())
        .map_err(|e| format!("同步目录失败（持久性屏障缺失）：{e}"))
}

#[cfg(not(unix))]
pub(super) fn fsync_dir(_dir: &CapDir) -> Result<(), String> {
    Ok(())
}

/// 相对锚定句柄读取路径身份：缺失/占用/异型分别处置（§7.2 恢复分支）。
#[cfg(unix)]
pub(super) enum PathIdentity {
    Missing,
    Regular(u64, u64),
    Other,
}

#[cfg(unix)]
pub(super) fn path_identity(parent: &CapDir, name: &str) -> Result<PathIdentity, String> {
    use cap_std::fs::MetadataExt;
    match parent.symlink_metadata(name) {
        Ok(md) if md.file_type().is_symlink() => Ok(PathIdentity::Other),
        Ok(md) if md.is_file() => Ok(PathIdentity::Regular(md.dev(), md.ino())),
        Ok(_) => Ok(PathIdentity::Other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathIdentity::Missing),
        Err(e) => Err(format!("读取路径元数据失败（{name}）：{e}")),
    }
}

/// no-follow 打开 .trash 隔离项并复核身份的三态判别（评审修复：缺失与
/// 身份不符必须区分——清理分支只允许在确认缺失时清除日志，身份不符/
/// 被占用保留现场与日志，不得丢失证据）。
#[cfg(unix)]
pub(super) enum TrashVerdict {
    IdentityOk(cap_std::fs::File),
    Missing,
    Mismatch,
}

#[cfg(unix)]
pub(super) fn verify_trash_identity(
    trash: &CapDir,
    entry: &JournalEntry,
) -> Result<TrashVerdict, String> {
    let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
    let md = match trash.symlink_metadata(file_name) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TrashVerdict::Missing),
        Err(e) => {
            return Err(format!("读取隔离项元数据失败（{}）：{e}", entry.trash_name));
        }
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return Ok(TrashVerdict::Mismatch);
    }
    use cap_std::fs::MetadataExt;
    if (md.dev(), md.ino()) != (entry.dev, entry.ino) {
        return Ok(TrashVerdict::Mismatch);
    }
    let f = trash
        .open(file_name)
        .map_err(|e| format!("打开隔离项失败（{}）：{e}", entry.trash_name))?;
    let fm = f
        .metadata()
        .map_err(|e| format!("读取隔离项句柄元数据失败：{e}"))?;
    if (fm.dev(), fm.ino()) != (entry.dev, entry.ino) {
        return Ok(TrashVerdict::Mismatch);
    }
    Ok(TrashVerdict::IdentityOk(f))
}

/// 打开 .trash 隔离区目录句柄（缺失返回 None；不在此创建——创建只发生在
/// 事务步骤①与恢复重隔离，且都在已验证资产根句柄下）。
pub(super) fn open_trash_dir(assets: &CapDir) -> Result<Option<CapDir>, String> {
    match assets.symlink_metadata(".trash") {
        Ok(md) if md.file_type().is_symlink() => Err("隔离目录是符号链接，拒绝操作".into()),
        Ok(md) if md.is_dir() => open_dir_bound(assets, ".trash", &md, "隔离目录").map(Some),
        Ok(_) => Err("隔离目录路径不是目录，拒绝操作".into()),
        // 仅 NotFound 视为缺失（评审修复：权限/瞬态 I/O 误当缺失会在未检查
        // 隔离项的情况下清除日志，丢失唯一清理记录）；其余错误中止恢复
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取隔离目录元数据失败：{e}")),
    }
}

/// 在已验证资产根句柄下确保 .trash 为真实目录并 fsync 资产根。
#[cfg(unix)]
pub(super) fn ensure_trash_dir(assets: &CapDir) -> Result<CapDir, String> {
    if let Err(e) = assets.create_dir(".trash") {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(format!("创建隔离目录失败：{e}"));
        }
    }
    let md = assets
        .symlink_metadata(".trash")
        .map_err(|e| format!("读取隔离目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err("隔离目录被占用为非目录，拒绝操作".into());
    }
    let dir = open_dir_bound(assets, ".trash", &md, "隔离目录")?;
    fsync_dir(assets)?;
    Ok(dir)
}

/// 隔离项回迁原位（§7.2：仅原名空缺时调用）：硬链接原子占位 + 隔离名
/// unlink 的 no-replace 语义——`link()` 在目标已存在时返回 EEXIST 不覆盖
/// 后来文件，窗口内被占用即失败并保留现场；成功则隔离名释放、双侧目录
/// fsync。cap-std 的 rename 在 Unix 为替换语义、不携带 no-replace 标志，
/// 故用硬链接对偶表达同一原子语义。
#[cfg(unix)]
pub(super) fn restore_from_trash(
    trash: &CapDir,
    entry: &JournalEntry,
    parent: &CapDir,
    last: &str,
) -> Result<(), String> {
    let file_name = entry.trash_name.rsplit('/').next().unwrap_or_default();
    // linkat 语义：目标存在即失败（no-replace），句柄相对解析——
    // 源为隔离名（.trash），目标为原路径（原名）
    trash
        .hard_link(file_name, parent, last)
        .map_err(|e| format!("回迁隔离项失败（{}）：{e}", entry.asset_id))?;
    // 耐久顺序（评审修复）：先让目标目录的硬链接持久化，再释放隔离名并
    // 持久化隔离目录——中断在中间不致于隔离名已删而目标未持久
    fsync_dir(parent)?;
    trash
        .remove_file(file_name)
        .map_err(|e| format!("释放隔离名失败（{}）：{e}", entry.asset_id))?;
    fsync_dir(trash)
}
