//! 项目媒体解析/打开内核与会话新增资产登记（pwmedia 项目 scope，issue #31
//! 及其评审修复）：按项目文档 `assets.byId` 逐请求解析 assetId → relPath，
//! 经实路径复验句柄链打开。桌面端导入/生成落盘媒体后、项目文档按防抖节律
//! （useDebouncedSave 600ms）落盘前存在索引空窗——登记表让协议解析在该
//! 窗口内可见会话新条目，否则新缩略图/生成产物在节点重挂载前一直不可见。
//! 登记表为 Tauri 应用显式拥有的状态（`Builder::manage`），非进程级可变
//! 全局单例（评审修复，软件工程标准「mutable global singletons are
//! prohibited…」）。自 `assets.rs` 拆出以符合源文件 800 行上限。

use std::collections::HashMap;
use std::sync::Mutex;

use cap_std::fs::Dir as CapDir;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::store::{
    is_canonical_mime, is_valid_active_asset_rel_path, load_project_file, validate_id,
    verify_asset_real_path,
};

use super::ensure_project_control;

/// 项目资产 id 的持久化契约（与保存边界 `validate_save_assets` 同域，
/// 评审修复）：非空白不透明字符串——`bad]`/Unicode/超长 id 是合法持久化
/// 资产，此前经 project_asset_path 可显示，迁移后不得被库 id 白名单
/// 永久拒绝。协议侧 URL 分段与 hex 编码细节归 library/media.rs。
fn validate_project_asset_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err(format!("非法项目资产 id：{id}"));
    }
    Ok(())
}

/// 会话新增项目资产登记表（Tauri 应用显式拥有的状态，lib.rs 经
/// `Builder::manage` 注册；评审修复：可变全局单例由应用状态替代）：
/// - `entries`：key = (projectId, assetId)，value = (relPath, mime)。导入/
///   生成内核落盘媒体成功后登记；文档收录（权威命中）即 opportunistic
///   清除，项目删除后按「项目不存在」拒绝（登记项不复活已删项目的媒体）。
/// - `aliases`：加载归一化空白键重发的解析别名（评审修复 P2-3），
///   key = (projectId, 重发 id)，value = 盘上空白键。别名不携带 relPath/
///   mime——解析时盘上条目为内容权威，盘上条目消失（撤销删除/改名重存）
///   即按不存在拒绝，别名永不复活媒体。
///
/// 生命周期随应用实例：撤销等未落盘条目的残留没有请求方，不影响正确性；
/// 应用退出自然销毁。
pub(crate) struct PendingProjectAssets {
    entries: Mutex<HashMap<(String, String), (String, String)>>,
    aliases: Mutex<HashMap<(String, String), String>>,
}

impl PendingProjectAssets {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            aliases: Mutex::new(HashMap::new()),
        }
    }

    /// 登记会话新增项目资产（导入/生成内核落盘成功后调用）：value 为刚
    /// 落盘媒体的 relPath 与规范 mime，解析时仍按同域词法/mime 校验兜底。
    fn register(&self, project_id: &str, asset_id: &str, rel_path: String, mime: String) {
        self.entries.lock().expect("项目媒体登记表被污染").insert(
            (project_id.to_string(), asset_id.to_string()),
            (rel_path, mime),
        );
    }

    /// 登记加载归一化空白键重发别名（仅空白键映射，见
    /// [`register_reissued_asset_alias`]）。
    fn register_alias(&self, project_id: &str, blank_key: &str, fresh_id: &str) {
        self.aliases.lock().expect("项目媒体登记表被污染").insert(
            (project_id.to_string(), fresh_id.to_string()),
            blank_key.to_string(),
        );
    }

    /// 查询重发别名（不消费）：盘上条目缺失时别名同样不得复活媒体。
    fn alias_disk_key(&self, project_id: &str, fresh_id: &str) -> Option<String> {
        self.aliases
            .lock()
            .expect("项目媒体登记表被污染")
            .get(&(project_id.to_string(), fresh_id.to_string()))
            .cloned()
    }

    /// 取走登记项（仅文档权威命中时调用，清理已完成使命的条目）。
    fn take(&self, project_id: &str, asset_id: &str) -> Option<(String, String)> {
        self.entries
            .lock()
            .expect("项目媒体登记表被污染")
            .remove(&(project_id.to_string(), asset_id.to_string()))
    }

    /// 窥视登记项（不消费）：登记项在文档收录前须可重复解析——URL 早反馈
    /// （get_asset_media_url）与随后的协议媒体请求是两次独立解析，命中即
    /// 取走会让后者在文档落盘前 404。
    fn peek(&self, project_id: &str, asset_id: &str) -> Option<(String, String)> {
        self.entries
            .lock()
            .expect("项目媒体登记表被污染")
            .get(&(project_id.to_string(), asset_id.to_string()))
            .cloned()
    }

    /// 清空某项目的全部登记项与别名（项目控制文件缺失/异型时调用——已删
    /// 项目的登记项/别名不得让其媒体经回退路径复活）。
    fn drain_project(&self, project_id: &str) {
        self.entries
            .lock()
            .expect("项目媒体登记表被污染")
            .retain(|(pid, _), _| pid != project_id);
        self.aliases
            .lock()
            .expect("项目媒体登记表被污染")
            .retain(|(pid, _), _| pid != project_id);
    }
}

/// 登记会话新增项目资产（导入/生成内核落盘成功后调用）：value 为刚落盘
/// 媒体的 relPath 与规范 mime，解析时仍按同域词法/mime 校验兜底。
pub(crate) fn register_pending_project_asset(
    pending: &PendingProjectAssets,
    project_id: &str,
    asset_id: &str,
    rel_path: String,
    mime: String,
) {
    pending.register(project_id, asset_id, rel_path, mime);
}

/// 登记加载归一化的空白键重发别名（issue #31 评审修复 P2-3）：前端
/// `reKeyBlankEntries` 对盘上空白键资产重发新 id 后，修复回写按防抖节律
/// 才落盘——期间协议解析经别名命中盘上条目（别名不携带 relPath/mime，
/// 盘上条目为内容权威）。仅空白键（trim 后为空）可登记；非空白键重发
/// 不在契约内，调用方不得传入。
pub(crate) fn register_reissued_asset_alias(
    pending: &PendingProjectAssets,
    project_id: &str,
    blank_key: &str,
    fresh_id: &str,
) {
    debug_assert!(blank_key.trim().is_empty(), "别名仅限空白键重发");
    pending.register_alias(project_id, blank_key, fresh_id);
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
/// 根句柄与应用拥有的登记表）：读项目文档 `assets.byId` 按当前内容逐请求
/// 解析 assetId → (relPath, mime)。文档命中即权威并清除该 id 的会话登记
/// 项；文档未收录时回退防抖落盘窗口内的会话登记项（评审修复：否则导入/
/// 生成的新条目在文档落盘前不可见）；项目控制文件缺失（已删除）则拒绝
/// 且登记项不复活媒体。
pub(crate) fn resolve_project_media_entry(
    projects: &CapDir,
    project_id: &str,
    asset_id: &str,
    pending: &PendingProjectAssets,
) -> Result<(String, String), String> {
    validate_id(project_id)?;
    validate_project_asset_id(asset_id)?;
    if let Err(err) = ensure_project_control(projects, project_id) {
        pending.drain_project(project_id);
        return Err(err);
    }
    let doc = load_project_file(projects, project_id)?;
    if let Some(entry) = doc.assets.get("byId").and_then(|by_id| by_id.get(asset_id)) {
        let resolved = checked_media_fields(
            asset_id,
            entry.get("relPath").and_then(Value::as_str),
            entry.get("mime").and_then(Value::as_str),
        )?;
        pending.take(project_id, asset_id);
        return Ok(resolved);
    }
    // 防抖落盘窗口：条目尚未进入文档，窥视会话登记项（不消费——文档
    // 收录前须可重复解析）
    if let Some((rel, mime)) = pending.peek(project_id, asset_id) {
        return checked_media_fields(asset_id, Some(&rel), Some(&mime));
    }
    // 加载归一化空白键重发别名（评审修复 P2-3）：盘上条目以空白键存在
    // 时，别名把重发 id 解析到该条目——别名不携带 relPath/mime，盘上条目
    // 为内容权威；盘上条目缺失即按不存在拒绝（别名永不复活媒体）
    if let Some(disk_key) = pending.alias_disk_key(project_id, asset_id) {
        if let Some(entry) = doc
            .assets
            .get("byId")
            .and_then(|by_id| by_id.get(&disk_key))
        {
            return checked_media_fields(
                asset_id,
                entry.get("relPath").and_then(Value::as_str),
                entry.get("mime").and_then(Value::as_str),
            );
        }
    }
    Err(format!("资产不存在：{asset_id}"))
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
    pending: &PendingProjectAssets,
) -> Result<(String, cap_std::fs::File), String> {
    let (rel, mime) = resolve_project_media_entry(projects, project_id, asset_id, pending)?;
    let file = verify_asset_real_path(projects, project_id, &rel)?;
    Ok((mime, file))
}

/// 加载归一化空白键重发的别名登记命令（issue #31 评审修复 P2-3）：前端
/// 加载归一化对盘上空白键资产重发新 id 后调用——修复回写按防抖节律才
/// 落盘，期间协议解析经别名命中盘上条目（别名不携带 relPath/mime，盘上
/// 条目为内容权威）。仅空白键可登记；blankKey 非空白即拒绝。登记经
/// [`register_reissued_asset_alias`] 内核完成。
#[tauri::command]
pub fn register_project_asset_alias(
    app: AppHandle,
    id: String,
    blank_key: String,
    fresh_id: String,
) -> Result<(), String> {
    validate_id(&id)?;
    if !blank_key.trim().is_empty() {
        return Err("别名仅限空白键重发（非空白键不在契约内）".into());
    }
    validate_project_asset_id(&fresh_id)?;
    let pending = app.state::<PendingProjectAssets>();
    register_reissued_asset_alias(&pending, &id, &blank_key, &fresh_id);
    Ok(())
}

#[cfg(test)]
mod tests;
