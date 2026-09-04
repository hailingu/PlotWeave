//! 项目生命周期 Tauri 命令（数据模型 §10）：create/load/save/delete
//! 与各自的可测内核——不可信 id 词法校验先于任何路径拼接；保存走
//! 保存边界校验 + 原子落盘 + 落盘后复验；删除按句柄相对递归且幂等。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::isotime::now_iso;
use crate::store::list::{parse_file, read_meta};
use crate::store::persist::{
    asset_identity, atomic_write, open_dir_bound, projects_dir, read_verified_file,
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
mod tests {
    use super::*;
    use crate::isotime::now_iso;
    use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir};
    use std::fs;

    #[test]
    fn persist_project_writes_envelope_and_passes_post_verify() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        let meta = persist_project(&cap(&projects), "p-1", doc).expect("保存");
        assert_eq!(meta.name, "剧");
        assert!(projects.join("p-1.json").exists(), "项目文件应落盘");
        cleanup_temp(&projects);
    }

    #[test]
    fn persist_project_rejects_untrusted_id_before_any_join() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        // 空资产索引下复验不设防：id 词法校验必须在任何路径拼接前拒绝
        let err = persist_project(&cap(&projects), "../evil", doc).unwrap_err();
        assert!(err.contains("非法"), "意外诊断：{err}");
        // 不得在 projects/ 之外创建任何文件
        assert!(
            fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
            "越界 id 不应写出 projects/"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn persist_project_replaces_existing_file_and_leaves_no_temp() {
        let projects = temp_projects_dir();
        let first = new_project_file("p-1", "一版".into(), now_iso());
        persist_project(&cap(&projects), "p-1", first).expect("首存");
        let second = new_project_file("p-1", "二版".into(), now_iso());
        persist_project(&cap(&projects), "p-1", second).expect("覆盖保存（rename 替换已存在目标）");
        let loaded = load_project_file(&cap(&projects), "p-1").expect("重读");
        assert_eq!(loaded.project.name, "二版");
        let leftovers: Vec<String> = fs::read_dir(&projects)
            .expect("扫描项目目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "遗留临时文件：{leftovers:?}");
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn persist_project_rejects_symlinked_target_without_following() {
        let projects = temp_projects_dir();
        let outside = projects.parent().expect("临时根").join("evil-target.json");
        fs::write(&outside, b"{}").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
        let doc = new_project_file("p-1", "剧".into(), now_iso());
        let err = persist_project(&cap(&projects), "p-1", doc).unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        // 链接未被跟随或覆盖：根外文件原样保留，链接本身仍在
        assert_eq!(fs::read(&outside).expect("读根外文件"), b"{}".to_vec());
        assert!(fs::symlink_metadata(projects.join("p-1.json"))
            .expect("链接仍在")
            .file_type()
            .is_symlink());
        cleanup_temp(&projects);
    }

    #[test]
    fn load_project_file_rejects_path_like_id_before_any_join() {
        let projects = temp_projects_dir();
        // 嵌套路径形态的 id：projects/ 内的资产/私有 JSON 不得经 load_project 读出
        let err = load_project_file(&cap(&projects), "p-1/assets/private").unwrap_err();
        assert!(
            err.contains("非法") || err.contains("不存在"),
            "意外诊断：{err}"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn load_project_file_reads_envelope_from_verified_handle() {
        let projects = temp_projects_dir();
        let doc = new_project_file("p-1", "午夜出租车".into(), now_iso());
        persist_project(&cap(&projects), "p-1", doc).expect("先保存");
        let loaded = load_project_file(&cap(&projects), "p-1").expect("从已验证句柄读取");
        assert_eq!(loaded.project.name, "午夜出租车");
        assert_eq!(loaded.schema_version, 1);
        cleanup_temp(&projects);
    }

    #[test]
    fn delete_project_files_removes_nested_asset_subtrees() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(assets.join("sub").join("deep")).expect("建嵌套目录");
        fs::write(assets.join("a.png"), b"A").expect("写资产");
        fs::write(assets.join("sub").join("b.png"), b"B").expect("写子目录资产");
        fs::write(assets.join("sub").join("deep").join("c.png"), b"C").expect("写深层资产");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        delete_project_files(&cap(&projects), "p-1").expect("删除项目");
        assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
        assert!(fs::symlink_metadata(projects.join("p-1.json")).is_err());
        cleanup_temp(&projects);
    }

    #[test]
    fn delete_project_files_removes_json_and_asset_tree_idempotently() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a.png"), b"A").expect("写资产");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        delete_project_files(&cap(&projects), "p-1").expect("删除项目");
        assert!(fs::symlink_metadata(projects.join("p-1.json")).is_err());
        assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
        // 幂等：文件与目录均已缺失时再删不报错
        assert!(delete_project_files(&cap(&projects), "p-1").is_ok());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn delete_project_files_unlinks_symlinks_without_following() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        let outside_dir = projects.parent().expect("临时根").join("keep");
        fs::create_dir_all(&outside_dir).expect("建根外目录");
        fs::write(outside_dir.join("secret.png"), b"s").expect("写根外文件");
        std::os::unix::fs::symlink(&outside_dir, assets.join("link")).expect("建目录符号链接");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        delete_project_files(&cap(&projects), "p-1").expect("删除项目");
        // 链接被移除但未跟随：根外目录与文件原样保留
        assert!(fs::symlink_metadata(outside_dir.join("secret.png")).is_ok());
        assert!(fs::symlink_metadata(&outside_dir).is_ok());
        assert!(fs::symlink_metadata(projects.join("p-1")).is_err());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn delete_project_files_keeps_record_when_asset_tree_removal_fails() {
        let projects = temp_projects_dir();
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a.png"), b"A").expect("写资产");
        fs::write(projects.join("p-1.json"), b"{}").expect("写项目文件");
        // 只读化资产目录：子项删除失败（非 root 用户无法 unlink）
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&assets).unwrap().permissions();
        perms.set_mode(0o555);
        fs::set_permissions(&assets, perms).expect("只读化");
        let result = delete_project_files(&cap(&projects), "p-1");
        let mut perms = fs::metadata(&assets).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(&assets, perms);
        assert!(result.is_err(), "资产目录删除失败应显式报错");
        // 权威项目文件必须仍在：项目可发现、删除可重试，不留孤儿媒体树
        assert!(
            projects.join("p-1.json").exists(),
            "项目记录先于资产目录被删，失败后媒体成不可发现孤儿"
        );
        cleanup_temp(&projects);
    }
}
