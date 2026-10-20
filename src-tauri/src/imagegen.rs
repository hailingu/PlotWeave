//! 画布内 AI 图像生成代理（docs/data-model.md §13 首个落地切片：文生图）。
//!
//! - `llm_image_generate`：前端只传 provider 配置、prompt、尺寸与 job id；
//!   API key 密文在本进程解密（与 `llm_chat` 同域，明文不出后端），请求
//!   OpenAI 兼容 `/images/generations`（GPT Image 系恒回 base64；部分兼容
//!   实现只回 `url`，则回退下载——目标与每跳重定向均过公网边界校验，
//!   恶意/被入侵 provider 不得驱使桌面端探入用户本机/内网），响应体
//!   流式限读、产物按字节魔数定型 MIME、过大小上限后原子落盘进项目
//!   `assets/`（`source=generated`），返回项目级 AssetRef。
//! - `llm_image_cancel`：协作式取消——登记取消标志，进行中的生成在请求
//!   返回后与落盘前检查并放弃结果。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use base64::Engine as _;
use cap_std::fs::Dir as CapDir;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::http_util::{read_text_capped, ProxyError};

mod download;
mod public_address;
use download::fetch_image_url;

/// 生成产物大小上限（32 MiB）：防异常响应把内存/磁盘撑爆。pwmedia 项目
/// scope 的读取上限（256 MiB 防御界）远超本值——生成产物契约是项目资产
/// 持久化契约的真子集（评审修复 P2-2/P2-4）。
const GENERATED_IMAGE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// 响应体读取上限（64 MiB）：主响应是 JSON 文本，base64 膨胀约 4/3 加
/// JSON 开销，按产物上限放宽一倍封顶——流式聚合、超限即中止，恶意/
/// 异常 provider 的超大响应在物化前被拒，上限真正护住内存。
const RESPONSE_BODY_MAX_BYTES: usize = GENERATED_IMAGE_MAX_BYTES * 2;

/// 生成请求超时：图像模型普遍慢于对话，放宽到 5 分钟。
const IMAGE_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 图像 MIME 嗅探（字节魔数）：PNG/JPEG/WebP/GIF 之外的格式拒绝落盘——
/// provider 声称的 content-type 不可信，落盘条目以字节实情为准。
pub(crate) fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

/// 响应成员 `data[0].b64_json` 解码：成员缺失、非字符串或 base64 非法均
/// 返回 None（交由调用方决定是否走 url 回退）。
fn decode_b64_image(resp: &Value) -> Option<Vec<u8>> {
    let b64 = resp.pointer("/data/0/b64_json")?.as_str()?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// 响应成员 `data[0].url`：仅接受字符串。
fn image_url_of(resp: &Value) -> Option<String> {
    resp.pointer("/data/0/url")?.as_str().map(str::to_string)
}

/// 取消墓碑上限（issue #143）：未知/已结束 id 的预取消墓碑按 FIFO
/// 淘汰——取消表不再无界增长。容量取 64：远覆盖一次会话的合理并发
/// 生成数；墓碑只服务「先取消后登记」的短窗口（见 `register`）。
const CANCEL_TOMBSTONE_CAP: usize = 64;

/// 生成作业取消注册表（issue #143，Tauri managed state——应用显式拥有
/// 的生命周期（lib.rs `Builder::manage`），非进程级静态单例）：取消
/// 状态归属有边界的活动作业注册。
/// - 活动作业：命令入口 `register` 登记，返回 RAII 守卫——成功/失败/
///   取消/卸载全部出口随 Drop 清理（错误路径不再依赖逐点 clear，
///   根治「部分错误路径遗留标记」）；`cancel` 命中活动作业即标记，
///   检查点经守卫 `is_cancelled` 查询。
/// - 预取消墓碑：`cancel` 命中未知/已结束 id 进有界墓碑（去重 + FIFO
///   淘汰——未知与迟到取消不无界增长）；`register` 消费同 id 墓碑使
///   预取消生效。预取消语义保留：前端取消可早于命令登记，丢掉它会
///   让已取消作业的付费产物落盘；复用墓碑窗口内的 id 按此语义继承
///   取消（前端 uid 唯一发号，正常路径不触发）。
///
/// 中毒后行为（issue #145）：经 `crate::lock::recover_guard` 恢复。
pub(crate) struct ImageJobRegistry {
    state: Mutex<JobRegistryState>,
}

#[derive(Default)]
struct JobRegistryState {
    /// 活动作业 id → 是否已被取消（登记入口/检查点查询）。
    active: HashMap<String, bool>,
    /// 预取消墓碑（去重、FIFO 淘汰、登记时消费）。
    tombstones: VecDeque<String>,
}

impl ImageJobRegistry {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(JobRegistryState::default()),
        }
    }

    /// 查询作业取消状态（命令侧检查点）：登记缺失视为未取消——检查点
    /// 均在登记守卫存活的语句序列内执行。阻塞线程上落盘单元的锁内复验
    /// 走 [`ImageJobRegistry::writable`]（登记缺失同样拒绝）。
    pub(crate) fn is_cancelled(&self, job_id: &str) -> bool {
        crate::lock::recover_guard(self.state.lock(), "生成作业注册表")
            .active
            .get(job_id)
            .copied()
            .unwrap_or(false)
    }

    /// 落盘单元的锁内复验（issue #310 评审修复）：作业仍处活动登记且
    /// 未被取消才允许写盘。spawn_blocking 不随等待者取消中断——命令
    /// future 被丢弃（如运行时关闭）时登记守卫先行 Drop 移除活动条目，
    /// 登记缺失同样拒绝：响应已无人接收，继续写盘只会留下不可达资产，
    /// 此前已登记的取消也不得被守卫释放抹去。
    pub(crate) fn writable(&self, job_id: &str) -> bool {
        crate::lock::recover_guard(self.state.lock(), "生成作业注册表")
            .active
            .get(job_id)
            .copied()
            == Some(false)
    }

    /// 命令入口登记：消费同 id 预取消墓碑（若有）并登记活动作业——
    /// 返回的守卫在 Drop 时移除活动登记，全部出口统一清理。
    fn register<'a>(&'a self, job_id: &str) -> JobRegistration<'a> {
        crate::lock::recover_guard(self.state.lock(), "生成作业注册表").register(job_id);
        JobRegistration {
            registry: self,
            job_id: job_id.to_string(),
        }
    }

    /// 登记取消：活动作业标记取消；未知/已结束 id 进有界墓碑（去重 +
    /// FIFO 淘汰，issue #143 验收：未知与迟到取消不无界增长）。
    fn cancel(&self, job_id: &str) -> ImageCancelResult {
        let cancelled =
            crate::lock::recover_guard(self.state.lock(), "生成作业注册表").cancel(job_id);
        ImageCancelResult { cancelled }
    }
}

impl JobRegistryState {
    fn register(&mut self, job_id: &str) {
        let pre_cancelled = match self.tombstones.iter().position(|id| id == job_id) {
            Some(pos) => {
                self.tombstones.remove(pos);
                true
            }
            None => false,
        };
        self.active.insert(job_id.to_string(), pre_cancelled);
    }

    /// Mark a live flag before reporting a hit; absent IDs still update the bounded tombstones.
    fn cancel(&mut self, job_id: &str) -> bool {
        if let Some(cancelled) = self.active.get_mut(job_id) {
            *cancelled = true;
            return true;
        }
        if self.tombstones.iter().any(|id| id == job_id) {
            return false;
        }
        if self.tombstones.len() >= CANCEL_TOMBSTONE_CAP {
            self.tombstones.pop_front();
        }
        self.tombstones.push_back(job_id.to_string());
        false
    }
}

/// 活动作业登记守卫（RAII）：`is_cancelled` 供检查点查询；Drop 清理
/// 活动登记——成功/失败/取消/卸载出口统一，错误路径不再遗留标记。
pub(crate) struct JobRegistration<'a> {
    registry: &'a ImageJobRegistry,
    job_id: String,
}

impl JobRegistration<'_> {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.registry.is_cancelled(&self.job_id)
    }
}

impl Drop for JobRegistration<'_> {
    fn drop(&mut self) {
        crate::lock::recover_guard(self.registry.state.lock(), "生成作业注册表")
            .active
            .remove(&self.job_id);
    }
}

/// url 回退下载的重定向上限：禁用客户端自动跟随、逐跳显式复验目标，
/// 防重定向链绕过首跳校验。
const DOWNLOAD_REDIRECT_LIMIT: usize = 5;

/// url 回退下载超时：只拉一帧 ≤32MiB 的图像，远小于生成超时。
const IMAGE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// 一次生成作业的总时间预算（issue #141）：覆盖 provider 凭据读取
/// （阻塞线程池）、生成 POST（含响应体读取）与 url 回退下载链（逐跳
/// DNS 解析 + 请求 + 响应体读取，最多 5 跳重定向可发 6 次请求）。作业
/// 开始时刻起算，各阶段等待上界均为剩余预算（[`with_stage_budget`] /
/// [`bounded_key_load`]）；预算耗尽即放弃并按阶段给出诊断，产物不写
/// 回，也不发出可能计费的请求。逐跳 120s 与 POST 300s 客户端上限保留
/// 为单阶段兜底。
const IMAGE_JOB_TOTAL_BUDGET_SECS: u64 = 600;

/// 作业剩余预算：截止时刻已过即 None（调用方按预算耗尽处置）。
fn remaining_budget(deadline: std::time::Instant) -> Option<std::time::Duration> {
    deadline.checked_duration_since(std::time::Instant::now())
}

/// 统一作业预算内核（issue #141）：把剩余预算作为等待上界套在任一
/// 阶段 future（生成 POST + 限读 / 每跳请求 / 响应体读取）上——预算
/// 内完成则结果与自身错误原样透传（不过度介入既有诊断），超时即
/// 放弃等待并返回带阶段标签的 [`ProxyError::JobBudgetExhausted`]。诊断
/// 区分阶段，满足验收「超时诊断区分阶段」。DNS 解析不走本内核：不可
/// 取消的阻塞解析由专用线程边界隔离（见 [`DNS_RESOLVE_MAX_IN_FLIGHT`]）。
async fn with_stage_budget<T, F>(
    deadline: std::time::Instant,
    stage: &'static str,
    fut: F,
) -> Result<T, ProxyError>
where
    F: std::future::Future<Output = Result<T, ProxyError>>,
{
    let Some(remaining) = remaining_budget(deadline) else {
        return Err(ProxyError::JobBudgetExhausted {
            stage,
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        });
    };
    match tokio::time::timeout(remaining, fut).await {
        Ok(result) => result,
        Err(_elapsed) => Err(ProxyError::JobBudgetExhausted {
            stage,
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        }),
    }
}

/// 生成请求参数（前端单对象传入：provider 配置 + 生成输入 + job 标识）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenRequest {
    project_id: String,
    job_id: String,
    provider_id: String,
    base_url: String,
    model: String,
    prompt: String,
    size: String,
}

/// 生成请求体（§13）：只含 model/prompt/size——**不携带 `response_format`**：
/// GPT Image 系（gpt-image-1 等）不接受该参数（携带即 400 unsupported
/// parameter，主路径在生成前失败），且总是返回 base64；DALL·E 系默认 url
/// 响应由响应侧 url 成员回退下载兜住。
fn generation_request_body(model: &str, prompt: &str, size: &str) -> Value {
    json!({ "model": model, "prompt": prompt, "size": size })
}

/// 文生图命令（§13）：成功返回 `source=generated` 的项目级 AssetRef，
/// 前端直接并入会话资产索引。请求返回后与落盘前各检查一次取消标志：
/// 协作式取消即放弃结果；落盘后在**命令内**完成 §9.3 预检（形状 +
/// 实路径复验）——生成后到返回前不再跨命令边界，消除前端二次 IPC 的
/// 卸载丢结果窗口。
/// provider API key 读取（provider_credential 为同步阻塞访问：设置文件读取
/// 与系统钥匙串）挪入阻塞线程池并受作业剩余预算约束（issue #141 评审
/// ——总预算自命令进入起算，前置阻塞不得在预算耗尽后仍发起计费请求）。
/// 阻塞任务不可取消：预算耗尽只是放弃等待，任务返回后结果被丢弃、不
/// 持有应用锁（同 DNS 解析的资源生命周期）。`load` 的错误文案原样
/// 透传；预算耗尽诊断标明读取凭据阶段。
async fn bounded_key_load<T: Send + 'static>(
    deadline: std::time::Instant,
    load: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let budget = || {
        ProxyError::JobBudgetExhausted {
            stage: "读取凭据",
            budget_secs: IMAGE_JOB_TOTAL_BUDGET_SECS,
        }
        .to_string()
    };
    let Some(remaining) = remaining_budget(deadline) else {
        return Err(budget());
    };
    match tokio::time::timeout(remaining, tauri::async_runtime::spawn_blocking(load)).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("读取 API key 失败：{join}")),
        Err(_) => Err(budget()),
    }
}

/// 生图出口的错误展示转换（聊天入口保留 SendTimeout 分类）：SendTimeout
/// 保留生成入口既有的「请求失败：」超时文案，其余类别统一 Display。
/// 裸 reqwest 错误的 Display 内嵌完整请求 URL（issue #308：SendTimeout
/// 特判绕开 [`ProxyError`] 的 Display 脱敏，敏感 query 随之进入前端
/// 诊断）——「请求失败：」前缀经 [`describe_reqwest_error`] 脱敏，
/// 与 #149「reqwest 展示路径统一脱敏」契约对齐（query/userinfo/fragment
/// 剥离，scheme/host/path 与错误类别保留）。
fn generate_exit_text(error: ProxyError) -> String {
    match error {
        ProxyError::SendTimeout { source, .. } => {
            format!(
                "请求失败：{}",
                crate::http_util::describe_reqwest_error(&source)
            )
        }
        other => other.to_string(),
    }
}

/// 生成请求 → 图像字节（自 llm_image_generate 提取，PR #220 评审：命令
/// 体超出 80 代码行硬上限）：POST 与响应体限读共同消费作业剩余预算
/// （issue #141 评审——预算被前置工作耗尽时在 POST 之前拒绝，不发出
/// 可能计费的请求）→ 读取后取消检查点（保持提取前位置与语义）→ 解析
/// b64 优先，url 成员回退预算化下载链。错误统一转既有展示文案。
async fn generate_image_bytes(
    base_url: &str,
    key: &str,
    body: &Value,
    registration: &JobRegistration<'_>,
    job_deadline: std::time::Instant,
) -> Result<Vec<u8>, String> {
    let (status, response_url, text) = with_stage_budget(job_deadline, "生成请求", async {
        let response = crate::provider_transport::post_json(
            base_url,
            "images/generations",
            key,
            body,
            IMAGE_REQUEST_TIMEOUT_SECS,
        )
        .await?;
        let status = response.status();
        let response_url = response.url().clone();
        // 展示边界转换（issue #45 首片）：文案与历史 format! 输出逐字一致
        let text = read_text_capped(response, RESPONSE_BODY_MAX_BYTES)
            .await
            .map_err(ProxyError::Body)?;
        Ok((status, response_url, text))
    })
    .await
    .map_err(generate_exit_text)?;
    if registration.is_cancelled() {
        return Err("已取消".into());
    }
    if !status.is_success() {
        // 网关/代理回显请求 URL 或密钥时展示不泄露（issue #149）
        let head = crate::http_util::redact_status_head(&text, key, &response_url);
        return Err(format!("服务返回 {status}：{head}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("响应不是有效 JSON：{e}"))?;
    match decode_b64_image(&parsed) {
        Some(b) => Ok(b),
        None => {
            let url = image_url_of(&parsed).ok_or("服务未返回图像内容")?;
            fetch_image_url(&url, job_deadline)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

/// 生图落盘同步内核（生产与测试共用，依赖注入以便夹具替换）：操作锁
/// 内写入 + §9.3 预检。锁内复验经 [`ImageJobRegistry::writable`]——
/// 已取消**或登记缺失**（命令 future 已被丢弃，评审修复）均拒绝；登记
/// 守卫生命周期由调用方持有。
fn write_and_validate_generated_asset(
    projects: &CapDir,
    pending: &crate::assets::project_media::PendingProjectAssets,
    registry: &ImageJobRegistry,
    job_id: &str,
    project_id: &str,
    bytes: &[u8],
    mime: &'static str,
) -> Result<Value, String> {
    let written =
        crate::assets::write_generated_asset(projects, project_id, bytes, mime, pending, &|| {
            !registry.writable(job_id)
        })
        .map_err(|e| e.to_string())?;
    // §9.3 预检并入同一工作单元（同一根句柄）：返回的产物已完成形状+实路径校验
    crate::assets::validate_project_asset_with(projects, project_id, &written)
        .map_err(|e| e.to_string())
}

/// 生成产物落盘调度（issue #310，#138/#279 之后剩余的生图阻塞路径）：
/// 目录准备、操作锁等待（与项目删除串行）、写入与 §9.3 预检作为单一
/// 同步工作单元移入阻塞执行——慢磁盘或锁竞争不再占用异步工作线程。
/// 取消复验经托管注册表在锁内进行；登记守卫生命周期仍在命令侧（调用方
/// 显式持有到本调用完成，见 `llm_image_generate`），不提前释放登记。
async fn persist_generated_asset(
    app: AppHandle,
    project_id: String,
    bytes: Vec<u8>,
    mime: &'static str,
    job_id: String,
) -> Result<Value, String> {
    crate::blocking::run("llm_image_generate", move || {
        let projects = crate::store::projects_dir(&app).map_err(crate::store::to_ipc_text)?;
        let pending = app.state::<crate::assets::project_media::PendingProjectAssets>();
        write_and_validate_generated_asset(
            &projects,
            &pending,
            &app.state::<ImageJobRegistry>(),
            &job_id,
            &project_id,
            &bytes,
            mime,
        )
    })
    .await
}

/// Bind the provider snapshot before billable work, retaining registration through the durable asset commit.
#[tauri::command]
pub async fn llm_image_generate(app: AppHandle, request: ImageGenRequest) -> Result<Value, String> {
    // 作业总预算自命令进入时刻起算（issue #141）：覆盖 POST 与下载链
    let job_deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(IMAGE_JOB_TOTAL_BUDGET_SECS);
    let ImageGenRequest {
        project_id,
        job_id,
        provider_id,
        base_url,
        model,
        prompt,
        size,
    } = request;
    // 活动作业登记（issue #143）：RAII 守卫覆盖全部出口——成功/失败/
    // 取消/卸载随 Drop 清理，错误路径不再遗留标记；预取消墓碑在登记
    // 时消费（先取消后登记的语义保留）
    let registry = app.state::<ImageJobRegistry>();
    let registration = registry.register(&job_id);
    if registration.is_cancelled() {
        return Err("已取消".into());
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt 不能为空".into());
    }
    if model.trim().is_empty() {
        return Err("未选择模型".into());
    }
    let credential = {
        let app = app.clone();
        bounded_key_load(job_deadline, move || {
            crate::prefs::provider_credential(&app, &provider_id, &base_url)
        })
        .await?
    };
    let body = generation_request_body(&model, prompt, &size);
    // POST 与下载链（含预算耗尽）的失败经同一展示文案上浮
    let bytes = generate_image_bytes(
        &credential.base_url,
        &credential.key,
        &body,
        &registration,
        job_deadline,
    )
    .await?;
    if bytes.len() > GENERATED_IMAGE_MAX_BYTES {
        return Err(format!(
            "生成图像超出大小上限（{GENERATED_IMAGE_MAX_BYTES} 字节）"
        ));
    }
    let mime = sniff_image_mime(&bytes).ok_or("生成内容不是支持的图像格式（PNG/JPEG/WebP/GIF）")?;
    if registration.is_cancelled() {
        return Err("已取消".into());
    }
    // 落盘与校验移入阻塞执行（issue #310）：慢磁盘/锁竞争不占用异步
    // 工作线程；显式 drop 把登记守卫生命周期延到持久化完成——锁内取消
    // 复验（阻塞线程经托管注册表查询）全程有效，Drop 清理语义不变。
    // 守卫借用原句柄，持久化用克隆句柄（同一托管注册表实例）。
    let asset = persist_generated_asset(app.clone(), project_id, bytes, mime, job_id).await?;
    drop(registration);
    Ok(asset)
}

/// #630 IPC response: a matched active flag, not proof that the remote HTTP request stopped.
#[derive(Debug, serde::Serialize)]
pub struct ImageCancelResult {
    /// True only after an active job's cooperative cancellation flag has been marked.
    pub cancelled: bool,
}

/// 协作式取消命令（issue #143）：活动作业标记取消；未知/已结束 id 进
/// 有界墓碑（去重 + FIFO 淘汰——未知与迟到取消不无界增长，登记时消费
/// 使预取消生效）。中毒恢复——登记真实生效才报成功（issue #145）。
#[tauri::command]
pub fn llm_image_cancel(app: AppHandle, job_id: String) -> Result<ImageCancelResult, String> {
    Ok(app.state::<ImageJobRegistry>().cancel(&job_id))
}

#[cfg(test)]
mod tests;
