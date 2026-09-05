//! 库删除隔离事务主体（docs/data-model.md §7.2 可恢复提交协议步骤①-④）：
//! 身份捕获与日志耐久记录 → 原子隔离 + 身份复核 → 原子提交去项索引 →
//! 身份绑定清理（能力不足保留隔离项）；冲突期条目的删除/导入拒绝。

use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};

use super::{
    ensure_trash_dir, fsync_dir, identity_bound_unlink, read_journal, recover,
    verify_trash_identity, write_journal, JournalEntry, Recovery, TrashVerdict, TRASH_DIR,
};
use crate::library_fs::{
    assets_root, ensure_index_size, open_parent_dir, read_index_capped, write_index,
};
use crate::store::{asset_stat, new_id};

/// 删除事务（§7.2 四步）：返回携带 warnings 与 cleanupPending 的响应负载。
pub(crate) fn delete_asset_transacted(library: &CapDir, id: &str) -> Result<Value, String> {
    #[cfg(not(unix))]
    {
        let _ = (library, id);
        return Err("平台缺少文件身份能力，删除暂不可用".into());
    }
    #[cfg(unix)]
    {
        delete_asset_transacted_unix(library, id)
    }
}

#[cfg(unix)]
fn delete_asset_transacted_unix(library: &CapDir, id: &str) -> Result<Value, String> {
    let mut recovery = recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    // 冲突期条目拒绝删除（评审修复）：重试会打开并隔离原 relPath 上的
    // 后来占用文件——标记只随日志事务解决而解除
    if recovery.conflicted.iter().any(|c| c == id) {
        return Err(format!(
            "资产 {id} 处于删除事务冲突期，拒绝删除：须先按日志恢复"
        ));
    }
    let (mut index, mut warnings) = read_index_capped(library)?;
    warnings.append(&mut recovery.warnings);
    let assets = assets_root(library)?;
    let assets_arr = index["assets"].as_array_mut().ok_or("资产索引结构损坏")?;
    let pos = assets_arr
        .iter()
        .position(|a| a.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    let rel = assets_arr[pos]
        .get("relPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    assets_arr.remove(pos);
    ensure_index_size(&index)?;
    if needs_no_quarantine(&assets, &index, &rel)? {
        write_index(library, &index)?;
        return Ok(json!({ "warnings": warnings, "cleanupPending": recovery.cleanup_pending }));
    }
    commit_quarantined_delete(library, &assets, id, &rel, index, warnings, recovery)
}

/// 无需隔离的情形：其他条目仍引用同一文件位置（同 relPath = 同一物理
/// 文件，只提交去项索引），或媒体/父目录已缺失（幂等收敛）。
fn needs_no_quarantine(assets: &CapDir, index: &Value, rel: &str) -> Result<bool, String> {
    let shared = index["assets"].as_array().is_some_and(|arr| {
        arr.iter()
            .any(|e| e.get("relPath").and_then(Value::as_str) == Some(rel))
    });
    if shared {
        return Ok(true);
    }
    let suffix = rel
        .strip_prefix("assets/")
        .ok_or_else(|| format!("relPath 越出 assets/：{rel}"))?;
    Ok(match open_parent_dir(assets, suffix)? {
        None => true,
        Some((parent, last)) => matches!(
            parent.symlink_metadata(&last),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound
        ),
    })
}

/// 步骤①：no-follow 打开待删普通文件、捕获平台稳定身份，返回
/// (已绑定父目录句柄, 终点名, 保持打开的文件句柄, (dev, ino))。
#[cfg(unix)]
fn capture_original(
    assets: &CapDir,
    rel: &str,
) -> Result<(CapDir, String, cap_std::fs::File, (u64, u64)), String> {
    use cap_std::fs::MetadataExt;
    let suffix = rel
        .strip_prefix("assets/")
        .ok_or_else(|| format!("relPath 越出 assets/：{rel}"))?;
    let (parent, last) =
        open_parent_dir(assets, suffix)?.ok_or_else(|| format!("资产父目录缺失：{rel}"))?;
    let md = asset_stat(&parent, &last, rel)?;
    if md.file_type().is_symlink() || !md.is_file() {
        return Err(format!("资产路径不是普通文件，拒绝删除：{rel}"));
    }
    let identity = (md.dev(), md.ino());
    let file = parent
        .open(&last)
        .map_err(|e| format!("打开待删资产失败（{rel}）：{e}"))?;
    let fm = file
        .metadata()
        .map_err(|e| format!("读取待删资产句柄元数据失败：{e}"))?;
    if (fm.dev(), fm.ino()) != identity {
        return Err(format!("待删文件在校验期间被替换：{rel}"));
    }
    Ok((parent, last, file, identity))
}

/// 隔离区同文件系统校验（跨设备原子 rename 不成立，须在写日志前失败）。
#[cfg(unix)]
fn check_same_fs(trash: &CapDir, identity: (u64, u64)) -> Result<(), String> {
    use cap_std::fs::MetadataExt;
    let tm = trash
        .dir_metadata()
        .map_err(|e| format!("读取隔离目录句柄元数据失败：{e}"))?;
    if tm.dev() != identity.0 {
        return Err("隔离区与媒体不在同一文件系统，无法原子隔离".into());
    }
    Ok(())
}

/// 步骤①日志耐久记录（先于任何移动）：追加事务并原子落盘 + 目录 fsync。
#[cfg(unix)]
fn record_delete_journal(
    library: &CapDir,
    id: &str,
    rel: &str,
    identity: (u64, u64),
    warnings: &mut Vec<String>,
) -> Result<(JournalEntry, Vec<JournalEntry>), String> {
    let txn = format!("t-{}", new_id());
    let entry = JournalEntry {
        id: txn.clone(),
        asset_id: id.to_string(),
        rel_path: rel.to_string(),
        dev: identity.0,
        ino: identity.1,
        trash_name: format!("{TRASH_DIR}/{txn}"),
    };
    let (mut entries, malformed) = read_journal(library, warnings);
    if malformed {
        return Err("删除日志异常，库写入/删除已暂停".into());
    }
    entries.push(entry.clone());
    write_journal(library, &entries)?;
    Ok((entry, entries))
}

/// 隔离事务主体：①身份捕获 + 日志耐久记录 ②原子隔离 + 身份复核
/// ③原子提交去项索引 ④身份绑定清理（能力不足保留隔离项）。
#[cfg(unix)]
fn commit_quarantined_delete(
    library: &CapDir,
    assets: &CapDir,
    id: &str,
    rel: &str,
    index: Value,
    mut warnings: Vec<String>,
    recovery: Recovery,
) -> Result<Value, String> {
    // ① 捕获身份并保持句柄/父目录句柄；隔离区确保存在且同文件系统
    // file 句柄按 §7.2 保持打开直至事务结束（下划线绑定仍存活到作用域末）
    let (parent, last, _file, identity) = capture_original(assets, rel)?;
    let trash = ensure_trash_dir(assets)?;
    check_same_fs(&trash, identity)?;
    let (entry, mut entries) = record_delete_journal(library, id, rel, identity, &mut warnings)?;
    // ② 原子隔离 + 双侧目录 fsync + 身份复核
    let txn = entry.id.clone();
    parent
        .rename(&last, &trash, &txn)
        .map_err(|e| format!("隔离媒体失败（{rel}）：{e}"))?;
    fsync_dir(&parent)?;
    fsync_dir(&trash)?;
    let verdict = verify_trash_identity(&trash, &entry)?;
    if !matches!(verdict, TrashVerdict::IdentityOk(_)) {
        // 身份未确认一律不得回迁（评审修复：Mismatch 回迁会把 .trash 中的
        // 替换文件装到活动资产路径上）；保留隔离项与日志，恢复流程收敛
        return Err(quarantine_conflict_error(&entry, &verdict));
    }
    // ③ 原子提交去项索引（保持已打开身份句柄直至本函数结束）
    write_index(library, &index)?;
    // ④ 身份绑定清理；能力不足/隔离项身份变化均保留隔离项与日志（评审
    // 修复：不得静默清除证据），索引不回滚。日志条目已在步骤①落盘——
    // 仅在清理成功时重写移除，失败分支保持原样即可。
    let mut cleanup_pending = recovery.cleanup_pending;
    match verify_trash_identity(&trash, &entry)? {
        TrashVerdict::IdentityOk(f) => {
            if identity_bound_unlink(&f).is_ok() {
                fsync_dir(&trash)?;
                entries.retain(|e| e.id != txn);
                write_journal(library, &entries)?;
            } else {
                cleanup_pending.push(format!("媒体已隔离待清理：{rel}"));
            }
        }
        TrashVerdict::Missing | TrashVerdict::Mismatch => {
            cleanup_pending.push(format!("隔离项身份异常，保留现场待恢复：{rel}"));
        }
    }
    Ok(json!({ "warnings": warnings, "cleanupPending": cleanup_pending }))
}

/// 步骤②身份复核失败的处置（评审修复）：隔离项与日志原样保留（恢复
/// 流程按原路径身份收敛——未开始事务清除、被占用标记冲突），仅在身份
/// 确认时才允许回迁，绝不把 .trash 中身份不符的替换文件装到活动路径。
#[cfg(unix)]
fn quarantine_conflict_error(entry: &JournalEntry, verdict: &TrashVerdict) -> String {
    match verdict {
        TrashVerdict::Missing => {
            format!("资产 {} 隔离项缺失，事务保留待恢复", entry.asset_id)
        }
        TrashVerdict::Mismatch => {
            format!(
                "资产 {} 隔离期身份不符：隔离项被替换，事务保留待恢复",
                entry.asset_id
            )
        }
        TrashVerdict::IdentityOk(_) => format!("资产 {} 隔离期身份冲突", entry.asset_id),
    }
}

/// 导入前的冲突期隔离检查（§7.2）：日志只读态与冲突 assetId 均拒绝服务。
pub(crate) fn ensure_importable(library: &CapDir, library_asset_id: &str) -> Result<(), String> {
    let recovery = recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    if recovery.conflicted.iter().any(|c| c == library_asset_id) {
        return Err(format!(
            "库资产 {library_asset_id} 处于删除事务冲突期，拒绝导入"
        ));
    }
    Ok(())
}
