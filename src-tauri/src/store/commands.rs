//! 项目生命周期 Tauri 命令（数据模型 §10）：create/load/save/delete
//! 与各自的可测内核——不可信 id 词法校验先于任何路径拼接；保存走
//! 保存边界校验 + 原子落盘 + 落盘后复验；删除按句柄相对递归且幂等。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::now_iso;
use crate::store::list::{parse_file, read_meta};
#[cfg(unix)]
use crate::store::persist::asset_identity;
use crate::store::persist::{
    atomic_write, open_dir_bound, projects_dir, read_verified_file, recovery_dir,
    recovery_file_name,
};
use crate::store::types::{
    new_id, new_project_file, sanitize_name, validate_id, ProjectFile, ProjectMeta,
};
use crate::store::validate::{prepare_save, verify_save_asset_files};
#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    let name = sanitize_name(&name)?;
    let id = new_id();
    // 边界校验先于任何文件名拼接（与 persist_project 同款）：id 虽为本地
    // 生成，仍以同一口径复核后才参与路径构造
    validate_id(&id)?;
    let file = new_project_file(&id, name, now_iso());
    let root = projects_dir(&app)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    atomic_write(&root, &format!("{id}.json"), &text)?;
    Ok(read_meta(&id, &file))
}
/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。读取相对
/// projects_dir 的受信根锚定句柄解析（§10.2），不按路径名重开。
#[tauri::command]
pub fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    let root = projects_dir(&app)?;
    load_project_file(&root, &id)
}

/// 读取项目独立 AI 会话：旧项目缺文件时返回空历史；会话损坏只阻断会话恢复，
/// 不影响同项目的画布文档读取。
#[tauri::command]
pub fn load_ai_session(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let root = projects_dir(&app)?;
    load_ai_session_file(&root, &id)
}

/// 保存项目独立 AI 会话。会话文件位于 `projects/{id}/ai-session.json`，与
/// `project.json` 分离，避免每条对话触发整份画布文档序列化。主文件成功
/// 落盘后清除可能存在的恢复副本（权威副本已取代它）。
#[tauri::command]
pub fn save_ai_session(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    let root = projects_dir(&app)?;
    let recovery = recovery_dir(&app)?;
    save_ai_session_authoritative(&root, &recovery, &id, &session)
}

/// 写入会话恢复副本（主文件保存失败后的跨进程保留）：与项目目录分离，
/// 项目目录不可写或记录暂不可读时仍可能写入成功。项目记录必须存在——
/// 已删除项目不得因恢复副本留下不可见聊天数据。
#[tauri::command]
pub fn stash_ai_session_recovery(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    let projects = projects_dir(&app)?;
    let recovery = recovery_dir(&app)?;
    stash_ai_session_recovery_file(&projects, &recovery, &id, &session)
}

/// 读取会话恢复副本；`session` 为 None 表示副本缺失或损坏（损坏时
/// `corrupt` 置位）。前端在主文件读取之外单独消费，以便向用户标明
/// 「已从恢复副本载入」。
#[tauri::command]
pub fn load_ai_session_recovery(app: AppHandle, id: String) -> Result<RecoveryCopy, String> {
    let recovery = recovery_dir(&app)?;
    load_ai_session_recovery_file(&recovery, &id)
}

/// 恢复副本读取结果：损坏（不可解析或信封非法）的内容无法被任何进程
/// 载入，与 `ensure_recovery_replaceable` 同口径按「可安全替换」归类，
/// 以 `corrupt` 标记返回而不是 Err——前端不得据此进入「新旧未知」门禁
/// 永久暂缓保存。Err 仅保留给真实 I/O 失败（权限/瞬态 I/O、元数据失败），
/// 那才是新旧无法确定、写入边界必须拒绝覆盖的情形。
#[derive(serde::Serialize)]
pub struct RecoveryCopy {
    pub session: Option<serde_json::Value>,
    pub corrupt: bool,
}

/// JS `Number.MAX_SAFE_INTEGER`（2^53-1）：会话写入序号的可接受上界。u64
/// 能表示更大的值，但前端 `seqOf` 会把超出安全整数范围的序号归一为 0
/// ——保存边界必须先拒绝，否则超范围序号一旦落盘，下一次合法保存（从 1
/// 续起）被序号守卫当作更旧而永久拒绝，权威持久化无法恢复。
const MAX_SAFE_WRITE_SEQ: u64 = (1u64 << 53) - 1;

/// 会话载荷的写入序号（非负整数；缺失/异型视作 0）。
fn session_write_seq(session: &serde_json::Value) -> u64 {
    session
        .get("writeSeq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

/// 会话载荷去除 `writeSeq` 后的对话内容：相等序号下的写入身份。内容一致
/// = 同一逻辑写入的幂等重放（如权威保存后清除副本失败时的同序号改写、
/// 旧无序号文件补显式 0 的升级），替换不丢失任何历史，必须放行；内容
/// 不同 = 无单实例约束下两进程各自续起撞号的并发冲突，后写替换先写会
/// 静默丢失一侧会话，必须拒绝（评审 pullrequestreview-5161801056）。
fn session_body(session: &serde_json::Value) -> serde_json::Value {
    let mut body = session.clone();
    if let Some(object) = body.as_object_mut() {
        object.remove("writeSeq");
    }
    body
}

/// 恢复副本替换/清除前的顺序守卫（§12.2，历轮评审修复）：仅当现存副本
/// 缺失、内容不可解析（损坏副本无法再被载入，可安全替换）、写入序号
/// 小于本次写入序号，或序号相等且对话内容一致（幂等重放）时才允许
/// 替换。副本不可读（权限/瞬态 I/O）或序号更新时拒绝——绝不在无法确定
/// 新旧的情况下销毁可能是唯一新副本的历史；相等序号的不同内容是两进程
/// 撞号的并发冲突，同样拒绝。
fn ensure_recovery_replaceable(
    recovery: &CapDir,
    id: &str,
    incoming: &serde_json::Value,
) -> Result<(), String> {
    let name = recovery_file_name(id);
    match recovery.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取 AI 会话恢复副本元数据失败，已拒绝覆盖：{e}")),
        Ok(_) => {}
    }
    let text = read_verified_file(recovery, &name)
        .map_err(|e| format!("AI 会话恢复副本不可读，无法确定新旧，已拒绝覆盖：{e}"))?;
    let existing = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .filter(|v| validate_ai_session(v).is_ok());
    match existing {
        Some(existing) if session_write_seq(&existing) > session_write_seq(incoming) => {
            Err("AI 会话恢复副本比本次保存更新，已拒绝覆盖（请重新打开项目载入更新的历史）".into())
        }
        Some(existing)
            if session_write_seq(&existing) == session_write_seq(incoming)
                && session_body(&existing) != session_body(incoming) =>
        {
            Err("AI 会话恢复副本已存在同一写入序号的不同会话（另一进程可能已写入），已拒绝覆盖（请重新打开项目载入最新历史）".into())
        }
        _ => Ok(()),
    }
}

/// 写恢复副本内核（不可信 id 与信封校验先于路径拼接；现存副本更新、
/// 不可读，或相等序号的不同内容（并发冲突）时拒绝覆盖）。
pub(crate) fn stash_ai_session_recovery_file(
    projects: &CapDir,
    recovery: &CapDir,
    id: &str,
    session: &serde_json::Value,
) -> Result<(), String> {
    validate_ai_session(session)?;
    require_project_record(projects, id)?;
    ensure_recovery_replaceable(recovery, id, session)?;
    let text =
        serde_json::to_string_pretty(session).map_err(|e| format!("序列化 AI 会话失败：{e}"))?;
    atomic_write(recovery, &recovery_file_name(id), &text)
        .map_err(|e| format!("保存 AI 会话恢复副本失败：{e}"))
}

/// 读恢复副本内核：缺失是合法状态（无失败保存）；损坏按可替换归类
/// （见 `RecoveryCopy` 的契约说明），不可读才是 Err。
pub(crate) fn load_ai_session_recovery_file(
    recovery: &CapDir,
    id: &str,
) -> Result<RecoveryCopy, String> {
    validate_id(id)?;
    let name = recovery_file_name(id);
    match recovery.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RecoveryCopy {
            session: None,
            corrupt: false,
        }),
        Ok(_) => {
            let text = read_verified_file(recovery, &name)
                .map_err(|e| format!("拒绝读取 AI 会话恢复副本：{e}"))?;
            let session = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .filter(|v| validate_ai_session(v).is_ok());
            Ok(match session {
                Some(session) => RecoveryCopy {
                    session: Some(session),
                    corrupt: false,
                },
                None => RecoveryCopy {
                    session: None,
                    corrupt: true,
                },
            })
        }
        Err(e) => Err(format!("读取 AI 会话恢复副本元数据失败：{e}")),
    }
}

/// 清除恢复副本内核：幂等（缺失即成功）；remove_file 只移除目录项本身，
/// 不跟随符号链接。
pub(crate) fn clear_ai_session_recovery_file(recovery: &CapDir, id: &str) -> Result<(), String> {
    validate_id(id)?;
    match recovery.remove_file(recovery_file_name(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清除 AI 会话恢复副本失败：{e}")),
    }
}

/// 权威保存 + 清除恢复副本：主文件失败时不触碰恢复副本（它是当前唯一可
/// 跨进程恢复的拷贝）；现存副本更新、不可读，或相等序号的不同内容时
/// 整次拒绝——写入主文件后再拒绝清除会让更新副本在下次载入时压过刚保存
/// 的内容。清除失败时改写为刚落盘的权威内容——陈旧副本若在下次载入时仍
/// 优先于权威文件，会把新会话回退成旧内容。
pub(crate) fn save_ai_session_authoritative(
    projects: &CapDir,
    recovery: &CapDir,
    id: &str,
    session: &serde_json::Value,
) -> Result<(), String> {
    ensure_recovery_replaceable(recovery, id, session)?;
    save_ai_session_file(projects, id, session)?;
    if let Err(e) = clear_ai_session_recovery_file(recovery, id) {
        eprintln!("[store] 清除 AI 会话恢复副本失败，改写为最新内容：{e}");
        if let Err(write_err) = stash_ai_session_recovery_file(projects, recovery, id, session) {
            eprintln!("[store] 恢复副本改写失败：{write_err}");
        }
    }
    Ok(())
}

/// 删除项目回执：删除本身已提交（项目记录与资产目录已移除）。恢复副本
/// 清除失败时带上诊断——此情形**不是**删除失败：前端若按失败回吐在途/
/// 吸收的画布保存，`save_project` 会重建已删除的项目记录，项目在用户删除
/// 后复活（资产目录却已移除）。残留副本由 `list_projects` 的孤儿清扫兜底。
#[derive(serde::Serialize)]
pub struct DeleteProjectReport {
    /// 已提交的删除但恢复副本清除失败（或恢复目录暂不可用）时的诊断；
    /// None = 完全干净。
    pub cleanup_error: Option<String>,
}

/// 删除项目 + 清除恢复副本：项目删除失败（项目仍在）时保留恢复副本并上浮
/// 错误；项目已删除但副本清除失败时返回已提交回执 + 清理诊断——删除不可
/// 回滚，不得让调用方回放画布保存。恢复目录在删除提交后才打开：它是可选
/// 的清理位置，暂不可用（不可读/被非目录占位）不得反过来阻断任何项目的
/// 删除，只作为清理诊断上报，残留副本由列表孤儿清扫兜底。
pub(crate) fn delete_project_with_recovery(
    projects: &CapDir,
    open_recovery: impl FnOnce() -> Result<CapDir, String>,
    id: &str,
) -> Result<DeleteProjectReport, String> {
    delete_project_files(projects, id)?;
    let cleanup_error = match open_recovery() {
        Ok(recovery) => clear_ai_session_recovery_file(&recovery, id)
            .err()
            .map(|e| format!("项目已删除，但清除 AI 会话恢复副本失败（列表时清扫残留副本）：{e}")),
        Err(e) => Some(format!(
            "项目已删除，但会话恢复目录暂不可用，未清除其恢复副本（列表时清扫残留副本）：{e}"
        )),
    };
    Ok(DeleteProjectReport { cleanup_error })
}

fn empty_ai_session() -> serde_json::Value {
    serde_json::json!({ "schemaVersion": 1, "entries": [] })
}

fn validate_ai_session(session: &serde_json::Value) -> Result<(), String> {
    let Some(object) = session.as_object() else {
        return Err("AI 会话必须是对象".into());
    };
    if object.get("schemaVersion") != Some(&serde_json::Value::from(1)) {
        return Err("AI 会话版本不受支持".into());
    }
    if !object
        .get("entries")
        .is_some_and(serde_json::Value::is_array)
    {
        return Err("AI 会话 entries 必须是数组".into());
    }
    // 存在的 writeSeq 必须是非负安全整数（缺失视作 0，兼容旧文件）：见
    // MAX_SAFE_WRITE_SEQ 的边界说明
    if let Some(seq) = object.get("writeSeq") {
        if seq.as_u64().is_none_or(|seq| seq > MAX_SAFE_WRITE_SEQ) {
            return Err("AI 会话 writeSeq 必须是非负安全整数".into());
        }
    }
    Ok(())
}

/// AI 会话只能附着在权威项目记录上。删除先移除该记录；迟到的会话保存
/// 因而无法重新创建 `projects/{id}/`，留下不可见的聊天数据。
fn require_project_record(root: &CapDir, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let name = format!("{id}.json");
    match root.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err("项目不存在，拒绝保存 AI 会话".into())
        }
        Ok(md) if md.file_type().is_symlink() => Err("项目记录是符号链接，拒绝保存 AI 会话".into()),
        Ok(md) if !md.is_file() => Err("项目记录不是普通文件，拒绝保存 AI 会话".into()),
        Ok(_) => read_verified_file(root, &name)
            .map(|_| ())
            .map_err(|e| format!("拒绝读取项目记录：{e}")),
        Err(e) => Err(format!("读取项目记录元数据失败：{e}")),
    }
}

/// 打开或创建会话目录。目录经 no-follow 分类与绑定后再打开，避免会话 I/O
/// 退化为未验证的路径拼接。
fn ai_session_dir(root: &CapDir, id: &str) -> Result<CapDir, String> {
    validate_id(id)?;
    for _ in 0..2 {
        match root.symlink_metadata(id) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err("项目会话目录是符号链接，拒绝访问".into())
            }
            Ok(md) if !md.is_dir() => return Err("项目会话路径不是目录，拒绝访问".into()),
            Ok(md) => return open_dir_bound(root, id, &md, "项目会话目录"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match root.create_dir(id) {
                Ok(()) => continue,
                Err(create_err) if create_err.kind() == std::io::ErrorKind::AlreadyExists => {
                    continue
                }
                Err(create_err) => return Err(format!("创建项目会话目录失败：{create_err}")),
            },
            Err(e) => return Err(format!("读取项目会话目录元数据失败：{e}")),
        }
    }
    Err("项目会话目录在创建期间持续变化，拒绝访问".into())
}

/// 会话读写内核：缺文件是旧项目的合法状态；损坏 JSON 明确上浮给前端展示。
pub(crate) fn load_ai_session_file(root: &CapDir, id: &str) -> Result<serde_json::Value, String> {
    validate_id(id)?;
    let dir = match root.symlink_metadata(id) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_ai_session()),
        Ok(md) if md.file_type().is_symlink() => {
            return Err("项目会话目录是符号链接，拒绝读取".into())
        }
        Ok(md) if !md.is_dir() => return Err("项目会话路径不是目录，拒绝读取".into()),
        Ok(md) => open_dir_bound(root, id, &md, "项目会话目录")?,
        Err(e) => return Err(format!("读取项目会话目录元数据失败：{e}")),
    };
    match dir.symlink_metadata("ai-session.json") {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(empty_ai_session()),
        Ok(_) => {
            let text = read_verified_file(&dir, "ai-session.json")
                .map_err(|e| format!("拒绝读取 AI 会话：{e}"))?;
            let session =
                serde_json::from_str(&text).map_err(|e| format!("AI 会话文件损坏：{e}"))?;
            validate_ai_session(&session)?;
            Ok(session)
        }
        Err(e) => Err(format!("读取 AI 会话文件元数据失败：{e}")),
    }
}

/// 权威会话文件替换前的顺序守卫（§12.2，历轮评审修复）：现存主文件缺失、
/// 内容不可解析（损坏内容无法再被载入，可安全替换）、写入序号小于本次
/// 写入序号，或序号相等且对话内容一致（幂等重放）时才允许覆盖。主文件
/// 不可读（权限/瞬态 I/O）或序号更新时拒绝——绝不在无法确定新旧的
/// 情况下销毁可能是更新权威副本的历史；相等序号的不同内容是两进程
/// 各自续起撞号的并发冲突（后写替换先写会把一侧会话静默丢失且写入
/// 边界还报告成功），同样拒绝（评审 pullrequestreview-5161801056）。
fn ensure_authoritative_replaceable(
    dir: &CapDir,
    incoming: &serde_json::Value,
) -> Result<(), String> {
    match dir.symlink_metadata("ai-session.json") {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取 AI 会话文件元数据失败，已拒绝覆盖：{e}")),
        Ok(_) => {}
    }
    let text = read_verified_file(dir, "ai-session.json")
        .map_err(|e| format!("AI 会话文件不可读，无法确定新旧，已拒绝覆盖：{e}"))?;
    let existing = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .filter(|v| validate_ai_session(v).is_ok());
    match existing {
        Some(existing) if session_write_seq(&existing) > session_write_seq(incoming) => {
            Err("AI 会话文件比本次保存更新，已拒绝覆盖（请重新打开项目载入更新的历史）".into())
        }
        Some(existing)
            if session_write_seq(&existing) == session_write_seq(incoming)
                && session_body(&existing) != session_body(incoming) =>
        {
            Err("AI 会话文件已存在同一写入序号的不同会话（另一进程可能已写入），已拒绝覆盖（请重新打开项目载入最新历史）".into())
        }
        _ => Ok(()),
    }
}

pub(crate) fn save_ai_session_file(
    root: &CapDir,
    id: &str,
    session: &serde_json::Value,
) -> Result<(), String> {
    validate_ai_session(session)?;
    require_project_record(root, id)?;
    let dir = ai_session_dir(root, id)?;
    ensure_authoritative_replaceable(&dir, session)?;
    let text =
        serde_json::to_string_pretty(session).map_err(|e| format!("序列化 AI 会话失败：{e}"))?;
    atomic_write(&dir, "ai-session.json", &text).map_err(|e| format!("保存 AI 会话失败：{e}"))
}
/// load_project 的可测内核：id 是 IPC 调用方传入的不可信参数，词法校验
/// 先于任何路径拼接——嵌套路径形态的 id（如 `p-1/assets/x`）不得把
/// projects/ 内的任意 JSON 经项目通道读出（句柄相对解析被沙箱限定在
/// projects/ 树内）。读取走 read_verified_file 的锚定句柄绑定。
pub(crate) fn load_project_file(root: &CapDir, id: &str) -> Result<ProjectFile, String> {
    validate_id(id)?;
    let name = format!("{id}.json");
    match root.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("项目不存在：{id}"))
        }
        Err(e) => return Err(format!("读取项目文件元数据失败：{e}")),
        Ok(_) => {}
    }
    let text = read_verified_file(root, &name).map_err(|e| format!("拒绝读取项目文件：{e}"))?;
    parse_file(id, &text).map_err(|e| format!("项目文件损坏：{e}"))
}
/// 全量保存（§10.5 保存边界）：完整信封校验先行，任一失败整次拒绝；
/// 资产 relPath 在已验证的 projects 目录下做实路径复验（no-follow +
/// canonical 包含），通过后才盖戳 updatedAt、创建临时文件并原子落盘；
/// 落盘后再复验一次——句柄只绑定打开时的 inode，不钉住路径名，保存期间
/// 被并发进程替换（unlink/重命名/换符号链接）的路径在写后复验中上浮为
/// 显式失败（文档虽已提交，篡改不得静默；下次加载复验会隔离条目兜底）。
#[tauri::command]
pub fn save_project(app: AppHandle, id: String, doc: ProjectFile) -> Result<ProjectMeta, String> {
    let root = projects_dir(&app)?;
    persist_project(&root, &id, doc)
}
/// save_project 的可测内核（给定已验证的 projects 目录）。id 是 IPC 调用方
/// 传入的不可信参数：词法校验先于任何路径拼接——否则 `../prefs` 式 id 可把
/// 空资产索引（复验不设防）的整份文档写到 projects/ 之外。
pub(crate) fn persist_project(
    root: &CapDir,
    id: &str,
    doc: ProjectFile,
) -> Result<ProjectMeta, String> {
    validate_id(id)?;
    // 句柄持有至函数结束——复验过的实体覆盖整个保存决策
    let _verified_assets = verify_save_asset_files(root, id, &doc.assets)?;
    let file = prepare_save(id, &doc)?;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("序列化失败：{e}"))?;
    atomic_write(root, &format!("{id}.json"), &text)?;
    if let Err(e) = verify_save_asset_files(root, id, &doc.assets) {
        eprintln!("[store] 保存后资产复验失败，路径可能在保存期间被替换：{e}");
        return Err(format!(
            "保存后资产复验失败（路径可能在保存期间被替换）：{e}"
        ));
    }
    Ok(read_meta(id, &file))
}
/// 删除项目（首页卡片菜单，§3.2）：移除 `projects/{id}.json` 与项目资产
/// 目录 `projects/{id}/`（当前扁平布局的资产根，§10.1）。目录删除逐项
/// no-follow 且全程相对已打开的 projects 根目录句柄（§10.2 openat 语义，
/// cap-std）——符号链接条目只移除链接本身，绝不跟随；任一失败显式报错，
/// 不静默遗留媒体文件。
#[tauri::command]
pub fn delete_project(app: AppHandle, id: String) -> Result<DeleteProjectReport, String> {
    let root = projects_dir(&app)?;
    // 恢复目录在项目删除提交后才打开：它不可用只能降级为清理诊断，不得
    // 阻断删除本身（见 delete_project_with_recovery 的顺序契约）
    delete_project_with_recovery(&root, || recovery_dir(&app), &id)
}
/// delete_project 的可测内核：资产目录与项目 JSON 的成对移除，幂等。
/// 顺序契约：先删资产树再删权威项目文件——树删除失败时项目仍在列表中
/// 可发现、可重试删除；反过来先删 JSON 会让失败留下不可发现的孤儿媒体。
/// 元数据读取、树删除与 unlink 均相对已打开的 projects 根目录句柄进行
/// （cap-std remove_dir_all 内部同样是逐组件 no-follow 的句柄相对实现），
/// 归类后 `projects/{id}` 被并发换成符号链接也无法把删除引到根外——链接
/// 自身按 remove_file 移除，不进入其指向的外部树。
/// 句柄相对递归删除（§10.2）：目录条目先 open_dir_bound 绑定身份再删
/// 内容——remove_dir_all 按名字重解析，归类后被换名的子目录会被误删；
/// 符号链接与非目录条目只移除目录项自身（remove_file 不跟随），目录清空
/// 后由调用方在复核身份下移除名字。
fn remove_dir_contents_bound(dir: &CapDir) -> Result<(), String> {
    for entry in dir
        .entries()
        .map_err(|e| format!("扫描待删目录失败：{e}"))?
    {
        let entry = entry.map_err(|e| format!("扫描待删目录失败：{e}"))?;
        // DirEntry::metadata 取 lstat 语义，不跟随符号链接
        let md = entry
            .metadata()
            .map_err(|e| format!("读取待删条目元数据失败：{e}"))?;
        let name = entry.file_name();
        if md.is_dir() {
            let child = open_dir_bound(dir, &name, &md, "待删子目录")?;
            remove_dir_contents_bound(&child)?;
            dir.remove_dir(&name)
                .map_err(|e| format!("删除子目录失败（{name:?}）：{e}"))?;
        } else {
            dir.remove_file(&name)
                .map_err(|e| format!("移除条目失败（{name:?}）：{e}"))?;
        }
    }
    Ok(())
}
fn delete_project_files(root: &CapDir, id: &str) -> Result<(), String> {
    validate_id(id)?;
    match root.symlink_metadata(id) {
        Ok(md) if md.is_dir() => {
            // 先绑定被归类目录的身份再删内容（§10.2）：remove_dir_all(id)
            // 按名字重解析——归类后 {id} 被并发换成根内另一真实项目目录时，
            // 被递归删除的是替换目录，无辜项目的资产被清光而本项目 JSON
            // 照删；绑定句柄后内容相对句柄删除，删空前再复核目录项身份，
            // 名字被换即显式失败（不误删也不静默遗留）
            let dir = open_dir_bound(root, id, &md, "待删项目目录")?;
            remove_dir_contents_bound(&dir)?;
            #[cfg(unix)]
            if let Ok(recheck) = root.symlink_metadata(id) {
                if asset_identity(&recheck) != asset_identity(&md) {
                    return Err(format!(
                        "项目资产目录在删除期间被替换，拒绝移除目录项：{id}"
                    ));
                }
            }
            root.remove_dir(id)
                .map_err(|e| format!("删除项目资产目录失败（{id}）：{e}"))?;
        }
        // 符号链接与普通文件同款：remove_file 只移除该目录项自身
        Ok(_) => root
            .remove_file(id)
            .map_err(|e| format!("移除项目资产路径失败（{id}）：{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取待删资产路径元数据失败（{id}）：{e}")),
    }
    match root.remove_file(format!("{id}.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除项目失败：{e}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests;
