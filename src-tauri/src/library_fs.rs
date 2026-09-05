//! 资产库文件系统共享内核（docs/data-model.md §7.1/§7.2 信任链）：应用级
//! `library/` 目录的受信锚定句柄、`library/assets/` 专用根句柄、索引受限
//! 读取与脏条目隔离、逐组件 no-follow 定位与原子落盘——library.rs 命令面
//! 与 assets.rs 导入路径共用同一实现，全程句柄相对操作，杜绝 ambient
//! `PathBuf` 拼接（issue #17：脏索引可越界删除、索引读取无校验无上限）。

use std::fs;
use std::io::Read;

use cap_std::ambient_authority;
use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::store::{
    asset_stat, is_canonical_mime, is_valid_asset_rel_path, new_id, open_dir_bound,
};

/// 库索引大小上限（1 MiB，对齐 prefs.rs 设置文件上限）：异常膨胀的索引在
/// 物化进内存前显式拒绝，防脏数据/篡改文件拖垮解析与 IPC。
pub(crate) const INDEX_MAX_BYTES: usize = 1024 * 1024;

/// 资产库索引文件名（单段，索引自身与库根下其他非资产文件不可经 relPath
/// 触达——relPath 词法要求首段 assets，见 [`is_valid_asset_rel_path`]）。
pub(crate) const INDEX_FILE_NAME: &str = "library.json";

/// 资产 id 约束：文件名安全字符集（同项目 id 规则）。
pub(crate) fn validate_asset_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("非法资产 id：{id}"))
    }
}

/// 空索引（首启或索引缺失时回退）。
pub(crate) fn default_index() -> Value {
    json!({ "assets": [], "groups": [] })
}

/// 资产库根目录的受信锚定句柄（§10.2 信任链，与 store::projects_dir 同构）：
/// canonicalize 应用数据根 → 锚定 → `library/` 缺失即创建、现存必须是非符号
/// 链接的真实目录并经身份绑定打开——不按路径名重开。
pub(crate) fn library_root(app: &AppHandle) -> Result<CapDir, String> {
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

/// `library/assets/` 专用根句柄（§7.1：凡按 relPath 触达媒体文件的入口均
/// 由该句柄出发）：缺失即创建，现存必须是非符号链接的真实目录并经身份
/// 绑定打开——媒体删除与读取从此不可达 assets/ 之外的任何路径。
pub(crate) fn assets_root(library: &CapDir) -> Result<CapDir, String> {
    match library.symlink_metadata("assets") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => library
            .create_dir("assets")
            .map_err(|e| format!("创建资产目录失败：{e}"))?,
        Err(e) => return Err(format!("读取资产目录元数据失败：{e}")),
    }
    let md = library
        .symlink_metadata("assets")
        .map_err(|e| format!("读取资产目录元数据失败：{e}"))?;
    if md.file_type().is_symlink() {
        return Err("资产目录是符号链接，拒绝操作".into());
    }
    if !md.is_dir() {
        return Err("资产目录路径不是目录".into());
    }
    open_dir_bound(library, "assets", &md, "资产目录")
}

/// 逐组件 no-follow 走到 rel_path 的父目录：中间组件必须是非符号链接的
/// 真实目录（open_dir_bound 身份绑定），返回 (绑定父目录句柄, 终点名)——
/// 终点的归类与动作（打开/删除）由调用方决定。rel_path 须为已过词法
/// 白名单的纯相对路径（不含 `..`/空段）。
pub(crate) fn open_parent_dir(root: &CapDir, rel_path: &str) -> Result<(CapDir, String), String> {
    let comps: Vec<&str> = rel_path.split('/').collect();
    let Some((last, parents)) = comps.split_last() else {
        return Err(format!("资产路径为空：{rel_path}"));
    };
    if last.is_empty() || *last == "." || *last == ".." {
        return Err(format!("资产路径终点非法：{rel_path}"));
    }
    let mut dir = root
        .try_clone()
        .map_err(|e| format!("复制锚定句柄失败：{e}"))?;
    for comp in parents {
        let md = asset_stat(&dir, comp, rel_path)?;
        if md.file_type().is_symlink() {
            return Err(format!("资产路径含符号链接：{rel_path}"));
        }
        if !md.is_dir() {
            return Err(format!("资产路径的中间组件不是目录：{rel_path}"));
        }
        dir = open_dir_bound(&dir, comp, &md, "资产路径中间目录")?;
    }
    Ok((dir, (*last).to_string()))
}

/// 删除库媒体文件（删除路径信任链，issue #17 场景 1-3 的闭环）：relPath
/// 必须已过 [`is_valid_asset_rel_path`] 白名单且以 `assets/` 开头；父目录
/// 逐组件 no-follow 绑定打开，终点归类为普通文件后句柄相对删除——索引
/// 自身与 assets/ 之外的路径不可达；终点缺失按已删除幂等成功。
pub(crate) fn remove_asset_file(library: &CapDir, rel_path: &str) -> Result<(), String> {
    let suffix = rel_path
        .strip_prefix("assets/")
        .ok_or_else(|| format!("资产 relPath 越出 assets/，拒绝删除：{rel_path}"))?;
    let assets = assets_root(library)?;
    let (parent, last) = open_parent_dir(&assets, suffix)?;
    match parent.symlink_metadata(&last) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("读取资产文件元数据失败（{rel_path}）：{e}")),
        Ok(md) if md.file_type().is_symlink() => {
            Err(format!("资产路径含符号链接，拒绝删除：{rel_path}"))
        }
        Ok(md) if !md.is_file() => Err(format!("资产路径不是普通文件，拒绝删除：{rel_path}")),
        Ok(_) => parent
            .remove_file(&last)
            .map_err(|e| format!("删除资产文件失败（{rel_path}）：{e}")),
    }
}

/// 索引受限读取（library.rs 命令面与 assets.rs 导入路径的**唯一**索引读
/// 实现）：no-follow 归类 → 大小上限内读取 → JSON 解析 → 逐条目白名单
/// 校验——非法条目隔离出内存索引并逐条返回警告（§7.2 非法条目不进内存
/// 索引），索引缺失回退默认空索引。
pub(crate) fn read_index_capped(library: &CapDir) -> Result<(Value, Vec<String>), String> {
    match read_index_text_capped(library)? {
        None => Ok((default_index(), Vec::new())),
        Some(text) => {
            let index: Value =
                serde_json::from_str(&text).map_err(|e| format!("资产索引损坏：{e}"))?;
            // 非对象根（标量/数组）显式拒绝：字符串索引在非对象根上 panic
            // 会把脏数据放大成全部库命令不可用（评审修复）
            if !index.is_object() {
                return Err("资产索引根必须是对象".into());
            }
            Ok(sanitize_index(index))
        }
    }
}

/// 索引文本受限读取：no-follow 归类（拒符号链接/异型）、总量上限内读取、
/// 缺失返回 None（回退默认索引）。
fn read_index_text_capped(library: &CapDir) -> Result<Option<String>, String> {
    let md = match library.symlink_metadata(INDEX_FILE_NAME) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取资产库索引元数据失败：{e}")),
    };
    if md.file_type().is_symlink() {
        return Err("资产库索引是符号链接，拒绝读取".into());
    }
    if !md.is_file() {
        return Err("资产库索引不是普通文件".into());
    }
    let file = library
        .open(INDEX_FILE_NAME)
        .map_err(|e| format!("打开资产库索引失败：{e}"))?;
    let mut bytes = Vec::new();
    file.take((INDEX_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取资产库索引失败：{e}"))?;
    if bytes.len() > INDEX_MAX_BYTES {
        return Err(format!(
            "资产库索引超过 {} MiB 上限，拒绝读取",
            INDEX_MAX_BYTES / (1024 * 1024)
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "资产库索引不是合法 UTF-8".to_string())
}

/// 索引条目白名单（§7.2）：id/relPath/mime 形状校验，mime 在内存中规范化
/// （trim + 小写）；任一项非法即整条拒绝。非法条目不进入内存索引；mime
/// 发生就地修复时追加警告（评审修复：修复必须可见，静默修复会让前端与
/// 后续写回都无法感知）。
fn sanitize_entry(entry: &Value, warnings: &mut Vec<String>) -> Result<Value, String> {
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .ok_or("id 缺失或非字符串")?;
    validate_asset_id(id)?;
    let rel = entry
        .get("relPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("条目 {id} 的 relPath 缺失或非字符串"))?;
    if !is_valid_asset_rel_path(rel) {
        return Err(format!("条目 {id} 的 relPath 越出 assets/：{rel}"));
    }
    let mime_raw = entry
        .get("mime")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("条目 {id} 的 mime 缺失或非字符串"))?;
    let mime = mime_raw.trim().to_ascii_lowercase();
    if !is_canonical_mime(&mime) {
        return Err(format!("条目 {id} 的 mime 非规范形式：{mime_raw}"));
    }
    if mime != mime_raw {
        warnings.push(format!("条目 {id} 的 mime 已规范化：{mime_raw} → {mime}"));
    }
    let mut normalized = entry.clone();
    normalized["mime"] = json!(mime);
    Ok(normalized)
}

/// 索引净化：逐条目过白名单，非法条目隔离并生成警告；assets/groups 非数组
/// 按空处理并告警。只影响内存视图，不回写磁盘（写入路径的落盘即净化由
/// 各命令的写回自然完成）。
fn sanitize_index(mut index: Value) -> (Value, Vec<String>) {
    let mut warnings = Vec::new();
    let assets = take_array(&mut index, "assets", &mut warnings);
    let kept: Vec<Value> = assets
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            sanitize_entry(e, &mut warnings)
                .map_err(|reason| warnings.push(format!("已隔离非法索引条目 #{i}：{reason}")))
                .ok()
        })
        .collect();
    index["assets"] = json!(kept);
    let groups = take_array(&mut index, "groups", &mut warnings);
    index["groups"] = json!(groups);
    (index, warnings)
}

/// 取出数组字段（非数组/缺失按空处理并告警）。
fn take_array(index: &mut Value, key: &str, warnings: &mut Vec<String>) -> Vec<Value> {
    match index.get_mut(key).map(Value::take) {
        Some(Value::Array(arr)) => arr,
        Some(_) => {
            warnings.push(format!("资产索引的 {key} 不是数组，已按空处理"));
            Vec::new()
        }
        None => Vec::new(),
    }
}

/// 写入侧同上限（与 read_index_capped 同一编码度量，评审修复）：候选索引
/// 按落盘使用的**紧凑**序列化计长，超过 INDEX_MAX_BYTES 即拒绝——读侧量
/// 的是磁盘原始字节、写侧量的是即将写出的同一表示，两侧闭环（可读即可
/// 写回，删除永不因写盘编码膨胀而卡死）。
pub(crate) fn ensure_index_size(index: &Value) -> Result<(), String> {
    let len = serde_json::to_string(index)
        .map_err(|e| format!("序列化索引失败：{e}"))?
        .len();
    if len > INDEX_MAX_BYTES {
        return Err(format!(
            "资产库索引超过 {} MiB 上限，拒绝写入",
            INDEX_MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 同目录原子落盘内核（排他临时文件 + sync + rename + 父目录 fsync 持久性
/// 屏障，Unix）：rename 前复核目标仍未被占（fail closed），失败尽力清理
/// 临时文件。写入动作由 write 闭包提供（拷贝源文件 / 写生成字节共用）。
pub(crate) fn atomic_write_with<F>(dir: &CapDir, final_name: &str, write: F) -> Result<(), String>
where
    F: FnOnce(&mut cap_std::fs::File) -> std::io::Result<()>,
{
    match dir.symlink_metadata(final_name) {
        Ok(_) => return Err(format!("目标资产文件已存在：{final_name}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取目标资产元数据失败：{e}")),
    }
    let tmp_name = format!(".{final_name}.{}.tmp", new_id());
    let result = write_tmp_and_rename(dir, &tmp_name, final_name, write);
    if result.is_err() {
        let _ = dir.remove_file(&tmp_name);
    }
    result
}

/// 原子落盘主体（排他临时文件 → 闭包写入 + fsync → rename 前复核 →
/// 句柄相对 rename → 父目录持久性屏障）。
fn write_tmp_and_rename<F>(
    dir: &CapDir,
    tmp_name: &str,
    final_name: &str,
    write: F,
) -> Result<(), String>
where
    F: FnOnce(&mut cap_std::fs::File) -> std::io::Result<()>,
{
    let mut dst = dir
        .open_with(
            tmp_name,
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
    dir.rename(tmp_name, dir, final_name)
        .map_err(|e| format!("落盘资产文件失败：{e}"))?;
    #[cfg(unix)]
    dir.open_dir(".")
        .and_then(|d| d.into_std_file().sync_all())
        .map_err(|e| format!("同步资产目录失败（持久性屏障缺失）：{e}"))?;
    Ok(())
}
