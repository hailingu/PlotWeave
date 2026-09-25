//! 持久化原语（数据模型 §10.2 信任链）：受信根锚定句柄（projects_dir、
//! open_dir_bound 身份绑定、no-follow 归类 asset_stat/asset_identity）、
//! 控制文件读取与原子写——全程句柄相对执行，不按路径名重解析。

use std::fs;

use cap_std::{ambient_authority, fs::Dir as CapDir};
use tauri::{AppHandle, Manager};

use crate::store::error::StoreError;
use crate::store::types::{new_id, validate_id};

#[cfg(test)]
pub(crate) mod faults;

/// 故障注入仅在测试中替换单个系统 I/O；发布构建直接执行原表达式。
/// `$crate` 绝对路径使其可在定义模块外（如 store::copy）经
/// `pub(crate) use atomic_io` 导入后展开。
macro_rules! atomic_io {
    ($stage:ident, $operation:expr) => {{
        #[cfg(test)]
        let result = $crate::store::persist::faults::run(
            $crate::store::persist::faults::Stage::$stage,
            || $operation,
        );
        #[cfg(not(test))]
        let result = $operation;
        result
    }};
}
pub(crate) use atomic_io;
/// 资产路径组件的 no-follow 元数据（相对锚定句柄），缺失映射为「资产文件不存在」。
pub(crate) fn asset_stat(
    dir: &CapDir,
    comp: &str,
    rel_path: &str,
) -> Result<cap_std::fs::Metadata, StoreError> {
    dir.symlink_metadata(comp).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            StoreError::missing(format!("资产文件不存在：{rel_path}"))
        } else {
            StoreError::io(format!("读取资产路径元数据失败（{rel_path}）"), e)
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
pub(crate) fn projects_dir(app: &AppHandle) -> Result<CapDir, StoreError> {
    let root_path = app
        .path()
        .app_data_dir()
        .map_err(|e| StoreError::AppDataDir { source: e })?;
    // 应用数据根的首次创建走持久化内核（issue #309）：新建层级条目在
    // 写入内容前逐级同步宿主，失败拆除重建。内核错误经 prefixed 保留
    // 既定 IPC 诊断上下文「创建应用数据目录失败」（评审修复：文案契约
    // 不因内核接入而漂移，来源链原样保留）。
    create_dir_all_durable(&root_path).map_err(|e| e.prefixed("创建应用数据目录失败"))?;
    let root_path = root_path
        .canonicalize()
        .map_err(|e| StoreError::io("解析应用数据目录真实路径失败", e))?;
    let root = CapDir::open_ambient_dir(&root_path, ambient_authority())
        .map_err(|e| StoreError::io("打开应用数据根目录失败", e))?;
    ensure_projects_dir(&root)
}

/// projects/ 确保内核（PR #224 评审，可测）：缺失即创建——并发首用容忍
/// AlreadyExists（spawn_blocking 把项目命令移出 invoke 主线程后，多个
/// 入口可同时发现目录缺失并双发 check-then-create；与 ensure_library_dir
/// 同语义：总是尝试创建、失败方在另一命令刚建好时照常继续），现存必须
/// 是非符号链接的真实目录并经 (dev, ino) 身份绑定打开——并发下失败方
/// 重走归类与绑定，不读取他方替换出的实体。
pub(crate) fn ensure_projects_dir(root: &CapDir) -> Result<CapDir, StoreError> {
    match root.symlink_metadata("projects") {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(e) = root.create_dir("projects") {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(StoreError::io("创建项目目录失败", e));
                }
            } else {
                // 本次调用真实创建了条目（issue #309）：同步宿主使新目录
                // 项与后续写入同持久；失败拆除重建，重试重新创建并同步
                sync_new_child_dir_host(root, "projects")?;
            }
        }
        Err(e) => return Err(StoreError::io("读取项目目录元数据失败", e)),
    }
    let md = root
        .symlink_metadata("projects")
        .map_err(|e| StoreError::io("读取项目目录元数据失败", e))?;
    if md.file_type().is_symlink() {
        return Err(StoreError::refused("拒绝符号链接形式的项目目录"));
    }
    if !md.is_dir() {
        return Err(StoreError::refused("项目目录路径不是目录"));
    }
    open_dir_bound(root, "projects", &md, "项目目录")
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
) -> Result<CapDir, StoreError> {
    let opened = parent
        .open_dir(&rel)
        .map_err(|e| StoreError::io(format!("打开{label}失败"), e))?;
    #[cfg(unix)]
    {
        let fm = opened
            .dir_metadata()
            .map_err(|e| StoreError::io(format!("读取{label}句柄元数据失败"), e))?;
        if asset_identity(&fm) != asset_identity(classified) {
            return Err(StoreError::refused(format!(
                "{label}在归类后被替换，拒绝操作"
            )));
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
            .map_err(|e| StoreError::io(format!("复核{label}元数据失败"), e))?;
        if recheck.file_type().is_symlink()
            || !recheck.is_dir()
            || !opened
                .dir_metadata()
                .map_err(|e| StoreError::io(format!("读取{label}句柄元数据失败"), e))?
                .is_dir()
        {
            return Err(StoreError::refused(format!(
                "{label}在归类后被替换，拒绝操作"
            )));
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
fn verify_control_file(root: &CapDir, name: &str) -> Result<Option<(u64, u64)>, StoreError> {
    let md = root
        .symlink_metadata(name)
        .map_err(|e| StoreError::io("读取项目文件元数据失败", e))?;
    if md.file_type().is_symlink() {
        return Err(StoreError::refused("项目文件是符号链接，拒绝读取"));
    }
    if !md.is_file() {
        return Err(StoreError::refused("项目文件不是普通文件"));
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
pub(crate) fn read_verified_file(root: &CapDir, name: &str) -> Result<String, StoreError> {
    let verified_identity = verify_control_file(root, name)?;
    use std::io::Read;
    let mut file = root
        .open(name)
        .map_err(|e| StoreError::io("打开项目文件失败", e))?;
    #[cfg(unix)]
    if let Some(id) = verified_identity {
        let fm = file
            .metadata()
            .map_err(|e| StoreError::io("读取项目文件句柄元数据失败", e))?;
        if asset_identity(&fm) != id {
            return Err(StoreError::refused("项目文件在读取前被替换，拒绝读取"));
        }
    }
    // 非 Unix 无 (dev, ino) 可比：打开后重走 no-follow 归类，换成符号链接/
    // 异型即拒绝（换成另一普通文件的残余窗口仍在，由 cap-std 沙箱限界内）
    #[cfg(not(unix))]
    {
        verify_control_file(root, name)?;
        match file.metadata() {
            Ok(fm) if fm.is_file() => {}
            _ => return Err(StoreError::refused("项目文件在读取前被替换，拒绝读取")),
        }
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| StoreError::io("读取项目文件失败", e))?;
    Ok(text)
}
/// 原子写控制文件（§10.2）：全程相对已验证父目录的打开句柄执行（cap-std
/// openat 语义）——目标归类与 rename 前复核（现存目标为符号链接或非普通
/// 文件即拒绝，不跟随）、随机同目录名临时文件以 O_CREAT|O_EXCL 排他创建
/// （预置 `.tmp` 符号链接无法截获写入）、写入 + flush/fsync、句柄相对
/// rename 原子覆盖（cap-std 在 Windows 上以替换语义实现 rename，std::fs::
/// rename 在该平台不替换已存在目标，已建项目的每次保存都会失败）→ 父目录
/// fsync（持久性屏障，打开/同步失败向上传播、不粉饰成功）；失败尽力清理
/// 本次成功创建的临时文件，排他创建失败不得清理其他写者的条目。
/// file_name 须为单段文件名（不含路径分量）：归类、创建与
/// rename 之外的越界形态在此拒绝，不得相对句柄逃出 projects/。
pub(crate) fn atomic_write(root: &CapDir, file_name: &str, text: &str) -> Result<(), StoreError> {
    use std::io::Write;
    if std::path::Path::new(file_name).components().count() != 1 {
        return Err(StoreError::refused(format!(
            "项目文件名含路径分量，拒绝：{file_name}"
        )));
    }
    // 目标归类（现存为符号链接或非普通文件即拒绝，不跟随）：仅**确证缺失**
    // 视作新建目标——权限/瞬态 I/O 错误当缺失放行会跳过归类，rename 可能
    // 覆盖未验证的目录项（fail closed）
    let check_target = || -> Result<(), StoreError> {
        match root.symlink_metadata(file_name) {
            Ok(md) if md.file_type().is_symlink() => {
                Err(StoreError::refused("拒绝符号链接形式的项目文件"))
            }
            Ok(md) if !md.is_file() => Err(StoreError::refused("项目路径不是普通文件")),
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::io("读取项目文件元数据失败", e)),
        }
    };
    check_target()?;
    let tmp_name = format!(".{file_name}.{}.tmp", new_id());
    #[cfg(test)]
    let tmp_name = faults::temp_name(tmp_name);
    // 排他创建失败直接返回；只有取得临时文件所有权后才进入失败清理区。
    let file = atomic_io!(
        Create,
        root.open_with(
            &tmp_name,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )
    )
    .map_err(|e| StoreError::io("创建临时文件失败", e))?;
    let result = (|| -> Result<(), StoreError> {
        let mut f = file;
        atomic_io!(Write, f.write_all(text.as_bytes()))
            .map_err(|e| StoreError::io("写入项目失败", e))?;
        atomic_io!(FileSync, f.sync_all()).map_err(|e| StoreError::io("同步临时文件失败", e))?;
        drop(f);
        // rename 前复核现存目标（§10.2）：写临时文件期间被换上的符号链接
        // 或异型条目在此拒绝，不被 rename 覆盖
        check_target()?;
        atomic_io!(Rename, root.rename(&tmp_name, root, file_name))
            .map_err(|e| StoreError::io("落盘项目失败", e))?;
        // 持久性屏障同步锚定句柄本身（经其重新绑定自身再 fsync，不按路径名
        // 重开——否则屏障加到并发替换后的目录上，保存成功而加载另一棵树）
        #[cfg(unix)]
        atomic_io!(
            DirectorySync,
            root.open_dir(".")
                .and_then(|d| d.into_std_file().sync_all())
        )
        .map_err(|e| StoreError::io("同步项目目录失败（持久性屏障缺失）", e))?;
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
/// 崩溃遗留临时文件的归属宽限期（§10.2 资源回收边界，issue #148）：原子写
/// 临时文件的正常生命周期为毫秒~秒级（写入 + fsync + rename，最大的
/// 256 MiB 项目媒体拷贝也在分钟级），mtime 超过本阈值只可能来自「排他
/// 创建与 rename 之间进程被终止」的遗留——阈值内一律保留，绝不触碰
/// 进行中的写入。
const ORPHAN_TEMP_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// projects/ 操作互斥锁（PR #217 第三轮评审，issue #148 后续）：进程内
/// Mutex 串行项目列表（含孤儿临时文件清扫）与项目文档原子写——挂起
/// 恢复或时钟前跳使进行中写入的临时文件 mtime 越过宽限期时，清扫也
/// 无法在排他创建与 rename 之间插入（库侧同型机制见
/// `library_journal::library_op_lock`）。跨进程协同不在本锁范围：§10.2
/// 单写者模型由前端保存链承担，两个应用实例并发写同一 projects/ 树
/// 属记录边界。中毒后行为（issue #145）：可验证恢复——本锁不守卫内存
/// 状态，磁盘一致性由原子写协议独立保证（遗留临时文件由清扫承接），
/// 经 `crate::lock::recover_guard` 恢复，不传播 panic。
static PROJECTS_OP_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

pub(crate) fn projects_op_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::lock::recover_guard(
        PROJECTS_OP_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock(),
        "项目操作锁",
    )
}
/// 随机 id 段的精确归属（PR #217 评审修复）：临时名的 id 段只可能来自
/// `new_id()`，其唯一产出形状是 `p-{ms:x}{rnd:x}-{seq:x}`——`p-` 前缀加
/// 两段非空小写十六进制。宽字符集（字母数字/`-`/`_`）会把
/// `.notes.backup.tmp` 之类外来文件误判为本协议临时文件并在超龄后
/// 误删；归属收紧为生成器实际形状——误收方向是数据丢失，误拒方向
/// 仅是遗留文件暂不回收（fail-safe）。长度上限沿用 id 域 64 字符。
fn is_generated_temp_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("p-") else {
        return false;
    };
    let Some((body, seq)) = rest.rsplit_once('-') else {
        return false;
    };
    let lowercase_hex = |s: &str| {
        !s.is_empty() && s.len() <= 62 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    };
    id.len() <= 64 && lowercase_hex(body) && lowercase_hex(seq)
}
/// 原子写临时名的归属判定（§10.2 命名协议 `.{目标名}.{new_id()}.tmp`）：
/// 隐藏点前缀 + `.tmp` 后缀，去掉首尾后按最后一个 `.` 分出目标名段与
/// 随机 id 段（目标名段自身可含 `.`，如 `p-1.json`）——目标名段须落在
/// 调用方目录的原子写目标白名单内（`target_ok`，PR #217 第二轮评审：
/// 仅非空会把 `.notes.p-18f-0.tmp` 之类「合成 id + 非法目标」的外来
/// 文件误收误删），id 段须匹配生成器实际产出形状（见
/// [`is_generated_temp_id`]）。不满足任一条件的条目与本协议无关，永不
/// 进入清扫候选（用户放入应用数据目录的 `.tmp` 杂物不被误收）。
fn is_atomic_temp_name(name: &str, target_ok: &dyn Fn(&str) -> bool) -> bool {
    let Some(body) = name.strip_prefix('.').and_then(|s| s.strip_suffix(".tmp")) else {
        return false;
    };
    let Some((target, id)) = body.rsplit_once('.') else {
        return false;
    };
    target_ok(target) && is_generated_temp_id(id)
}
/// projects/ 的原子写目标白名单（§10.2）：唯一目标是 `{项目 id}.json`
/// （create/save）；AI 会话临时文件位于 `projects/{id}/` 会话目录，
/// 不在本目录的清扫范围（记录边界）。
pub(crate) fn is_project_temp_target(target: &str) -> bool {
    target
        .strip_suffix(".json")
        .is_some_and(|id| validate_id(id).is_ok())
}
/// 清扫候选判定：归属可辨（目标白名单 + 生成器 id 形状）+ no-follow
/// 归类为普通文件（符号链接/目录等异型条目只跳过、绝不跟随）+ mtime
/// 超龄（读取失败或未来时刻的脏时间戳一律按未超龄保留）。`md` 须为
/// lstat 语义（cap-std `DirEntry::metadata` 不跟随符号链接，与
/// commands 删除路径同款前置）。
fn is_sweep_candidate(
    name: &str,
    md: &cap_std::fs::Metadata,
    now: std::time::SystemTime,
    target_ok: &dyn Fn(&str) -> bool,
) -> bool {
    if !is_atomic_temp_name(name, target_ok) || !md.is_file() {
        return false;
    }
    let Ok(modified) = md.modified() else {
        return false;
    };
    matches!(now.duration_since(modified.into_std()), Ok(age) if age >= ORPHAN_TEMP_MIN_AGE)
}
/// 崩溃遗留孤儿临时文件清扫（§10.2 资源回收边界，issue #148）：扫描
/// 已验证目录句柄，移除「归属可辨（目标白名单 + 生成器 id 形状）、
/// no-follow 归类为普通文件、mtime 超龄」三条件同时成立的条目；
/// `target_ok` 由调用方给出本目录的原子写目标白名单（projects/ 见
/// [`is_project_temp_target`]，library/ 与 assets/ 见 library_fs）。
/// 调用方须持有本目录的操作锁（projects/ 见 [`projects_op_lock`]，
/// library/ 由 `library_journal::library_op_lock` 覆盖）——仅凭年龄
/// 判孤儿时，挂起恢复/时钟前跳会让进行中写入的临时文件显得超龄
/// （PR #217 第三轮评审）；锁保证清扫不在排他创建与 rename 之间插入。
/// remove_file 只移除目录项自身，不跟随符号链接。尽力而为、fail-soft
/// ——扫描/元数据/删除失败只留结构化诊断，不向调用方传播：清扫永不
/// 阻断列表/启动，也不因单条坏数据中断其余条目的回收。只删除、不
/// 读取内容：遗留临时文件不充当恢复副本（不扩大为新的恢复副本
/// 协议）。返回移除计数（诊断与测试用）。
pub(crate) fn sweep_orphan_temp_files(
    dir: &CapDir,
    label: &str,
    target_ok: impl Fn(&str) -> bool,
) -> usize {
    let now = std::time::SystemTime::now();
    let entries = match dir.entries() {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("[store] {label}：扫描崩溃遗留临时文件失败（跳过清扫）：{e}");
            return 0;
        }
    };
    let mut removed = 0usize;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                eprintln!("[store] {label}：遍历目录失败（跳过该条目）：{e}");
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // 名字归属是纯字符串判定：先行过滤，非临时名的条目不做 metadata 调用
        if !is_atomic_temp_name(name, &target_ok) {
            continue;
        }
        // DirEntry::metadata 取 lstat 语义，不跟随符号链接
        let md = match entry.metadata() {
            Ok(md) => md,
            Err(e) => {
                eprintln!("[store] {label}：读取临时条目元数据失败（跳过 {name}）：{e}");
                continue;
            }
        };
        if !is_sweep_candidate(name, &md, now, &target_ok) {
            continue;
        }
        match dir.remove_file(name) {
            Ok(()) => {
                removed += 1;
                eprintln!("[store] {label}：已清理崩溃遗留临时文件：{name}");
            }
            Err(e) => eprintln!("[store] {label}：清理崩溃遗留临时文件失败（{name}）：{e}"),
        }
    }
    removed
}
/// 目录条目持久化计划（§10.2，Unix）：`hosts` 为新条目宿主链——从
/// `dir` 的最深已存在祖先（锚点，含 `dir` 本身）到其直接父目录的每一
/// 级路径，新建目录的条目都落在这些宿主里；`created` 为本次调用预期
/// 新建的各级目录（严格位于锚点之下、含 `dir` 本身，浅→深），是失败
/// 清理的回滚范围。`dir` 已存在时 hosts 退化为仅含直接父目录：这是
/// 单级未同步创建的兜底（宿主链在创建时刻已不可考），多级兜底由
/// 「每个创建入口都用 [`create_dir_all_durable`] 在创建时刻同步、失败
/// 即拆除新建层级让重试重新探测锚点」承担——store/library 侧入口已接入
/// 该助手与句柄相对宿主同步（issue #309）：路径入口走本助手，句柄相对
/// 入口走 [`sync_new_child_dir_host`]。根目录无父级宿主，返回 None。
#[cfg(unix)]
struct EntrySyncPlan {
    hosts: Vec<std::path::PathBuf>,
    created: Vec<std::path::PathBuf>,
}
/// 探测锚点（§10.2，Unix）：`dir` 的最深已存在祖先。逐级自深向浅比对
/// 元数据，`NotFound` 视为缺失候选，其余 I/O 失败按 fail-closed 直接上抛
/// （PR #201 第四轮评审：现存目录被瞬态错误吞掉会误判为「本次新建」，
/// 进而在失败清理中被拆）。`dir` 自身存在返回 `Ok(dir)`。
#[cfg(unix)]
fn existing_anchor(dir: &std::path::Path) -> Result<std::path::PathBuf, StoreError> {
    for ancestor in dir.ancestors() {
        #[cfg(test)]
        if let Some(e) = faults::fail_at(faults::Stage::AnchorProbe) {
            return Err(StoreError::io("探测目录条目宿主失败", e));
        }
        match ancestor.symlink_metadata() {
            Ok(_) => return Ok(ancestor.to_path_buf()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(StoreError::io("探测目录条目宿主失败", e)),
        }
    }
    // 理论上不可达（根总是存在）；防御性按 IO 错误处理
    Err(StoreError::io(
        "探测目录条目宿主失败",
        std::io::Error::other("找不到已存在的祖先"),
    ))
}
#[cfg(unix)]
fn entry_sync_plan(dir: &std::path::Path) -> Result<Option<EntrySyncPlan>, StoreError> {
    let Some(parent) = dir.parent().map(|p| p.to_path_buf()) else {
        return Ok(None);
    };
    let anchor = existing_anchor(dir)?;
    if anchor == dir {
        // dir 已存在：单级兜底同步直接父目录，无回滚范围
        return Ok(Some(EntrySyncPlan {
            hosts: vec![parent],
            created: Vec::new(),
        }));
    }
    // 新建级 = 严格位于锚点之下、含 dir 的各段，浅→深
    let missing = dir.strip_prefix(&anchor).unwrap();
    let mut created = Vec::new();
    let mut cursor = anchor.clone();
    for component in missing.components() {
        cursor = cursor.join(component);
        created.push(cursor.clone());
    }
    // hosts = 锚点 + 除最深层（dir）外的各新建级：每级新条目落在其父宿主里
    let mut hosts = Vec::with_capacity(created.len());
    hosts.push(anchor);
    hosts.extend(created[..created.len() - 1].iter().cloned());
    Ok(Some(EntrySyncPlan { hosts, created }))
}
/// 逐级同步目录条目宿主：自锚点向下游（先持久宿主条目，再持久子级），
/// 任一失败上抛，不粉饰成功。
#[cfg(unix)]
fn sync_entry_hosts(hosts: &[std::path::PathBuf]) -> Result<(), StoreError> {
    for host in hosts {
        atomic_io!(EntrySync, fs::File::open(host).and_then(|f| f.sync_all()))
            .map_err(|e| StoreError::io("同步目录条目失败（持久性屏障缺失）", e))?;
    }
    Ok(())
}
/// 失败清理：自深至浅尽力拆除本次新建的各级目录（仅空目录可拆）。
/// 拆除失败（并发写入占据等）不掩盖原始错误；残留层级与「清理前来
/// 不及执行的崩溃／断电」同属记录边界——下次调用走「目录已存在」
/// 单级兜底（PR #201 第三轮评审）。
#[cfg(unix)]
fn remove_created_levels(created: &[std::path::PathBuf]) {
    for path in created.iter().rev() {
        let _ = fs::remove_dir(path);
    }
}
/// [`fs::create_dir_all`] 的持久化版本（§10.2）：先探测最深已存在祖先，
/// 创建 `dir` 后逐级 fsync 新目录条目所在的宿主（Unix），使首次创建的
/// 目录条目与调用方后续写入的内容同为持久；宿主链在写入内容前同步，
/// 失败时 `dir` 内尚无内容产生。创建或同步失败即尽力拆除本次新建层级
/// 后返回原错误——重试得以重新探测锚点、再做全链同步，而非退化为
/// 「目录已存在」的单级兜底（PR #201 第三轮评审）。非 Unix 沿用共享
/// 内核现状，不执行目录 fsync（Windows 目录句柄无法 fsync）。并发创建
/// 幂等：`create_dir_all` 不区分本次或他方创建，宿主链覆盖锚点到直接
/// 父目录的每一级路径。
pub(crate) fn create_dir_all_durable(dir: &std::path::Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    let plan = entry_sync_plan(dir)?;
    if let Err(e) = fs::create_dir_all(dir) {
        #[cfg(unix)]
        if let Some(plan) = &plan {
            remove_created_levels(&plan.created);
        }
        return Err(StoreError::io("创建目录失败", e));
    }
    #[cfg(unix)]
    if let Some(plan) = plan {
        if let Err(e) = sync_entry_hosts(&plan.hosts) {
            remove_created_levels(&plan.created);
            return Err(e);
        }
    }
    Ok(())
}

/// 句柄相对的「新目录条目宿主同步」（issue #309，store/library 接入
/// `EntrySyncPlan` 同款契约）：锚定句柄内**本次真实创建**的子目录条目，
/// 其持久性由宿主（parent 自身）的 fsync 保证——宿主经句柄相对
/// `open_dir(".")` 转标准句柄同步（同 `write_tmp_and_rename` 的父目录
/// 屏障惯用法），不按绝对路径重开（ambient 重开会把并发替换后的目录
/// 当表面宿主，破坏 §10.2 信任链）。失败即尽力拆除本次新建层级（仅空
/// 目录可拆），重试重新创建并同步而非退化为「目录已存在」单级兜底
/// （与 [`create_dir_all_durable`] 同语义）；拆除失败不掩盖原始错误。
/// 仅限创建成功路径调用：已存在目录（AlreadyExists 容忍路径）的条目
/// 持久性归创建时刻的调用方负责。非 Unix 不执行目录 fsync（Windows
/// 目录句柄无法 fsync），沿用共享内核现状。
#[cfg(unix)]
pub(crate) fn sync_new_child_dir_host(parent: &CapDir, name: &str) -> Result<(), StoreError> {
    let synced = atomic_io!(
        ChildHostSync,
        parent
            .open_dir(".")
            .and_then(|dir| dir.into_std_file().sync_all())
    )
    .map_err(|e| StoreError::io("同步新目录条目宿主失败（持久性屏障缺失）", e));
    if synced.is_err() {
        let _ = parent.remove_dir(name);
    }
    synced
}
/// 非 Unix：Windows 目录句柄无法 fsync，沿用共享内核现状不执行宿主同步。
#[cfg(not(unix))]
pub(crate) fn sync_new_child_dir_host(parent: &CapDir, name: &str) -> Result<(), StoreError> {
    let _ = (parent, name);
    Ok(())
}

#[cfg(test)]
mod tests;
