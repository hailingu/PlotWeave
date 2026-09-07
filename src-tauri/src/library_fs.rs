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

use crate::store::{new_id, open_dir_bound};

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

/// 空索引（首启或索引缺失时回退；目标 Record 形状，§7.2）。
pub(crate) fn default_index() -> Value {
    json!({ "assets": { "byId": {} }, "groups": { "byId": {} } })
}

/// 库目录确保内核：缺失即创建（并发首用容忍 AlreadyExists，评审修复——
/// 与 assets.rs 的 ensure_child_dir 同语义：总是尝试创建、失败方在另一
/// 命令刚建好时照常继续，归类校验与身份绑定兜底），现存必须是非符号链接
/// 的真实目录并经身份绑定打开。
pub(crate) fn ensure_library_dir(root: &CapDir) -> Result<CapDir, String> {
    match root.symlink_metadata("library") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(e) = root.create_dir("library") {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!("创建资产库目录失败：{e}"));
                }
            }
        }
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
    open_dir_bound(root, "library", &md, "资产库目录")
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
    ensure_library_dir(&root)
}

/// `library/assets/` 专用根句柄（§7.1：凡按 relPath 触达媒体文件的入口均
/// 由该句柄出发）：缺失即创建（并发首用容忍 AlreadyExists），现存必须是
/// 非符号链接的真实目录并经身份绑定打开——媒体删除与读取从此不可达
/// assets/ 之外的任何路径。
pub(crate) fn assets_root(library: &CapDir) -> Result<CapDir, String> {
    match library.symlink_metadata("assets") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(e) = library.create_dir("assets") {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!("创建资产目录失败：{e}"));
                }
            }
        }
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
/// 真实目录（open_dir_bound 身份绑定），返回 (绑定父目录句柄, 终点名)；
/// 某个中间目录缺失时返回 None——终点必然也不存在，由调用方按语义分野
/// 处置（删除入口按"已删除"幂等，读取/导入入口映射为显式错误，评审修复）；
/// 符号链接与非目录中间组件一律拒绝。rel_path 须为已过词法白名单的纯
/// 相对路径（不含 `..`/空段）。
pub(crate) fn open_parent_dir(
    root: &CapDir,
    rel_path: &str,
) -> Result<Option<(CapDir, String)>, String> {
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
        let md = match dir.symlink_metadata(comp) {
            Ok(md) => md,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("读取资产路径元数据失败（{rel_path}）：{e}")),
        };
        if md.file_type().is_symlink() {
            return Err(format!("资产路径含符号链接：{rel_path}"));
        }
        if !md.is_dir() {
            return Err(format!("资产路径的中间组件不是目录：{rel_path}"));
        }
        dir = open_dir_bound(&dir, comp, &md, "资产路径中间目录")?;
    }
    Ok(Some((dir, (*last).to_string())))
}

/// 迁移/恢复诊断逐条进结构化本机日志（评审修复，PR #33 第十一/十二轮）：
/// 警告本应随响应返回，但命令在迁移落盘后因业务失败（资产不存在、补丁非法）
/// 提前返回 Err 时 warnings 不附加——修复已提交、诊断却永久丢失（下次 list
/// 读到的是已干净文件）。凡「recover 已可能落盘迁移」的命令内核在业务校验
/// 之前调用本函数兜底；成功路径随响应返回的 warnings 与日志重复可接受（重复
/// 优于丢失）。
pub(crate) fn report_recovery_diagnostics(context: &str, warnings: &[String]) {
    for w in warnings {
        eprintln!("[library] {context}伴随迁移/恢复诊断：{w}");
    }
}

/// 归一化读取结果：迁移挂起（suspended）表示迁移产物超限无法持久化——
/// 读路径照常服务只读视图，**写路径必须拒绝**，否则无关变更写回会永久抹掉
/// 被隔离的需重发条目（评审修复，PR #33 第十六轮）。
pub(crate) struct NormalizedIndex {
    pub(crate) index: Value,
    pub(crate) warnings: Vec<String>,
    /// 迁移/修复已发生且可以落盘。
    pub(crate) migrated: bool,
    /// 迁移挂起：迁移产物超限，本次仅内存只读视图（写路径拒绝）。
    pub(crate) suspended: bool,
}

/// 索引受限读取（library.rs 命令面与 assets.rs 导入路径的**唯一**索引读
/// 实现）：no-follow 归类 → 大小上限内读取 → JSON 解析 → 兼容迁移 + 完整
/// 归一化（[`crate::library_index`]，§7.2）——旧数组形状迁移为 Record、
/// 非法条目隔离出内存索引并逐条返回警告，索引缺失回退默认空索引。
/// 迁移/修复发生时把归一化结果原子落盘（评审修复，PR #33 第二轮）：重发的
/// id 与翻转的 Record 形状随读持久化，后续媒体/删除/更新命令读到同一身份。
/// 返回挂起标志：写路径（put/update/delete）检测到即拒绝（评审修复，PR #33
/// 第十六轮）。本函数总在持有 `library_op_lock`/`library_file_lock` 的命令
/// 上下文内被调用。
pub(crate) fn read_index_capped(library: &CapDir) -> Result<(Value, Vec<String>, bool), String> {
    let normalized = read_index_normalized(library)?;
    let suspended = normalized.suspended;
    if normalized.migrated {
        write_index(library, &normalized.index)?;
    }
    Ok((normalized.index, normalized.warnings, suspended))
}

/// 读取并归一化索引但**不落盘**（评审修复，PR #33 第三轮）：返回
/// [`NormalizedIndex`]。供 `library_journal::recover` 在确认删除日志非异型
/// 之前使用——journal 异型须先进入只读告警态，不得先迁移改写 library.json；
/// 落盘决策由调用方在 journal 校验通过后执行。迁移产物复检大小上限（评审
/// 修复，PR #33 第十四/十五/十六轮）：旧数组紧凑、迁移后（byId 键 + source +
/// ISO）膨胀可越过写上限——超限则**不落盘**并进入挂起态：改用只读归一化
/// 隔离需重发的条目（不暴露跨读漂移的 id）、丢弃可写遍的「已重发」谎报
/// （实际行为是隔离）、置 suspended 供写路径拒绝；否则迁移落盘失败会把
/// 「可读的旧索引」升级成全库命令死锁，放行写回又会让无关变更永久抹掉
/// 被隔离条目。
pub(crate) fn read_index_normalized(library: &CapDir) -> Result<NormalizedIndex, String> {
    match read_index_text_capped(library)? {
        None => Ok(NormalizedIndex {
            index: default_index(),
            warnings: Vec::new(),
            migrated: false,
            suspended: false,
        }),
        Some(text) => {
            let index: Value =
                serde_json::from_str(&text).map_err(|e| format!("资产索引损坏：{e}"))?;
            // 非对象根（标量/数组）显式拒绝：字符串索引在非对象根上 panic
            // 会把脏数据放大成全部库命令不可用（评审修复）
            if !index.is_object() {
                return Err("资产索引根必须是对象".into());
            }
            // 规范化表示同上限（评审修复）：原始字节达标但解析后规范化表示
            // 膨胀（如 1e10 → 10000000000.0）的索引同样拒绝——可读 ⇒ 可写回
            // 的编码闭环不因词法差异破洞
            if normalized_len(&index)? > INDEX_MAX_BYTES {
                return Err(format!(
                    "资产索引规范化表示超过 {} MiB 上限，拒绝读取",
                    INDEX_MAX_BYTES / (1024 * 1024)
                ));
            }
            // 超限降级（评审修复，PR #33 第十四/十五/十六轮）：迁移产物越过
            // 写上限时进入挂起态——只读归一化隔离需重发的条目；诊断只保留
            // 超限警告与只读遍声明，可写遍的「已重发」谎报（实际是隔离）
            // 不得外泄
            let original = index.clone();
            let (normalized, writable_warnings, migrated) =
                crate::library_index::migrate_and_normalize(index);
            if migrated && normalized_len(&normalized)? > INDEX_MAX_BYTES {
                let mut warnings = vec![format!(
                    "资产索引迁移结果超过 {} MiB 上限，迁移挂起：库读取照常、写入暂停，须人工修整 library.json 条目使迁移结果可落盘",
                    INDEX_MAX_BYTES / (1024 * 1024)
                )];
                let (ro_normalized, ro_warnings, _) =
                    crate::library_index::migrate_and_normalize_readonly(original);
                warnings.extend(ro_warnings);
                return Ok(NormalizedIndex {
                    index: ro_normalized,
                    warnings,
                    migrated: false,
                    suspended: true,
                });
            }
            Ok(NormalizedIndex {
                index: normalized,
                warnings: writable_warnings,
                migrated,
                suspended: false,
            })
        }
    }
}

/// 只读告警态的归一化读取（评审修复，PR #33 第七轮）：不落盘且**不重发
/// id**——journal 异型时写入被暂停，`new_id()` 重发的新身份无法持久化、
/// 跨读漂移；需重发的条目隔离并警告（不暴露不稳定身份）。供 list/媒体/
/// 导入三个读取路径在 `recovery.read_only` 时使用。
pub(crate) fn read_index_normalized_readonly(
    library: &CapDir,
) -> Result<(Value, Vec<String>), String> {
    match read_index_text_capped(library)? {
        None => Ok((default_index(), Vec::new())),
        Some(text) => {
            let index: Value =
                serde_json::from_str(&text).map_err(|e| format!("资产索引损坏：{e}"))?;
            if !index.is_object() {
                return Err("资产索引根必须是对象".into());
            }
            if normalized_len(&index)? > INDEX_MAX_BYTES {
                return Err(format!(
                    "资产索引规范化表示超过 {} MiB 上限，拒绝读取",
                    INDEX_MAX_BYTES / (1024 * 1024)
                ));
            }
            let (normalized, warnings, _) =
                crate::library_index::migrate_and_normalize_readonly(index);
            Ok((normalized, warnings))
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

/// 索引规范化（紧凑）表示的字节长度：读取侧与写入侧的统一度量。
fn normalized_len(index: &Value) -> Result<usize, String> {
    serde_json::to_string(index)
        .map(|text| text.len())
        .map_err(|e| format!("序列化索引失败：{e}"))
}

/// 写入侧同上限（与 read_index_capped 同一编码度量，评审修复）：候选索引
/// 按落盘使用的**紧凑**序列化计长，超过 INDEX_MAX_BYTES 即拒绝——读侧在
/// 规范化表示上同检（见 read_index_capped），两侧闭环（可读即可写回，
/// 删除永不因写盘编码膨胀而卡死）。
pub(crate) fn ensure_index_size(index: &Value) -> Result<(), String> {
    if normalized_len(index)? > INDEX_MAX_BYTES {
        return Err(format!(
            "资产库索引超过 {} MiB 上限，拒绝写入",
            INDEX_MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 索引原子落盘：全程相对库根锚定句柄，复用 store 的 §10.2 替换语义原子
/// 写内核（排他临时文件 + rename 前复核 + 持久性屏障），不按路径名重解析。
/// 序列化使用紧凑形式并校验读取侧同款大小上限（评审修复）：读侧量磁盘
/// 原始字节、写侧量即将写出的同一紧凑表示，两侧同一编码闭环——超限索引
/// 拒绝落盘，可读的索引永远可写回。调用方传入的索引应为净化后视图。
pub(crate) fn write_index(library: &CapDir, index: &Value) -> Result<(), String> {
    ensure_index_size(index)?;
    let text = serde_json::to_string(index).map_err(|e| format!("序列化索引失败：{e}"))?;
    crate::store::atomic_write(library, INDEX_FILE_NAME, &text)
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
