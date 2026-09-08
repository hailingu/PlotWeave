//! 个人资产库（docs/ui-design.md §8.1 / 数据模型 §7）：
//! 应用级 `library/` 目录跨项目复用——`library.json` 全量索引（内存过滤），
//! 媒体文件落 `library/assets/`，展示经 `pwmedia` 自定义协议按 id 懒加载
//! （§7.1 opaque asset URL，协议面在 [`media`] 子模块，issue #26/#31）。
//! 索引结构对前端自有（serde_json::Value 透传）。
//! 全部文件操作经 [`crate::library_fs`] 共享内核的受信锚定句柄执行（§7.1/§7.2
//! 信任链）：脏索引条目在读取时白名单隔离，删除经 `library/assets/` 专用根
//! 句柄逐组件 no-follow 定位——索引自身与库外路径不可达（issue #17）。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::library_fs::{
    assets_root, atomic_write_with, ensure_index_size, library_root, read_index_capped,
    validate_asset_id, write_index,
};
use crate::library_journal::{library_file_lock, library_op_lock};
use crate::store::is_canonical_mime;

/// 单文件上限 20 MiB：资产库放参考图/氛围图，防异常输入撑爆磁盘与 IPC。
pub(crate) const ASSET_MAX_BYTES: usize = 20 * 1024 * 1024;
const NAME_MAX_CHARS: usize = 128;
const TAGS_MAX: usize = 16;
/// 单个 tag 去空白后的字符上限（与 §7.2 归一化内核同域）。
const TAG_MAX_CHARS: usize = 64;

const KINDS: [&str; 6] = [
    "character",
    "location",
    "wardrobe",
    "colorlight",
    "reference",
    "other",
];
const VIEWS: [&str; 8] = [
    "front",
    "side",
    "back",
    "three_quarter",
    "top",
    "expression",
    "turnout",
    "other",
];

/// 列出全量索引（启动时一次载入，前端内存过滤，§8.1）：先按 §7.2 恢复
/// 删除日志中的未完成事务，脏索引条目由共享内核隔离，`warnings` 与
/// `cleanupPending` 随索引返回，冲突期条目标记 `conflicted` 不可用。
#[tauri::command]
pub fn list_library_assets(app: AppHandle) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    let (mut index, warnings) = list_assets_with(&library)?;
    index["warnings"] = json!(warnings);
    Ok(index)
}

/// 列表读取内核（句柄域，`list_library_assets` 与测试共用）：先恢复删除日志，
/// 再按只读态分流读取——日志异型（只读告警态）用不落盘读取，索引保持
/// 原始字节（评审修复，PR #33 第五轮：只读态下迁移落盘会改写索引）；迁移
/// 警告与冲突期标记随结果返回。
pub(crate) fn list_assets_with(library: &cap_std::fs::Dir) -> Result<(Value, Vec<String>), String> {
    let mut recovery = crate::library_journal::recover(library)?;
    let (mut index, mut warnings) = if recovery.read_only {
        let (idx, w) = crate::library_fs::read_index_normalized_readonly(library)?;
        (idx, w)
    } else {
        // 挂起态（迁移产物超限）读路径照常服务只读视图
        let (idx, w, _suspended) = read_index_capped(library)?;
        (idx, w)
    };
    warnings.append(&mut recovery.warnings);
    for id in &recovery.conflicted {
        if let Some(e) = index["assets"]["byId"].get_mut(id) {
            e["conflicted"] = json!(true);
        }
        warnings.push(format!("资产 {id} 处于删除事务冲突期，暂不可用"));
    }
    index["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok((index, warnings))
}

/// 导入资产内核（句柄域）：mime 信任边界（trim + 小写后必须规范形）、媒体
/// 经 `library/assets/` 专用根句柄原子落盘（新 id，库自包含），索引净化
/// 读取后追加并落盘，返回新条目。
pub(crate) fn put_asset_with(
    library: &cap_std::fs::Dir,
    name: &str,
    mime: &str,
    kind: &str,
    bytes: &[u8],
) -> Result<Value, String> {
    validate_name(name)?;
    validate_kind(kind)?;
    let mime = mime.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(format!("非法 mime：{mime}"));
    }
    if bytes.is_empty() {
        return Err("文件内容为空".into());
    }
    if bytes.len() > ASSET_MAX_BYTES {
        return Err("文件超过 20 MiB 上限".into());
    }
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    // 迁移落盘已发生而导入可能因业务失败早退——诊断兜底进日志（评审修复，
    // PR #33 第十二轮）
    crate::library_fs::report_recovery_diagnostics("导入", &recovery.warnings);
    let assets = assets_root(library)?;
    let (mut index, mut warnings, migration_suspended) = read_index_capped(library)?;
    if migration_suspended {
        return Err(
            "资产索引迁移挂起（迁移结果超大小上限），写入已暂停：须人工修整 library.json 条目"
                .into(),
        );
    }
    warnings.extend(recovery.warnings);
    let cleanup_pending = recovery.cleanup_pending;
    // id 用防碰撞生成器（毫秒+进程内计数+随机段，评审修复，PR #33 第十二/
    // 十七轮）：旧 la-{毫秒}-{大小} 方案同毫秒同大小即碰撞；进程内计数器跨
    // 进程不唯一（Windows 库锁为进程本地互斥），故生成后按当前 byId 查重
    // 重试——随机段提升跨进程区分度，查重闭合跨进程锁正确平台的碰撞窗口
    let id = {
        let taken = index["assets"]["byId"]
            .as_object()
            .ok_or("资产索引结构损坏")?
            .clone();
        unique_library_id(&taken)
    };
    let file_name = format!("{}.{}", id, ext_for(name, &mime));
    let mut entry = json!({
        "id": id,
        "name": name.trim(),
        "kind": kind,
        "mime": mime,
        "relPath": format!("assets/{file_name}"),
        "source": "upload",
        "createdAt": crate::isotime::now_iso(),
        "tags": [],
    });
    index["assets"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?
        .insert(id.clone(), entry.clone());
    // 媒体落盘前先校验候选索引大小（评审修复）：超限在物化前拒绝，
    // 不留下索引写不回去的孤儿媒体文件
    ensure_index_size(&index)?;
    atomic_write_with(&assets, &file_name, |dst| {
        std::io::Write::write_all(dst, bytes).map(|_| ())
    })?;
    write_index(library, &index)?;
    // 净化诊断随响应可见（评审修复）：脏索引变脏后直接导入时，被隔离
    // 条目/规范化修复不得随"落盘即净化"静默发生；仅在非空时附加，保持
    // 常态响应形状纯净
    if !warnings.is_empty() {
        entry["warnings"] = json!(warnings);
    }
    entry["cleanupPending"] = json!(cleanup_pending);
    Ok(entry)
}

/// 导入资产命令：媒体拷入 assets/（新 id，库自包含），索引追加并返回新条目。
#[tauri::command]
pub fn import_library_asset(
    app: AppHandle,
    name: String,
    mime: String,
    kind: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    put_asset_with(&library, &name, &mime, &kind, &bytes)
}

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("资产名不能为空".into());
    }
    if trimmed.chars().count() > NAME_MAX_CHARS {
        return Err("资产名过长".into());
    }
    Ok(())
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("未知资产分类：{kind}"))
    }
}

fn normalize_tags(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .take(TAGS_MAX)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 库资产 id（评审修复，PR #33 第十七轮）：生成器产出与当前 byId 冲突时
/// 重试——进程内计数器跨进程不唯一（Windows 的库锁为进程本地互斥，同毫秒
/// 两进程可能生成同 id 且 last-writer-wins 覆盖），随机段提升跨进程区分度、
/// 按当前索引查重重试在跨进程锁正确平台（Unix flock）闭合碰撞窗口。
fn unique_library_id(taken: &serde_json::Map<String, Value>) -> String {
    unique_library_id_with(taken, || {
        crate::store::new_id_with_prefix("la").replace('-', "_")
    })
}

/// [`unique_library_id`] 的可注入变体（测试用）：生成器由调用方提供。
fn unique_library_id_with<G: FnMut() -> String>(
    taken: &serde_json::Map<String, Value>,
    mut gen: G,
) -> String {
    for _ in 0..8 {
        let cand = gen();
        if !taken.contains_key(&cand) {
            return cand;
        }
    }
    // 兜底（理论不可达：随机段 2^32 + 计数器）：拼时间戳保证唯一形态
    let mut fallback = crate::store::new_id_with_prefix("la").replace('-', "_");
    while taken.contains_key(&fallback) {
        fallback = format!("{fallback}x");
    }
    fallback
}

/// mime → 扩展名（未知类型回退 bin，文件名扩展优先）。
pub(crate) fn ext_for(name: &str, mime: &str) -> String {
    if let Some(dot) = name.rfind('.') {
        let ext = &name[dot + 1..];
        let ok =
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric());
        if ok {
            return ext.to_ascii_lowercase();
        }
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => "bin",
    }
    .to_string()
}

/// 校验元信息补丁（§7.2）：字段白名单；字段**一旦出现**即做运行时类型和
/// 值域校验——非字符串的 name/kind/view、tags 的异型/空白/超长/重复成员与
/// 超 16 项一律拒绝整次命令，不得静默跳过校验、截断或留待读取归一化剥离
/// （评审修复，PR #33 第十轮）。
fn validate_meta_patch(patch: &Value) -> Result<(), String> {
    if !patch.is_object() {
        return Err("patch 必须是对象".into());
    }
    const EDITABLE: [&str; 5] = ["name", "kind", "view", "tags", "groupId"];
    for key in patch.as_object().unwrap().keys() {
        if !EDITABLE.contains(&key.as_str()) {
            return Err(format!("不可修改的字段：{key}"));
        }
    }
    if let Some(v) = patch.get("name") {
        let Some(n) = v.as_str() else {
            return Err("name 必须是字符串".into());
        };
        validate_name(n)?;
    }
    if let Some(v) = patch.get("kind") {
        let Some(k) = v.as_str() else {
            return Err("kind 必须是字符串".into());
        };
        validate_kind(k)?;
    }
    if let Some(v) = patch.get("view") {
        if !v.is_null() {
            let Some(s) = v.as_str() else {
                return Err("view 必须是字符串或 null".into());
            };
            if !VIEWS.contains(&s) {
                return Err(format!("未知视角：{s}"));
            }
        }
    }
    if let Some(v) = patch.get("tags") {
        validate_tags_patch(v)?;
    }
    Ok(())
}

/// tags 补丁值域（§7.2「tags 须在输入时满足数组、成员和值域规则」）：数组、
/// 成员去空白后 1–64 字符且规范化后唯一、至多 16 项。
fn validate_tags_patch(v: &Value) -> Result<(), String> {
    let Some(arr) = v.as_array() else {
        return Err("tags 必须是数组".into());
    };
    let mut seen: Vec<String> = Vec::new();
    for t in arr {
        let Some(s) = t.as_str() else {
            return Err("tags 成员必须是字符串".into());
        };
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err("tags 成员去空白后不能为空".into());
        }
        if trimmed.chars().count() > TAG_MAX_CHARS {
            return Err(format!("tags 成员超长（>{} 字符）", TAG_MAX_CHARS));
        }
        if seen.iter().any(|x| x == trimmed) {
            return Err(format!("tags 成员重复：{trimmed}"));
        }
        seen.push(trimmed.to_string());
    }
    if seen.len() > TAGS_MAX {
        return Err(format!("tags 最多 {} 项", TAGS_MAX));
    }
    Ok(())
}

/// 应用 groupId 补丁（§7.2）：null/空白是唯一清除标记，落盘删除可选字段；
/// 非空值必须 **verbatim** 过 id 值域——`" g "` 不得 trim 成 `"g"` 错接进组
/// g（评审修复，PR #33 第十一轮：ID 不透明，trim 只适用于契约允许的字段）；
/// 其他异型值拒绝。
fn apply_group_id(entry: &mut Value, g: &Value) -> Result<(), String> {
    match g {
        Value::Null => {
            entry.as_object_mut().unwrap().remove("groupId");
        }
        Value::String(s) if s.trim().is_empty() => {
            entry.as_object_mut().unwrap().remove("groupId");
        }
        Value::String(s) if validate_asset_id(s).is_ok() => entry["groupId"] = json!(s),
        _ => return Err("groupId 必须是合法 id 字符串或 null".into()),
    }
    Ok(())
}

// ---- opaque asset URL 媒体协议（§7.1/§10.5）已拆至 [`media`] 子模块：
// scope + assetId 的 opaque URL 与 `pwmedia` 协议处理器（issue #26/#31）。

/// 删除资产命令：日志驱动的身份绑定隔离事务（§7.2）——响应携带净化
/// 诊断与 cleanupPending。移除索引项并把媒体隔离进 .trash/。
#[tauri::command]
pub fn delete_library_asset(app: AppHandle, id: String) -> Result<Value, String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    crate::library_journal::delete_asset_transacted(&library, &id)
}

/// 更新元信息内核（句柄域）：补丁值域校验（§7.2 在内核强制——绕过命令
/// 层的原始 IPC 同样不得绕过）→ 净化读取 → 定位条目 → 应用补丁 → 复验
/// 合并结果 → 原子写回；返回条目随写回携带净化诊断（仅在非空时附加）。
fn update_meta_with(library: &cap_std::fs::Dir, id: &str, patch: &Value) -> Result<Value, String> {
    validate_meta_patch(patch)?;
    let tags = normalize_tags(patch.get("tags"));
    let recovery = crate::library_journal::recover(library)?;
    if recovery.read_only {
        return Err("删除日志异常，库写入/删除已暂停：须人工修复 asset-delete-journal.json".into());
    }
    // 迁移落盘已发生而命令可能因业务失败早退（资产不存在/合并结果冲突）——
    // 诊断兜底进日志，修复可见性不随 Err 丢失（评审修复，PR #33 第十二轮）
    crate::library_fs::report_recovery_diagnostics("元信息更新", &recovery.warnings);
    let (mut index, mut warnings, migration_suspended) = read_index_capped(library)?;
    if migration_suspended {
        return Err(
            "资产索引迁移挂起（迁移结果超大小上限），写入已暂停：须人工修整 library.json 条目"
                .into(),
        );
    }
    warnings.extend(recovery.warnings);
    let assets = index["assets"]["byId"]
        .as_object_mut()
        .ok_or("资产索引结构损坏")?;
    let entry = assets
        .get_mut(id)
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    if let Some(n) = patch.get("name").and_then(|v| v.as_str()) {
        entry["name"] = json!(n.trim());
    }
    if let Some(k) = patch.get("kind").and_then(|v| v.as_str()) {
        entry["kind"] = json!(k);
    }
    if let Some(v) = patch.get("view") {
        // §7.2：view: null 是唯一清除标记，落盘删除可选字段
        if v.is_null() {
            entry.as_object_mut().unwrap().remove("view");
        } else {
            entry["view"] = v.clone();
        }
    }
    if patch.get("tags").is_some() {
        entry["tags"] = json!(tags);
    }
    if let Some(g) = patch.get("groupId") {
        apply_group_id(entry, g)?;
    }
    // 复验完整合并结果（§7.2）：groupId 存在性与「资产和组 kind 一致」——
    // 改 kind 或换编组后的条目若与当前组冲突，整次命令拒绝且不写盘，不得
    // 让成功的元信息编辑在下次读取时被归一化静默抹掉编组（评审修复，PR #33
    // 第九轮）
    let merged = entry.clone();
    if let Some(gid) = merged.get("groupId").and_then(Value::as_str) {
        let group_kind = index["groups"]["byId"]
            .get(gid)
            .and_then(|g| g.get("kind"))
            .and_then(Value::as_str);
        let entry_kind = merged.get("kind").and_then(Value::as_str);
        if group_kind.is_none() || group_kind != entry_kind {
            return Err(format!(
                "资产 {id} 的编组 {gid} 不存在或与资产 kind 不一致，拒绝更新"
            ));
        }
    }
    let mut updated = merged;
    write_index(library, &index)?;
    if !warnings.is_empty() {
        updated["warnings"] = json!(warnings);
    }
    updated["cleanupPending"] = json!(recovery.cleanup_pending);
    Ok(updated)
}

/// 更新条目元信息（改名/分类/视角/标签/编组）；id 与媒体文件不变。补丁
/// 值域校验在内核 update_meta_with 内强制（命令层与原始 IPC 同一口径）。
#[tauri::command]
pub fn update_library_asset(app: AppHandle, id: String, patch: Value) -> Result<Value, String> {
    validate_asset_id(&id)?;
    let library = library_root(&app)?;
    let _op = library_op_lock();
    let _file_lock = library_file_lock(&library)?;
    update_meta_with(&library, &id, &patch)
}

pub(crate) mod group_commands;
pub(crate) mod media;
#[cfg(test)]
mod read_only_tests;
#[cfg(test)]
mod tests;
