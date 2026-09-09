# 已关闭 Issue 的设计同步记录

本文记录已关闭 issue 对设计正文的影响，供查阅实现状态与历史决策；不新增产品范围或工程门禁。

核对日期：2026-09-09。范围为当时 GitHub 上全部 18 个已关闭 issue 的正文和关闭讨论（不含 PR）；代码依据为本地已合并基线 [`0ce89317e0a37e15c1610e6b2415394011072dd2`](https://github.com/hailingu/PlotWeave/commit/0ce89317e0a37e15c1610e6b2415394011072dd2)。工作区中进行中的 #44 AI 设定工具修改不纳入完成状态。本表“已实现”指已合入 `dev`，不等于已发布到 `main`。

配套正文：[数据模型设计](data-model.md)、[UI 设计规格](ui-design.md)。表内“模型”“UI”的章节号分别指这两份文档。

## 逐项对照

| Issue | 关闭结论与设计影响 | 正文位置 | 合并依据 |
| --- | --- | --- | --- |
| [#6](https://github.com/hailingu/PlotWeave/issues/6) 归一化拆分 | `convert.ts` 保留门面，归一化与序列化按阶段拆分；原文件及函数的规模豁免失效，行为不变 | 模型 §2、§11 | [PR #11](https://github.com/hailingu/PlotWeave/pull/11) |
| [#8](https://github.com/hailingu/PlotWeave/issues/8) 预览媒体独立性 | 浏览器导入创建独立 object URL，删除源库条目不再破坏项目缩略图；重载仍不持久化 | 模型 §7.3；UI §8.1 | [PR #19](https://github.com/hailingu/PlotWeave/pull/19) |
| [#9](https://github.com/hailingu/PlotWeave/issues/9) 文件协议范围 | 最初收窄到资产子目录；随后 #26/#31 全面替换为 `pwmedia`，当前通用 asset 协议已停用 | 模型 §7.1 | [PR #20](https://github.com/hailingu/PlotWeave/pull/20)、[PR #38](https://github.com/hailingu/PlotWeave/pull/38) |
| [#10](https://github.com/hailingu/PlotWeave/issues/10) 重做资产复验 | 库导入与生成产物重做前异步复验，失败可重试；栈版本守护使被后续操作取代的校验失效。删除撤销的同构复验仍保留为边界 | 模型 §9.4；UI §8.1 | [PR #21](https://github.com/hailingu/PlotWeave/pull/21) |
| [#14](https://github.com/hailingu/PlotWeave/issues/14) Rust 项目存储拆分 | `store.rs` 拆成 `store/`，保留命令与导出路径；不改变存储格式或行为 | 模型 §2 | [PR #22](https://github.com/hailingu/PlotWeave/pull/22) |
| [#15](https://github.com/hailingu/PlotWeave/issues/15) 对话请求上限 | 120 秒超时、16 MiB 响应体流式限读，与图像代理共用 `http_util` | 模型 §10.5 | [PR #23](https://github.com/hailingu/PlotWeave/pull/23) |
| [#16](https://github.com/hailingu/PlotWeave/issues/16) 类型边界 | `NodeDataPatch` 判别联合与 `PatchShape` 约束补丁，序列化穷尽分派；输入 JSON 仍需运行时校验 | 模型 §2 | [PR #24](https://github.com/hailingu/PlotWeave/pull/24) |
| [#17](https://github.com/hailingu/PlotWeave/issues/17) 库文件安全 | 锚定目录句柄、no-follow 文件访问、1 MiB 索引限读与脏条目隔离；后续事务与协议分别由 #25/#26 承接 | 模型 §7.1、§7.2 | [PR #27](https://github.com/hailingu/PlotWeave/pull/27) |
| [#18](https://github.com/hailingu/PlotWeave/issues/18) 分支文案 | 稳定选项 id 实时派生，运行态也移除 `optionLabel`；改名、撤销和重做即时更新连线胶囊 | UI §4.4；模型 §5、§8.1 原有单一真相规则保留 | [PR #28](https://github.com/hailingu/PlotWeave/pull/28) |
| [#25](https://github.com/hailingu/PlotWeave/issues/25) 库删除恢复 | 日志 → 身份核验隔离 → 索引提交 → 身份绑定清理；列表/写入前恢复，保留 `cleanupPending`、冲突隔离与只读告警态 | 模型 §7.2、§10.5；UI §8.1 | [PR #30](https://github.com/hailingu/PlotWeave/pull/30) |
| [#26](https://github.com/hailingu/PlotWeave/issues/26) 库媒体 URL | 删除 `library_dir_path`，库媒体经 scope + assetId 访问 `pwmedia`，前端不拼接本机路径 | 模型 §7.1、§10.5；UI §8.1 | [PR #32](https://github.com/hailingu/PlotWeave/pull/32) |
| [#29](https://github.com/hailingu/PlotWeave/issues/29) 库索引与组命令 | 当前格式为 `assets.byId`/`groups.byId`；旧数组迁移、完整归一化与稳定 id 回写已实现；组写命令、库命令命名已对齐。收藏链路不在关闭范围 | 模型 §7.2、§7.3、§10.5；UI §8.1 | [PR #33](https://github.com/hailingu/PlotWeave/pull/33)、[PR #36](https://github.com/hailingu/PlotWeave/pull/36)、[PR #37](https://github.com/hailingu/PlotWeave/pull/37) |
| [#31](https://github.com/hailingu/PlotWeave/issues/31) 项目媒体 URL | 删除 `project_asset_path`，项目接入 `pwmedia`；补防抖保存期间的会话登记、重发 id 别名与读取上限说明 | 模型 §7.1、§10.5；UI §8.1 | [PR #38](https://github.com/hailingu/PlotWeave/pull/38) |
| [#34](https://github.com/hailingu/PlotWeave/issues/34) 按域加载 | 编辑器/设置页惰性加载，React Flow 依赖封闭于编辑器；切换和设置关闭用 transition 保留当前界面 | UI §3.1、§8.2 | [PR #40](https://github.com/hailingu/PlotWeave/pull/40) |
| [#35](https://github.com/hailingu/PlotWeave/issues/35) 编辑器编排 | 文档、面板、持久化、图动作按域 hooks 拆分，布局独立；交互及保存语义保持不变 | 模型 §2 | [PR #50](https://github.com/hailingu/PlotWeave/pull/50) |
| [#39](https://github.com/hailingu/PlotWeave/issues/39) 模块余量 | AI 命令、侧栏、节点表单、库索引/恢复与项目存储进一步拆分；属于结构重构，不扩展设计行为 | 模型 §2、§11 | [PR #52](https://github.com/hailingu/PlotWeave/pull/52) |
| [#41](https://github.com/hailingu/PlotWeave/issues/41) AI 字段协议 | 原正文已记录共享字段表与最多 3 次产出纠错；本次修正流程图，明确校验、预览、用户确认先于执行 | 模型 §12.2；UI §6 原有规则保留 | [PR #43](https://github.com/hailingu/PlotWeave/pull/43) |
| [#42](https://github.com/hailingu/PlotWeave/issues/42) 中文组合输入 | 节点面板自由文本在组合期间仅缓冲，结束时提交，避免旧受控值中断输入法；普通输入保持即时提交 | UI §4.3 | [PR #51](https://github.com/hailingu/PlotWeave/pull/51) |

## 保留的边界与目标差异

- #10 只补库导入和生成产物的重做复验；删除撤销恢复资产的复验未实现。
- #25 的事务恢复已实现，平台清理能力不足时仍可留下 `cleanupPending`；同用户本地恶意并发换体继续遵循 `AGENTS.md` 的既有威胁模型。
- #29 不包含项目 → 库收藏；`collect_library_asset` 是目标接口。库组命令与前端门面完成也不等于全部目标编组 UI 已交付。
- #31 的媒体读取有 256 MiB 项目上限，持久化资产校验没有同一大小上限；大文件可能可保存但不能预览。
- `GraphStore` 是目标架构名，当前会话状态与历史栈实现见模型 §2；历史栈当前默认 200 条，与原目标 50 条的差异单独注明，未在本次修改容量。
- 设置当前采用同窗页面与扁平 provider 配置；独立窗口、目录化能力模型，以及 UI §12 的 macOS 原生材质方案仍为规划。
- 文生图已实现；图生图、视频、作业持久化与恢复等继续按模型 §13 演进。

## 本次核验

本次按 issue 关闭讨论、合并 PR 与上述代码基线交叉核对实现状态，检查正文中的当前/历史/目标标记、IPC 注册名和章节交叉引用。只修改 Markdown，没有修改业务代码、工程门禁或未关闭 issue 的设计范围。

按 `AGENTS.md` 的文档路由执行结构化审阅；没有配置文档自动化检查，不新增逐字匹配正文的测试。另以 `git diff --check` 检查补丁空白错误。本次未运行源码测试、构建或 SonarQube，也未提交或推送；各 issue 中历史测试结果属于对应 PR，不能作为本次运行结果。
