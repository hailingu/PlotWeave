//! `pwmedia` opaque asset URL 媒体协议（数据模型 §7.1/§10.5，issue #26/#31）：
//! relPath 与本机绝对路径仅留在 Rust 侧，前端只获得含逻辑 scope + assetId
//! 的 opaque URL——库 scope 自 issue #26 按当前净化索引解析，项目 scope 自
//! issue #31 按项目文档 `assets.byId` 逐请求解析 assetId → relPath；自定义
//! 协议处理器（lib.rs 注册）每次请求重新执行解析，并经受信句柄链读取字节。
//! 自 `library.rs` 拆出以符合源文件 800 行上限（评审修复，PR #32 第六轮）。

use std::sync::{Condvar, Mutex, OnceLock};

use serde_json::Value;
use tauri::AppHandle;

use crate::assets::project_media::{open_project_media_with, resolve_project_media_entry};
use crate::library::ASSET_MAX_BYTES;
use crate::library_fs::{library_root, read_index_capped, validate_asset_id};
use crate::library_journal::{library_file_lock, library_op_lock};
use crate::store::{is_canonical_mime, is_valid_active_asset_rel_path, projects_dir, validate_id};

/// opaque asset URL 的自定义协议名（lib.rs 注册同名协议处理器）。
pub(crate) const MEDIA_SCHEME: &str = "pwmedia";

/// 项目 scope 媒体单文件上限（issue #31 评审修复 P2-2）：与生成产物写入
/// 上限 [`crate::imagegen::GENERATED_IMAGE_MAX_BYTES`] 同源——写入侧允许
/// 落盘的合法产物必须在读取侧可服务，读写契约不得分叉。
pub(crate) const PROJECT_MEDIA_MAX_BYTES: usize = crate::imagegen::GENERATED_IMAGE_MAX_BYTES;

/// 媒体请求的逻辑 scope（§10.5 命令表）：库按净化索引解析，项目按项目
/// 文档索引解析。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MediaScope {
    Library,
    Project { project_id: String },
}

const SCOPE_ERR: &str =
    "媒体 URL scope 仅支持 {{ kind: 'library' }} 或 {{ kind: 'project', projectId }}";

/// scope 白名单解析（§10.5 命令表，issue #31 并入项目 scope）：只接受精确
/// 形状——目录/路径字符串、缺 projectId、多余键与越界 projectId 一律拒绝；
/// projectId 过 [`validate_id`] 词法后才可参与 URL 构造。
pub(crate) fn parse_media_scope(scope: &Value) -> Result<MediaScope, String> {
    let obj = scope.as_object().ok_or(SCOPE_ERR)?;
    match (obj.len(), obj.get("kind").and_then(Value::as_str)) {
        (1, Some("library")) => Ok(MediaScope::Library),
        (2, Some("project")) => {
            let pid = obj
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or(SCOPE_ERR)?;
            validate_id(pid)?;
            Ok(MediaScope::Project {
                project_id: pid.to_string(),
            })
        }
        _ => Err(SCOPE_ERR.to_string()),
    }
}

/// opaque asset URL（前端可直接挂到 img/src 的完整 URL）：Windows/Android
/// 走 `http://{scheme}.localhost`，其余平台走原生自定义 scheme（与 Tauri
/// convertFileSrc 的平台分野一致）。URL 只由逻辑段与 id 构成，不含任何
/// 本机路径与 relPath。
pub(crate) fn opaque_media_url(scope: &MediaScope, asset_id: &str) -> String {
    let path = match scope {
        MediaScope::Library => format!("/library/{asset_id}"),
        MediaScope::Project { project_id } => format!("/project/{project_id}/{asset_id}"),
    };
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let url = format!("http://{MEDIA_SCHEME}.localhost{path}");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let url = format!("{MEDIA_SCHEME}://localhost{path}");
    url
}

/// 协议请求解析（issue #31 并入项目 scope）：接受 `/library/{assetId}` 单段
/// 与 `/project/{projectId}/{assetId}` 两段形式。id 不做百分号解码——合法
/// id 字符集（[`validate_asset_id`]/[`validate_id`]）不含 `%`，编码/异段数/
/// 异 scope 形式天然拒绝。
pub(crate) fn parse_media_uri(uri: &tauri::http::Uri) -> Result<(MediaScope, String), String> {
    let path = uri.path();
    let invalid = || format!("媒体请求路径非法：{path}");
    if let Some(rest) = path.strip_prefix("/library/") {
        if rest.is_empty() || rest.contains('/') {
            return Err(invalid());
        }
        validate_asset_id(rest)?;
        return Ok((MediaScope::Library, rest.to_string()));
    }
    if let Some(rest) = path.strip_prefix("/project/") {
        let Some((project_id, asset_id)) = rest.split_once('/') else {
            return Err(invalid());
        };
        if project_id.is_empty() || asset_id.is_empty() || asset_id.contains('/') {
            return Err(invalid());
        }
        validate_id(project_id)?;
        validate_asset_id(asset_id)?;
        return Ok((
            MediaScope::Project {
                project_id: project_id.to_string(),
            },
            asset_id.to_string(),
        ));
    }
    Err(invalid())
}

/// 库 scope 的 id → (relPath, mime) 解析内核（句柄域，锁由调用方持有；每次
/// 请求重新执行）：恢复流程复核冲突期 → 净化索引按 id 定位 → relPath 词法
/// 复核。媒体字节读取与 URL 早反馈共用。
fn resolve_media_entry_with(
    library: &cap_std::fs::Dir,
    id: &str,
) -> Result<(String, String), String> {
    validate_asset_id(id)?;
    let recovery = crate::library_journal::recover(library)?;
    if recovery.conflicted.iter().any(|c| c == id) {
        return Err(format!("资产 {id} 处于删除事务冲突期，媒体不可用"));
    }
    // 只读告警态用不落盘读取（评审修复，PR #33 第五轮）：媒体读取本身不受限，
    // 但不得在只读态把迁移结果写回 library.json
    let (index, _) = if recovery.read_only {
        let (idx, w) = crate::library_fs::read_index_normalized_readonly(library)?;
        // 只读归一化诊断进日志（评审修复，PR #33 第十九轮）：媒体响应只回
        // 200/404 无法携带 warnings，隔离/修复诊断丢弃会让脏数据不可见
        crate::library_fs::report_recovery_diagnostics("库媒体请求", &w);
        (idx, w)
    } else {
        // 挂起态读路径照常服务只读视图
        let (idx, w, _suspended) = read_index_capped(library)?;
        (idx, w)
    };
    // 迁移/恢复诊断进结构化本机日志（评审修复，PR #33 第十一轮）：媒体请求
    // 只回 200/404、响应无法携带 warnings；迁移落盘后这些隔离/改写诊断若被
    // 丢弃，后续 list 读到的是已干净文件，诊断永久丢失——不落盘规则「失败
    // 不得隐匿」同样适用于修复可见性
    for w in &recovery.warnings {
        eprintln!("[library] 库媒体请求伴随迁移/恢复诊断：{w}");
    }
    let entry = index["assets"]["byId"]
        .get(id)
        .ok_or_else(|| format!("资产不存在：{id}"))?;
    let rel = entry
        .get("relPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("资产 {id} 的 relPath 缺失"))?;
    if !is_valid_active_asset_rel_path(rel) {
        return Err(format!("资产 {id} 的 relPath 非法：{rel}"));
    }
    let mime = entry
        .get("mime")
        .and_then(Value::as_str)
        .filter(|m| is_canonical_mime(m))
        .unwrap_or("application/octet-stream")
        .to_string();
    Ok((rel.to_string(), mime))
}

/// 库 scope 锁内打开媒体句柄（句柄域，锁由调用方持有）：[`resolve_media_entry_with`]
/// 解析后复用 [`crate::assets::open_library_asset`] 的句柄链定位——最终
/// 组件 no-follow 拒绝符号链接、确认普通文件并按 (dev, ino) 身份绑定。
/// 锁的作用域到打开即结束：字节读取在锁外消费已绑定句柄（评审修复，PR
/// #32 第三轮——最多 20 MiB 的 I/O 不得串行化并发缩略图请求、不得把
/// 导入/元信息/删除排在读取全程之后）。
pub(crate) fn open_media_with(
    library: &cap_std::fs::Dir,
    id: &str,
) -> Result<(String, cap_std::fs::File), String> {
    let (rel, mime) = resolve_media_entry_with(library, id)?;
    let file = crate::assets::open_library_asset(library, &rel)?;
    Ok((mime, file))
}

/// 并发媒体读取上限（评审修复，PR #32 第四轮）：多个大图同时进入视口时，
/// 每个并发读取各自分配缓冲，N×单文件上限的瞬时峰值可能拖垮进程——读取
/// 并发数收敛到 4；许可随响应体存活到交付（见 [`MediaDelivery`]），故在
/// 交付完成前峰值 ≤ 4×单文件上限（库 20 MiB / 项目 32 MiB，见
/// [`PROJECT_MEDIA_MAX_BYTES`]）。交付后字节归 webview 所有，其消费内存
/// 不在 Rust 侧观测范围（Tauri 同步协议 API 无交付完成信号，此为文档化
/// 边界）；库写入/删除/元信息不受影响（闸门只作用于媒体字节读取）。
const MEDIA_READ_CONCURRENCY: usize = 4;

/// 并发媒体读取闸门：Mutex + Condvar 的计数信号量（同步 spawn_blocking
/// 上下文，不用 tokio::sync::Semaphore）。许可随 [`MediaReadPermit`] drop
/// 释放。
pub(crate) struct MediaReadGate {
    max: usize,
    held: Mutex<usize>,
    available: Condvar,
}

static MEDIA_READ_GATE: OnceLock<MediaReadGate> = OnceLock::new();

/// 释放许可：归还计数并唤醒一个等待者。
impl Drop for MediaReadPermit<'_> {
    fn drop(&mut self) {
        let mut held = self.0.held.lock().expect("媒体读取闸门被污染");
        *held -= 1;
        self.0.available.notify_one();
    }
}

/// 一个并发媒体读取许可；drop 时归还。
pub(crate) struct MediaReadPermit<'a>(&'a MediaReadGate);

impl MediaReadGate {
    fn new(max: usize) -> Self {
        Self {
            max,
            held: Mutex::new(0),
            available: Condvar::new(),
        }
    }

    fn gate() -> &'static MediaReadGate {
        MEDIA_READ_GATE.get_or_init(|| MediaReadGate::new(MEDIA_READ_CONCURRENCY))
    }

    /// 尝试获取许可：满额即返回 None（仅测试：确定性验证上限语义）。
    #[cfg(test)]
    fn try_acquire(&self) -> Option<MediaReadPermit<'_>> {
        let mut held = self.held.lock().expect("媒体读取闸门被污染");
        if *held >= self.max {
            return None;
        }
        *held += 1;
        Some(MediaReadPermit(self))
    }

    /// 阻塞获取许可：满额时等待释放。
    fn acquire(&self) -> MediaReadPermit<'_> {
        let mut held = self.held.lock().expect("媒体读取闸门被污染");
        while *held >= self.max {
            held = self.available.wait(held).expect("媒体读取闸门被污染");
        }
        *held += 1;
        MediaReadPermit(self)
    }
}

/// 锁外的受限字节读取（≤ `max_bytes`，库/项目 scope 各自的上限见
/// [`read_media_capped`]/[`read_project_media_capped`]）：消费已身份绑定的
/// 句柄，读取并发经 `gate` 收敛（见 [`MEDIA_READ_CONCURRENCY`]）。成功时把
/// 并发许可随结果交还调用方：许可必须存活到响应交付之后（见
/// [`MediaDelivery`]），否则等待中的读者会在先前响应体仍待交付时分配新
/// 缓冲，峰值契约不成立；失败时许可就地释放。POSIX 语义下已打开句柄的
/// 内容读取稳定——删除事务的隔离 rename 不影响该句柄，故无需持锁。
pub(crate) fn read_media_capped_in<'g>(
    gate: &'g MediaReadGate,
    id: &str,
    mime: String,
    file: cap_std::fs::File,
    max_bytes: usize,
) -> Result<(String, Vec<u8>, MediaReadPermit<'g>), String> {
    use std::io::Read;
    let permit = gate.acquire();
    let mut bytes = Vec::new();
    file.take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取资产 {id} 媒体失败：{e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "资产 {id} 的媒体超过 {} MiB 上限",
            max_bytes / (1024 * 1024)
        ));
    }
    Ok((mime, bytes, permit))
}

/// [`read_media_capped_in`] 的库 scope 全局闸门入口（20 MiB 上限）：许可
/// 存活到调用方交付（见 [`MediaDelivery`]），成功时随结果返回。
pub(crate) fn read_media_capped(
    id: &str,
    mime: String,
    file: cap_std::fs::File,
) -> Result<(String, Vec<u8>, MediaReadPermit<'static>), String> {
    read_media_capped_in(MediaReadGate::gate(), id, mime, file, ASSET_MAX_BYTES)
}

/// [`read_media_capped_in`] 的项目 scope 全局闸门入口（32 MiB 上限，评审
/// 修复 P2-2）：与生成产物写入上限 [`PROJECT_MEDIA_MAX_BYTES`] 同源——
/// 写入侧允许落盘的合法产物必须在读取侧可服务，旧 asset 协议无 20 MiB
/// 限制，迁移不得让已持久化产物永久 404。
pub(crate) fn read_project_media_capped(
    id: &str,
    mime: String,
    file: cap_std::fs::File,
) -> Result<(String, Vec<u8>, MediaReadPermit<'static>), String> {
    read_media_capped_in(
        MediaReadGate::gate(),
        id,
        mime,
        file,
        PROJECT_MEDIA_MAX_BYTES,
    )
}

/// 404 的后端诊断文本（评审修复，复用 store 的 eprintln 结构化诊断约定，
/// 见 store/commands.rs）：webview 只收非敏感 404 固定文案，原始原因带
/// `[media]` 标签进本机诊断日志——脏数据/文件缺失与普通失败可区分，
/// 失败不得隐匿（AGENTS.md 不得隐匿失败硬性规则）。
fn media_failure_diagnostic(err: &str) -> String {
    format!("[media] 媒体请求失败：{err}")
}

/// 响应映射（句柄域测试与协议处理器共用）：命中 → 200 + 索引 mime；
/// 任何失败 → 404 纯文本——不区分错误种类，避免向 webview 泄露盘面细节。
fn media_http_response(
    result: Result<(String, Vec<u8>), String>,
) -> tauri::http::Response<Vec<u8>> {
    const NOT_FOUND: &str = "媒体不可用";
    match result {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::OK)
            .header(tauri::http::header::CONTENT_TYPE, mime)
            .body(bytes)
            .expect("固定形状的媒体响应构造不可能失败"),
        Err(_) => tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .header(
                tauri::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )
            .body(NOT_FOUND.as_bytes().to_vec())
            .expect("固定形状的错误响应构造不可能失败"),
    }
}

/// 待交付的媒体响应（评审修复，PR #32 第五轮）：响应体与并发许可绑定，
/// 调用方（lib.rs 的 `pwmedia` 协议闭包）必须先解构出二者、调用
/// `responder.respond(response)` 后再让 `permit` 出界释放——许可持有到
/// 交付完成，等待中的读者才不会在先前响应体仍待交付/消费时分配新缓冲，
/// 4×20 MiB 峰值契约才成立。404 路径无许可（`permit: None`）。
pub(crate) struct MediaDelivery {
    pub(crate) response: tauri::http::Response<Vec<u8>>,
    pub(crate) permit: Option<MediaReadPermit<'static>>,
}

/// `pwmedia` 协议处理器（lib.rs 注册；在 spawn_blocking 线程执行）：解析
/// 请求 → 按 scope 逐请求解析 id（库走锁内净化索引；项目走项目文档索引，
/// §10.2 单写者 + 原子写语义无需互斥锁）→ 句柄链读字节 → 响应。§7.1 每次
/// 请求重新解析，目录项在列表后被替换也无法越出资产根。失败向 webview
/// 折叠为非敏感 404，原始原因经 [`media_failure_diagnostic`] 进本机日志。
/// 返回 [`MediaDelivery`]：调用方在 `responder.respond` 之后再释放许可
/// （评审修复，PR #32 第五轮——许可生命周期覆盖到响应交付）。
pub(crate) fn handle_media_request(app: &AppHandle, uri: &tauri::http::Uri) -> MediaDelivery {
    let result = parse_media_uri(uri).and_then(|(scope, id)| match scope {
        MediaScope::Library => {
            let library = library_root(app)?;
            // 锁内：恢复复核 + 净化索引解析 + 身份绑定打开；锁随打开结束
            let opened = {
                let _op = library_op_lock();
                let _file_lock = library_file_lock(&library)?;
                open_media_with(&library, &id)
            };
            // 锁外：消费已绑定句柄读取字节（评审修复，PR #32 第三轮）；成功
            // 时许可随结果返回，交由 MediaDelivery 持有到交付之后
            opened.and_then(|(mime, file)| read_media_capped(&id, mime, file))
        }
        MediaScope::Project { project_id } => {
            // 项目 scope（issue #31）：按项目文档逐请求解析后经
            // verify_asset_real_path 句柄链打开身份绑定句柄；读取上限与
            // 生成产物写入契约同源（评审修复 P2-2）
            let projects = projects_dir(app)?;
            let opened = open_project_media_with(&projects, &project_id, &id);
            opened.and_then(|(mime, file)| read_project_media_capped(&id, mime, file))
        }
    });
    if let Err(e) = &result {
        eprintln!("{}", media_failure_diagnostic(e));
    }
    match result {
        Ok((mime, bytes, permit)) => MediaDelivery {
            response: media_http_response(Ok((mime, bytes))),
            permit: Some(permit),
        },
        Err(e) => MediaDelivery {
            response: media_http_response(Err(e)),
            permit: None,
        },
    }
}

/// opaque asset URL 解析命令（§10.5 命令表 get_asset_media_url）：scope +
/// assetId 入参，返回前端可直接使用的 opaque URL；本机路径与 relPath 不出
/// Rust。此处仅做早反馈（库冲突期/存在性复核、项目条目存在性复核），权威
/// 校验在协议处理器的每次媒体请求内（issue #26/#31）。
#[tauri::command]
pub fn get_asset_media_url(
    app: AppHandle,
    scope: Value,
    asset_id: String,
) -> Result<String, String> {
    let parsed = parse_media_scope(&scope)?;
    match &parsed {
        MediaScope::Library => {
            let library = library_root(&app)?;
            let _op = library_op_lock();
            let _file_lock = library_file_lock(&library)?;
            resolve_media_entry_with(&library, &asset_id)?;
        }
        MediaScope::Project { project_id } => {
            let projects = projects_dir(&app)?;
            resolve_project_media_entry(&projects, project_id, &asset_id)?;
        }
    }
    Ok(opaque_media_url(&parsed, &asset_id))
}

#[cfg(test)]
mod tests;
