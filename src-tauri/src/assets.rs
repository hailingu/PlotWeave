//! 项目资产导入与预检命令（数据模型 §7.1/§7.3/§9.3）：
//! - `import_project_asset_from_library`：库资产拖上画布 = 文件**拷贝**进项目
//!   `assets/` 并生成项目级 AssetRef（新 id）——源读取与目标写入全程相对
//!   受信锚定句柄 + no-follow（§10.2 信任链，与 store 内核同域）；
//! - `validate_project_asset`：前端 `set_asset` 调度前的强制预检（§9.3）——
//!   单条 AssetRef 形状校验 + 实路径复验，返回规范化后的条目；
//! - `project_asset_path`：缩略图等媒体展示的绝对路径（前端 convertFileSrc
//!   拼接），交出前完成 relPath 词法校验与实路径复验。

use std::fs;
use std::io::Write;

use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::isotime::{is_canonical_utc_timestamp, now_iso};
use crate::library::ext_for;
#[cfg(unix)]
use crate::store::asset_identity;
use crate::store::{
    asset_stat, is_canonical_mime, is_valid_asset_rel_path, new_id, open_dir_bound, projects_dir,
    validate_id, verify_asset_real_path,
};

/// 新资产 id：`pa-{ms:x}-{seq:x}`（复用 store 的毫秒 + 进程内计数不碰撞内核）。
fn new_asset_id() -> String {
    let nid = new_id();
    format!("pa-{}", &nid[2..])
}

/// 资产库根目录的受信锚定句柄（§10.2 信任链，与 store::projects_dir 同构）：
/// canonicalize 应用数据根 → 锚定 → `library/` 缺失即创建、现存必须是非符号
/// 链接的真实目录并经身份绑定打开——不按路径名重开。
fn library_root(app: &AppHandle) -> Result<CapDir, String> {
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
    match root.symlink_metadata("library") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => root
            .create_dir("library")
            .map_err(|e| format!("创建资产库目录失败：{e}"))?,
        Err(e) => return Err(format!("读取资产库目录元数据失败：{e}")),
    }
    let md = root
        .symlink_metadata("library")
        .map_err(|e| format!("读取资产库目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("拒绝符号链接形式的资产库目录".into());
    }
    if !md.is_dir() {
        return Err("资产库路径不是目录".into());
    }
    open_dir_bound(&root, "library", &md, "资产库目录")
}

/// 读取库索引并定位条目（相对受信库根句柄，no-follow）：返回
/// (relPath, 规范化 mime, 文件名组件)。索引缺失/损坏/条目缺失/条目形状非法
/// 均为显式错误——坏数据绝不进入拷贝流程。
fn find_library_entry(
    library: &CapDir,
    library_asset_id: &str,
) -> Result<(String, String, String), String> {
    match library.symlink_metadata("library.json") {
        Ok(md) if md.file_type().is_symlink() => {
            return Err("资产库索引是符号链接，拒绝读取".into())
        }
        Ok(md) if !md.is_file() => return Err("资产库索引不是普通文件".into()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("库资产不存在：{library_asset_id}"))
        }
        Err(e) => return Err(format!("读取资产库索引元数据失败：{e}")),
    }
    use std::io::Read;
    let mut text = String::new();
    library
        .open("library.json")
        .map_err(|e| format!("打开资产库索引失败：{e}"))?
        .read_to_string(&mut text)
        .map_err(|e| format!("读取资产库索引失败：{e}"))?;
    let index: Value = serde_json::from_str(&text).map_err(|e| format!("资产库索引损坏：{e}"))?;
    let entry = index
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|a| a.get("id").and_then(Value::as_str) == Some(library_asset_id))
        })
        .ok_or_else(|| format!("库资产不存在：{library_asset_id}"))?;
    let rel_path = entry
        .get("relPath")
        .and_then(Value::as_str)
        .filter(|p| is_valid_asset_rel_path(p))
        .ok_or_else(|| format!("库资产 {library_asset_id} 的 relPath 非法，拒绝导入"))?;
    let mime_raw = entry
        .get("mime")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("库资产 {library_asset_id} 的 mime 缺失，拒绝导入"))?;
    let mime = mime_raw.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(format!("库资产 {library_asset_id} 的 mime 非法，拒绝导入"));
    }
    let name = rel_path
        .rsplit('/')
        .next()
        .ok_or_else(|| format!("库资产 {library_asset_id} 的 relPath 非法，拒绝导入"))?;
    Ok((rel_path.to_string(), mime, name.to_string()))
}

/// 打开库媒体文件（相对受信库根句柄逐组件 no-follow 解析）：中间组件必须是
/// 非符号链接目录（open_dir_bound 身份绑定），终点必须是普通文件且打开句柄
/// 按 (dev, ino) 与归类实体一致（Unix）——校验与打开之间被替换即拒绝。
fn open_library_asset(library: &CapDir, rel_path: &str) -> Result<cap_std::fs::File, String> {
    let comps: Vec<&str> = rel_path.split('/').collect();
    let Some((last, parents)) = comps.split_last() else {
        return Err(format!("库资产路径为空：{rel_path}"));
    };
    let mut dir = library
        .try_clone()
        .map_err(|e| format!("复制资产库根句柄失败：{e}"))?;
    for comp in parents {
        let md = asset_stat(&dir, comp, rel_path)?;
        if md.file_type().is_symlink() {
            return Err(format!("库资产路径含符号链接：{rel_path}"));
        }
        if !md.is_dir() {
            return Err(format!("库资产路径的中间组件不是目录：{rel_path}"));
        }
        dir = open_dir_bound(&dir, comp, &md, "资产库中间目录")?;
    }
    let md = asset_stat(&dir, last, rel_path)?;
    if md.file_type().is_symlink() {
        return Err(format!("库资产路径含符号链接：{rel_path}"));
    }
    if !md.is_file() {
        return Err(format!("库资产路径不是普通文件：{rel_path}"));
    }
    let file = dir
        .open(last)
        .map_err(|e| format!("打开库资产文件失败（{rel_path}）：{e}"))?;
    #[cfg(unix)]
    {
        let fm = file
            .metadata()
            .map_err(|e| format!("读取库资产句柄元数据失败（{rel_path}）：{e}"))?;
        if asset_identity(&fm) != asset_identity(&md) {
            return Err(format!("库资产文件在校验期间被替换：{rel_path}"));
        }
    }
    Ok(file)
}

/// 确保子目录存在并返回身份绑定的打开句柄：缺失即创建（排他语义由后续
/// 归类 + open_dir_bound 保证），现存必须是非符号链接的真实目录。
fn ensure_child_dir(parent: &CapDir, name: &str, label: &str) -> Result<CapDir, String> {
    match parent.symlink_metadata(name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => parent
            .create_dir(name)
            .map_err(|e| format!("创建{label}失败：{e}"))?,
        Err(e) => return Err(format!("读取{label}元数据失败：{e}")),
        Ok(_) => {}
    }
    let md = parent
        .symlink_metadata(name)
        .map_err(|e| format!("读取{label}元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err(format!("{label}是符号链接，拒绝写入"));
    }
    if !md.is_dir() {
        return Err(format!("{label}不是目录，拒绝写入"));
    }
    open_dir_bound(parent, name, &md, label)
}

/// 同目录原子落盘内核（排他临时文件 + sync + rename + 父目录 fsync 持久性
/// 屏障，Unix）：rename 前复核目标仍未被占（fail closed），失败尽力清理
/// 临时文件。写入动作由 write 闭包提供（拷贝源文件 / 写生成字节共用）。
fn atomic_write_with<F>(dir: &CapDir, final_name: &str, write: F) -> Result<(), String>
where
    F: FnOnce(&mut cap_std::fs::File) -> std::io::Result<()>,
{
    match dir.symlink_metadata(final_name) {
        Ok(_) => return Err(format!("目标资产文件已存在：{final_name}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取目标资产元数据失败：{e}")),
    }
    let tmp_name = format!(".{final_name}.{}.tmp", new_id());
    let result = (|| -> Result<(), String> {
        let mut dst = dir
            .open_with(
                &tmp_name,
                cap_std::fs::OpenOptions::new().write(true).create_new(true),
            )
            .map_err(|e| format!("创建临时资产文件失败：{e}"))?;
        write(&mut dst).map_err(|e| format!("写入资产文件失败：{e}"))?;
        dst.sync_all()
            .map_err(|e| format!("同步资产文件失败：{e}"))?;
        drop(dst);
        match dir.symlink_metadata(final_name) {
            Ok(_) => return Err(format!("目标资产文件已存在：{final_name}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("读取目标资产元数据失败：{e}")),
        }
        dir.rename(&tmp_name, dir, final_name)
            .map_err(|e| format!("落盘资产文件失败：{e}"))?;
        #[cfg(unix)]
        dir.open_dir(".")
            .and_then(|d| d.into_std_file().sync_all())
            .map_err(|e| format!("同步资产目录失败（持久性屏障缺失）：{e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = dir.remove_file(&tmp_name);
    }
    result
}

/// 流式拷贝进目标目录（原子落盘，与 store::atomic_write 同构）。
fn copy_into_dir(
    src: &mut cap_std::fs::File,
    dir: &CapDir,
    final_name: &str,
) -> Result<(), String> {
    let mut src = src;
    atomic_write_with(dir, final_name, |dst| {
        std::io::copy(&mut src, dst).map(|_| ())
    })
}

/// 项目控制文件存在性归类校验：不存在/符号链接/非普通文件均拒绝——
/// 不替不存在的项目建资产目录（导入与生成媒体落盘共用）。
fn ensure_project_control(projects: &CapDir, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let control = format!("{id}.json");
    match projects.symlink_metadata(&control) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("项目不存在：{id}"))
        }
        Err(e) => return Err(format!("读取项目文件元数据失败：{e}")),
        Ok(md) => {
            if md.file_type().is_symlink() {
                return Err("项目文件是符号链接，拒绝写入资产".into());
            }
            if !md.is_file() {
                return Err("项目文件不是普通文件，拒绝写入资产".into());
            }
        }
    }
    Ok(())
}

/// 库资产 → 项目资产的导入内核（给定已验证的 projects 与 library 根句柄）：
/// 项目控制文件必须存在且通过归类校验（不替不存在的项目建资产目录）；
/// 库条目形状校验 → 源文件身份绑定打开 → 目标目录确保 → 原子拷贝落盘 →
/// 返回项目级 AssetRef（新 id、source=upload、规范 UTC createdAt）。
fn import_asset_from_library(
    projects: &CapDir,
    library: &CapDir,
    id: &str,
    library_asset_id: &str,
) -> Result<Value, String> {
    ensure_project_control(projects, id)?;
    let (rel_path, mime, name) = find_library_entry(library, library_asset_id)?;
    let mut src = open_library_asset(library, &rel_path)?;
    let project_dir = ensure_child_dir(projects, id, "项目资产根")?;
    let assets_dir = ensure_child_dir(&project_dir, "assets", "项目资产目录")?;
    let asset_id = new_asset_id();
    let final_name = format!("{asset_id}.{}", ext_for(&name, &mime));
    copy_into_dir(&mut src, &assets_dir, &final_name)?;
    Ok(json!({
        "id": asset_id,
        "relPath": format!("assets/{final_name}"),
        "mime": mime,
        "source": "upload",
        "createdAt": now_iso(),
    }))
}

/// 生成媒体 MIME → 文件名扩展（生成产物没有源文件名，只按 MIME 映射；
/// 调用方已按字节魔数定型 MIME，未知值兜底 bin）。
fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// 生成媒体落盘内核（docs/data-model.md §13 outputs 槽位的媒体侧）：
/// 字节经原子写入进项目 `assets/`，返回 `source=generated` 的项目级
/// AssetRef（新 id、规范 UTC createdAt）。项目控制文件必须存在且通过
/// 归类校验（不替不存在的项目建资产目录）。
pub(crate) fn write_generated_asset(
    projects: &CapDir,
    id: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<Value, String> {
    ensure_project_control(projects, id)?;
    let project_dir = ensure_child_dir(projects, id, "项目资产根")?;
    let assets_dir = ensure_child_dir(&project_dir, "assets", "项目资产目录")?;
    let asset_id = new_asset_id();
    let final_name = format!("{asset_id}.{}", ext_for_mime(mime));
    atomic_write_with(&assets_dir, &final_name, |dst| dst.write_all(bytes))?;
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
fn validate_project_asset_with(root: &CapDir, id: &str, asset: &Value) -> Result<Value, String> {
    let normalized = validate_asset_ref(asset)?;
    let rel_path = normalized
        .get("relPath")
        .and_then(Value::as_str)
        .ok_or("资产 relPath 缺失")?;
    let asset_id = normalized
        .get("id")
        .and_then(Value::as_str)
        .ok_or("资产 id 缺失")?;
    verify_asset_real_path(root, id, rel_path).map_err(|e| format!("资产 {asset_id}：{e}"))?;
    Ok(normalized)
}

/// 库资产导入命令（§7.3 库资产进入项目 = 拷贝）：返回新 AssetRef 交前端
/// 并入会话资产索引与引用位绑定。
#[tauri::command]
pub fn import_project_asset_from_library(
    app: AppHandle,
    id: String,
    library_asset_id: String,
) -> Result<Value, String> {
    let projects = projects_dir(&app)?;
    let library = library_root(&app)?;
    import_asset_from_library(&projects, &library, &id, &library_asset_id)
}

/// set_asset 调度前的强制预检命令（§9.3）：形状 + 实路径复验，返回规范化
/// AssetRef（分发器必须使用返回值而非调用方原值）。
#[tauri::command]
pub fn validate_project_asset(app: AppHandle, id: String, asset: Value) -> Result<Value, String> {
    validate_id(&id)?;
    let root = projects_dir(&app)?;
    validate_project_asset_with(&root, &id, &asset)
}

/// 媒体展示的资产绝对路径（前端 convertFileSrc 拼接缩略图）：relPath 词法
/// 校验 + 实路径复验通过后才交出路径——未验证的路径不进入媒体管线。
#[tauri::command]
pub fn project_asset_path(app: AppHandle, id: String, rel_path: String) -> Result<String, String> {
    validate_id(&id)?;
    if !is_valid_asset_rel_path(&rel_path) {
        return Err(format!("资产 relPath 非法：{rel_path}"));
    }
    let root = projects_dir(&app)?;
    verify_asset_real_path(&root, &id, &rel_path)?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .canonicalize()
        .map_err(|e| format!("解析应用数据目录真实路径失败：{e}"))?;
    let mut path = base.join("projects").join(&id);
    for comp in rel_path.split('/') {
        path = path.join(comp);
    }
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "资产路径含非法字符".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    /// 测试内核的受信句柄：对临时目录做环境打开（等价生产端锚定句柄）。
    fn cap(p: &Path) -> CapDir {
        CapDir::open_ambient_dir(p, ambient_authority()).expect("打开测试根句柄")
    }

    /// 唯一临时根：`{tmp}/pw-assets-test-{new_id}/` 下含 `projects/` 与
    /// `library/assets/`；返回 (projects, library, root)——root 供清理。
    fn temp_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("pw-assets-test-{}", new_id()));
        fs::create_dir_all(root.join("projects")).expect("创建临时 projects 目录");
        fs::create_dir_all(root.join("library").join("assets")).expect("创建临时 library 目录");
        (root.join("projects"), root.join("library"), root)
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    fn seed_project(projects: &Path, id: &str) {
        fs::write(projects.join(format!("{id}.json")), b"{}").expect("写入项目控制文件");
    }

    /// 库索引 + 媒体文件的最小合法 fixture（索引条目按 library.rs 现有形状）。
    fn seed_library(library: &Path, id: &str, file: &str, bytes: &[u8], mime: &str) {
        fs::write(library.join("assets").join(file), bytes).expect("写入库媒体文件");
        let index = json!({
            "assets": [{
                "id": id,
                "name": file,
                "kind": "character",
                "mime": mime,
                "relPath": format!("assets/{file}"),
            }],
            "groups": [],
        });
        fs::write(
            library.join("library.json"),
            serde_json::to_string(&index).expect("序列化库索引"),
        )
        .expect("写入库索引");
    }

    #[test]
    fn import_copies_file_and_returns_project_asset_ref() {
        let (projects, library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        seed_library(&library, "la-1", "la-1.png", b"PNGDATA", "image/png");
        let asset = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect("导入应成功");
        let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
        assert!(asset_id.starts_with("pa-"), "意外 id 前缀：{asset_id}");
        assert_eq!(
            asset.get("relPath").and_then(Value::as_str),
            Some(format!("assets/{asset_id}.png").as_str())
        );
        assert_eq!(asset.get("mime").and_then(Value::as_str), Some("image/png"));
        assert_eq!(asset.get("source").and_then(Value::as_str), Some("upload"));
        let created = asset
            .get("createdAt")
            .and_then(Value::as_str)
            .expect("createdAt 缺失");
        assert!(
            is_canonical_utc_timestamp(created),
            "createdAt 非规范 UTC：{created}"
        );
        // 拷贝字节一致，且通过项目侧实路径复验
        let copied = projects
            .join("p-1")
            .join("assets")
            .join(format!("{asset_id}.png"));
        assert_eq!(fs::read(&copied).expect("副本缺失"), b"PNGDATA");
        assert!(
            verify_asset_real_path(&cap(&projects), "p-1", &format!("assets/{asset_id}.png"))
                .is_ok()
        );
        // 源文件保持不动（拷贝语义）
        assert_eq!(
            fs::read(library.join("assets").join("la-1.png")).expect("源文件缺失"),
            b"PNGDATA"
        );
        cleanup(&root);
    }

    #[test]
    fn import_twice_into_same_project_reuses_existing_dirs() {
        let (projects, library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
        import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect("首次导入");
        let second = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect("现存资产目录下二次导入");
        let file_count = fs::read_dir(projects.join("p-1").join("assets"))
            .expect("读取资产目录")
            .count();
        assert_eq!(file_count, 2, "两次导入应各落一份副本");
        assert!(second.get("id").and_then(Value::as_str).is_some());
        cleanup(&root);
    }

    #[test]
    fn import_rejects_missing_project_and_unknown_library_asset() {
        let (projects, library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        seed_library(&library, "la-1", "la-1.png", b"A", "image/png");
        let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-9", "la-1")
            .expect_err("不存在的项目应拒绝");
        assert!(err.contains("项目不存在"), "意外诊断：{err}");
        let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-9")
            .expect_err("未知库资产应拒绝");
        assert!(err.contains("库资产不存在"), "意外诊断：{err}");
        cleanup(&root);
    }

    #[test]
    fn import_rejects_index_entry_with_escaping_rel_path() {
        let (projects, library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        fs::write(library.join("assets").join("a.png"), b"A").expect("写库媒体");
        let index = json!({
            "assets": [{ "id": "la-1", "name": "a.png", "mime": "image/png", "relPath": "../a.png" }],
            "groups": [],
        });
        fs::write(
            library.join("library.json"),
            serde_json::to_string(&index).expect("序列化"),
        )
        .expect("写库索引");
        let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect_err("越界 relPath 应拒绝");
        assert!(err.contains("relPath 非法"), "意外诊断：{err}");
        cleanup(&root);
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_symlinked_library_source() {
        let (projects, library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        fs::write(root.join("secret.png"), b"SECRET").expect("写根外文件");
        std::os::unix::fs::symlink(
            root.join("secret.png"),
            library.join("assets").join("la-1.png"),
        )
        .expect("建符号链接");
        let index = json!({
            "assets": [{ "id": "la-1", "name": "la-1.png", "mime": "image/png", "relPath": "assets/la-1.png" }],
            "groups": [],
        });
        fs::write(
            library.join("library.json"),
            serde_json::to_string(&index).expect("序列化"),
        )
        .expect("写库索引");
        let err = import_asset_from_library(&cap(&projects), &cap(&library), "p-1", "la-1")
            .expect_err("符号链接源应拒绝");
        assert!(err.contains("符号链接"), "意外诊断：{err}");
        assert!(
            fs::symlink_metadata(projects.join("p-1").join("assets")).is_err()
                || fs::read_dir(projects.join("p-1").join("assets"))
                    .expect("读资产目录")
                    .count()
                    == 0,
            "拒绝导入不得留下资产文件"
        );
        cleanup(&root);
    }

    /// 合法 AssetRef fixture（p-1 下落有对应媒体文件）。
    fn seed_valid_asset(projects: &Path) -> Value {
        let assets = projects.join("p-1").join("assets");
        fs::create_dir_all(&assets).expect("建资产目录");
        fs::write(assets.join("a1.png"), b"PNG").expect("写资产文件");
        json!({
            "id": "a1",
            "relPath": "assets/a1.png",
            "mime": "image/png",
            "source": "upload",
            "createdAt": "2026-09-04T08:00:00.000Z",
        })
    }

    #[test]
    fn validate_accepts_and_normalizes_valid_asset_ref() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        let mut asset = seed_valid_asset(&projects);
        // 大小写/空白非规范的 mime 由预检规范化后放行
        asset["mime"] = json!(" Image/PNG ");
        let out = validate_project_asset_with(&cap(&projects), "p-1", &asset).expect("应通过");
        assert_eq!(out.get("mime").and_then(Value::as_str), Some("image/png"));
        assert_eq!(out.get("id").and_then(Value::as_str), Some("a1"));
        cleanup(&root);
    }

    #[test]
    fn validate_rejects_shape_violations() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        let good = seed_valid_asset(&projects);
        for (patch, expect_msg) in [
            (json!({"relPath": "../evil.png"}), "relPath"),
            (json!({"mime": "not-a-mime"}), "mime"),
            (json!({"source": "mystery"}), "source"),
            (json!({"createdAt": "2026-08-01"}), "createdAt"),
        ] {
            let mut bad = good.clone();
            for (k, v) in patch.as_object().expect("补丁对象") {
                bad[k] = v.clone();
            }
            let err = validate_project_asset_with(&cap(&projects), "p-1", &bad)
                .expect_err("形状违规应拒绝");
            assert!(err.contains(expect_msg), "诊断缺 {expect_msg}：{err}");
        }
        cleanup(&root);
    }

    #[test]
    fn validate_rejects_missing_or_swapped_media_file() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        fs::create_dir_all(projects.join("p-1").join("assets")).expect("建资产目录");
        let asset = json!({
            "id": "a1",
            "relPath": "assets/gone.png",
            "mime": "image/png",
            "source": "upload",
            "createdAt": "2026-09-04T08:00:00.000Z",
        });
        let err = validate_project_asset_with(&cap(&projects), "p-1", &asset)
            .expect_err("媒体缺失应拒绝");
        assert!(err.contains("资产文件不存在"), "意外诊断：{err}");
        cleanup(&root);
    }

    #[test]
    fn write_generated_asset_lands_bytes_and_generated_ref() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3];
        let asset = write_generated_asset(&cap(&projects), "p-1", bytes, "image/png")
            .expect("生成媒体落盘应成功");
        let asset_id = asset.get("id").and_then(Value::as_str).expect("id 缺失");
        assert!(asset_id.starts_with("pa-"), "意外 id 前缀：{asset_id}");
        assert_eq!(
            asset.get("relPath").and_then(Value::as_str),
            Some(format!("assets/{asset_id}.png").as_str())
        );
        assert_eq!(
            asset.get("source").and_then(Value::as_str),
            Some("generated")
        );
        assert_eq!(asset.get("mime").and_then(Value::as_str), Some("image/png"));
        let created = asset
            .get("createdAt")
            .and_then(Value::as_str)
            .expect("createdAt 缺失");
        assert!(
            is_canonical_utc_timestamp(created),
            "createdAt 非规范 UTC：{created}"
        );
        // 字节一致且通过项目侧实路径复验
        let landed = projects
            .join("p-1")
            .join("assets")
            .join(format!("{asset_id}.png"));
        assert_eq!(fs::read(&landed).expect("落盘文件缺失"), bytes);
        assert!(
            verify_asset_real_path(&cap(&projects), "p-1", &format!("assets/{asset_id}.png"))
                .is_ok()
        );
        cleanup(&root);
    }

    #[test]
    fn write_generated_asset_rejects_missing_project() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        let err = write_generated_asset(&cap(&projects), "p-9", b"PNG", "image/png")
            .expect_err("不存在的项目应拒绝");
        assert!(err.contains("项目不存在"), "意外诊断：{err}");
        cleanup(&root);
    }

    #[test]
    fn write_generated_asset_ext_follows_mime() {
        let (projects, _library, root) = temp_fixture();
        seed_project(&projects, "p-1");
        let asset = write_generated_asset(&cap(&projects), "p-1", b"JPEGBYTES", "image/jpeg")
            .expect("jpeg 落盘应成功");
        let rel = asset
            .get("relPath")
            .and_then(Value::as_str)
            .expect("relPath");
        assert!(rel.ends_with(".jpg"), "jpeg 扩展应映射为 .jpg：{rel}");
        assert_eq!(ext_for_mime("image/webp"), "webp");
        assert_eq!(ext_for_mime("application/octet-stream"), "bin");
        cleanup(&root);
    }
}
