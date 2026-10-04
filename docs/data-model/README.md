# PlotWeave 数据模型

> 状态：v1（2026-08-28 定稿）
> 实施状态（2026-09-09 核对）：`ProjectDocument` v1、加载归一化与序列化管线已落地；磁盘保存使用 `schemaVersion: 1`，旧 v0 文档经迁移后进入会话。本索引同时保留目标架构与后续演进，不能据此认定每个示意接口均已实现；当前模块与命令映射见[分层](overview.md#二总体分层)与[Rust 持久化命令](persistence.md#105-rust-持久化命令tauri-commands)。已关闭 issue 的逐项结论和合并依据见[设计同步记录](../design-sync.md)。历轮评审修订已归档至[修订历史](../data-model-revisions.md)，当前状态以各主题正文的落地说明为准。
> 适用范围：画布文档模型、设定与资产模型、命令与撤销、本地存储体系、AI Agent 交互。
> 明确不在范围内：用户体系、租户、余额/计费。PlotWeave 是单用户 BYOK 桌面工具；若未来出现此类需求，另起《服务端领域模型》文档。

## 阅读路径

| 主题 | 内容与原章节 |
| --- | --- |
| [设计原则、分层与演进](overview.md) | 背景、目标架构及现行模块映射、后续演进（原 §1、§2、§13） |
| [项目文档](project-document.md) | `ProjectDocument` 根结构、版本与会话态边界（原 §3） |
| [图模型](graph-model.md) | 节点、spec、端口和边（原 §4、§5） |
| [设定与引用](settings-and-references.md) | 设定集、引用真相及生命周期联动（原 §6、§8） |
| [资产](assets.md) | 项目与库资产、分类、编组和流转（原 §7） |
| [命令与撤销](commands.md) | 命令结构、预检、执行与撤销重做（原 §9） |
| [持久化](persistence.md) | 目录布局、写入安全与 Rust 持久化命令（原 §10.1、§10.2、§10.5） |
| [Provider 设置](provider-settings.md) | Provider、模型及密钥配置（原 §10.3、§10.4） |
| [加载与归一化](normalization.md) | 信封判型、迁移、修复和警告（原 §11） |
| [AI 交互](ai-integration.md) | 应用内 Agent 命令通道与 MCP 规划（原 §12） |

首次阅读建议按表中顺序；维护特定模块时可直接进入对应主题。每项契约以主题正文为准，实施状态、类型示例、矩阵、例外与依据链接均保留在其所属主题附近。

## 迁移与历史记录

- [旧路径与全部 35 个章节、子章节标题的迁移对照](../data-model.md)保留原标题锚点；历史记录或源码注释中的 `§` 编号可从此处定位。拆分依据见 [issue #281](https://github.com/hailingu/PlotWeave/issues/281)。
- [设计同步记录](../design-sync.md)保留已关闭 issue 的落地结论与依据；[修订历史](../data-model-revisions.md)保留 v1 定稿过程中的历轮记录。两者不替代现行主题正文。
- 结构拆分未修改 `ProjectDocument` schema、IPC、持久化、归一化或撤销契约；原正文中的实施与规划标记继续有效。
