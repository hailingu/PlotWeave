//! 项目生命周期 Tauri 命令（数据模型 §10）：create/load/save/delete
//! 与各自的可测内核——不可信 id 词法校验先于任何路径拼接；保存走
//! 保存边界校验 + 原子落盘 + 落盘后复验；删除按句柄相对递归且幂等。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::now_iso;
use crate::store::list::{parse_file, read_meta};
#[cfg(unix)]
use crate::store::persist::asset_identity;
use crate::store::persist::{atomic_write, open_dir_bound, projects_dir, read_verified_file};
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

/// 读取项目独立 AI 会话：`session` 为 None 表示缺失（旧项目，前端视作空
/// 历史）或损坏（`corrupt` 置位，按可安全替换归类）；会话损坏只阻断会话
/// 恢复，不影响同项目的画布文档读取。
#[tauri::command]
pub fn load_ai_session(app: AppHandle, id: String) -> Result<SessionCopy, String> {
    let root = projects_dir(&app)?;
    load_ai_session_file(&root, &id)
}

/// 单实例会话保存：仅原子写入主文件，失败直接上浮，不写恢复副本。
#[tauri::command]
pub fn save_ai_session(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    let root = projects_dir(&app)?;
    save_ai_session_file(&root, &id, &session)
}

/// 主文件加载结果；缺失为空历史，损坏由前端提示，真实 I/O 错误仍返回 Err。
#[derive(serde::Serialize)]
pub struct SessionCopy {
    pub session: Option<serde_json::Value>,
    pub corrupt: bool,
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

/// 会话读写内核：缺文件是旧项目的合法状态（None，前端视作空历史）；
/// 损坏（不可解析/信封非法）以 corrupt 提示，不可读则返回 Err。
pub(crate) fn load_ai_session_file(root: &CapDir, id: &str) -> Result<SessionCopy, String> {
    validate_id(id)?;
    let dir = match root.symlink_metadata(id) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionCopy {
                session: None,
                corrupt: false,
            })
        }
        Ok(md) if md.file_type().is_symlink() => {
            return Err("项目会话目录是符号链接，拒绝读取".into())
        }
        Ok(md) if !md.is_dir() => return Err("项目会话路径不是目录，拒绝读取".into()),
        Ok(md) => open_dir_bound(root, id, &md, "项目会话目录")?,
        Err(e) => return Err(format!("读取项目会话目录元数据失败：{e}")),
    };
    match dir.symlink_metadata("ai-session.json") {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionCopy {
            session: None,
            corrupt: false,
        }),
        Ok(_) => {
            let text = read_verified_file(&dir, "ai-session.json")
                .map_err(|e| format!("拒绝读取 AI 会话：{e}"))?;
            let session = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .filter(|v| validate_ai_session(v).is_ok());
            Ok(match session {
                Some(session) => SessionCopy {
                    session: Some(session),
                    corrupt: false,
                },
                None => SessionCopy {
                    session: None,
                    corrupt: true,
                },
            })
        }
        Err(e) => Err(format!("读取 AI 会话文件元数据失败：{e}")),
    }
}

/// 复用项目记录校验和原子落盘；单进程的调用顺序由前端共享保存链拥有。
pub(crate) fn save_ai_session_file(
    root: &CapDir,
    id: &str,
    session: &serde_json::Value,
) -> Result<(), String> {
    validate_ai_session(session)?;
    require_project_record(root, id)?;
    let dir = ai_session_dir(root, id)?;
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
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let root = projects_dir(&app)?;
    delete_project_files(&root, &id)
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
