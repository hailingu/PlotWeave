//! 组写命令（§7.2 库写边界，issue #29 PR 2）：`upsert_library_group`/
//! `delete_library_group` 的内核与命令面——完整形状校验、改 kind 冲突复核、
//! 同次原子写删组并剥离成员 groupId。自 library.rs 拆出以符合源文件 800
//! 行上限（评审修复）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::library::library_root;
use crate::library_fs::{read_index_capped, validate_asset_id, write_index};
use crate::library_journal::{library_file_lock, library_op_lock};

/// 组写入内核（句柄域，§7.2 库写边界）：完整形状校验 → 归一化读取基线 →
/// 改 kind 冲突复核（成员资产 groupId 指向该组且 kind 不一致即拒绝）→
/// 原子写回；返回写入的组条目。
pub(crate) fn upsert_group_with(
    library: &cap_std::fs::Dir,
    group: &Value,
) -> Result<Value, String> {
    let normalized_group = crate::library_index::validate_group_for_write(group)?;
    let gid = normalized_group["id"]
        .as_str()
        .expect("校验后 id 必在")
        .to_string();
    let gkind = normalized_group["kind"].as_str().expect("校验后 kind 必在");
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    crate::library_fs::report_recovery_diagnostics("组写入", &recovery.warnings);
    let (mut index, mut warnings, migration_suspended) = read_index_capped(library)?;
    if migration_suspended {
        return Err(
            "资产索引迁移挂起（迁移结果超大小上限），写入已暂停：须人工修整 library.json 条目"
                .into(),
        );
    }
    warnings.extend(recovery.warnings);
    // 迁移落盘已发生而命令可能因业务失败早退（改 kind 冲突/组不存在）——
    // 归一化诊断兜底进日志，修复可见性不随 Err 丢失（评审修复，PR #36 第七轮）
    crate::library_fs::report_recovery_diagnostics("组写入", &warnings);
    // 改 kind 冲突复核（§7.2）：组已存在且新 kind 与任一成员资产不一致即拒绝
    if let Some(existing) = index["groups"]["byId"].get(&gid) {
        let old_kind = existing.get("kind").and_then(Value::as_str);
        if old_kind != Some(gkind) {
            let conflict = index["assets"]["byId"]
                .as_object()
                .map(|m| {
                    m.values().any(|a| {
                        a.get("groupId").and_then(Value::as_str) == Some(gid.as_str())
                            && a.get("kind").and_then(Value::as_str) != Some(gkind)
                    })
                })
                .unwrap_or(false);
            if conflict {
                return Err(format!(
                    "组 {gid} 改 kind 与成员资产冲突：存在 kind 不一致的成员，拒绝更新"
                ));
            }
        }
    }
    index["groups"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?
        .insert(gid.clone(), normalized_group.clone());
    write_index(library, &index)?;
    // 响应携带 cleanupPending（评审修复，PR #36 第二轮）：删除隔离区积压
    // （身份绑定清理不可用的常态）不得因 upsert 响应只附 warnings 而丢失——
    // 与 list/delete 同款上报路径
    let mut g = normalized_group.clone();
    if !warnings.is_empty() {
        g["warnings"] = json!(warnings);
    }
    g["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(g)
}

/// 组删除内核（句柄域，§7.2）：组存在 → 同次原子写删组并剥离成员资产的
/// groupId（不留悬空编组引用）；返回响应带净化诊断。
pub(crate) fn delete_group_with(library: &cap_std::fs::Dir, id: &str) -> Result<Value, String> {
    validate_asset_id(id)?;
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    crate::library_fs::report_recovery_diagnostics("组删除", &recovery.warnings);
    let (mut index, mut warnings, migration_suspended) = read_index_capped(library)?;
    if migration_suspended {
        return Err(
            "资产索引迁移挂起（迁移结果超大小上限），写入已暂停：须人工修整 library.json 条目"
                .into(),
        );
    }
    warnings.extend(recovery.warnings);
    // 迁移落盘已发生而删除可能因「组不存在」早退——归一化诊断兜底进日志
    // （评审修复，PR #36 第七轮）
    crate::library_fs::report_recovery_diagnostics("组删除", &warnings);
    let groups = index["groups"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?;
    if groups.remove(id).is_none() {
        return Err(format!("组不存在：{id}"));
    }
    // 同次原子写剥离成员 groupId（§7.2：不留悬空编组引用）
    if let Some(assets) = index["assets"]["byId"].as_object_mut() {
        for a in assets.values_mut() {
            if a.get("groupId").and_then(Value::as_str) == Some(id) {
                a.as_object_mut().unwrap().remove("groupId");
            }
        }
    }
    write_index(library, &index)?;
    let mut resp = json!({ "id": id });
    if !warnings.is_empty() {
        resp["warnings"] = json!(warnings);
    }
    resp["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(resp)
}

/// 组写入命令：新建/更新编组；改 kind 与成员冲突即拒绝。
#[tauri::command]
pub fn upsert_library_group(app: AppHandle, group: Value) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    upsert_group_with(&library, &group)
}

/// 组删除命令：原子删除组并剥离成员资产的 groupId。
#[tauri::command]
pub fn delete_library_group(app: AppHandle, id: String) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    delete_group_with(&library, &id)
}
