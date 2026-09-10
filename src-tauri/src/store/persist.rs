//! 持久化原语（数据模型 §10.2 信任链）：受信根锚定句柄（projects_dir、
//! open_dir_bound 身份绑定、no-follow 归类 asset_stat/asset_identity）、
//! 控制文件读取与原子写——全程句柄相对执行，不按路径名重解析。

use std::fs;

use cap_std::{ambient_authority, fs::Dir as CapDir};
use tauri::{AppHandle, Manager};

use crate::store::types::new_id;
/// 资产路径组件的 no-follow 元数据（相对锚定句柄），缺失映射为「资产文件不存在」。
pub(crate) fn asset_stat(
    dir: &CapDir,
    comp: &str,
    rel_path: &str,
) -> Result<cap_std::fs::Metadata, String> {
    dir.symlink_metadata(comp).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("资产文件不存在：{rel_path}")
        } else {
            format!("读取资产路径元数据失败（{rel_path}）：{e}")
        }
    })
}
/// Unix 组件身份 (dev, ino)：读取与资产校验全程句柄相对后，身份比对只在
/// cap-std 元数据之间进行（归类元数据与打开句柄元数据同源）。
#[cfg(unix)]
pub(crate) fn asset_identity(md: &cap_std::fs::Metadata) -> (u64, u64) {
    use cap_std::fs::MetadataExt;
    (md.dev(), md.ino())
}
/// 项目根目录（§10.2 信任链）：canonicalize 应用数据根并以**受信根句柄**
/// 锚定——`projects/` 的创建、非符号链接校验与打开全部相对该句柄执行，
/// 打开经 (dev, ino) 身份绑定。返回的 projects 句柄供读/写/删/拷与持久性
/// 屏障内核复用，不按路径名重开（`open_ambient_dir` 与 fsync 重开都会把
/// 并发替换后的目录变成表面根）。路径名被换时：越界被沙箱拒绝，界内
/// 替换被身份绑定拒绝。
pub(crate) fn projects_dir(app: &AppHandle) -> Result<CapDir, String> {
    let root_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    fs::create_dir_all(&root_path).map_err(|e| format!("创建应用数据目录失败：{e}"))?;
    let root_path = root_path
        .canonicalize()
        .map_err(|e| format!("解析应用数据目录真实路径失败：{e}"))?;
    let root = CapDir::open_ambient_dir(&root_path, ambient_authority())
        .map_err(|e| format!("打开应用数据根目录失败：{e}"))?;
    match root.symlink_metadata("projects") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => root
            .create_dir("projects")
            .map_err(|e| format!("创建项目目录失败：{e}"))?,
        Err(e) => return Err(format!("读取项目目录元数据失败：{e}")),
    }
    let md = root
        .symlink_metadata("projects")
        .map_err(|e| format!("读取项目目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("拒绝符号链接形式的项目目录".into());
    }
    if !md.is_dir() {
        return Err("项目目录路径不是目录".into());
    }
    open_dir_bound(&root, "projects", &md, "项目目录")
}
/// 打开已归类为实际目录的子目录并绑定身份（§10.2）：cap-std 的 open_dir
/// 在沙箱内跟随符号链接，Unix 上以打开句柄的 (dev, ino) 与归类时身份比对
/// ——归类后被换成符号链接/另一实体即拒绝，不从被替换的目标读出；非
/// Unix 无身份可比，改为打开后重走 no-follow 归类复核（换名残余窗口由
/// cap-std 沙箱限定在 projects/ 树内）。
#[allow(unused_variables)]
pub(crate) fn open_dir_bound<P: AsRef<std::path::Path>>(
    parent: &CapDir,
    rel: P,
    classified: &cap_std::fs::Metadata,
    label: &str,
) -> Result<CapDir, String> {
    let opened = parent
        .open_dir(&rel)
        .map_err(|e| format!("打开{label}失败：{e}"))?;
    #[cfg(unix)]
    {
        let fm = opened
            .dir_metadata()
            .map_err(|e| format!("读取{label}句柄元数据失败：{e}"))?;
        if asset_identity(&fm) != asset_identity(classified) {
            return Err(format!("{label}在归类后被替换，拒绝操作"));
        }
    }
    // 非 Unix 无 (dev, ino) 可比（该助手已服务破坏性删除递归——不绑定的
    // 话，归类后被换名的目录会被按名重开、无辜项目被清空）：打开后重走
    // no-follow 归类，换成符号链接/异型即拒绝（换成另一真实目录的残余
    // 窗口仍在，由 cap-std 沙箱限定在 projects/ 树内）
    #[cfg(not(unix))]
    {
        let recheck = parent
            .symlink_metadata(&rel)
            .map_err(|e| format!("复核{label}元数据失败：{e}"))?;
        if recheck.file_type().is_symlink()
            || !recheck.is_dir()
            || !opened
                .dir_metadata()
                .map_err(|e| format!("读取{label}句柄元数据失败：{e}"))?
                .is_dir()
        {
            return Err(format!("{label}在归类后被替换，拒绝操作"));
        }
    }
    #[cfg(not(unix))]
    let _ = classified;
    Ok(opened)
}
/// §10.2 控制文件信任链——读取前置校验（句柄相对，no-follow）：拒绝符号
/// 链接（无论指向根内或根外）、要求普通文件。相对 projects_dir 的**受信
/// 根锚定句柄**解析使包含关系由 cap-std 沙箱保证，无需 canonical 路径
/// 比对——路径名比对在 projects/ 校验后被并发整体替换时会验到替换树、
/// 相互包含照样通过。返回目录项身份（Unix 为 (dev, ino)）供调用方在打开
/// 后绑定同一实体——校验与打开之间被替换（换成符号链接或另一文件）即
/// 拒绝且不读取。
fn verify_control_file(root: &CapDir, name: &str) -> Result<Option<(u64, u64)>, String> {
    let md = root
        .symlink_metadata(name)
        .map_err(|e| format!("读取项目文件元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("项目文件是符号链接，拒绝读取".into());
    }
    if !md.is_file() {
        return Err("项目文件不是普通文件".into());
    }
    #[cfg(unix)]
    {
        Ok(Some(asset_identity(&md)))
    }
    #[cfg(not(unix))]
    Ok(None)
}
/// 经已验证句柄读取项目文件文本（load/list 共用内核）：校验、打开与读取
/// 全程相对 projects_dir 返回的**受信根锚定句柄**——归类（no-follow 元数据，
/// 拒符号链接、要求普通文件）、打开与 (dev, ino) 身份比对均不按路径名重新
/// 解析，projects/ 路径名在校验后被并发整体替换（rename 换目录树）也无法
/// 把读取引到替换树；cap-std 沙箱保证解析不逃出锚定根，校验与打开之间的
/// 目录项替换（换成符号链接或另一文件）由身份比对拒绝且不读取。
pub(crate) fn read_verified_file(root: &CapDir, name: &str) -> Result<String, String> {
    let verified_identity = verify_control_file(root, name)?;
    use std::io::Read;
    let mut file = root
        .open(name)
        .map_err(|e| format!("打开项目文件失败：{e}"))?;
    #[cfg(unix)]
    if let Some(id) = verified_identity {
        let fm = file
            .metadata()
            .map_err(|e| format!("读取项目文件句柄元数据失败：{e}"))?;
        if asset_identity(&fm) != id {
            return Err("项目文件在读取前被替换，拒绝读取".into());
        }
    }
    // 非 Unix 无 (dev, ino) 可比：打开后重走 no-follow 归类，换成符号链接/
    // 异型即拒绝（换成另一普通文件的残余窗口仍在，由 cap-std 沙箱限界内）
    #[cfg(not(unix))]
    {
        verify_control_file(root, name)?;
        match file.metadata() {
            Ok(fm) if fm.is_file() => {}
            _ => return Err("项目文件在读取前被替换，拒绝读取".into()),
        }
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("读取项目文件失败：{e}"))?;
    Ok(text)
}
/// 原子写控制文件（§10.2）：全程相对已验证父目录的打开句柄执行（cap-std
/// openat 语义）——目标归类与 rename 前复核（现存目标为符号链接或非普通
/// 文件即拒绝，不跟随）、随机同目录名临时文件以 O_CREAT|O_EXCL 排他创建
/// （预置 `.tmp` 符号链接无法截获写入）、写入 + flush/fsync、句柄相对
/// rename 原子覆盖（cap-std 在 Windows 上以替换语义实现 rename，std::fs::
/// rename 在该平台不替换已存在目标，已建项目的每次保存都会失败）→ 父目录
/// fsync（持久性屏障，打开/同步失败向上传播、不粉饰成功）；失败尽力清理
/// 临时文件。file_name 须为单段文件名（不含路径分量）：归类、创建与
/// rename 之外的越界形态在此拒绝，不得相对句柄逃出 projects/。
pub(crate) fn atomic_write(root: &CapDir, file_name: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    if std::path::Path::new(file_name).components().count() != 1 {
        return Err(format!("项目文件名含路径分量，拒绝：{file_name}"));
    }
    // 目标归类（现存为符号链接或非普通文件即拒绝，不跟随）：仅**确证缺失**
    // 视作新建目标——权限/瞬态 I/O 错误当缺失放行会跳过归类，rename 可能
    // 覆盖未验证的目录项（fail closed）
    let check_target = || -> Result<(), String> {
        match root.symlink_metadata(file_name) {
            Ok(md) if md.file_type().is_symlink() => Err("拒绝符号链接形式的项目文件".into()),
            Ok(md) if !md.is_file() => Err("项目路径不是普通文件".into()),
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("读取项目文件元数据失败：{e}")),
        }
    };
    check_target()?;
    let tmp_name = format!(".{file_name}.{}.tmp", new_id());
    let result = (|| -> Result<(), String> {
        let mut f = root
            .open_with(
                &tmp_name,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .map_err(|e| format!("创建临时文件失败：{e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("写入项目失败：{e}"))?;
        f.sync_all().map_err(|e| format!("同步临时文件失败：{e}"))?;
        drop(f);
        // rename 前复核现存目标（§10.2）：写临时文件期间被换上的符号链接
        // 或异型条目在此拒绝，不被 rename 覆盖
        check_target()?;
        root.rename(&tmp_name, root, file_name)
            .map_err(|e| format!("落盘项目失败：{e}"))?;
        // 持久性屏障同步锚定句柄本身（经其重新绑定自身再 fsync，不按路径名
        // 重开——否则屏障加到并发替换后的目录上，保存成功而加载另一棵树）
        #[cfg(unix)]
        root.open_dir(".")
            .and_then(|d| d.into_std_file().sync_all())
            .map_err(|e| format!("同步项目目录失败（持久性屏障缺失）：{e}"))?;
        // Windows 无法对目录句柄 fsync：跳过屏障而非误报成功写失败
        #[cfg(not(unix))]
        let _ = root;
        Ok(())
    })();
    if result.is_err() {
        let _ = root.remove_file(&tmp_name);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::{cap, cleanup_temp, temp_projects_dir};

    #[test]
    fn verify_control_file_requires_regular_file() {
        let projects = temp_projects_dir();
        let file = projects.join("p-1.json");
        fs::write(&file, b"{}").expect("写项目文件");
        assert!(verify_control_file(&cap(&projects), "p-1.json").is_ok());
        // 目录占位：不是普通文件
        let dir_as_file = projects.join("p-2.json");
        fs::create_dir(&dir_as_file).expect("建目录占位");
        let err = verify_control_file(&cap(&projects), "p-2.json").unwrap_err();
        assert!(err.contains("普通文件"), "意外诊断：{err}");
        // 缺失文件拒绝（读取前置）
        assert!(verify_control_file(&cap(&projects), "p-3.json").is_err());
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn verify_control_file_rejects_symlinked_project_file() {
        let projects = temp_projects_dir();
        let outside = projects.parent().expect("临时根").join("evil.json");
        fs::write(&outside, b"{}").expect("写根外文件");
        std::os::unix::fs::symlink(&outside, projects.join("p-1.json")).expect("建符号链接");
        let err = verify_control_file(&cap(&projects), "p-1.json").unwrap_err();
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }

    #[test]
    fn atomic_write_rejects_path_like_file_name() {
        let projects = temp_projects_dir();
        // 句柄相对写入的最后边界：嵌套形态的文件名不得相对句柄逃出 projects/
        let err = atomic_write(&cap(&projects), "../evil.json", "{}").unwrap_err();
        assert!(err.contains("路径分量"), "意外诊断：{err}");
        assert!(
            fs::symlink_metadata(projects.parent().expect("临时根").join("evil.json")).is_err(),
            "含路径分量的文件名不应写出 projects/"
        );
        cleanup_temp(&projects);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_fails_closed_on_target_metadata_errors() {
        let projects = temp_projects_dir();
        let root = cap(&projects);
        // 收权让 symlink_metadata 报 EACCES（非 NotFound）：归类步骤必须
        // 显式上抛，不得把错误当目标缺失放行后误报后续步骤
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&projects).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&projects, perms).expect("收权");
        let err = atomic_write(&root, "p-1.json", "{}").unwrap_err();
        let mut perms = fs::metadata(&projects).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(&projects, perms);
        assert!(err.contains("元数据"), "意外诊断：{err}");
        cleanup_temp(&projects);
    }
}
