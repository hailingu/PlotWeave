# 原生版本当前功能状态

核对日期：2026-10-21。实现基线：[dev `bf095386`](https://github.com/hailingu/PlotWeave/commit/bf095386d748ee1ba170807105fc8d03a87ecd70)。本页是 README 的当前能力、证据与验收边界入口（[issue #666](https://github.com/hailingu/PlotWeave/issues/666)）；按能力域维护，不把单次验证日志当作持续的当前断言。磁盘格式和交互的详细规则仍以[数据模型](data-model/README.md)、[界面设计](ui-design.md)及[开发规范](development/workflow.md)为准。

**已实现**表示该基线已有生产接线与列出的自动回归，不等于全部人工验收通过；**计划中**表示尚未实现；**保留边界**表示限制、未验证项或明确取消的范围。历史证据位于[功能补齐归档](swiftui-react-flow-feature-parity.md)，无需逐节读取归档即可判断以下状态。

## 宿主与数据归属

| 状态 | 当前结论 | 依据 |
| --- | --- | --- |
| 已实现 | 官方支持 macOS：SwiftUI/AppKit 外壳、持久 WKWebView 与 React Flow 画布。默认入口是真实项目；显式 `#fixture` 为隔离演示。系统工具栏、应用图标和窗口生命周期已接通 | [工作流](development/workflow.md)、[工具链](swiftui-react-flow-toolchain.md)、[生产入口](../native/macos/App/WebCanvasHostView.swift) |
| 已实现 | React 拥有唯一文档、撤销历史和保存协调；Swift 表单只有草稿／只读投影，原生动作进入既有编辑通道。存储、图库、设置和模型服务由 Swift 承接，新原生应用不链接 Rust | [迁移计划 §4](swiftui-react-flow-migration-plan.md#42-写入与会话存活)、[原生服务装配](../native/macos/App/NativeHostServices.swift) |
| 保留边界 | Tauri/Rust/core/C ABI 保留为既有宿主与行为／磁盘合同回归基线，不是当前 Swift 应用的后台。原生开发数据根与旧 Tauri 数据／历史 Keychain 隔离，不承诺自动迁移 | [原生数据根](../native/macos/App/NativeHostServices.swift)、[Rust 范围](development/rust-standard.md)、[设置合同](data-model/provider-settings.md) |
| 保留边界 | 源码构建不等于签名、公证和安装包验收；其他操作系统没有本页所称的官方支持或验证承诺 | [README](../README.md)、[开发工作流](development/workflow.md) |

## 已实现能力与验证

| 能力域 | 状态与当前支持 | 自动证据与保留边界 |
| --- | --- | --- |
| 项目片库与导航 | **已实现**：欢迎首页、新建、打开、改名、复制、删除、返回片库与项目工具栏；单条项目读取错误保留有效列表并显示诊断 | [首页实现](../native/macos/App/NativeHomeView.swift)、[存储回归](../native/macos/Tests/NativeProjectStoreTests.swift)、[持久化合同](data-model/persistence.md)；不把历史窗口尺寸截图当作当前视觉验收 |
| 画布、节点与历史 | **已实现**：六类节点、连线、移动／选择、复制／删除、撤销重做、排布／对齐、锁定／吸附与缩放。节点属性由原生检查器呈现，展开侧栏不重建编辑会话 | [画布入口](../src/editor/nativeCanvas/NativeCanvasApp.tsx)、[检查器](../native/macos/App/NativeInspectorView.swift)、[桥与窗口回归](../native/macos/Tests/WebHostBridgeTests.swift)、[UI 设计](ui-design.md)；真实 IME 见下表 |
| 大纲与项目设定 | **已实现**：分集与大纲导航／排序、角色／地点／文档增改删及关联编辑；稳定目标身份进入同一命令／历史通道，陈旧目标不复活 | [设定视图](../native/macos/App/NativeProjectSettingsView.swift)、[原生编辑回归](../src/editor/nativeCanvas/nativeEditorShell.test.tsx)、[数据模型](data-model/graph-model.md) |
| 保存、失败与退出 | **已实现**：项目、独立 AI 会话、设置等写入协调，失败可见并保留重试快照；退出排空至固定点、失败留窗。Web 编辑器区域异常可手动重试；原生页面失效沿宿主恢复／关闭协议处理 | [保存合同](data-model/persistence.md)、[真实 WK→文件→退出→重开](../native/macos/Tests/NativeProductionLifecycleTests.swift)、[退出回归](../native/macos/Tests/HostQuitTests.swift)、[区域恢复](../src/editor/EditorRegionBoundary.tsx)；崩溃后未落盘编辑不承诺恢复 |
| 图库、项目资产与媒体 | **已实现**：导入、列表／分组、引用、复制入项目、删除／恢复诊断及受限媒体读取；有效项和单条错误分开呈现 | [图库服务](../native/macos/App/NativeLibrary.swift)、[共享资产向量](../native/macos/Tests/NativeAssetContractVectorTests.swift)、[媒体响应边界](development/media-response-boundary.md)、[资产合同](data-model/assets.md)；真实系统文件面板／拖放人工验收不由注入夹具替代 |
| 应用设置与模型配置 | **已实现**：原生设置入口、Provider／模型／默认模型、既有密文兼容、保存反馈及成功后消费者刷新；损坏设置拒绝无损覆盖 | [设置视图](../native/macos/App/NativeSettingsView.swift)、[设置实现](../native/macos/App/NativePreferences.swift)、[Provider 合同](data-model/provider-settings.md)；不读取旧宿主真实凭据 |
| AI 对话与命令 | **已实现**：选择模型、发送／取消、新会话、Markdown 消息、读工具、修改批次预览／危险操作确认、执行／撤销及独立历史保存 | [原生 AI 呈现](../native/macos/App/NativeAiView.swift)、[共享命令合同](data-model/commands.md)、[AI 合同](data-model/ai-integration.md)；自动回归使用隔离／注入传输，不代表付费模型已验收 |
| 图片生成与下载 | **已实现**：生成作业身份、预算、取消和产物提交；图片下载采用 HTTPS 与公网地址判定，初始 URL／重定向均受策略限制 | [Swift 下载](../native/macos/App/NativePublicDownload.swift)、[网络策略回归](../native/macos/Tests/NativeNetworkPolicyTests.swift)、[Rust 下载](../src-tauri/src/imagegen/download.rs)、[资产合同](data-model/assets.md)；真实公网 TLS、特殊网络路由与计费调用未验证；Provider API 的本地／自建服务支持保留 |
| 导出与系统交付 | **已实现**：Markdown／JSON 导出、文本复制及原生保存；成功后才反馈成功，取消／失败不冒充已交付 | [导出视图](../native/macos/App/NativeExportView.swift)、[系统服务](../native/macos/App/NativeHostServices.swift)、[导出合同](data-model/persistence.md)；真实 NSSavePanel 选址目验未做 |
| 视频制作、JSON 导入、资产收藏回库 | **计划中**：本基线尚未实现，不因原生补齐或格式兼容被标作支持 | [实施范围](swiftui-react-flow-feature-parity.md#差异与实施范围)、[界面规划](ui-design.md) |

## Rust／Swift 契约核对

此矩阵说明共同合同是否对齐，以及有意的宿主差异；不把 Swift 消息桥、Tauri invoke 和历史 C ABI 当作同一种传输。详细规则仍由所链接的契约／实现拥有。

| 合同 | 当前结论 | 判定与依据 |
| --- | --- | --- |
| 项目资产 `relPath` | **已实现／共同规则一致** | 以 `assets/` 起始的相对组件；拒绝空组件、`.`／`..`、反斜杠、NUL 和首尾空白。活动引用禁止任一 `.trash` 组件；加载诊断、保存拒绝与隔离物理字节保留分别验证。[共享语料](../crates/plotweave-core/testdata/asset-contract.json)、[Swift 叶子规则](../native/macos/App/NativeAssetContract.swift)、[Web 向量](../src/model/assetContract.test.ts)、[Swift 向量及真实 I/O](../native/macos/Tests/NativeAssetContractVectorTests.swift)、[修复 PR #672](https://github.com/hailingu/PlotWeave/pull/672) |
| 媒体 MIME | **已实现／共同词法一致** | 持久化值为小写、明确的 `type/subtype` token；拒绝通配符、参数和非法字符。同一语料由 Rust、Swift、Web 各自判定。响应层另限制可交付媒体类型，非媒体以 octet-stream 交付；不能把 MIME 词法许可误作可执行内容许可。[资产合同](data-model/assets.md)、[共享语料](../crates/plotweave-core/testdata/asset-contract.json)、[媒体响应边界](development/media-response-boundary.md)、[PR #678](https://github.com/hailingu/PlotWeave/pull/678) |
| IPC 命令表与失败 | **已实现／共同业务命令对应，宿主入口有意不同** | Tauri 注册与前端常量双向守卫；Swift 由各服务的具名 Command 枚举识别，未知命令结构化拒绝。系统文本交付、原生退出决策等宿主特有入口不伪称同表同载荷。[唯一命令名表](../src/ipc/commands.ts)、[Tauri 守卫](../src/ipc/commands.test.ts)、[共享传输入口](../src/ipc/invoke.ts)、[Swift 路由](../native/macos/App/NativeHostServices.swift)、[路由回归](../native/macos/Tests/NativeCommandRoutingTests.swift) |
| 桥信封、会话与信任 | **已实现／授权目的对齐，机制不同** | Swift 桥使用 `protocolVersion/sessionId/requestId`，只信任当前入口文件的主 frame；旧会话、重复身份冲突及失效页面拒绝。回执缓存有界，退役身份不自动重做副作用；Tauri 继续使用自身 invoke／权限边界。[Swift 信封与去重](../native/macos/App/HostCommandRouter.swift)、[页面边界](../native/macos/App/WebCanvasHostView.swift)、[Web 桥](../src/platform/swiftHost.ts)、[迁移协议](swiftui-react-flow-migration-plan.md#41-双向桥接)。媒体 SVG 的 sandbox/CSP/nosniff 与页面桥授权分开，见[媒体边界](development/media-response-boundary.md) |
| 图片下载 URL／地址 | **已实现／下载判定对齐** | Rust 已对齐 Swift 的无凭据 HTTPS、公网／特殊用途地址判定与逐跳检查；取消、大小和预算限制保留。该限制针对生成图片下载，不把 Provider API 的本地／自建服务配置禁掉。[PR #678](https://github.com/hailingu/PlotWeave/pull/678)、[Swift 策略](../native/macos/App/NativeNetworkPolicy.swift)、[Rust 下载](../src-tauri/src/imagegen/download.rs)；**保留边界**：真实公网 TLS 与特殊路由未验收 |
| 格式与存储所有权 | **已实现／沿用既有磁盘合同** | 不升级 schema、不产生两份可写文档；Swift 与 Rust 各自在隔离根实现已有格式，归一化与保存边界由现行文档及回归约束。格式可兼容不等于开发数据根自动互通。[持久化合同](data-model/persistence.md)、[生产往返回归](../native/macos/Tests/NativeProductionLifecycleTests.swift)、[Rust 核心](../crates/plotweave-core/src/store/mod.rs) |

## 验收状态与保留边界

| 状态 | 当前边界 | 依据／处置 |
| --- | --- | --- |
| 已实现 | 常规功能回归、键盘／语义标签／既有 axe、外观与几何回归继续运行；这些不等于所有真实系统交互均已人工验收 | [UI 设计](ui-design.md)、[原生测试规范](development/swift-standard.md) |
| 保留边界／不支持 | VoiceOver 支持和对应验收已取消，不是待完成项，也不写成通过 | [所有者决定 #569](https://github.com/hailingu/PlotWeave/issues/569)、[迁移范围](swiftui-react-flow-migration-plan.md#1-目标与范围) |
| 保留边界／已取消验收 | 视觉快照验收已取消；保留现有外观／几何测试，不新增快照验收要求，历史截图不升级为当前产品验收 | 本页沿用既定所有者范围；已有外观／几何合同见[UI 设计](ui-design.md)，历史截图仍在[归档](swiftui-react-flow-feature-parity.md) |
| 保留边界／未验证 | 真实中文输入法未测是已接受边界；组合键／草稿等自动回归不能写成真实 IME 验收，也不重新增加本轮工作 | [输入与焦点设计](ui-design.md)、[P5 历史证据](swiftui-react-flow-p5-evidence.md) |
| 保留边界／未验证 | 真实公网 TLS、付费模型、真实文件／保存面板选址、完整应用视觉与系统交互的人工验收不由注入传输或几何断言替代 | [模型与资产合同](data-model/assets.md)、[归档各域原始范围](swiftui-react-flow-feature-parity.md) |
| 保留边界／条件性证据 | 已有简化特效、15 节点／15 连线用户跟手反馈；#688 加载准备后，18 节点保存图的十组未预选目标首／二拖未出现 >33ms 间隔；有限 Debug 合成输入不替代真实触控板、标准特效、大图或高刷新率验收 | [画布性能诊断](development/canvas-performance-diagnostics.md)；性能诊断已实现，常规功能回归照跑 |
| 保留边界／显式 opt-in | 昂贵的原生压力、长循环及首拖测量仅显式请求时运行；CPU 默认固定 4。Native 覆盖率默认 report-only、minimum null；前端／Rust 整体地板仍为 80% | [功能／压力路由](development/quality-gate-push.md#native-regression-and-stress)、[CPU 预算](development/quality-gate-cost.md#gate-cpu-budget-2026-10-16-owner-direction)、[Native 覆盖率](development/native-coverage.md)、[Rust 口径](development/rust-standard.md#test-coverage) |

## 同视图重载的就绪边界（issue #764）

依赖协同迁移后的 [dev CI 39817850250](https://github.com/hailingu/PlotWeave/actions/runs/39817850250) 暴露了既有窗口：同一 WKWebView 开始新加载后沿用旧页面的 ready，命令可能在新页安装入口前进入 JavaScript。此窗口在迁移前的生产实现已存在，未将 React 19 或 runner 环境认定为最初引入原因。[加载入口](../native/macos/App/WebCanvasHostView.swift)通过 [beginLoad](../native/macos/App/WebCanvasState.swift) 立即撤销旧就绪状态；握手与期限绑定当前注入的协议和 session，导航失败绑定当前 WKNavigation，旧加载回调不能修改新加载。

| 前置状态与动作 | 不变量与可观察结果 | 验证 |
| --- | --- | --- |
| 已 ready 的同一视图开始新 load | 立即 loading；新握手前返回 PW_CANVAS_NOT_READY，不进入 JS | [真实 WK 回归](../native/macos/Tests/WebHostBridgeTests.swift) `reloadingReadyCanvasWaitsForFreshHandshake` 在旧实现确定性失败，修复后通过 |
| 连续重试后旧 ready 或导航失败迟到 | 当前加载保持自身状态与期限；旧消息不能放行命令或失效新页 | 真实 WK 手动握手／旧导航身份回归；当前失败与新会话恢复分别验证 |
| 新文档完成导航、安装入口并报告 ready | 当前文档握手后命令恢复有效回执 | 同一真实 WK fixture 检查当前会话、ready 和一次真实入口调用；既有生产动态端口／pagehide／重载／磁盘回读回归保留 |
| 初次加载、显式 retry、失败后 late ready | beginLoad 不递增 reloadToken；显式 retry 仍递增；未开始新 load 时 late ready 不覆盖失败诊断 | [状态回归](../native/macos/Tests/WebCanvasStateTests.swift)、[加载回归](../native/macos/Tests/WebCanvasLoadingTests.swift)及真实桥回归 |

PR #766 的第一轮本地完整公开入口 `sh scripts/test-native.sh` 的红测为 369 项中仅新增就绪用例失败；修复后 369 项／82 套件通过，原生覆盖率 8709/9890 行、73/73 文件。后续审查补充连续重试的会话归属：真实 WK 红测为新增三个测试族的 15 处预期失败、原 369 项通过；修复后完整 372 项／82 套件通过，8723/9901 行、73/73 文件，仍为 report-only。Web 侧 7 项新增协议回归先红，修复后的桥与真实 React 入口三个文件 27 项通过；托管结果由对应后续 PR 记录。未增加视觉、中文输入法、VoiceOver、公网模型或压力验收。

## README 截图来源

[README 画布截图](../assets/plotweave-canvas-dev-b94ac01f.jpg)用于展示真实应用形态（[issue #772](https://github.com/hailingu/PlotWeave/issues/772)），不新增或替代完整产品视觉验收。

| 项目 | 来源与边界 |
| --- | --- |
| 应用源码 | [`b94ac01f8276a3aa3c9124bc540555335e6e5590`](https://github.com/hailingu/PlotWeave/commit/b94ac01f8276a3aa3c9124bc540555335e6e5590)，v0.3.0 开发源码；公开正式 Release 仍为 [v0.2.0](https://github.com/hailingu/PlotWeave/releases/latest) |
| 真实运行入口 | 从该源码构建的 SwiftUI/AppKit 生产应用与 `native-canvas.html`，未使用 `#fixture`、设计稿或生成图；画面显示故事大纲及 50% 缩放的分支画布局部视图 |
| 示例数据 | 应用在全新隔离目录自动创建的[仓库内置合成项目](../src/projectStore/seeds.ts)“午夜出租车”，15 个节点；未使用真实用户项目、Provider 配置或密钥 |
| 隔离方式 | 仅本次构建覆盖 `PRODUCT_BUNDLE_IDENTIFIER=dev.plotweave.readme772demo`，独立数据根由现有 `Bundle.main` 规则派生；启动前确认该根不存在，核验进程可执行路径属于本任务构建。未修改生产源码、项目配置或默认开发数据根 |
| 捕获方式 | 2026-10-23，直接截取正在运行的原生窗口，保留原始 JPEG；收起空检查器以显示画布，未重绘、拼接或合成界面 |
| 构建工具 | 本机 Xcode 27.1 / SDK 27.0；源码与 CI 钉版要求仍为 Xcode 27.0 / SDK 27.0，没有更改全局工具链或仓库要求 |
| 验证边界 | 截图仅证明该示例的可观察运行画面，不表示已完成签名、公证、安装包、真实中文输入法、VoiceOver、公网 TLS、付费模型或整体性能验收；不将本次运行描述为历史 AppKit 异常的根因修复 |

README 下沉信息的查找入口：迁移分支、2026-10-13 的 PR #526 合并与分支删除记录见[工作流的技术栈与工程布局](development/workflow.md#technology-and-repository-layout)；默认生产入口、显式 `#fixture`、独立开发数据根、旧 Tauri／Keychain 隔离、AI Provider 重配见[开发运行说明](development/workflow.md#原生应用启动与验证)；原生界面／Swift 服务的逐域能力及人工边界见本页上方矩阵。原来的源码构建／发行安装包区别、VoiceOver 取消决定、真实 IME／TLS／模型／性能限制均保留。

## 可核对的验证快照与维护

基线的[自动 dev CI 39535403860](https://github.com/hailingu/PlotWeave/actions/runs/39535403860) 已通过 frontend、rust、native；gate-evidence 在 dev push 按规则 skipped。原生功能测试为 353 项／79 套件，覆盖率工件为 8398/9559 行、71/71 文件、report-only。该次同源本地完整门禁的前端为 3468 项、97.49% 行覆盖率，Rust 为 6790/7954 行；这是明确版本的验证快照，不是永久不变的计数或覆盖所有人工验收的保证。后续变更仍按[当前门禁](development/quality-gate-enforcement.md)取得自己的实际证据。

后续功能变化应更新本页相应能力域、状态和依据；详细契约仍修改其权威文档，不在本页复制第二套协议。新一轮验证流水可归档，但历史“未创建 PR／CI 未运行”等时点句不回填为当前结论；原归档 22 节及其旧锚点保持不变。#667 的类型入口归属修正在 [AGENTS](../AGENTS.md#scope-routing)，具体配置来源和测试／探针范围以[严格类型入口规范](development/typescript-standard.md#strict-type-check-entry)为准，没有修改编译标志或门禁政策。
