//! 项目存储领域错误类型（issue #144 store 分片）：保存/加载/删除/复制
//! 链路的领域内部错误按失败类别区分——底层 I/O（可重试类，保留
//! `io::Error` 来源）、控制文件损坏（保留 `serde_json::Error` 来源）、
//! 不可信输入校验失败、信任边界保护性拒绝与目标缺失——底层来源经
//! `source` 链保留，调用方在展示边界（Tauri 命令出口）经 [`to_ipc_text`]
//! 统一转换为既有中文文案（与历史 `format!` 输出逐字一致，前端可见诊断
//! 不变，issue #144 不改 IPC 错误形状）。
//!
//! 归类规则：变体刻画失败的**根因性质**（缺失/损坏/非法输入/保护性拒绝/
//! 底层 I/O），不为同类下每条诊断单独设变体；`detail`/`context` 承载的
//! 诊断明细是展示边界契约的一部分。库/日志/资产与代理等领域沿用各自
//! 边界 `String` 返回，由后续分片按同一模式迁移（#45 首片
//! `http_util::ReadBodyError`、本片 store；不引入包容所有失败的单一巨型
//! 枚举）。

/// 项目存储领域错误：store 链路内核（persist/list/validate/commands/
/// copy）的统一错误类型，领域内部传递，展示边界统一转文案。
#[derive(Debug)]
pub(crate) enum StoreError {
    /// 无法定位应用数据目录（Tauri 路径解析失败）：环境/安装异常，
    /// 非调用方可修复；来源为 Tauri 路径错误。
    AppDataDir { source: tauri::Error },
    /// 底层 I/O 失败（创建/读取/写入/同步/rename 等，重试可能恢复）：
    /// `context` 为既有诊断的操作阶段（含相关实体名），`source` 保留
    /// `io::Error`，`ErrorKind` 可由调用方经 source 链取得。
    Io {
        context: String,
        source: std::io::Error,
    },
    /// JSON 序列化失败（保存前信封/AI 会话序列化）：`context` 为操作
    /// 阶段，`source` 保留 `serde_json::Error`。
    Serialize {
        context: String,
        source: serde_json::Error,
    },
    /// 控制文件损坏——JSON 解析失败：`source` 保留 `serde_json::Error`，
    /// 展示文案为 serde 原始诊断（与历史 `to_string` 透传逐字一致）。
    CorruptJson(serde_json::Error),
    /// 控制文件损坏——信封判型/家族矛盾：固定诊断文案，无底层来源。
    CorruptEnvelope(&'static str),
    /// 信任边界保护性拒绝（§10.2 句柄相对信任链）：符号链接/异型条目、
    /// 归类或校验后的身份替换、路径形态越界等——决策类失败，无底层错误。
    Refused { detail: String },
    /// 不可信输入校验失败（IPC 参数/保存信封/AI 会话形状）：词法或形状
    /// 不满足约束，拒绝在先、不触盘。
    InvalidInput { detail: String },
    /// 目标缺失（项目/资产文件不存在）：删除路径按幂等处理，读取/保存
    /// 路径映射为显式错误。
    NotFound { detail: String },
    /// 上下文包装：错误上浮时内核附加阶段前缀，`source` 保留原错误；
    /// 类别判定越过包装链取根因（见 `root` 助手），文案为「前缀：原文案」。
    Contextual {
        prefix: String,
        source: Box<StoreError>,
    },
}

impl StoreError {
    /// 底层 I/O 失败：`context` 为既有诊断的操作阶段，`source` 为 io 错误。
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        StoreError::Io {
            context: context.into(),
            source,
        }
    }
    /// 信任边界保护性拒绝：`detail` 为既有诊断文案。
    pub(crate) fn refused(detail: impl Into<String>) -> Self {
        StoreError::Refused {
            detail: detail.into(),
        }
    }
    /// 不可信输入校验失败：`detail` 为既有诊断文案。
    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        StoreError::InvalidInput {
            detail: detail.into(),
        }
    }
    /// 目标缺失：`detail` 为既有诊断文案。
    pub(crate) fn missing(detail: impl Into<String>) -> Self {
        StoreError::NotFound {
            detail: detail.into(),
        }
    }
    /// JSON 序列化失败：`context` 为操作阶段，`source` 为 serde 错误。
    pub(crate) fn serialize(context: impl Into<String>, source: serde_json::Error) -> Self {
        StoreError::Serialize {
            context: context.into(),
            source,
        }
    }
    /// 附加阶段前缀并保留原错误为来源（展示文案与历史 `format!` 前缀
    /// 拼接逐字一致）。
    pub(crate) fn prefixed(self, prefix: impl Into<String>) -> Self {
        StoreError::Contextual {
            prefix: prefix.into(),
            source: Box::new(self),
        }
    }
    /// 越过 [`StoreError::Contextual`] 包装链取根因（类别判定用）：生产
    /// 消费方为列表内核的读取失败分派（issue #123——I/O 失败占位呈现、
    /// 信任链拒绝与并发删除跳过），测试用于类别断言。
    pub(crate) fn root(&self) -> &StoreError {
        match self {
            StoreError::Contextual { source, .. } => source.root(),
            other => other,
        }
    }
}

/// 展示边界契约：文案与历史 `format!` 输出逐字一致，前端可见诊断不变。
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::AppDataDir { source } => write!(f, "无法定位应用数据目录：{source}"),
            StoreError::Io { context, source } => write!(f, "{context}：{source}"),
            StoreError::Serialize { context, source } => write!(f, "{context}：{source}"),
            StoreError::CorruptJson(source) => write!(f, "{source}"),
            StoreError::CorruptEnvelope(detail) => write!(f, "{detail}"),
            StoreError::Refused { detail } => write!(f, "{detail}"),
            StoreError::InvalidInput { detail } => write!(f, "{detail}"),
            StoreError::NotFound { detail } => write!(f, "{detail}"),
            StoreError::Contextual { prefix, source } => write!(f, "{prefix}：{source}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::AppDataDir { source } => Some(source),
            StoreError::Io { source, .. } => Some(source),
            StoreError::Serialize { source, .. } => Some(source),
            StoreError::CorruptJson(source) => Some(source),
            StoreError::Contextual { source, .. } => Some(source.as_ref()),
            StoreError::CorruptEnvelope(_)
            | StoreError::Refused { .. }
            | StoreError::InvalidInput { .. }
            | StoreError::NotFound { .. } => None,
        }
    }
}

/// IPC 展示边界统一转换：领域错误 → 既有中文文案（供 `#[tauri::command]`
/// 出口及暂未迁移领域把 store 内核错误按原样文案上浮）。
pub(crate) fn to_ipc_text(e: StoreError) -> String {
    e.to_string()
}

/// `load_project` 出口的 IPC 文案（issue #229）：NotFound 根因携带稳定机器
/// 码前缀 `[project_not_found] `——前端程序判定（空库播种的存在性分支）按码
/// 分支，不经中文文案，展示措辞/本地化调整不改变行为；码不上屏，前端展示层
/// 剥离前缀。其余类别（Io/损坏/拒绝）不带码，前端对无码错误保守视为「存在
/// 但不可读」，绝不以示例覆盖。与 issue #144 保留的 `Result<_, String>` 出口
/// 契约兼容；新增需要程序判定的错误时在此登记码值。
pub(crate) fn load_project_ipc_text(e: StoreError) -> String {
    if matches!(e.root(), StoreError::NotFound { .. }) {
        format!("[project_not_found] {e}")
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    /// 展示边界契约：Io/Serialize 变体文案为「操作阶段：底层错误」，
    /// 与历史 `format!` 输出逐字一致（Tauri 命令出口以 to_string 转换）。
    #[test]
    fn io_display_composes_context_and_source() {
        let e = StoreError::io("创建临时文件失败", io::Error::other("boom"));
        assert_eq!(e.to_string(), "创建临时文件失败：boom");
        assert!(std::error::Error::source(&e).is_some(), "io 来源应保留");
        assert_eq!(
            std::error::Error::source(&e).unwrap().to_string(),
            "boom",
            "ErrorKind/底层诊断应可经 source 链取得"
        );
    }

    /// 展示边界契约：序列化失败保留 serde 来源。
    #[test]
    fn serialize_display_composes_context_and_serde_source() {
        // serde_json::Error 同型即可（保存链的序列化失败实践中不可达，
        // 此处验证变体展示与来源契约）
        let serde_err = serde_json::from_str::<serde_json::Value>("nope").expect_err("非法 JSON");
        let e = StoreError::serialize("序列化失败", serde_err);
        assert!(e.to_string().starts_with("序列化失败："));
        assert!(
            std::error::Error::source(&e).is_some_and(|s| s.is::<serde_json::Error>()),
            "serde 来源应经 source 链保留"
        );
    }

    /// 展示边界契约：JSON 解析失败的文案为 serde 原始诊断（与历史
    /// `to_string` 透传一致），来源保留为 `serde_json::Error`。
    #[test]
    fn corrupt_json_display_passes_through_serde_text_with_source() {
        let serde_err = serde_json::from_str::<serde_json::Value>("nope").expect_err("非法 JSON");
        let expected = serde_err.to_string();
        let e = StoreError::CorruptJson(serde_err);
        assert_eq!(e.to_string(), expected);
        assert!(
            std::error::Error::source(&e).is_some_and(|s| s.is::<serde_json::Error>()),
            "损坏的 serde 来源应保留"
        );
    }

    /// 展示边界契约：保护性拒绝/非法输入/缺失/信封判型损坏的文案即
    /// 诊断明细字段本身。
    #[test]
    fn detail_variants_display_their_detail_field() {
        assert_eq!(
            StoreError::refused("项目文件是符号链接，拒绝读取").to_string(),
            "项目文件是符号链接，拒绝读取"
        );
        assert_eq!(
            StoreError::invalid("非法项目 id：../evil").to_string(),
            "非法项目 id：../evil"
        );
        assert_eq!(
            StoreError::missing("项目不存在：p-1").to_string(),
            "项目不存在：p-1"
        );
        assert_eq!(
            StoreError::CorruptEnvelope(
                "无法判别文档信封：v1 与旧扁平特征键混合或均不足（已保留原文件）"
            )
            .to_string(),
            "无法判别文档信封：v1 与旧扁平特征键混合或均不足（已保留原文件）"
        );
    }

    /// 上下文包装：文案为「前缀：原文案」（与历史 format! 前缀拼接逐字
    /// 一致），原错误的类别与来源均保留，root() 越过包装链取根因。
    #[test]
    fn contextual_prefix_preserves_root_cause_and_source_chain() {
        let e =
            StoreError::io("读取项目文件失败", io::Error::other("x")).prefixed("拒绝读取项目文件");
        assert_eq!(e.to_string(), "拒绝读取项目文件：读取项目文件失败：x");
        assert!(
            std::error::Error::source(&e).is_some(),
            "包装不得丢弃来源链"
        );
        assert!(
            matches!(e.root(), StoreError::Io { .. }),
            "根因类别应可越过包装判定"
        );
        // 多层包装同样收敛到根因
        let deep = e.prefixed("项目文件损坏");
        assert!(matches!(deep.root(), StoreError::Io { .. }));
        assert_eq!(
            deep.to_string(),
            "项目文件损坏：拒绝读取项目文件：读取项目文件失败：x"
        );
    }

    /// 决策类失败（保护性拒绝/非法输入/缺失/信封判型损坏）无底层来源。
    #[test]
    fn decision_variants_have_no_source() {
        for e in [
            StoreError::refused("拒绝"),
            StoreError::invalid("非法"),
            StoreError::missing("缺失"),
            StoreError::CorruptEnvelope("信封矛盾"),
        ] {
            assert!(
                std::error::Error::source(&e).is_none(),
                "决策类失败不应伪造来源：{e}"
            );
        }
    }

    /// issue #229 契约：`load_project` 的 NotFound 出口携带稳定机器码前缀
    /// `[project_not_found] `——前端播种按码分支，不经中文文案（文案可
    /// 本地化/改写而行为不变）；其余类别（Io/损坏/拒绝）不带码，前端对
    /// 无码错误保守视为「存在但不可读」，绝不以示例覆盖。
    #[test]
    fn load_project_ipc_text_codes_only_not_found_root() {
        assert_eq!(
            load_project_ipc_text(StoreError::missing("项目不存在：p-1")),
            "[project_not_found] 项目不存在：p-1"
        );
        // 包装链按根因类别判定（root() 越过 Contextual）
        let wrapped = StoreError::missing("项目不存在：p-2").prefixed("读取失败");
        assert_eq!(
            load_project_ipc_text(wrapped),
            "[project_not_found] 读取失败：项目不存在：p-2"
        );
        // 非 NotFound 类别不带码：不可读/未知错误前端保守跳过播种
        let io = StoreError::io("读取项目文件失败", io::Error::other("denied"));
        assert_eq!(load_project_ipc_text(io), "读取项目文件失败：denied");
        assert_eq!(
            load_project_ipc_text(StoreError::CorruptEnvelope("信封矛盾")),
            "信封矛盾"
        );
    }
}
