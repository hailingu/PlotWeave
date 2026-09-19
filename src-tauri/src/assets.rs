//! 项目资产管线（数据模型 §7.1/§7.3/§9.3）：
//! - `import_project_asset_from_library`：库资产拖上画布 = 文件**拷贝**进项目
//!   `assets/` 并生成项目级 AssetRef（新 id）——源读取与目标写入全程相对
//!   受信锚定句柄 + no-follow（§10.2 信任链，与 store 内核同域）；
//! - `validate_project_asset`：前端 `set_asset` 调度前的强制预检（§9.3）——
//!   单条 AssetRef 形状校验 + 实路径复验，返回规范化后的条目；
//! - 项目媒体解析/打开内核与会话新增资产登记在 [`project_media`] 子模块：
//!   `pwmedia` 协议的项目 scope（issue #31）按项目文档 `assets.byId` 逐请求
//!   解析 assetId → relPath，经实路径复验句柄链打开——本机路径与 relPath
//!   不出 Rust。

use std::io::Write;

use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::assets::error::AssetsError;
use crate::isotime::{is_canonical_utc_timestamp, now_iso};
use crate::library_fs::{atomic_write_with, library_root, open_library_asset};
use crate::media_format::{ext_for, ext_for_mime};
use crate::store::{
    is_canonical_mime, is_valid_asset_rel_path, new_id, open_dir_bound, projects_dir, to_ipc_text,
    validate_id, verify_asset_real_path,
};

pub(crate) mod error;
pub(crate) mod project_media;

/// 新资产 id：`pa-{ms:x}-{seq:x}`（复用 store 的毫秒 + 进程内计数不碰撞内核）。
fn new_asset_id() -> String {
    let nid = new_id();
    format!("pa-{}", &nid[2..])
}

/// 读取库索引并定位条目（索引读取走 library_fs 共享内核：no-follow 归类 +
/// 大小上限 + 脏条目隔离，坏数据绝不进入拷贝流程）：返回 (relPath, 规范化
/// mime, 文件名组件)。条目缺失/条目形状非法均为显式错误。删除日志只读
/// 告警态用不落盘读取（评审修复，PR #33 第七轮：导入是读取路径照常服务，
/// 但不得把迁移结果写回 library.json）。恢复结果由冲突检查共享，不再重复恢复。
fn find_library_entry(
    library: &CapDir,
    library_asset_id: &str,
    recovery: &crate::library_journal::Recovery,
) -> Result<(String, String, String), AssetsError> {
    let read_only = recovery.read_only;
    // 恢复结果已报告给操作边界，随后经事件通知前端；本机日志继续保留明细
    for w in &recovery.warnings {
        eprintln!("[library] 项目导入伴随迁移/恢复诊断：{w}");
    }
    let (index, _) = if read_only {
        let (idx, w) = crate::library_fs::read_index_normalized_readonly(library)?;
        // 只读归一化诊断进日志（评审修复，PR #33 第十九轮）：导入响应无法
        // 携带 warnings，隔离/修复诊断丢弃会让脏数据不可见
        crate::library_fs::report_recovery_diagnostics("项目导入", &w);
        (idx, w)
    } else {
        // 挂起态读路径照常服务只读视图
        let (idx, _w, _suspended) = crate::library_fs::read_index_capped(library)?;
        (idx, _w)
    };
    let entry = index
        .get("assets")
        .and_then(|a| a.get("byId"))
        .and_then(Value::as_object)
        .and_then(|m| m.get(library_asset_id))
        .ok_or_else(|| AssetsError::missing(format!("库资产不存在：{library_asset_id}")))?;
    let rel_path = entry
        .get("relPath")
        .and_then(Value::as_str)
        .filter(|p| is_valid_asset_rel_path(p))
        .ok_or_else(|| {
            AssetsError::invalid(format!(
                "库资产 {library_asset_id} 的 relPath 非法，拒绝导入"
            ))
        })?;
    let mime_raw = entry.get("mime").and_then(Value::as_str).ok_or_else(|| {
        AssetsError::invalid(format!("库资产 {library_asset_id} 的 mime 缺失，拒绝导入"))
    })?;
    let mime = mime_raw.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(AssetsError::invalid(format!(
            "库资产 {library_asset_id} 的 mime 非法，拒绝导入"
        )));
    }
    let name = rel_path.rsplit('/').next().ok_or_else(|| {
        AssetsError::invalid(format!(
            "库资产 {library_asset_id} 的 relPath 非法，拒绝导入"
        ))
    })?;
    Ok((rel_path.to_string(), mime, name.to_string()))
}

/// 确保子目录存在并返回身份绑定的打开句柄：缺失即创建（排他语义由后续
/// 归类 + open_dir_bound 保证），现存必须是非符号链接的真实目录。
fn ensure_child_dir(parent: &CapDir, name: &str, label: &str) -> Result<CapDir, AssetsError> {
    // 总是尝试创建、容忍 AlreadyExists：先查再建留有竞态窗口——两个并发
    // 首次落盘同时观察到目录缺失时，其一的 create_dir 会撞上另一者刚建的
    // 目录；该作业的付费生成结果不应因此丢弃。归类校验照常兜底。
    if let Err(e) = parent.create_dir(name) {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(AssetsError::io(format!("创建{label}失败"), e));
        }
    }
    let md = parent
        .symlink_metadata(name)
        .map_err(|e| AssetsError::io(format!("读取{label}元数据失败"), e))?;
    if md.file_type().is_symlink() {
        return Err(AssetsError::refused(format!("{label}是符号链接，拒绝写入")));
    }
    if !md.is_dir() {
        return Err(AssetsError::refused(format!("{label}不是目录，拒绝写入")));
    }
    open_dir_bound(parent, name, &md, label).map_err(AssetsError::Store)
}

/// 流式拷贝进目标目录（原子落盘，与 store::atomic_write 同构）。
fn copy_into_dir(
    src: &mut cap_std::fs::File,
    dir: &CapDir,
    final_name: &str,
) -> Result<(), AssetsError> {
    let mut src = src;
    atomic_write_with(dir, final_name, |dst| {
        std::io::copy(&mut src, dst).map(|_| ())
    })
    .map_err(AssetsError::Library)
}

/// 项目控制文件存在性归类校验：不存在/符号链接/非普通文件均拒绝——
/// 不替不存在的项目建资产目录（导入与生成媒体落盘共用）。
fn ensure_project_control(projects: &CapDir, id: &str) -> Result<(), AssetsError> {
    validate_id(id).map_err(AssetsError::invalid)?;
    let control = format!("{id}.json");
    match projects.symlink_metadata(&control) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AssetsError::missing(format!("项目不存在：{id}")));
        }
        Err(e) => return Err(AssetsError::io("读取项目文件元数据失败", e)),
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err(AssetsError::refused("项目文件是符号链接，拒绝写入资产"));
            }
            if !md.is_file() {
                return Err(AssetsError::refused("项目文件不是普通文件，拒绝写入资产"));
            }
        }
    }
    Ok(())
}

/// 库资产 → 项目资产的导入内核（给定已验证的 projects 与 library 根句柄）：
/// 项目控制文件必须存在且通过归类校验（不替不存在的项目建资产目录）；
/// 库条目形状校验 → 源文件身份绑定打开 → 目标目录确保 → 原子拷贝落盘 →
/// 返回项目级 AssetRef（新 id、source=upload、规范 UTC createdAt）。控制
/// 校验与资产提交经 projects 操作锁与项目删除串行（PR #224 第二轮评审：
/// 删除持锁期间不得越过校验重建已删目录，锁序为 library→projects 单向，
/// 本锁在调用方可能持有的库锁之后取得）。
pub(crate) fn import_asset_from_library(
    projects: &CapDir,
    library: &CapDir,
    id: &str,
    library_asset_id: &str,
    pending: &project_media::PendingProjectAssets,
    report: &mut dyn FnMut(&crate::library_journal::Recovery),
) -> Result<Value, AssetsError> {
    let _op = crate::store::projects_op_lock();
    ensure_project_control(projects, id)?;
    // §7.2：冲突期条目不得为导入/收藏提供复制源
    let recovery = crate::library_journal::ensure_importable(library, library_asset_id, report)?;
    let (rel_path, mime, name) = find_library_entry(library, library_asset_id, &recovery)?;
    let mut src = open_library_asset(library, &rel_path)?;
    let project_dir = ensure_child_dir(projects, id, "项目资产根")?;
    let assets_dir = ensure_child_dir(&project_dir, "assets", "项目资产目录")?;
    let asset_id = new_asset_id();
    let final_name = format!("{asset_id}.{}", ext_for(&name, &mime));
    copy_into_dir(&mut src, &assets_dir, &final_name)?;
    // 防抖落盘窗口内协议解析可见（issue #31 评审修复）：文档尚未收录该
    // 条目前，pwmedia 项目 scope 经会话登记项解析
    project_media::register_pending_project_asset(
        pending,
        id,
        &asset_id,
        format!("assets/{final_name}"),
        mime.clone(),
    );
    Ok(json!({
        "id": asset_id,
        "relPath": format!("assets/{final_name}"),
        "mime": mime,
        "source": "upload",
        "createdAt": now_iso(),
    }))
}

/// 生成媒体落盘内核（docs/data-model.md §13 outputs 槽位的媒体侧）：
/// 字节经原子写入进项目 `assets/`，返回 `source=generated` 的项目级
/// AssetRef（新 id、规范 UTC createdAt）。项目控制文件必须存在且通过
/// 归类校验（不替不存在的项目建资产目录）。控制校验与资产提交经
/// projects 操作锁与项目删除串行（PR #224 第二轮评审，同导入内核）。
pub(crate) fn write_generated_asset(
    projects: &CapDir,
    id: &str,
    bytes: &[u8],
    mime: &str,
    pending: &project_media::PendingProjectAssets,
) -> Result<Value, AssetsError> {
    let _op = crate::store::projects_op_lock();
    ensure_project_control(projects, id)?;
    let project_dir = ensure_child_dir(projects, id, "项目资产根")?;
    let assets_dir = ensure_child_dir(&project_dir, "assets", "项目资产目录")?;
    let asset_id = new_asset_id();
    let final_name = format!("{asset_id}.{}", ext_for_mime(mime));
    atomic_write_with(&assets_dir, &final_name, |dst| dst.write_all(bytes))?;
    // 防抖落盘窗口内协议解析可见（issue #31 评审修复）
    project_media::register_pending_project_asset(
        pending,
        id,
        &asset_id,
        format!("assets/{final_name}"),
        mime.to_string(),
    );
    Ok(json!({
        "id": asset_id,
        "relPath": format!("assets/{final_name}"),
        "mime": mime,
        "source": "generated",
        "createdAt": now_iso(),
    }))
}

/// 单条 AssetRef 形状校验 + 规范化（§7.1，与前端 normalizeAssetRecords、
/// Rust 保存边界 validate_save_assets 同域）：relPath 词法（首段 assets、
/// 无空段/`.`/`..`）、mime 规范化（trim + 小写）后须为规范形、source 枚举、
/// createdAt 必须是规范 UTC（toISOString 形）。返回规范化条目。
fn validate_asset_ref(asset: &Value) -> Result<Value, String> {
    let id = asset
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("资产 id 缺失或为空")?;
    let rel_path = asset
        .get("relPath")
        .and_then(Value::as_str)
        .filter(|p| is_valid_asset_rel_path(p))
        .ok_or_else(|| format!("资产 {id} 的 relPath 缺失或越出资产子目录"))?;
    let mime_raw = asset
        .get("mime")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("资产 {id} 的 mime 缺失"))?;
    let mime = mime_raw.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(format!("资产 {id} 的 mime 非规范形式"));
    }
    let source = asset.get("source").and_then(Value::as_str);
    if source != Some("upload") && source != Some("generated") {
        return Err(format!("资产 {id} 的 source 非法"));
    }
    let created_at = asset
        .get("createdAt")
        .and_then(Value::as_str)
        .filter(|s| is_canonical_utc_timestamp(s))
        .ok_or_else(|| format!("资产 {id} 的 createdAt 不是规范 UTC 时间戳"))?;
    Ok(json!({
        "id": id,
        "relPath": rel_path,
        "mime": mime,
        "source": source.unwrap_or("upload"),
        "createdAt": created_at,
    }))
}

/// set_asset 预检内核（§9.3，给定已验证的 projects 根句柄）：形状规范化
/// 之后做实路径复验——形状合法但媒体文件缺失/符号链接/逃逸的条目同样拒绝。
pub(crate) fn validate_project_asset_with(
    root: &CapDir,
    id: &str,
    asset: &Value,
) -> Result<Value, AssetsError> {
    let normalized = validate_asset_ref(asset).map_err(AssetsError::invalid)?;
    let rel_path = normalized
        .get("relPath")
        .and_then(Value::as_str)
        .ok_or_else(|| AssetsError::invalid("资产 relPath 缺失"))?;
    let asset_id = normalized
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AssetsError::invalid("资产 id 缺失"))?;
    verify_asset_real_path(root, id, rel_path)
        .map_err(|e| AssetsError::Store(e).prefixed(format!("资产 {asset_id}")))?;
    Ok(normalized)
}

/// 库资产导入命令（§7.3 库资产进入项目 = 拷贝）：返回新 AssetRef 交前端
/// 并入会话资产索引与引用位绑定。
#[tauri::command]
pub async fn import_project_asset_from_library(
    app: AppHandle,
    id: String,
    library_asset_id: String,
) -> Result<Value, String> {
    crate::blocking::run("import_project_asset_from_library", move || {
        let projects = projects_dir(&app).map_err(to_ipc_text)?;
        let library = library_root(&app).map_err(|e| e.to_string())?;
        // 库操作互斥锁（issue #25 评审修复）：导入的恢复 + 读取 + 拷贝全链路
        // 与删除串行——import 在删除写入索引前恢复并把媒体移回原位，删除随后
        // 提交去项索引会把已恢复的媒体孤儿化
        let pending = app.state::<project_media::PendingProjectAssets>();
        crate::library::diagnostics::with_recovery_snapshot(
            &library,
            |library, report| {
                import_asset_from_library(
                    &projects,
                    library,
                    &id,
                    &library_asset_id,
                    &pending,
                    report,
                )
            },
            |snapshot| crate::library::diagnostics::publish_recovery(&app, snapshot),
        )
        .map_err(|e| e.to_string())
    })
    .await
}

/// set_asset 调度前的强制预检命令（§9.3）：形状 + 实路径复验，返回规范化
/// AssetRef（分发器必须使用返回值而非调用方原值）。
#[tauri::command]
pub async fn validate_project_asset(
    app: AppHandle,
    id: String,
    asset: Value,
) -> Result<Value, String> {
    crate::blocking::run("validate_project_asset", move || {
        validate_id(&id)?;
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        validate_project_asset_with(&root, &id, &asset).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests;
