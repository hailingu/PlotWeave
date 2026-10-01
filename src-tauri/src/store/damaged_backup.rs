//! 损坏控制文件覆盖前的耐久备份内核（数据模型 §7.2，#137 图库索引先例、
//! #390 提取共用并接入 prefs 设置）：控制文件（`library.json`、
//! `settings.json` 等）被判定为损坏时，任何覆盖写之前先把原始字节按
//! SHA-256 摘要命名耐久备份到同目录——损坏原件可事后取证或修复，覆盖
//! 不再不可逆地消灭 `keyEnc` 密文等不可重建数据。
//!
//! 语义（两域共用同一实现，防漂移）：
//! - 读取：相对锚定句柄 no-follow 归类（符号链接/非普通文件在打开前拒绝），
//!   cap+1 流式限读（超限视为备份异常，不物化全文件）；仅条目缺失视为
//!   无原件可保护，不产生备份。
//! - 损坏判定：字节解析为 JSON **对象**即健康（不备份）；其余——含合法
//!   JSON 但非对象、非法 JSON、非法 UTF-8——一律按损坏备份，按**原字节**
//!   （不转文本、不规范化）留存。
//! - 命名：`{backup_prefix}{sha256 小写十六进制}.bak`——同一原件失败重试
//!   复用同一副本，不随重试累计；原件变化（不同摘要）保留独立备份。
//! - 复用校验：同名备份必须仍是普通文件、Unix 下按 (dev, ino) 与归类身份
//!   一致、字节与本次原件完整一致，随后重新同步文件与目录（Unix）才放行
//!   ——类型/内容不符或校验失败一律拒绝，既不覆盖证据也不忽略错误。
//! - 落盘：排他临时文件 + 写入 + fsync + rename 前复核目标未被占 +
//!   句柄相对 rename + 父目录 fsync（Unix），与 §10.2 原子写同型但目标
//!   **必须不存在**（绝不覆盖既有备份）。备份创建、读取或同步失败阻止
//!   本次覆盖并上抛可诊断错误（fail-closed）。
//!
//! 调用方持有的目录操作锁负责进程内与清扫串行（`library/` 由库操作锁
//! 覆盖，设置根由 `settings_write_guard` 覆盖）；跨进程并发写不在锁范围
//! （§10.2 单写者模型记录边界）。设置域的临时备份与最终备份在 Unix 从
//! 创建起为 0600；复用旧备份先绑定身份并核对字节，再通过句柄收权后同步。
//! 备份临时文件遵循 `.{备份名}.{id}.tmp`
//! 命名；是否清扫该目录的遗留临时文件由各目录既有清扫策略决定（应用
//! 数据根暂不清扫，见 docs/data-model/persistence.md §10.2 记录边界）。

use std::io::Read;

use cap_std::fs::Dir as CapDir;
use sha2::{Digest, Sha256};

use crate::store::error::StoreError;
use crate::store::file_permissions::FilePermissions;
use crate::store::persist::atomic_io;
use crate::store::types::new_id;

/// 备份规格：由各控制文件域声明自己的名字、上限与诊断实体名。
pub(crate) struct DamagedFileBackup {
    /// 域权限策略：新建临时副本与复用既有备份采用同一私有性要求。
    pub(crate) permissions: FilePermissions,
    /// 被覆盖保护的控制文件名（单段，不含路径分量）。
    pub(crate) file_name: &'static str,
    /// 备份名前缀，完整备份名为 `{前缀}{sha256 小写十六进制 64 字符}.bak`。
    pub(crate) backup_prefix: &'static str,
    /// 既有文件的受限读取上限（字节，cap+1 流式限读，超限按备份异常拒绝）。
    pub(crate) max_bytes: usize,
    /// 源文件诊断实体名（如「资产库索引」「设置文件」），组合读取期诊断。
    pub(crate) source_label: &'static str,
    /// 备份诊断实体名（如「索引」「设置文件」），组合复用与落盘期诊断。
    pub(crate) backup_label: &'static str,
}

/// 覆盖前的损坏备份入口：既有文件缺失或健康（JSON 对象）时不触盘直接
/// 放行；损坏时按字节摘要命名备份，已存在同摘装备份则校验后复用，否则
/// 耐久新建。任何备份异常上抛，由调用方阻止本次覆盖。
pub(crate) fn backup_damaged_file(
    dir: &CapDir,
    spec: &DamagedFileBackup,
) -> Result<(), StoreError> {
    let Some(bytes) = read_control_bytes_capped(dir, spec)? else {
        return Ok(());
    };
    if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| value.is_object()) {
        return Ok(());
    }
    let name = format!("{}{:x}.bak", spec.backup_prefix, Sha256::digest(&bytes));
    if reuse_durable_backup(dir, spec, &name, &bytes)? {
        return Ok(());
    }
    write_backup_durable_new(dir, spec, &name, &bytes)
}

/// 既有控制文件的原字节受限读取（备份专用）：no-follow 归类拒绝符号链接
/// 与非普通文件，cap+1 流式限读在物化前拒绝超限；仅 NotFound 视为缺失
/// （无原件可保护）。与各域读取入口的分类语义同款，但按字节返回以保留
/// 非法 UTF-8 原件。
fn read_control_bytes_capped(
    dir: &CapDir,
    spec: &DamagedFileBackup,
) -> Result<Option<Vec<u8>>, StoreError> {
    let md = match dir.symlink_metadata(spec.file_name) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(StoreError::io(
                format!("读取{}元数据失败", spec.source_label),
                e,
            ))
        }
    };
    if md.file_type().is_symlink() {
        return Err(StoreError::refused(format!(
            "{}是符号链接，拒绝读取",
            spec.source_label
        )));
    }
    if !md.is_file() {
        return Err(StoreError::refused(format!(
            "{}不是普通文件",
            spec.source_label
        )));
    }
    let file = dir
        .open(spec.file_name)
        .map_err(|e| StoreError::io(format!("打开{}失败", spec.source_label), e))?;
    let mut bytes = Vec::new();
    file.take((spec.max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::io(format!("读取{}失败", spec.source_label), e))?;
    if bytes.len() > spec.max_bytes {
        return Err(StoreError::refused(format!(
            "{}超过 {} MiB 上限，拒绝读取",
            spec.source_label,
            spec.max_bytes / (1024 * 1024)
        )));
    }
    Ok(Some(bytes))
}

/// 复用既有同摘装备份：摘要仅用于定位；复用前校验普通文件身份（Unix 按
/// (dev, ino) 与归类元数据比对）及完整字节，再同步文件和目录。同名备份
/// 被修改、类型不符或读取/同步失败时拒绝继续——既不覆盖证据也不忽略
/// 错误。返回 false 表示备份尚不存在，由调用方新建。
fn reuse_durable_backup(
    dir: &CapDir,
    spec: &DamagedFileBackup,
    name: &str,
    bytes: &[u8],
) -> Result<bool, StoreError> {
    let md = match dir.symlink_metadata(name) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(StoreError::io(
                format!("读取{}备份元数据失败", spec.backup_label),
                e,
            ))
        }
    };
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(StoreError::refused(format!(
            "{}备份不是普通文件，拒绝复用",
            spec.backup_label
        )));
    }
    if md.len() != bytes.len() as u64 {
        return Err(StoreError::refused(format!(
            "{}备份内容不符，保留原件待核对",
            spec.backup_label
        )));
    }
    let mut file = dir
        .open(name)
        .map_err(|e| StoreError::io(format!("打开{}备份失败", spec.backup_label), e))?;
    #[cfg(unix)]
    {
        let opened = file.metadata().map_err(|e| {
            StoreError::io(format!("读取{}备份句柄元数据失败", spec.backup_label), e)
        })?;
        if crate::store::asset_identity(&opened) != crate::store::asset_identity(&md) {
            return Err(StoreError::refused(format!(
                "{}备份在校验期间被替换",
                spec.backup_label
            )));
        }
    }
    let mut stored = Vec::new();
    (&mut file)
        .take((bytes.len() + 1) as u64)
        .read_to_end(&mut stored)
        .map_err(|e| StoreError::io(format!("读取{}备份失败", spec.backup_label), e))?;
    if stored != bytes {
        return Err(StoreError::refused(format!(
            "{}备份内容不符，保留原件待核对",
            spec.backup_label
        )));
    }
    tighten_backup_permissions(&file, spec)?;
    file.sync_all()
        .map_err(|e| StoreError::io(format!("同步{}备份失败", spec.backup_label), e))?;
    #[cfg(unix)]
    dir.open_dir(".")
        .and_then(|d| d.into_std_file().sync_all())
        .map_err(|e| StoreError::io(format!("同步{}备份目录失败", spec.backup_label), e))?;
    Ok(true)
}

/// 只在普通文件身份与完整字节已核对后，通过打开句柄收紧凭据备份权限。
/// 收权先于文件同步；失败经既有备份错误出口阻止原件覆盖。
fn tighten_backup_permissions(
    file: &cap_std::fs::File,
    spec: &DamagedFileBackup,
) -> Result<(), StoreError> {
    #[cfg(unix)]
    if spec.permissions == FilePermissions::OwnerOnly {
        use cap_std::fs::PermissionsExt;
        atomic_io!(
            SetPermissions,
            file.set_permissions(cap_std::fs::Permissions::from_mode(0o600))
        )
        .map_err(|e| StoreError::io(format!("收紧{}备份权限失败", spec.backup_label), e))?;
    }
    #[cfg(not(unix))]
    let _ = (file, spec);
    Ok(())
}

/// 新建耐久备份（目标必须不存在，绝不覆盖既有备份）：排他临时文件 +
/// fsync + rename 前复核 + 句柄相对 rename + 父目录 fsync（Unix）。
/// 失败尽力清理本次排他创建的临时文件。
fn write_backup_durable_new(
    dir: &CapDir,
    spec: &DamagedFileBackup,
    name: &str,
    bytes: &[u8],
) -> Result<(), StoreError> {
    match dir.symlink_metadata(name) {
        Ok(_) => {
            return Err(StoreError::refused(format!(
                "{}备份已存在：{name}",
                spec.backup_label
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(StoreError::io(
                format!("读取{}备份元数据失败", spec.backup_label),
                e,
            ))
        }
    }
    let tmp_name = format!(".{name}.{}.tmp", new_id());
    let result = write_backup_tmp_and_rename(dir, spec, &tmp_name, name, bytes);
    if result.is_err() {
        let _ = dir.remove_file(&tmp_name);
    }
    result
}

/// 备份落盘主体（排他临时文件 → 写入 + fsync → rename 前复核 → 句柄相对
/// rename → 父目录持久性屏障），系统 I/O 阶段与 store 原子写共用测试故障
/// 注入点。
fn write_backup_tmp_and_rename(
    dir: &CapDir,
    spec: &DamagedFileBackup,
    tmp_name: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), StoreError> {
    use std::io::Write;
    let mut dst = atomic_io!(
        Create,
        dir.open_with(tmp_name, &spec.permissions.new_file_options())
    )
    .map_err(|e| StoreError::io(format!("创建{}备份临时文件失败", spec.backup_label), e))?;
    atomic_io!(Write, dst.write_all(bytes))
        .map_err(|e| StoreError::io(format!("写入{}备份失败", spec.backup_label), e))?;
    atomic_io!(FileSync, dst.sync_all())
        .map_err(|e| StoreError::io(format!("同步{}备份失败", spec.backup_label), e))?;
    drop(dst);
    // rename 前复核目标未被占（复用校验与本创建之间的并发写者不得被覆盖）
    match dir.symlink_metadata(name) {
        Ok(_) => {
            return Err(StoreError::refused(format!(
                "{}备份已存在：{name}",
                spec.backup_label
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(StoreError::io(
                format!("读取{}备份元数据失败", spec.backup_label),
                e,
            ))
        }
    }
    atomic_io!(Rename, dir.rename(tmp_name, dir, name))
        .map_err(|e| StoreError::io(format!("落盘{}备份失败", spec.backup_label), e))?;
    #[cfg(unix)]
    atomic_io!(
        DirectorySync,
        dir.open_dir(".").and_then(|d| d.into_std_file().sync_all())
    )
    .map_err(|e| {
        StoreError::io(
            format!("同步{}备份目录失败（持久性屏障缺失）", spec.backup_label),
            e,
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests;
