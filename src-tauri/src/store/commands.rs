//! 项目生命周期 Tauri 命令（数据模型 §10）：create/load/save/delete
//! 与各自的可测内核——不可信 id 词法校验先于任何路径拼接；保存走
//! 保存边界校验 + 原子落盘 + 落盘后复验；删除按句柄相对递归且幂等。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::now_iso;
use crate::store::error::{load_project_ipc_text, to_ipc_text, StoreError};
use crate::store::list::{parse_file, read_meta};
#[cfg(unix)]
use crate::store::persist::asset_identity;
use crate::store::persist::{
    atomic_write, open_dir_bound, projects_dir, projects_op_lock, read_verified_file,
};
use crate::store::types::{
    new_id, new_project_file, sanitize_name, validate_id, ProjectFile, ProjectMeta,
};
use crate::store::validate::{prepare_save, verify_save_asset_files};
/// 新建项目：先校验名称，再在阻塞线程内完成目录准备和原子落盘。
#[tauri::command]
pub async fn create_project(app: AppHandle, name: String) -> Result<ProjectMeta, String> {
    crate::blocking::run("create_project", move || {
        // 不可信输入校验先于任何存储打开/创建（PR #179 评审修复）：名称非法
        // 不得触发应用数据/projects 目录创建副作用，也不得被存储故障顶替为
        // 名称诊断——历史行为是名称校验先于 projects_dir
        sanitize_name(&name)?;
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        create_project_file(&root, &name).map_err(to_ipc_text)
    })
    .await
}
/// create_project 的可测内核：名称清洗 → 本地 id 复核 → 新建空信封 →
/// 原子落盘（与 persist_project 同款：词法校验先于任何文件名拼接——
/// id 虽为本地生成，仍以同一口径复核后才参与路径构造）。
fn create_project_file(root: &CapDir, name: &str) -> Result<ProjectMeta, StoreError> {
    // 与列表清扫串行（PR #217 第三轮评审）：挂起/时钟前跳致临时文件
    // 显得超龄时，清扫也不得插入排他创建与 rename 之间
    let _op = projects_op_lock();
    let name = sanitize_name(name).map_err(StoreError::invalid)?;
    let id = new_id();
    validate_id(&id).map_err(StoreError::invalid)?;
    let file = new_project_file(&id, name, now_iso());
    let text =
        serde_json::to_string_pretty(&file).map_err(|e| StoreError::serialize("序列化失败", e))?;
    atomic_write(root, &format!("{id}.json"), &text)?;
    Ok(read_meta(&id, &file))
}
/// 读取项目完整内容（含画布）；旧扁平格式包装为 v0 信封返回。读取相对
/// projects_dir 的受信根锚定句柄解析（§10.2），不按路径名重开。
/// NotFound 出口携带 `[project_not_found] ` 机器码前缀（issue #229）——
/// 前端空库播种按码分支，不经中文文案；码不上屏，展示层剥离。
#[tauri::command]
pub async fn load_project(app: AppHandle, id: String) -> Result<ProjectFile, String> {
    crate::blocking::run("load_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        load_project_file(&root, &id).map_err(load_project_ipc_text)
    })
    .await
}

/// 读取项目独立 AI 会话：`session` 为 None 表示缺失（旧项目，前端视作空
/// 历史）或损坏（`corrupt` 置位，按可安全替换归类）；会话损坏只阻断会话
/// 恢复，不影响同项目的画布文档读取。
#[tauri::command]
pub async fn load_ai_session(app: AppHandle, id: String) -> Result<SessionCopy, String> {
    crate::blocking::run("load_ai_session", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        load_ai_session_file(&root, &id).map_err(to_ipc_text)
    })
    .await
}

/// 单实例会话保存：仅原子写入主文件，失败直接上浮，不写恢复副本。
#[tauri::command]
pub async fn save_ai_session(
    app: AppHandle,
    id: String,
    session: serde_json::Value,
) -> Result<(), String> {
    crate::blocking::run("save_ai_session", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        save_ai_session_file(&root, &id, &session).map_err(to_ipc_text)
    })
    .await
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
fn require_project_record(root: &CapDir, id: &str) -> Result<(), StoreError> {
    validate_id(id).map_err(StoreError::invalid)?;
    let name = format!("{id}.json");
    match root.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(StoreError::missing("项目不存在，拒绝保存 AI 会话"))
        }
        Ok(md) if md.file_type().is_symlink() => {
            Err(StoreError::refused("项目记录是符号链接，拒绝保存 AI 会话"))
        }
        Ok(md) if !md.is_file() => Err(StoreError::refused(
            "项目记录不是普通文件，拒绝保存 AI 会话",
        )),
        Ok(_) => read_verified_file(root, &name)
            .map(|_| ())
            .map_err(|e| e.prefixed("拒绝读取项目记录")),
        Err(e) => Err(StoreError::io("读取项目记录元数据失败", e)),
    }
}

/// 打开或创建会话目录。目录经 no-follow 分类与绑定后再打开，避免会话 I/O
/// 退化为未验证的路径拼接。
fn ai_session_dir(root: &CapDir, id: &str) -> Result<CapDir, StoreError> {
    validate_id(id).map_err(StoreError::invalid)?;
    for _ in 0..2 {
        match root.symlink_metadata(id) {
            Ok(md) if md.file_type().is_symlink() => {
                return Err(StoreError::refused("项目会话目录是符号链接，拒绝访问"))
            }
            Ok(md) if !md.is_dir() => {
                return Err(StoreError::refused("项目会话路径不是目录，拒绝访问"))
            }
            Ok(md) => return open_dir_bound(root, id, &md, "项目会话目录"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => match root.create_dir(id) {
                // 本次真实创建的条目同步宿主（issue #309）：失败拆除重建，
                // 重试重新创建并同步
                Ok(()) => {
                    crate::store::sync_new_child_dir_host(root, id)?;
                    continue;
                }
                Err(create_err) if create_err.kind() == std::io::ErrorKind::AlreadyExists => {
                    continue
                }
                Err(create_err) => return Err(StoreError::io("创建项目会话目录失败", create_err)),
            },
            Err(e) => return Err(StoreError::io("读取项目会话目录元数据失败", e)),
        }
    }
    Err(StoreError::refused(
        "项目会话目录在创建期间持续变化，拒绝访问",
    ))
}

/// 会话读写内核：缺文件是旧项目的合法状态（None，前端视作空历史）；
/// 损坏（不可解析/信封非法）以 corrupt 提示，不可读则返回 Err。
pub(crate) fn load_ai_session_file(root: &CapDir, id: &str) -> Result<SessionCopy, StoreError> {
    validate_id(id).map_err(StoreError::invalid)?;
    let dir = match root.symlink_metadata(id) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionCopy {
                session: None,
                corrupt: false,
            })
        }
        Ok(md) if md.file_type().is_symlink() => {
            return Err(StoreError::refused("项目会话目录是符号链接，拒绝读取"))
        }
        Ok(md) if !md.is_dir() => {
            return Err(StoreError::refused("项目会话路径不是目录，拒绝读取"))
        }
        Ok(md) => open_dir_bound(root, id, &md, "项目会话目录")?,
        Err(e) => return Err(StoreError::io("读取项目会话目录元数据失败", e)),
    };
    match dir.symlink_metadata("ai-session.json") {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SessionCopy {
            session: None,
            corrupt: false,
        }),
        Ok(_) => {
            let text = read_verified_file(&dir, "ai-session.json")
                .map_err(|e| e.prefixed("拒绝读取 AI 会话"))?;
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
        Err(e) => Err(StoreError::io("读取 AI 会话文件元数据失败", e)),
    }
}

/// 复用项目记录校验和原子落盘；单进程的调用顺序由前端共享保存链拥有。
pub(crate) fn save_ai_session_file(
    root: &CapDir,
    id: &str,
    session: &serde_json::Value,
) -> Result<(), StoreError> {
    validate_ai_session(session).map_err(StoreError::invalid)?;
    // 与项目删除共享 projects 操作锁（PR #224 第二轮评审）：
    // require_project_record + 会话目录创建原子化，迟到保存不得重建
    // 已删项目的目录（恢复 ai_session_dir 注释的既有文档意图）
    let _op = projects_op_lock();
    require_project_record(root, id)?;
    let dir = ai_session_dir(root, id)?;
    let text = serde_json::to_string_pretty(session)
        .map_err(|e| StoreError::serialize("序列化 AI 会话失败", e))?;
    atomic_write(&dir, "ai-session.json", &text).map_err(|e| e.prefixed("保存 AI 会话失败"))
}
/// load_project 的可测内核：id 是 IPC 调用方传入的不可信参数，词法校验
/// 先于任何路径拼接——嵌套路径形态的 id（如 `p-1/assets/x`）不得把
/// projects/ 内的任意 JSON 经项目通道读出（句柄相对解析被沙箱限定在
/// projects/ 树内）。读取走 read_verified_file 的锚定句柄绑定。
pub(crate) fn load_project_file(root: &CapDir, id: &str) -> Result<ProjectFile, StoreError> {
    validate_id(id).map_err(StoreError::invalid)?;
    let name = format!("{id}.json");
    match root.symlink_metadata(&name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StoreError::missing(format!("项目不存在：{id}")))
        }
        Err(e) => return Err(StoreError::io("读取项目文件元数据失败", e)),
        Ok(_) => {}
    }
    let text = read_verified_file(root, &name).map_err(|e| e.prefixed("拒绝读取项目文件"))?;
    parse_file(id, &text).map_err(|e| e.prefixed("项目文件损坏"))
}
/// 全量保存（§10.5 保存边界）：完整信封校验先行，任一失败整次拒绝；
/// 资产 relPath 在已验证的 projects 目录下做实路径复验（no-follow +
/// canonical 包含），通过后才盖戳 updatedAt、创建临时文件并原子落盘；
/// 落盘后再复验一次——句柄只绑定打开时的 inode，不钉住路径名，保存期间
/// 被并发进程替换（unlink/重命名/换符号链接）的路径在写后复验中上浮为
/// 显式失败（文档虽已提交，篡改不得静默；下次加载复验会隔离条目兜底）。
#[tauri::command]
pub async fn save_project(
    app: AppHandle,
    id: String,
    doc: ProjectFile,
    expect_existing: Option<bool>,
) -> Result<ProjectMeta, String> {
    crate::blocking::run("save_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        match expect_existing.unwrap_or(false) {
            false => persist_project(&root, &id, doc),
            true => persist_project_expect_existing(&root, &id, doc, true),
        }
        .map_err(to_ipc_text)
    })
    .await
}
/// save_project 的可测内核（给定已验证的 projects 目录）。id 是 IPC 调用方
/// 传入的不可信参数：词法校验先于任何路径拼接——否则 `../prefs` 式 id 可把
/// 空资产索引（复验不设防）的整份文档写到 projects/ 之外。
pub(crate) fn persist_project(
    root: &CapDir,
    id: &str,
    doc: ProjectFile,
) -> Result<ProjectMeta, StoreError> {
    persist_project_expect_existing(root, id, doc, false)
}

/// [`persist_project`] 的完整形态：`expect_existing` 为真时锁内前置校验
/// 目标控制文件仍存在（PR #224 第六轮评审）——副本后续保存在 copy 释放
/// 锁后可能遭遇排队的删除把目标移走，此时的保存不得复活控制文件
///（atomic_write 支持新建目标）；默认 false 保持既有语义——迟到重试
/// 保存的复活治理归前端删除墓碑（§10.2），Rust 不越权扩大拒绝面。
pub(crate) fn persist_project_expect_existing(
    root: &CapDir,
    id: &str,
    doc: ProjectFile,
    expect_existing: bool,
) -> Result<ProjectMeta, StoreError> {
    // 与列表清扫串行（PR #217 第三轮评审，同 create_project_file）
    let _op = projects_op_lock();
    validate_id(id).map_err(StoreError::invalid)?;
    if expect_existing {
        // 仅确证缺失视为「项目不存在」（PR #224 第九轮评审）：权限/瞬态
        // I/O 错误按原语境上抛（可行动诊断），不得谎报契约状态
        match root.symlink_metadata(format!("{id}.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(StoreError::missing(format!(
                    "项目不存在，拒绝写入副本：{id}"
                )));
            }
            Err(e) => {
                return Err(StoreError::io("读取项目文件元数据失败", e));
            }
            Ok(_) => {}
        }
    }
    // 句柄持有至函数结束——复验过的实体覆盖整个保存决策
    let _verified_assets = verify_save_asset_files(root, id, &doc.assets)?;
    let file = prepare_save(id, &doc)?;
    let text =
        serde_json::to_string_pretty(&file).map_err(|e| StoreError::serialize("序列化失败", e))?;
    atomic_write(root, &format!("{id}.json"), &text)?;
    if let Err(e) = verify_save_asset_files(root, id, &doc.assets) {
        eprintln!("[store] 保存后资产复验失败，路径可能在保存期间被替换：{e}");
        return Err(e.prefixed("保存后资产复验失败（路径可能在保存期间被替换）"));
    }
    Ok(read_meta(id, &file))
}
/// 删除项目（首页卡片菜单，§3.2）：移除 `projects/{id}.json` 与项目资产
/// 目录 `projects/{id}/`（当前扁平布局的资产根，§10.1）。目录删除逐项
/// no-follow 且全程相对已打开的 projects 根目录句柄（§10.2 openat 语义，
/// cap-std）——符号链接条目只移除链接本身，绝不跟随；任一失败显式报错，
/// 不静默遗留媒体文件。
#[tauri::command]
pub async fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    crate::blocking::run("delete_project", move || {
        let root = projects_dir(&app).map_err(to_ipc_text)?;
        delete_project_files(&root, &id).map_err(to_ipc_text)
    })
    .await
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
fn remove_dir_contents_bound(dir: &CapDir) -> Result<(), StoreError> {
    for entry in dir
        .entries()
        .map_err(|e| StoreError::io("扫描待删目录失败", e))?
    {
        let entry = entry.map_err(|e| StoreError::io("扫描待删目录失败", e))?;
        // DirEntry::metadata 取 lstat 语义，不跟随符号链接
        let md = entry
            .metadata()
            .map_err(|e| StoreError::io("读取待删条目元数据失败", e))?;
        let name = entry.file_name();
        if md.is_dir() {
            let child = open_dir_bound(dir, &name, &md, "待删子目录")?;
            remove_dir_contents_bound(&child)?;
            dir.remove_dir(&name)
                .map_err(|e| StoreError::io(format!("删除子目录失败（{name:?}）"), e))?;
        } else {
            dir.remove_file(&name)
                .map_err(|e| StoreError::io(format!("移除条目失败（{name:?}）"), e))?;
        }
    }
    Ok(())
}
fn delete_project_files(root: &CapDir, id: &str) -> Result<(), StoreError> {
    validate_id(id).map_err(StoreError::invalid)?;
    // 删除与导入/生成/复制/会话创建/列表清扫共享 projects 操作锁
    //（PR #224 第二轮评审）：写入路径的控制校验与资产提交不在删除
    // 窗口中越过，已删目录不被重建
    let _op = projects_op_lock();
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
                    return Err(StoreError::refused(format!(
                        "项目资产目录在删除期间被替换，拒绝移除目录项：{id}"
                    )));
                }
            }
            root.remove_dir(id)
                .map_err(|e| StoreError::io(format!("删除项目资产目录失败（{id}）"), e))?;
        }
        // 符号链接与普通文件同款：remove_file 只移除该目录项自身
        Ok(_) => root
            .remove_file(id)
            .map_err(|e| StoreError::io(format!("移除项目资产路径失败（{id}）"), e))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(StoreError::io(
                format!("读取待删资产路径元数据失败（{id}）"),
                e,
            ))
        }
    }
    match root.remove_file(format!("{id}.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StoreError::io("删除项目失败", e)),
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod blocking_tests;
