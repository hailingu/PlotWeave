//! 项目资产领域错误类型（issue #144 assets 分片）：项目资产导入（库 →
//! 项目拷贝）、生成媒体落盘、AssetRef 预检与 pwmedia 项目 scope 解析链路
//! 的领域内部错误按失败类别区分——底层 I/O（保留 `io::Error` 来源）、
//! 不可信输入/数据词法校验失败、信任边界保护性拒绝与目标缺失；store
//! 持久化原语与资产库（library）域错误分别经 [`AssetsError::Store`] 与
//! [`AssetsError::Library`] 透传（文案与来源原样），阶段前缀包装经
//! [`AssetsError::Contextual`] 保留原错误来源链。调用方在展示边界
//! （Tauri 命令出口、pwmedia 协议 404 折叠、生成代理命令）以 `Display`
//! 统一转换为既有中文文案（与历史 `format!` 输出逐字一致）。
//!
//! 归类规则与 store / library 分片一致：变体刻画失败的**根因性质**，
//! `detail`/`context` 承载的明细是展示边界契约的一部分。

use crate::library::error::LibraryError;
use crate::store::error::StoreError;

/// 项目资产领域错误：assets / project_media 内核的统一错误类型，领域
/// 内部传递，展示边界统一转文案。
#[derive(Debug)]
pub(crate) enum AssetsError {
    /// 底层 I/O 失败（创建/读取/写入/同步等，重试可能恢复）：`context`
    /// 为既有诊断的操作阶段（含相关实体名），`source` 保留 `io::Error`。
    Io {
        context: String,
        source: std::io::Error,
    },
    /// 不可信输入/数据词法校验失败（AssetRef 形状、relPath/id 词法等）。
    InvalidInput { detail: String },
    /// 信任边界保护性拒绝：句柄信任链（符号链接/异型/身份替换）、目标
    /// 已存在等——决策类失败，无底层错误。
    Refused { detail: String },
    /// 目标缺失（项目/库资产/媒体不存在）。
    NotFound { detail: String },
    /// store 持久化原语错误透传（`From` 转换）：文案与来源链原样保留。
    Store(StoreError),
    /// 资产库域错误透传（`From` 转换）：文案与来源链原样保留。
    Library(LibraryError),
    /// 上下文包装：内核附加阶段前缀（如「资产 {id}：」），`source` 保留
    /// 原错误；文案为「前缀：原文案」。
    Contextual {
        prefix: String,
        source: Box<AssetsError>,
    },
}

impl AssetsError {
    /// 底层 I/O 失败：`context` 为既有诊断的操作阶段，`source` 为 io 错误。
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        AssetsError::Io {
            context: context.into(),
            source,
        }
    }
    /// 不可信输入/数据词法校验失败：`detail` 为既有诊断文案。
    pub(crate) fn invalid(detail: impl Into<String>) -> Self {
        AssetsError::InvalidInput {
            detail: detail.into(),
        }
    }
    /// 信任边界保护性拒绝：`detail` 为既有诊断文案。
    pub(crate) fn refused(detail: impl Into<String>) -> Self {
        AssetsError::Refused {
            detail: detail.into(),
        }
    }
    /// 目标缺失：`detail` 为既有诊断文案。
    pub(crate) fn missing(detail: impl Into<String>) -> Self {
        AssetsError::NotFound {
            detail: detail.into(),
        }
    }
    /// 附加阶段前缀并保留原错误为来源（展示文案与历史 `format!` 前缀
    /// 拼接逐字一致）。
    pub(crate) fn prefixed(self, prefix: impl Into<String>) -> Self {
        AssetsError::Contextual {
            prefix: prefix.into(),
            source: Box::new(self),
        }
    }
    /// 越过 [`AssetsError::Contextual`] 包装链取根因（类别判定用）。当前
    /// 消费方为领域内核的类别断言（测试）；生产调用方需要按类别分派时
    /// 移除 `cfg(test)` 提升为通用 API。
    #[cfg(test)]
    pub(crate) fn root(&self) -> &AssetsError {
        match self {
            AssetsError::Contextual { source, .. } => source.root(),
            other => other,
        }
    }
}

impl From<StoreError> for AssetsError {
    fn from(e: StoreError) -> Self {
        AssetsError::Store(e)
    }
}

impl From<LibraryError> for AssetsError {
    fn from(e: LibraryError) -> Self {
        AssetsError::Library(e)
    }
}

/// 展示边界契约：文案与历史 `format!` 输出逐字一致，前端可见诊断不变。
impl std::fmt::Display for AssetsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AssetsError::Io { context, source } => write!(f, "{context}：{source}"),
            AssetsError::InvalidInput { detail } => write!(f, "{detail}"),
            AssetsError::Refused { detail } => write!(f, "{detail}"),
            AssetsError::NotFound { detail } => write!(f, "{detail}"),
            AssetsError::Store(e) => write!(f, "{e}"),
            AssetsError::Library(e) => write!(f, "{e}"),
            AssetsError::Contextual { prefix, source } => write!(f, "{prefix}：{source}"),
        }
    }
}

impl std::error::Error for AssetsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AssetsError::Io { source, .. } => Some(source),
            AssetsError::Store(e) => Some(e),
            AssetsError::Library(e) => Some(e),
            AssetsError::Contextual { source, .. } => Some(source.as_ref()),
            AssetsError::InvalidInput { .. }
            | AssetsError::Refused { .. }
            | AssetsError::NotFound { .. } => None,
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
            AssetsError::io("打开库资产文件失败（assets/a.png）", io::Error::other("x"))
                .to_string(),
            "打开库资产文件失败（assets/a.png）：x"
        );
        assert_eq!(
            AssetsError::missing("库资产不存在：la-1").to_string(),
            "库资产不存在：la-1"
        );
        assert_eq!(
            AssetsError::invalid("资产 id 缺失或为空").to_string(),
            "资产 id 缺失或为空"
        );
    }

    /// store 与 library 透传：文案与来源链原样，类别可下钻内层错误。
    #[test]
    fn passthrough_variants_preserve_text_and_source() {
        let s: AssetsError = StoreError::io("读取项目文件元数据失败", io::Error::other("y")).into();
        assert_eq!(s.to_string(), "读取项目文件元数据失败：y");
        assert!(std::error::Error::source(&s).is_some());
        assert!(matches!(s, AssetsError::Store(StoreError::Io { .. })));

        let l: AssetsError = LibraryError::missing("资产不存在：la-2").into();
        assert_eq!(l.to_string(), "资产不存在：la-2");
        assert!(matches!(
            l,
            AssetsError::Library(LibraryError::NotFound { .. })
        ));
    }

    /// 阶段前缀包装：文案为「前缀：原文案」（与历史 format! 拼接逐字
    /// 一致），根因类别与来源链保留。
    #[test]
    fn contextual_prefix_preserves_root_and_source() {
        let e = AssetsError::from(StoreError::missing(
            "项目资产根不存在，资产文件不存在：assets/a.png",
        ))
        .prefixed("资产 pa-1");
        assert_eq!(
            e.to_string(),
            "资产 pa-1：项目资产根不存在，资产文件不存在：assets/a.png"
        );
        assert!(
            matches!(e.root(), AssetsError::Store(StoreError::NotFound { .. })),
            "根因类别应可越过包装判定：{e:?}"
        );
        assert!(std::error::Error::source(&e).is_some());
    }

    /// 决策类失败无底层来源。
    #[test]
    fn decision_variants_have_no_source() {
        for e in [
            AssetsError::invalid("非法"),
            AssetsError::refused("拒绝"),
            AssetsError::missing("缺失"),
        ] {
            assert!(
                std::error::Error::source(&e).is_none(),
                "决策类失败不应伪造来源：{e}"
            );
        }
    }
}
