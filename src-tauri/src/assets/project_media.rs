//! 项目媒体解析/打开内核与会话新增资产登记（pwmedia 项目 scope，issue #31
//! 及其评审修复）：按项目文档 `assets.byId` 逐请求解析 assetId → relPath，
//! 经实路径复验句柄链打开。桌面端导入/生成落盘媒体后、项目文档按防抖节律
//! （useDebouncedSave 600ms）落盘前存在索引空窗——登记表让协议解析在该
//! 窗口内可见会话新条目，否则新缩略图/生成产物在节点重挂载前一直不可见。
//! 自 `assets.rs` 拆出以符合源文件 800 行上限。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use cap_std::fs::Dir as CapDir;
use serde_json::Value;

use crate::store::{
    is_canonical_mime, is_valid_active_asset_rel_path, load_project_file, validate_id,
    verify_asset_real_path,
};

use super::ensure_project_control;

/// 项目资产 id 的持久化契约（与保存边界 `validate_save_assets` 同域，
/// 评审修复）：非空白不透明字符串——`bad]`/Unicode/超长 id 是合法持久化
/// 资产，此前经 project_asset_path 可显示，迁移后不得被库 id 白名单
/// 永久拒绝。协议侧 URL 分段与编码细节归 library/media.rs。
fn validate_project_asset_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err(format!("非法项目资产 id：{id}"));
    }
    Ok(())
}

/// 会话新增项目资产登记表：key = (projectId, assetId)，value =
/// (relPath, mime)。导入/生成内核落盘媒体成功后登记；文档收录（权威命中）
/// 即 opportunistic 清除，项目删除后按「项目不存在」拒绝（登记项不复活
/// 已删项目的媒体）。生命周期为进程内：撤销等未落盘条目的残留没有请求方，
/// 不影响正确性；进程退出自然消失。
type PendingAssets = HashMap<(String, String), (String, String)>;

static PENDING_PROJECT_ASSETS: OnceLock<Mutex<PendingAssets>> = OnceLock::new();

fn pending_map() -> &'static Mutex<PendingAssets> {
    PENDING_PROJECT_ASSETS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记会话新增项目资产（导入/生成内核落盘成功后调用）：value 为刚落盘
/// 媒体的 relPath 与规范 mime，解析时仍按同域词法/mime 校验兜底。
pub(crate) fn register_pending_project_asset(
    project_id: &str,
    asset_id: &str,
    rel_path: String,
    mime: String,
) {
    pending_map().lock().expect("项目媒体登记表被污染").insert(
        (project_id.to_string(), asset_id.to_string()),
        (rel_path, mime),
    );
}

/// 取走登记项（仅文档权威命中时调用，清理已完成使命的条目）。
fn take_pending(project_id: &str, asset_id: &str) -> Option<(String, String)> {
    pending_map()
        .lock()
        .expect("项目媒体登记表被污染")
        .remove(&(project_id.to_string(), asset_id.to_string()))
}

/// 窥视登记项（不消费）：登记项在文档收录前须可重复解析——URL 早反馈
/// （get_asset_media_url）与随后的协议媒体请求是两次独立解析，命中即
/// 取走会让后者在文档落盘前 404。
fn peek_pending(project_id: &str, asset_id: &str) -> Option<(String, String)> {
    pending_map()
        .lock()
        .expect("项目媒体登记表被污染")
        .get(&(project_id.to_string(), asset_id.to_string()))
        .cloned()
}

/// 清空某项目的全部登记项（项目控制文件缺失/异型时调用——已删项目的
/// 登记项不得让其媒体经回退路径复活）。
fn drain_pending_project(project_id: &str) {
    pending_map()
        .lock()
        .expect("项目媒体登记表被污染")
        .retain(|(pid, _), _| pid != project_id);
}

/// 条目字段域校验（文档条目与会话登记项同域）：relPath 过活动索引词法
/// （排除 `.trash` 隔离区），mime 非规范时兜底 application/octet-stream
/// （与库解析内核同域）——脏数据在触达文件系统前即拒绝。
fn checked_media_fields(
    asset_id: &str,
    rel: Option<&str>,
    mime: Option<&str>,
) -> Result<(String, String), String> {
    let rel = rel.ok_or_else(|| format!("资产 {asset_id} 的 relPath 缺失"))?;
    if !is_valid_active_asset_rel_path(rel) {
        return Err(format!("资产 {asset_id} 的 relPath 非法：{rel}"));
    }
    let mime = mime
        .filter(|m| is_canonical_mime(m))
        .unwrap_or("application/octet-stream")
        .to_string();
    Ok((rel.to_string(), mime))
}

/// 项目媒体解析内核（pwmedia 项目 scope，issue #31；给定已验证的 projects
/// 根句柄）：读项目文档 `assets.byId` 按当前内容逐请求解析 assetId →
/// (relPath, mime)。文档命中即权威并清除该 id 的会话登记项；文档未收录时
/// 回退防抖落盘窗口内的会话登记项（评审修复：否则导入/生成的新条目在
/// 文档落盘前不可见）；项目控制文件缺失（已删除）则拒绝且登记项不复活
/// 媒体。
pub(crate) fn resolve_project_media_entry(
    projects: &CapDir,
    project_id: &str,
    asset_id: &str,
) -> Result<(String, String), String> {
    validate_id(project_id)?;
    validate_project_asset_id(asset_id)?;
    if let Err(err) = ensure_project_control(projects, project_id) {
        drain_pending_project(project_id);
        return Err(err);
    }
    let doc = load_project_file(projects, project_id)?;
    if let Some(entry) = doc.assets.get("byId").and_then(|by_id| by_id.get(asset_id)) {
        let resolved = checked_media_fields(
            asset_id,
            entry.get("relPath").and_then(Value::as_str),
            entry.get("mime").and_then(Value::as_str),
        )?;
        take_pending(project_id, asset_id);
        return Ok(resolved);
    }
    // 防抖落盘窗口：条目尚未进入文档，窥视会话登记项（不消费——文档
    // 收录前须可重复解析）
    match peek_pending(project_id, asset_id) {
        Some((rel, mime)) => checked_media_fields(asset_id, Some(&rel), Some(&mime)),
        None => Err(format!("资产不存在：{asset_id}")),
    }
}

/// 项目媒体句柄打开（pwmedia 项目 scope，issue #31）：[`resolve_project_media_entry`]
/// 解析后经 [`verify_asset_real_path`] 的受信句柄链定位——最终组件 no-follow
/// 拒绝符号链接、确认普通文件并按 (dev, ino) 身份绑定；打开的句柄交协议
/// 处理器在无锁状态下读取（§10.2 单写者 + 原子写语义，项目侧无删除日志，
/// 无需互斥锁）。
pub(crate) fn open_project_media_with(
    projects: &CapDir,
    project_id: &str,
    asset_id: &str,
) -> Result<(String, cap_std::fs::File), String> {
    let (rel, mime) = resolve_project_media_entry(projects, project_id, asset_id)?;
    let file = verify_asset_real_path(projects, project_id, &rel)?;
    Ok((mime, file))
}

#[cfg(test)]
mod tests;
