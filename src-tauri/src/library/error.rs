//! 个人资产库领域错误类型（issue #144 library 分片）：资产库（索引、
//! 媒体、编组）、其删除隔离日志与恢复链路的领域内部错误按失败类别
//! 区分——底层 I/O（保留 `io::Error` 来源）、索引损坏（JSON 解析保留
//! `serde_json::Error` 来源；形状损坏为固定诊断）、序列化失败（保留
//! serde 来源）、大小上限族、不可信输入校验失败、信任边界/状态类保护性
//! 拒绝与目标缺失——底层来源经 `source` 链保留，store 持久化原语经
//! [`LibraryError::Store`] 透传（文案与来源原样），调用方在展示边界
//! （Tauri 命令出口、pwmedia 协议 404 折叠）以 `Display` 统一转换为既有
//! 中文文案（与历史 `format!` 输出逐字一致，前端可见诊断不变）。
//!
//! 归类规则与 store 分片一致：变体刻画失败的**根因性质**，不为同类下每条
//! 诊断单独设变体；`detail`/`context` 承载的明细是展示边界契约的一部分。

use crate::store::error::StoreError;

/// 个人资产库领域错误：library / library_fs / library_journal 与媒体
/// 解析内核的统一错误类型，领域内部传递，展示边界统一转文案。
#[derive(Debug)]
pub(crate) enum LibraryError {
    /// 无法定位应用数据目录（Tauri 路径解析失败）：环境/安装异常。
    AppDataDir { source: tauri::Error },
    /// 底层 I/O 失败（创建/读取/写入/同步/rename 等，重试可能恢复）：
    /// `context` 为既有诊断的操作阶段（含相关实体名），`source` 保留
    /// `io::Error`。
    Io {
        context: String,
        source: std::io::Error,
    },
    /// JSON 序列化失败（索引/删除日志落盘前序列化）：`source` 保留
    /// `serde_json::Error`。
    Serialize {
        context: String,
        source: serde_json::Error,
    },
    /// 索引损坏——JSON 解析失败：`source` 保留 `serde_json::Error`，
    /// 展示文案固定为「资产索引损坏：{来源}」（两处读取路径同文案）。
    CorruptIndex(serde_json::Error),
    /// 索引/日志数据损坏（非 serde 层）：根形状异型、结构损坏、编码非法
    /// 等固定诊断，无底层来源。
    Corrupt { detail: String },
    /// 大小上限族（索引读/写/规范化表示/迁移结果/导入文件）：异常膨胀
    /// 的数据在物化或落盘前被拒。
    Limit { detail: String },
    /// 不可信输入/数据词法校验失败（id/名称/分类/补丁/relPath 词法等）。
    InvalidInput { detail: String },
    /// 信任边界或状态类保护性拒绝：句柄信任链（符号链接/异型/身份替换）、
    /// 只读告警态与迁移挂起态的写拒绝、冲突期拒绝、日志积压守卫、平台
    /// 能力缺失——决策类失败，无底层错误。
    Refused { detail: String },
    /// 目标缺失（资产/组/目录不存在）：删除幂等处理，读取/写入显式报错。
    NotFound { detail: String },
    /// store 持久化原语错误透传（`From` 转换）：文案与来源链原样保留，
    /// 类别判定可继续下钻内层 `StoreError`。
    Store(StoreError),
}

impl LibraryError {
    /// 底层 I/O 失败：`context` 为既有诊断的操作阶段，`source` 为 io 错误。
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        LibraryError::Io {
            context: context.into(),
            source,
        }
    }
    /// JSON 序列化失败：`context` 为操作阶段，`source` 为 serde 错误。
    pub(crate) fn serialize(context: impl Into<String>, source: serde_json::Error) -> Self {
        LibraryError::Serialize {
            context: context.into(),
            source,
        }
    }
    /// 信任边界/状态类保护性拒绝：`detail` 为既有诊断文案。
    pub(crate) fn refused(detail: impl Into<String>) -> Self {
        LibraryError::Refused {
            detail: detail.into(),
        }
    }
    /// 不可信输入/数据词法校验失败：`detail` 为既有诊断文案。
    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        LibraryError::InvalidInput {
            detail: detail.into(),
        }
    }
    /// 目标缺失：`detail` 为既有诊断文案。
    pub(crate) fn missing(detail: impl Into<String>) -> Self {
        LibraryError::NotFound {
            detail: detail.into(),
        }
    }
}

impl From<StoreError> for LibraryError {
    fn from(e: StoreError) -> Self {
        LibraryError::Store(e)
    }
}

/// 展示边界契约：文案与历史 `format!` 输出逐字一致，前端可见诊断不变。
impl std::fmt::Display for LibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LibraryError::AppDataDir { source } => write!(f, "无法定位应用数据目录：{source}"),
            LibraryError::Io { context, source } => write!(f, "{context}：{source}"),
            LibraryError::Serialize { context, source } => write!(f, "{context}：{source}"),
            LibraryError::CorruptIndex(source) => write!(f, "资产索引损坏：{source}"),
            LibraryError::Corrupt { detail } => write!(f, "{detail}"),
            LibraryError::Limit { detail } => write!(f, "{detail}"),
            LibraryError::InvalidInput { detail } => write!(f, "{detail}"),
            LibraryError::Refused { detail } => write!(f, "{detail}"),
            LibraryError::NotFound { detail } => write!(f, "{detail}"),
            LibraryError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LibraryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LibraryError::AppDataDir { source } => Some(source),
            LibraryError::Io { source, .. } => Some(source),
            LibraryError::Serialize { source, .. } => Some(source),
            LibraryError::CorruptIndex(source) => Some(source),
            LibraryError::Store(e) => Some(e),
            LibraryError::Corrupt { .. }
            | LibraryError::Limit { .. }
            | LibraryError::InvalidInput { .. }
            | LibraryError::Refused { .. }
            | LibraryError::NotFound { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    /// 展示边界契约：各变体文案与历史 `format!` 输出逐字一致。
    #[test]
    fn display_composes_historical_texts() {
        assert_eq!(
            LibraryError::io("创建资产库目录失败", io::Error::other("boom")).to_string(),
            "创建资产库目录失败：boom"
        );
        assert_eq!(
            LibraryError::refused("隔离目录是符号链接，拒绝操作").to_string(),
            "隔离目录是符号链接，拒绝操作"
        );
        assert_eq!(
            LibraryError::missing("资产不存在：la-1").to_string(),
            "资产不存在：la-1"
        );
        assert_eq!(
            LibraryError::invalid("非法资产 id：../evil").to_string(),
            "非法资产 id：../evil"
        );
        assert_eq!(
            LibraryError::Limit {
                detail: "资产库索引超过 1 MiB 上限，拒绝读取".into()
            }
            .to_string(),
            "资产库索引超过 1 MiB 上限，拒绝读取"
        );
    }

    /// 索引损坏保留 serde 来源，文案固定带「资产索引损坏」前缀。
    #[test]
    fn corrupt_index_preserves_serde_source_with_prefix() {
        let serde_err = serde_json::from_str::<serde_json::Value>("nope").expect_err("非法 JSON");
        let e = LibraryError::CorruptIndex(serde_err);
        assert!(e.to_string().starts_with("资产索引损坏："), "实际文案：{e}");
        assert!(
            std::error::Error::source(&e).is_some_and(|s| s.is::<serde_json::Error>()),
            "损坏的 serde 来源应保留"
        );
    }

    /// store 原语透传：文案与来源链原样，类别可下钻内层 StoreError。
    #[test]
    fn store_passthrough_preserves_text_and_source() {
        let e: LibraryError =
            StoreError::io("读取项目文件元数据失败", io::Error::other("x")).into();
        assert_eq!(e.to_string(), "读取项目文件元数据失败：x");
        assert!(
            std::error::Error::source(&e).is_some(),
            "透传不得丢弃 store 来源链"
        );
        assert!(
            matches!(e, LibraryError::Store(StoreError::Io { .. })),
            "类别应可下钻：{e:?}"
        );
    }

    /// 决策类失败无底层来源；io/序列化保留来源。
    #[test]
    fn decision_variants_have_no_source() {
        for e in [
            LibraryError::refused("拒绝"),
            LibraryError::invalid("非法"),
            LibraryError::missing("缺失"),
            LibraryError::Corrupt {
                detail: "异型".into(),
            },
            LibraryError::Limit {
                detail: "超限".into(),
            },
        ] {
            assert!(
                std::error::Error::source(&e).is_none(),
                "决策类失败不应伪造来源：{e}"
            );
        }
    }
}
