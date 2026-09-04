//! 跨项目资产复制（数据模型 §7.3 项目复制 = 文档级复制 + 媒体整目录
//! 拷贝）：全程句柄相对、逐项 no-follow，符号链接与异型条目拒绝，
//! 失败回滚不遗留半拷贝。

use cap_std::fs::Dir as CapDir;
use tauri::AppHandle;

use crate::store::persist::{asset_identity, open_dir_bound, projects_dir};
use crate::store::types::validate_id;
/// §7.3 复制项目：整目录拷贝项目资产（当前扁平布局下 `projects/{fromId}/
/// assets` → `projects/{toId}/assets`），供 §10.5 保存边界的实路径复验在
/// 副本侧通过。源资产目录缺失视为无资产（no-op）；存在时源根必须为非
/// 符号链接的实际目录，子树逐项 no-follow——符号链接与非普通文件条目
/// 拒绝；目标目录已存在视为异常（新副本 id 刚分配）。任一失败整次报错
/// 并回滚已拷贝的目标子树，不遗留半拷贝。
#[tauri::command]
pub fn copy_project_assets(app: AppHandle, from_id: String, to_id: String) -> Result<(), String> {
    let root = projects_dir(&app)?;
    copy_assets_tree(&root, &from_id, &to_id)
}
/// copy_project_assets 的可测内核。全程相对已打开的 projects 根目录句柄
/// 执行（§10.2 openat 语义，cap-std）：归类、目录打开、递归与文件创建
/// 不再退回路径名拼接——源/目标子目录在元数据检查后被并发替换（含换成
/// 符号链接）时，句柄相对解析仍不逃出 projects/，越界符号链接被沙箱拒绝。
fn copy_assets_tree(root: &CapDir, from_id: &str, to_id: &str) -> Result<(), String> {
    validate_id(from_id)?;
    validate_id(to_id)?;
    // 源项目目录先归类绑定（§10.2）：组合路径 `{from_id}/assets` 的
    // symlink_metadata 会跟随中间的 {from_id} 符号链接——projects/{from}
    // 被换成指向根内其他项目的链接时，归类与身份绑定都落在错误项目的
    // 真实目录上，复制会把无关媒体拷进新项目
    let proj_md = match root.symlink_metadata(from_id) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取源项目目录元数据失败：{e}")),
    };
    if proj_md.file_type().is_symlink() {
        return Err("源项目目录是符号链接，拒绝复制".into());
    }
    if !proj_md.is_dir() {
        return Err("源项目路径不是目录，拒绝复制".into());
    }
    let src_proj = open_dir_bound(root, from_id, &proj_md, "源项目目录")?;
    let md = match src_proj.symlink_metadata("assets") {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("读取源资产目录元数据失败：{e}")),
    };
    if md.file_type().is_symlink() {
        return Err("源资产目录是符号链接，拒绝复制".into());
    }
    if !md.is_dir() {
        return Err("源资产路径不是目录，拒绝复制".into());
    }
    match root.symlink_metadata(to_id) {
        Ok(_) => return Err(format!("目标资产目录已存在，拒绝复制：{to_id}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取目标资产目录元数据失败：{e}")),
    }
    // 拷贝目标是 {to}/assets：与 relPath 首段（§7.1）及实路径复验的资产根一致
    let src_dir = open_dir_bound(&src_proj, "assets", &md, "源资产目录")?;
    root.create_dir_all(to_id)
        .map_err(|e| format!("创建目标项目目录失败：{e}"))?;
    let dst_root = root
        .open_dir(to_id)
        .map_err(|e| format!("打开目标项目目录失败：{e}"))?;
    dst_root
        .create_dir("assets")
        .map_err(|e| format!("创建目标资产目录失败：{e}"))?;
    let dst_assets = dst_root
        .open_dir("assets")
        .map_err(|e| format!("打开目标资产目录失败：{e}"))?;
    if let Err(e) = copy_dir_handles(&src_dir, &dst_assets) {
        // 回滚清理同款句柄相对删除（§10.2）：dst_root 被并发换成符号链接时
        // remove_dir_all 只移除链接自身，不进入其指向的外部树
        let _ = root.remove_dir_all(to_id);
        return Err(e);
    }
    Ok(())
}
/// 递归拷贝目录树（句柄相对 + 逐项 no-follow，§10.2）：目录对应创建，
/// 普通文件逐个拷贝，符号链接与异型条目拒绝——副本绝不携带根外内容。
/// 递归与创建全部相对**已打开的目录句柄**进行：中间目录被并发替换时不再
/// 按路径名重新解析。源子目录经 open_dir_bound 绑定身份；源文件绑定打开
/// 句柄（Unix：按 (dev, ino) 与归类时身份比对），从同一句柄读出；目标
/// 文件以 create_new 排他创建，预置在目标路径上的符号链接无法截获写入；
/// 目标子目录 create_dir 排他创建后立即打开，残余窗口内的替换也被 cap-std
/// 沙箱限定在 projects/ 树内。
fn copy_dir_handles(src: &CapDir, dst: &CapDir) -> Result<(), String> {
    let entries = src
        .entries()
        .map_err(|e| format!("扫描源资产目录失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("扫描源资产目录失败：{e}"))?;
        // DirEntry::metadata 取 lstat 语义，不跟随符号链接
        let md = entry
            .metadata()
            .map_err(|e| format!("读取源资产条目元数据失败：{e}"))?;
        let name = entry.file_name();
        let shown = name.to_string_lossy();
        let ft = md.file_type();
        if ft.is_symlink() {
            return Err(format!("源资产子树含符号链接，拒绝复制：{shown}"));
        }
        if ft.is_dir() {
            let child_src = open_dir_bound(src, &name, &md, "源资产子目录")?;
            dst.create_dir(&name)
                .map_err(|e| format!("创建目标资产子目录失败（{shown}）：{e}"))?;
            let child_dst = dst
                .open_dir(&name)
                .map_err(|e| format!("打开目标资产子目录失败（{shown}）：{e}"))?;
            copy_dir_handles(&child_src, &child_dst)?;
        } else if ft.is_file() {
            copy_file_bound(src, &name, &md, dst)?;
        } else {
            return Err(format!("源资产子树含非普通文件条目：{shown}"));
        }
    }
    Ok(())
}
/// 单文件绑定拷贝（句柄相对）：源从句柄读（身份与归类时一致），目标排他创建。
fn copy_file_bound(
    src_dir: &CapDir,
    name: &std::ffi::OsStr,
    classified: &cap_std::fs::Metadata,
    dst_dir: &CapDir,
) -> Result<(), String> {
    let shown = name.to_string_lossy();
    let mut src = src_dir
        .open(name)
        .map_err(|e| format!("打开源资产失败（{shown}）：{e}"))?;
    #[cfg(unix)]
    {
        let fm = src
            .metadata()
            .map_err(|e| format!("读取源资产句柄元数据失败（{shown}）：{e}"))?;
        if asset_identity(&fm) != asset_identity(classified) {
            return Err(format!("源资产在拷贝期间被替换，拒绝复制：{shown}"));
        }
    }
    #[cfg(not(unix))]
    let _ = classified;
    let mut dst_file = dst_dir
        .open_with(
            name,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )
        .map_err(|e| format!("创建目标资产失败（{shown}）：{e}"))?;
    std::io::copy(&mut src, &mut dst_file)
        .map(|_| ())
        .map_err(|e| format!("拷贝资产文件失败（{shown}）：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir};
    use std::fs;

    #[test]
    fn copy_assets_tree_copies_regular_files_recursively() {
        let projects = temp_projects_dir();
        let src = projects.join("p-1").join("assets");
        fs::create_dir_all(src.join("sub")).expect("建源目录");
        fs::write(src.join("a.png"), b"A").expect("写资产");
        fs::write(src.join("sub").join("b.png"), b"B").expect("写子目录资产");
        copy_assets_tree(&cap(&projects), "p-1", "p-2").expect("拷贝项目资产");
        let dst = projects.join("p-2").join("assets");
        assert_eq!(fs::read(dst.join("a.png")).expect("副本文件缺失"), b"A");
        assert_eq!(
            fs::read(dst.join("sub").join("b.png")).expect("子目录副本缺失"),
            b"B"
        );
        cleanup_temp(&projects);
    }

    #[test]
    fn copy_assets_tree_noop_without_source_and_rejects_existing_destination() {
        let projects = temp_projects_dir();
        // 源项目无资产目录：no-op 成功（无资产项目的复制路径）
        assert!(copy_assets_tree(&cap(&projects), "p-1", "p-2").is_ok());
        fs::create_dir_all(projects.join("p-1").join("assets")).expect("建源目录");
        fs::create_dir_all(projects.join("p-3")).expect("预置目标");
        let err = copy_assets_tree(&cap(&projects), "p-1", "p-3").unwrap_err();
        assert!(err.contains("目标资产目录已存在"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn copy_assets_tree_rejects_symlink_and_rolls_back_partial_copy() {
        let projects = temp_projects_dir();
        let src = projects.join("p-1").join("assets");
        fs::create_dir_all(&src).expect("建源目录");
        fs::write(src.join("a.png"), b"A").expect("写资产");
        let outside = projects.parent().expect("临时根").join("outside.png");
        fs::write(&outside, b"secret").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, src.join("link.png")).expect("建符号链接");
        let err = copy_assets_tree(&cap(&projects), "p-1", "p-2").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        // 失败回滚：不遗留半拷贝的目标目录
        assert!(fs::symlink_metadata(projects.join("p-2")).is_err());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn copy_assets_tree_rejects_symlinked_source_project() {
        let projects = temp_projects_dir();
        // p-1 被换成指向根内其他项目 p-2 的符号链接：组合路径 {p-1}/assets
        // 的 no-follow 只看终点组件，归类与身份绑定都落在 p-2 的真实目录上
        let victim = projects.join("p-2").join("assets");
        fs::create_dir_all(&victim).expect("建资产目录");
        fs::write(victim.join("secret.png"), b"s").expect("写资产");
        std::os::unix::fs::symlink(projects.join("p-2"), projects.join("p-1"))
            .expect("建项目符号链接");
        let err = copy_assets_tree(&cap(&projects), "p-1", "p-3").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }
}
