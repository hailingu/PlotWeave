//! Host-owned rollback of unaccepted library copies into project quarantine (issue #864).
use cap_std::fs::{Dir, File};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::{ensure_child_dir, error::AssetsError, project_media::PendingProjectAssets};
use crate::library_fs::{atomic_write_with, open_library_asset};
use crate::store::{load_project_file, new_id, projects_dir, projects_op_lock, validate_id};

/// An opened inode and trusted parent grant authority; discard callers supply only logical IDs.
pub(crate) struct ImportReceipt {
    parent: Dir,
    name: String,
    rel_path: String,
    file: File,
    token: String,
}

/// Generated and ordinary pending assets never acquire library-import rollback authority.
pub(super) fn register(
    pending: &PendingProjectAssets,
    project: &str,
    asset: &str,
    directory: &Dir,
    parent: &Dir,
    name: &str,
) -> Result<(), AssetsError> {
    let rel_path = format!("assets/{name}");
    let receipt = ImportReceipt {
        parent: parent
            .try_clone()
            .map_err(|e| AssetsError::io("保留导入目录失败", e))?,
        name: name.into(),
        file: open_library_asset(directory, &rel_path)?,
        rel_path,
        token: format!("import-{}", new_id()),
    };
    crate::lock::recover_guard(pending.imports.lock(), "导入凭据")
        .insert((project.into(), asset.into()), receipt);
    Ok(())
}

/// A successful saved acceptance permanently retires rollback, including after subsequent undo saves.
pub(crate) fn retire(pending: &PendingProjectAssets, project: &str, assets: &Value) {
    let entries = assets.get("byId").and_then(Value::as_object);
    crate::lock::recover_guard(pending.imports.lock(), "导入凭据").retain(
        |(id, asset), receipt| {
            id != project
                || !entries.is_some_and(|rows| {
                    rows.contains_key(asset)
                        || rows.values().any(|row| {
                            row.get("relPath").and_then(Value::as_str) == Some(&receipt.rel_path)
                        })
                })
        },
    );
}

/// Dispatch shares the normal project mutation boundary and never accepts a client filesystem path.
#[tauri::command]
pub async fn discard_project_asset_import(
    app: AppHandle,
    id: String,
    asset_id: String,
) -> Result<(), String> {
    crate::blocking::run("discard_project_asset_import", move || {
        let projects = projects_dir(&app).map_err(crate::store::to_ipc_text)?;
        discard(&projects, &id, &asset_id, &app.state()).map_err(|e| e.to_string())
    })
    .await
}

/// Reject unknown or referenced imports; retain authority when quarantine fails so recovery can retry.
pub(super) fn discard(
    projects: &Dir,
    id: &str,
    asset: &str,
    pending: &PendingProjectAssets,
) -> Result<(), AssetsError> {
    let _operation = projects_op_lock();
    validate_id(id).map_err(AssetsError::invalid)?;
    let document = load_project_file(projects, id)?;
    let mut imports = crate::lock::recover_guard(pending.imports.lock(), "导入凭据");
    let key = (id.to_owned(), asset.to_owned());
    let receipt = imports
        .get(&key)
        .ok_or_else(|| AssetsError::refused("导入凭据不存在或已被项目接受"))?;
    if document
        .assets
        .get("byId")
        .and_then(Value::as_object)
        .is_some_and(|rows| {
            rows.contains_key(asset)
                || rows.values().any(|row| {
                    row.get("relPath").and_then(Value::as_str) == Some(&receipt.rel_path)
                })
        })
    {
        return Err(AssetsError::refused("项目仍引用导入媒体，拒绝隔离"));
    }
    quarantine(receipt, asset)?;
    imports.remove(&key);
    pending.take(id, asset);
    Ok(())
}

/// Retain exact bytes and a durable receipt instead of claiming unavailable inode-bound physical deletion.
#[cfg(unix)]
fn quarantine(receipt: &ImportReceipt, asset: &str) -> Result<(), AssetsError> {
    use crate::store::asset_identity;
    let identity = asset_identity(
        &receipt
            .file
            .metadata()
            .map_err(|e| AssetsError::io("读取导入身份失败", e))?,
    );
    let metadata = match receipt.parent.symlink_metadata(&receipt.name) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(AssetsError::io("读取导入副本失败", error)),
    };
    if metadata.as_ref().is_some_and(|metadata| {
        !metadata.is_file()
            || metadata.file_type().is_symlink()
            || asset_identity(metadata) != identity
    }) {
        return Err(AssetsError::refused("导入副本身份变化，保留现场"));
    }
    let trash = ensure_child_dir(&receipt.parent, ".trash", "项目导入隔离区")?;
    let slot = ensure_child_dir(&trash, &receipt.token, "项目导入隔离项")?;
    let record = json!({"assetId": asset, "relPath": receipt.rel_path, "dev": identity.0.to_string(), "ino": identity.1.to_string()});
    persist_receipt(&slot, &record)?;
    // A prior failure can leave either or both names; retry only the same captured inode.
    match slot.symlink_metadata("media") {
        Ok(held)
            if held.is_file()
                && !held.file_type().is_symlink()
                && asset_identity(&held) == identity => {}
        Ok(_) => return Err(AssetsError::refused("隔离目标身份不符，保留凭据")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && metadata.is_some() => {
            receipt
                .parent
                .hard_link(&receipt.name, &slot, "media")
                .map_err(|e| AssetsError::io("隔离导入副本失败", e))?;
        }
        Err(error) => return Err(AssetsError::io("导入副本及隔离状态不可确认", error)),
    }
    sync(&slot)?;
    if metadata.is_some() {
        receipt
            .parent
            .remove_file(&receipt.name)
            .map_err(|e| AssetsError::io("移除活动导入名失败", e))?;
    }
    sync(&receipt.parent)
}

/// Platforms without file identity refuse rather than infer deletion authority.
#[cfg(not(unix))]
fn quarantine(_receipt: &ImportReceipt, _asset: &str) -> Result<(), AssetsError> {
    Err(AssetsError::refused(
        "平台缺少文件身份原语，无法隔离导入副本",
    ))
}

/// Capability-relative directory barrier for ordered quarantine durability.
fn sync(directory: &Dir) -> Result<(), AssetsError> {
    directory
        .try_clone()
        .and_then(|dir| dir.into_std_file().sync_all())
        .map_err(|e| AssetsError::io("同步导入隔离目录失败", e))
}

/// Reuse only byte-independent matching JSON evidence; never overwrite a conflicting or malformed receipt.
fn persist_receipt(slot: &Dir, record: &Value) -> Result<(), AssetsError> {
    match slot.symlink_metadata("receipt.json") {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 4096 =>
        {
            let file = slot
                .open("receipt.json")
                .map_err(|e| AssetsError::io("读取隔离凭据失败", e))?;
            let prior: Value =
                serde_json::from_reader(file).map_err(|e| AssetsError::invalid(e.to_string()))?;
            if &prior != record {
                return Err(AssetsError::refused("隔离凭据冲突，保留现场"));
            }
            sync(slot)
        }
        Ok(_) => Err(AssetsError::refused("隔离凭据异型，保留现场")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            atomic_write_with(slot, "receipt.json", |file| {
                serde_json::to_writer(file, record).map_err(std::io::Error::other)
            })?;
            Ok(())
        }
        Err(error) => Err(AssetsError::io("读取隔离凭据元数据失败", error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_fixture::{cap, cleanup};
    use std::fs;

    /// A failure after durable journal creation must not make every subsequent retry fail on that journal.
    #[test]
    fn retry_reuses_the_matching_receipt_after_occupied_media_is_removed() {
        let (projects, root, pending, asset) = super::super::import_discard_tests::imported();
        let id = asset["id"].as_str().unwrap();
        let imports = crate::lock::recover_guard(pending.imports.lock(), "测试导入凭据");
        let receipt = imports.get(&("p-1".into(), id.into())).unwrap();
        let trash = ensure_child_dir(&receipt.parent, ".trash", "test trash").unwrap();
        let slot = ensure_child_dir(&trash, &receipt.token, "test slot").unwrap();
        slot.write("media", b"occupied").unwrap();
        let path = projects.join("p-1/assets/.trash").join(&receipt.token);
        drop(imports);
        assert!(discard(&cap(&projects), "p-1", id, &pending).is_err());
        assert!(path.join("receipt.json").exists());
        assert_eq!(fs::read(path.join("media")).unwrap(), b"occupied");
        fs::remove_file(path.join("media")).unwrap();
        discard(&cap(&projects), "p-1", id, &pending).unwrap();
        assert_eq!(fs::read(path.join("media")).unwrap(), b"copied bytes");
        cleanup(&root);
    }
}
