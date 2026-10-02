# 数据模型：设计原则、分层与演进

[返回数据模型索引](README.md) · 相关主题：[项目文档](project-document.md)、[命令与撤销](commands.md)

## 一、设计背景与原则

PlotWeave 是 Tauri + React Flow + Rust 的单用户桌面工具：创作者在画布上把剧本、场景、角色与剧情分支组织为节点图。模型配置走 BYOK——用户自己在客户端里配置 provider（base URL + API key），无服务端、无计费。

全部模型设计从五条原则推出，后文每个决策都能回溯到其中之一：

1. **单一文档真源**：一个项目的画布数据收敛为一份带 `schemaVersion` 的 JSON 文档。备份、导出、版本兼容都只围绕这一份文件。
2. **数据按职责分区**：渲染布局、会话状态、用户意图、元信息分开存放，互不污染。
3. **一切变更走命令**：状态修改有唯一入口，撤销/重做、持久化、AI 操作画布都建立在这条通道上。
4. **资产文件化**：媒体内容落盘为文件，文档内只存引用。
5. **不为不存在的问题付费**：单写者桌面场景不引入并发仲裁、协同合并、任务编排等机制。
## 二、总体分层

下图是目标架构的职责划分，`GraphStore` / `useGraphStore` 为设计名称，不是当前可导入的实现符号。

```
React 组件层（节点组件、设定面板、资产库面板）
   ↓ 交互意图
Store 桥接层（useGraphStore hook）
   ↓ 命令（GraphCommand）
模型层（纯 TypeScript，无框架依赖）
   ProjectDocument ← GraphStore（applyCommand / undo / redo / 防抖持久化回调）
   ↓ invoke
Rust 持久化层（Tauri commands：文件读写、资产导入、设置与密钥、LLM 代理）
```

两条约束贯穿所有层：

- 模型层是纯 TS：不可变更新，对外暴露只读快照。便于单测，也便于未来需要时平移到 Rust。**类型所有权**（[issue #266](https://github.com/hailingu/PlotWeave/issues/266)、[issue #353](https://github.com/hailingu/PlotWeave/issues/353) 方向一，已实施）：落盘格式与会话文档的类型由 `src/model/` 自有——磁盘侧 `ProjectDocument`/`StoryNode`/`StoryEdge`（`model/document.ts`）、会话侧 `ProjectContent`/`SessionNode`/`SessionEdge`（`model/session.ts`）、设定集实体与归一化（`model/settings.ts`）、端口/句柄与连线语义判别（`model/graphSemantics.ts`）；`src/model/` 对 `editor/` 与 `@xyflow/react` 无任何编译期引用（类型或运行时），对 react/@tauri-apps 无运行时导入。编辑器运行态以**结构兼容**对接：`editor/nodes/types.ts` 的 `*NodeData` 为模型 `*SessionData` 的运行态别名并与 React Flow `Node` 组合，`editor/settings.ts` 再导出实体类型并保留 UI 创建/解析助手，`editor/graphRules.ts` 再导出落盘语义并保留交互规则——`editor/ → model` 是唯一允许的依赖方向，编辑器节点形状变更不再等价于持久化 schema 变更；会话形状的最小结构契约（`SessionNode`/`SessionEdge` 双向可赋值）由 `editor/nodes/sessionCompat.test-d.ts` 的编译期探针钉住（仅严格类型检查入口编译）。
- 画布状态的唯一真源是 GraphStore；React Flow 只作渲染与交互层，不持有业务状态。

**当前实现映射（#6、#14、#16、#35、#39）**：`EditorView` 负责装配，`useEditorDocument` 持有会话文档，`useEditorController` 汇集按域 hooks，`EditorLayout`/`EditorCanvasRegion`/`EditorOverlays` 承载布局；撤销重做由 `history.ts` 的 `CommandStack` 承载。会话 `ProjectContent` 与磁盘 `ProjectDocument` 通过 `model/convert.ts` 门面转换，归一化阶段位于 `normalize*.ts`，序列化位于 `serialize.ts`。UI 补丁经 `nodes/patch.ts` 的 `NodeDataPatch` 按节点类型判别，`PatchShape` 去掉索引签名，序列化按节点联合穷尽分派；JSON 输入仍须运行时校验。`projectStore.ts` 是持久化门面，内部按 `memory`/`tauri`/`saveChain`/`seeds` 分域；Rust 项目存储位于 `store/`，库索引与删除恢复分别位于 `library_index/`、`library_journal/`。这些拆分不改变文档格式或产品行为。模块图守卫（`src/moduleGraph.ts` + `moduleGraph.test.ts`，issue #106）承诺的是相对导入图无环（运行时图与编译期图分别检测）——**无环是比分层纯度更弱的性质，二者不可互替**；模型层的三条层间契约由同一守卫文件的专用判定另行验证，判定契约带可执行反例：① 框架运行时依赖禁止（issue #266）；② model → editor 运行时值依赖禁止（issue #353 方向一实施后，原「登记纯叶子白名单」随模型层类型自有化移除——model 不再持有任何 editor 运行时依赖，`editor/graphRules`/`editor/settings` 的依赖方向已反转为 editor → model）；③ 模型层编译期独立性（issue #353 新增）——model **编译期可达闭包**（含 type-only 边，评审 5326092395：类型链触达的共享模块同样使模型编译面依赖 UI）内对 `editor/` 的任何边与对 `@xyflow/*` 的任何外部边（均含 `import type`）计违规，守住「编辑器类型即 schema 类型」的倒置不复发。守卫口径含 JSX 隐式 `react/jsx-runtime` 运行时边（`jsx: react-jsx` 编译合成、源码不可见）、无替换模板字面量动态导入与逐说明符 type-only（`import { type A }` 整条编译期擦除）识别，①②按**运行时可达闭包**、③按**编译期可达闭包**执行（model 经共享叶子如 `uid.ts` 传递引入框架或触及 editor 模块同样违规，类型链触达的模块在 ③ 下同论）；闭包内**不可静态解析的动态导入**（带替换模板等）一律 fail-closed 计违规——目标运行时才定，纯度无法静态验证（PR #305 评审补强）。

下文顺序：先定义数据本身（三~七）与引用规则（八），再定义变更机制（九：命令与撤销），然后是落地（十：存储；十一：加载归一化），最后是建立在命令通道之上的 AI 能力（十二）与演进方向（十三）。
## 十三、后续演进预留

以下方向发生时需要修订本文档或另起文档：

- **画布内 AI 生成**（文生图/AI 编剧）：新增媒体节点类型（图片节点、视频节点，如角色立绘、场景概念图），建模遵循三分原则——**引用类输入走边**（如图生视频的立绘引用），**参数类配置走 `spec.params`**（尺寸/时长/seed），**操作类型由 `spec.operation` + 输入证据推断**（有参考图 → 图生图，无需用户显式选择）；产物是 `outputs` 里的 AssetRef 槽位（`primary` / `poster` / `preview`，附宽高、时长等 metadata）。节点的 prompt、模型选择作为 `data.spec` 字段随 `project.json` 持久化，无需额外存储；需要新增的是 job 状态机（落盘 + 启动恢复）与输入签名（防旧结果覆盖新编辑），进程内以 tokio task + 取消令牌实现。
  - **落地状态（2026-09-04，首片）**：文生图已上线——图片节点 `image`（§4.2 ImageSpec：prompt/model/size + `outputs.primary`）经 `llm_image_generate` 代理产出 `source=generated` 项目资产，以**复合命令**写回（资产入索引与 `outputs` 同栈撤销/重做，§7.3 库资产导入同构）；输入签名守护（prompt/model/size 规范化元组）与协作式取消（`llm_image_cancel` 取消标志 + 检查点放弃）为进程内实现，发起端同步占位作业表（设置加载的异步间隙内双击不重复发起计费请求）；取消请求的 IPC 拒绝不再静默（[issue #160](https://github.com/hailingu/PlotWeave/issues/160)）：用户取消失败仅在该取消请求仍拥有节点诊断归属时转入作业错误态（文案明示远端生成可能继续并计费、结果到达时仍按取消语义丢弃）。宿主节点删除时清除其全部作业状态（包括已落定的取消、生成、设置加载或计划解析错误），仅对 running 作业发送取消请求；撤销删除不恢复旧诊断，重新生成可正常落位（[PR #200 后续审查](https://github.com/hailingu/PlotWeave/pull/200#discussion_r4044155985)）。同节点启动后续作业、宿主节点删除或编辑器卸载即撤销旧请求的诊断归属；后续作业即使已完成、失败或再次取消，旧取消响应也不能覆盖其状态。已失效请求及卸载/宿主删除触发的取消失败均经控制台留痕定位 jobId，不产生未处理拒绝；迟到生成产物仍经 jobAlive 丢弃（[PR #200 审查修复](https://github.com/hailingu/PlotWeave/pull/200#discussion_r4042402798)）。作业生命周期 = **编辑器挂载期**：不跨重启持久化（重启即丢失进行中作业，产物本身已落盘），亦不跨编辑器卸载——打开设置页 / 返回首页卸载编辑器时即对全部进行中作业发协作式取消（检查点放弃，防孤儿媒体与卸载后写回）；跨界面保留随「job 落盘与启动恢复」演进一并解决。**仍属演进**：图生图（引用输入走边与 `spec.operation` 推断）、视频节点、job 落盘与启动恢复、宽高/时长 metadata 回填、§10.3 目录化模型清单。
- **多端同步/协作/官方代付**：另起《服务端领域模型》文档；`schemaVersion` 迁移机制届时成为前后端契约的一部分。
- **跨项目搜索、资产去重**：评估 SQLite 索引层。
