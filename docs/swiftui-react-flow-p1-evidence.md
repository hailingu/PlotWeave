# SwiftUI/AppKit + React Flow 改造：P1 证据记录

> 配套：[改造计划](swiftui-react-flow-migration-plan.md)（§7.3 证据模板、§6 状态矩阵）。本页只记录已实际执行的验证；未执行的检查明确标注原因。

> 当前工具链同步（2026-10-04）：所有者已授权升级为 Xcode 27.0／Swift 6.4 编译器／macOS SDK 27.0，语言模式仍为 Swift 6，部署目标仍为 macOS 26.0；现行约定与本次验证结果见[工具链升级记录](swiftui-react-flow-toolchain.md)。以下 P1 工具链、Figma 选型、构建结果与测试数量均保留为历史执行记录，不作为新版工具链的验证结论。

> 当前路径同步（2026-10-04）：原 `src/native-canvas/` 演示源码已迁至 `src/editor/nativeCanvas/`，遵守 `dev` 的 shell → editor 运行时边界；`native-canvas.html` 指向新入口。以下 2026-09-15 记录中的旧路径、命令和结果均为当时的历史证据，构建命令与资源输出保持不变。

## Xcode 27 工具链同步（2026-10-07）

所有者在本任务中要求将项目设置更新为 Xcode 27；本节取代下方 P1-1 的当前工具链约束，旧记录保留为历史证据。本次为工程/CI 配置与规范文档更新，不改变原生业务阶段、画布协议或最低部署版本。验证对应 `codex/swiftui-react-flow` 工作区在 `08653d21cb45f0a70b96651c590b4eec37397ff6` 上的本轮未提交配置更新，不构成提交或托管 CI 证据。

| 项 | 当前记录值 |
| --- | --- |
| 本机系统 | macOS 27.0.1（26A434），arm64 |
| Xcode | 27.0（27A266a），本机选择 `/Applications/Xcode.app/Contents/Developer` |
| Swift 编译器 / 语言模式 | Apple Swift 6.4（swiftlang-6.4.0.34.1 clang-2100.3.34.1）/ `SWIFT_VERSION = 6.0` |
| macOS SDK / 最低部署版本 | 27.0 / 26.0（`SDKROOT = macosx`，`MACOSX_DEPLOYMENT_TARGET = 26.0`） |
| native CI | `runs-on: xcode-27`；`DEVELOPER_DIR = /Applications/Xcode_27.0.app/Contents/Developer`，构建前校验 Xcode 27.0 与 SDK 27.0 |
| Node / Rust | 沿用 `.nvmrc` 的 24.18.0 与 `rust-toolchain.toml` 的 1.95.0 |

2026-10-07 核对的[官方镜像清单](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)列出 Xcode 27.0（27A266a）、上述版本别名与 macOS SDK 27.0；[可用镜像表](https://github.com/actions/runner-images#available-images)确认 YAML 标签为 `xcode-27`。[官方公告](https://github.com/actions/runner-images/issues/14404)将该镜像标为 public preview，并记录其系统基线已切至 macOS 27。CI 显式选择 27.0，避免镜像默认版本变化后静默改用其它 Xcode。

工程与共享 scheme 的升级检查元数据更新为 `2700`，创建版本 `CreatedOnToolsVersion = 26.6` 保留其历史含义。构建命令仍为 `npm run build:native`；原生验证继续使用 `AGENTS.md` 的完整路由命令，项目成员关系、签名方式与部署版本维持原配置。macOS 26 UI Kit 仍是 P1 已采纳的设计基准，工具链升级不代表已完成 macOS 27 的控件映射或视觉验收。

**验证（仓库根目录；Node 24.18.0）**：

| 检查 | 结果 |
| --- | --- |
| `npx prettier --check .github`；本次修改的 Markdown 格式检查 | 通过；文档另按工具链约束、交叉链接、历史/当前证据与业务边界做结构化审阅，无独立文档自动检查配置 |
| `plutil -lint native/macos/PlotWeaveNative.xcodeproj/project.pbxproj`；`xmllint --noout native/macos/PlotWeaveNative.xcodeproj/xcshareddata/xcschemes/PlotWeaveNative.xcscheme` | 通过；工程与 scheme 可解析 |
| Ruby YAML 解析工作流并执行实际版本校验脚本 | 本机 Xcode 27.0 / SDK 27.0 通过；临时命令夹具下 27.0/27.0 接受，26.6/27.0、27.1/27.0 与 27.0/26.5 均以非零状态拒绝；该检查不代替真实 runner 的版本别名验证 |
| `npm run check:size` | 失败：任务开始前已存在的未跟踪 `native/macos/PlotWeaveNative.xcodeproj/project.xcworkspace/contents.xcworkspacedata` 触发 `SIZE_UNCLASSIFIED_FILE`；保留该文件，未增加排除或绕过守卫 |
| `npm run build:native-canvas` | 通过；规模检查失败后单独执行，完整路由不宣称全绿 |
| `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` | 沙箱外通过：`TEST SUCCEEDED`，6 suites / 16 tests；覆盖真实 WKWebView ready、节点渲染与面板切换不重建页面 |
| `xcrun vtool -show-build native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app/Contents/MacOS/PlotWeaveNative` | `platform MACOS`、`minos 26.0`、`sdk 27.0`，部署目标与 SDK 配置一致 |

**尚未验证与已知诊断**：托管 CI 须以该配置对应 PR 的工作流结果为准，本轮未提交或推送，未运行 SonarQube 门禁；其要求继续适用于后续 Git 操作。最低部署版本不等同 macOS 26 实机已验证，本次无 macOS 26 测试主机；未执行 Release 构建、性能或视觉验收。工具链同步验证时，`Snapshot.currentColorScheme` 中的 `NSApp.effectiveAppearance` 曾产生两条主线程隔离警告，已由下方[外观隔离修复](#外观快照主线程隔离修复2026-10-07)解决；AppIntents 元数据提取与 WebKit 系统服务诊断未造成测试失败。一次性构建、画布资源和临时校验夹具在验证完成后删除，原有工作区改动保留。

## 外观快照主线程隔离修复（2026-10-07）

所有者要求修复 Xcode 27 报告的两条 AppKit 主线程隔离警告。`CanvasAppearanceState` 已在主 actor，但嵌套值类型 `Snapshot` 的静态方法没有继承该隔离；生产读取链 `Snapshot.current()` → `currentColorScheme()` 需要显式主 actor 约束。值类型的构造、比较与 Codable/JSON 编码继续保持纯数据语义。

本次通过读取函数的 Swift 类型合同做回归：`systemReaderRetainsMainActorContract` 在擦除类型后仍要求系统读取函数兼容主 actor 桥接函数类型。先观察缺失隔离使该测试失败，再修复读取链并重跑聚焦与完整原生路由；类型擦除后的兼容检查不单独证明 actor 调用边界，额外编译探针验证非法非隔离调用被拒绝。不通过文本匹配 Swift 注解来验证隔离。探索时尝试 `SWIFT_TREAT_WARNINGS_AS_ERRORS`，编译器仍将这两条 AppKit 诊断保留为警告，故撤回该配置，不把它当作有效的回归门禁。

### 关键状态与不变量矩阵

| 前置状态 | 动作／时序 | 可观察结果 | 不变量及所有者／入口 | 对应验证／缺口 |
| --- | --- | --- | --- | --- |
| 系统外观读取链未正确隔离 | 读取函数经类型擦除进入合同检查；编译非隔离调用探针 | 主 actor 合同测试失败；修复后非法调用探针编译失败 | `Snapshot.current` 与 `currentColorScheme`：系统外观读取必须在主 actor；入口包括默认 `SnapshotReader` 与直接调用 `current()` | `systemReaderRetainsMainActorContract` 先红后绿；额外非隔离调用探针须由编译器拒绝 |
| 合法的主 actor 调用 | 初始化状态／直接读取当前系统快照 | 取得桥接合同允许的 light/dark 和可访问性值 | 同一读取链：主 actor 调用可同步完成；不增加异步、缓存或第二快照来源 | `currentSnapshotStaysWithinBridgeContract` 与真实 WKWebView 加载回归 |
| 已有快照被序列化或比较 | 编码桥接载荷，再解码；比较刷新前后值 | 每个语义字段保持一致，相同值不触发推送 | `Snapshot` 数据操作：actor 约束只覆盖系统读取，不把纯值载荷变成主 actor 服务 | `payloadJSONRoundTripsEverySemanticField`、`refreshNotifiesOnlyOnActualChange` |
| 外观变化／观察停止 | 刷新后推送；停止观察后解绑回调 | 仅真实变化通知，停止后不再向已释放页面推送 | `CanvasAppearanceState` 与 coordinator：既有主线程通知、去重和生命周期约束维持 | `stopObservingDetachesChangeHandler`、`panelTogglesKeepWebViewAndPageAlive` |

本次不改变状态、重试或事件时序，持久化不适用；跨 actor 的非法同步读取由编译器拒绝，不增加后台任务来搬运 AppKit 访问。无法识别外观时回退 light 的分支未修改，未新增故障注入；当前系统状态与现有 WebKit 回归覆盖合法读取入口。

**验证结果（仓库根目录；Xcode 27.0 / Swift 6 模式；Node 24.18.0）**：

- 聚焦命令 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test -only-testing:PlotWeaveNativeTests/CanvasAppearanceStateTests`：先红，新增合同测试在未隔离读取函数上断言失败（退出 65），其余 4 项通过；为 `Snapshot.current` 与 `currentColorScheme` 增加 `@MainActor` 后，5 项全部通过，原两条 AppKit 隔离警告消失。
- Swift 编译探针使用 `xcrun swiftc -typecheck -swift-version 6 -target arm64-apple-macos26.0 -module-cache-path <临时目录>/module-cache native/macos/App/CanvasAppearanceState.swift <探针文件>` 编译实际生产文件：主 actor 同步读取，以及非隔离上下文的值构造、比较、JSON 编解码均通过；非隔离同步调用 `Snapshot.current()` 被拒绝（退出 1，稳定诊断 `ActorIsolatedCall`）。正向探针无编译诊断；探针为临时校验夹具，完成后删除。
- `npm run check:size` 仍因任务开始前已有的未跟踪 workspace 文件触发 `SIZE_UNCLASSIFIED_FILE`，完整路由不能宣称全绿。其余路由命令单独运行：`npm run build:native-canvas` 通过，`xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 通过，6 suites / 17 tests，包含真实 WKWebView 加载与生命周期回归。
- `npx prettier --check docs/development/swift-standard.md docs/swiftui-react-flow-p1-evidence.md` 与 `git diff --check` 通过。源文件 131 行、测试文件 103 行；文档按矩阵映射、当前/历史证据、工具链和交叉链接做结构化审阅，无独立文档自动检查配置。

矩阵中的类型兼容、合法读取、纯值操作与通知/生命周期条目分别映射到上述回归、编译探针和现有测试，均通过。macOS 26 实机、Release 构建和托管 CI 未执行；本次未改变运行时状态或保存链路，未运行前端/Rust 全量检查或 SonarQube，未创建提交或推送。一次性原生构建、画布资源、测试日志与编译探针均在验证后删除；原有 workspace 与其它任务的文档改动保留。

## Home 图标与演示首页导航（2026-10-07）

所有者要求只恢复标题栏 Home 图标按钮。本次为原生界面的局部导航补齐：Home 返回演示首页，首页可继续当前画布。启动仍直接进入画布演示；不接入真实项目列表、存储或右侧业务工具。首页明确说明演示内容不落盘，不能用占位首页冒充已完成 P3 项目首页。

### Home 导航状态与不变量矩阵

| 前置状态 | 动作／时序 | 可观察结果 | 不变量及所有者／入口 | 对应验证／缺口 |
| --- | --- | --- | --- | --- |
| 应用已显示演示画布 | 点击标题栏 Home 图标 | 显示演示首页及继续画布入口；Home 有可访问名称 | `NativeShellRoot` / `ShellLayoutState`：导航仅切换界面，不创建第二份图文档；工具栏 Home 入口 | 真实应用窗口通过辅助功能按钮执行点击；实现前应因 Home 按钮缺失失败 |
| 已编辑画布并返回演示首页 | 点击继续画布，再次 Home → 继续 | 回到同一画布，已删除节点不复活，页面探针和视口保持，WebView 实例未更换 | 同一组合：首页往返不销毁或重载 WebView；继续入口与 Home 共用导航状态 | 同一真实窗口回归先通过节点设置 UI 删除节点（9 → 8），再覆盖两次往返；现有面板与外观生命周期回归 |
| 画布加载未完成或失败 | Home → 继续画布 | 原加载／诊断与重试状态保留 | `WebCanvasSection` 仍拥有加载状态，导航不伪造 ready 或保存成功 | `homeDuringLoadingPreservesCanvasAndPanelPreference` 覆盖在首页挂载画布后继续；失败后的首页往返未单独注入，现有加载失败／重试测试保留 |
| 检查器可见／隐藏 | 返回首页，再继续画布 | 首页不显示画布属性；返回画布恢复原检查器偏好 | `ShellLayoutState` 保留面板偏好，首页可见性不能覆盖它 | 窗口回归覆盖检查器偏好；原布局切换单测 |
| WebView 正持有键盘焦点 | 点击 Home | 焦点离开隐藏画布，可操作首页继续按钮 | `WebCanvasHostView` 在导航隐藏时释放自身第一响应者，`ShellHomeView` 请求继续按钮焦点；Home 与首页挂载入口不得让不可见编辑表面接收输入 | 真实窗口先聚焦 WebView，再经 Home 点击检查第一响应者已离开 WebView；仅 SwiftUI FocusState 的实现曾使此断言失败 |

导航无异步请求或持久化写入，乱序回执、磁盘失败及重试不适用。真实项目首页与保存屏障仍属 P2/P3；本次不扩大该阶段边界。图标视觉位置由标准 macOS 工具栏负责，辅助功能回归检查按钮角色、可操作性与名称，不按源码文字或像素布局断言。

**实现与验证结果（仓库根目录；Xcode 27.0；Node 24.18.0；叠加于 `08653d21cb45f0a70b96651c590b4eec37397ff6` 的未提交修改）**：

- `NativeShellRoot` 在导航工具栏加入 `house` 图标与「返回首页」可访问名称；`ShellLayoutState.homeVisible` 是两页切换的唯一状态。演示首页的继续按钮回到原画布，首页期间保留检查器偏好；`WebCanvasSection` 与宿主均常驻，不创建第二份图文档。`WebCanvasHostView` 按导航状态隐藏自身并释放其 WebKit 第一响应者，避免仅用 SwiftUI opacity / FocusState 时仍可输入隐藏画布的缺陷。
- 聚焦命令：`xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test -only-testing:PlotWeaveNativeTests/ShellHomeNavigationTests`。旧界面实际因缺少 `shell.returnHome` / `shell.resumeCanvas` 控件失败（退出 65）；实现后通过。额外的焦点断言曾在只用 SwiftUI 隐藏／请求焦点时失败，增加原生隐藏与释放第一响应者后通过。
- Home 回归通过公开 AXUIElement API 操作本测试进程的真实窗口；辅助功能查询按特定窗口限定，避免完整套件并行打开其它原生测试窗口时误点另一窗口的同名按钮。最终通过节点设置 UI 删除演示节点（9 → 8），再验证两次 Home → 继续后的节点数、WebView 身份、JS 探针、视口与焦点。加载期间的首页继续覆盖检查器可见／隐藏两种偏好。
- `npm run check:size` 仍失败：任务开始前已有的未跟踪 `native/macos/PlotWeaveNative.xcodeproj/project.xcworkspace/contents.xcworkspacedata` 触发 `SIZE_UNCLASSIFIED_FILE`。该文件保留；本次 4 个生产文件分别为 145、26、106、214 行，新测试文件 202 行，均低于适用上限。完整路由不能宣称全绿。
- 其余原生路由分别执行：`npm run build:native-canvas` 通过；`xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 通过，7 suites / 19 tests（Home 加载用例另含 2 个参数案例）。覆盖现有真实 WKWebView 加载／重试、外观和面板生命周期回归。
- `git diff --check` 通过。文档按当前阶段、状态矩阵、构建入口及链接做结构化审阅，无独立文档自动检查配置。仓库默认 Prettier 忽略 Markdown；额外执行 `npx prettier --check --ignore-path /dev/null docs/development/workflow.md docs/swiftui-react-flow-migration-plan.md docs/swiftui-react-flow-p1-evidence.md docs/ui-design.md`，workflow 通过，另 3 页未通过，已用 Prettier API 确认其 HEAD 版本也存在格式差异，未夹带整页重排。

矩阵中的可操作入口、已编辑画布往返、加载期间继续、面板偏好与隐藏画布焦点分别映射到上述真实窗口回归，均通过。失败画布的首页往返未另作资源故障注入：本次没有修改加载状态机，失败／重试由既有套件覆盖，首页只隐藏同一宿主。图标像素位置、macOS 26 实机、Release 与托管 CI 未验证；前端／Rust 源码未变，未运行其全量路由或 SonarQube，未提交／推送。一次性测试构建、资源与日志删除；任务开始前已有的本地构建和资源先备份、验证后恢复，原有其它工作区修改保留。

## P1-1 工具链记录与原生工程骨架（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 1 项；2026-09-15；`codex/swiftui-react-flow` 工作区未提交状态（叠加在 P0 文档改动之上；提交与门禁按任务另行执行，本页不构成提交证据）。

**系统 / 工具链 / 硬件（当时固定的构建配置；当前约束见上方 Xcode 27 同步）**：

| 项 | 记录值 |
| --- | --- |
| macOS | 26.6.2（Build 25G83） |
| Xcode | 26.6（17F113），`/Applications/Xcode.app` |
| Swift | 6.3.3（swiftlang-6.3.3.1.3 clang-2100.1.1.101）；工程语言模式 Swift 6（`SWIFT_VERSION = 6.0`） |
| macOS SDK | 26.5 |
| 硬件与屏幕 | Apple M4 Max，64 GB RAM，内置 Retina 显示器 3456×2234 |

**启动命令 / 夹具 / 数据根目录策略**：仓库根目录执行下方验证命令；本切片无数据根（骨架不读写任何数据目录，正式数据根与 App 身份属 P4 决策）。

```
xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative \
  -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test
```

**交付内容**：

- `native/macos/PlotWeaveNative.xcodeproj`：手工维护的 Xcode 工程（文件夹同步成员关系 + 已提交共享 scheme），目标 `PlotWeaveNative`（App）与 `PlotWeaveNativeTests`（Swift Testing 单测，宿主为 App 进程）；构建产物二进制实测 `platform macOS / minos 26.0 / sdk 26.5`，ad-hoc 签名（identifier `dev.plotweave.PlotWeaveNative`）。
- 骨架窗口：`ShellStage` 阶段记录 + `ShellStageView` 占位窗口，明确标注"画布、工具栏与数据链路尚未接入"；`includesWebCanvas == false` 由测试守护，防止骨架被误认为成品。
- 工程规范与路由：新增 [swift-standard.md](development/swift-standard.md)；`AGENTS.md` Scope Routing 增加 `native/**` 行，规模上限（800/1800/80）同步覆盖 `native/**`。

**矩阵 ID / 测试命令或步骤 / 预期 / 实际 / 结论**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| 工程解析与 scheme | `xcodebuild -project … -list` | 两 target、Debug/Release 配置、共享 scheme `PlotWeaveNative` 可见 | 与预期一致 | 通过 |
| 构建 + 单测 | 上方 `test` 命令 | `** TEST SUCCEEDED **`，全部测试通过 | TEST SUCCEEDED；Swift Testing 1 suite / 2 tests 通过（`currentStageDoesNotClaimWebCanvas`、`currentStageExposesReadablePlaceholderText`，0 失败） | 通过 |
| 启动冒烟 | `open …/Debug/PlotWeaveNative.app` 后 `pgrep -x PlotWeaveNative` | 进程存在且出现窗口 | 进程 pid 13590 存在；窗口 ID 125658，bounds {x:512, y:304, w:900, h:450} | 通过 |
| 正常退出 | `osascript -e 'tell application id "dev.plotweave.PlotWeaveNative" to quit'` | 进程退出 | 进程消失 | 通过 |

测试日志中的 `com.apple.linkd.autoShortcut` 连接失败为 ad-hoc 签名宿主注册 App Intents 的系统级噪音，不影响测试结果。

**矩阵覆盖说明**：本切片只建立工程与占位窗口，未触及[改造计划 §6](swiftui-react-flow-migration-plan.md#六关键状态与不变量矩阵)任何行的可观察行为；M01–M03（就绪握手、布局/命中、输入交接）待下一切片接入 WKWebView 与画布夹具后验证。本切片新增源码的唯一行为是"骨架窗口如实标注阶段"，由 `ShellStageTests` 覆盖；该测试为骨架创建时随工程一并引入，未单独走先红后绿（工程建立前无可运行测试宿主）。

**失败场景、尚未接通的能力与未验证原因**：

- 窗口截图暂缺：本会话终端宿主与 ZCode Computer Use 均未获"屏幕录制"授权（`screencapture` 返回 `could not create image from window/display`）。需仓库所有者在"系统设置 > 隐私与安全性 > 屏幕录制"授权后补拍并归档至 `docs/assets/swiftui-react-flow/`（目录随首张截图创建）。P1 完成条件中的截图/录屏由画布切片统一补齐。
- 未运行 Release 构建：路由验证命令为 Debug `test`；Release 构建随首个需要发版产物的任务验证。
- 未运行前端/Rust 路由检查：本切片未触及 `src/**`、`src-tauri/**`。
- 未运行 SonarQube 门禁：本次未提交、未推送（提交前按 `AGENTS.md` 执行）。

**下一步**：P1 第 2–3 项——SwiftUI 外壳 + AppKit WKWebView 宿主加载打包 Web 资源，接入确定性脱敏画布夹具。

## P1-2a 外壳容器与玻璃首验（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 2 项前半片（原生外壳容器）；同工作区未提交状态。

**交付内容**：

- `NativeShellRoot`：`NavigationSplitView`（导航侧栏占位）+ 统一工具栏（系统侧栏开关 + 检查器开关按钮）+ 尾随检查器占位；标准容器在 macOS 26 SDK 下自动获得 Liquid Glass（计划 §2.2"优先系统标准结构"）。
- 画布区域为不透明占位表面（`CanvasPlaceholderView`，`windowBackgroundColor`），承载阶段文案；底部悬浮玻璃控件簇使用 `glassEffect(.regular, in: .capsule)`（按钮禁用，tooltip"画布未接入，缩放暂不可用"），验证自定义浮动控件的玻璃 API 路径。
- `ShellLayoutState`（`@Observable`）：本片外壳唯一自持布局状态（检查器可见性）；侧栏收展交给系统工具栏开关，不自建状态。
- 占位内容诚实标注：侧栏页脚"功能在 P3 接通"、检查器页脚"属性编辑在 P3 接通"；`ShellStage` 摘要更新为"外壳容器已建立，画布与数据链路尚未接入"，`includesWebCanvas == false` 不变。
- TDD：先写 `ShellLayoutStateTests` 观察到编译期失败（`cannot find 'ShellLayoutState' in scope`，TEST FAILED），实现后通过。实现中修正一处 API 标签：macOS 上 `inspector` 修饰符参数为 `isPresented:`（首写 `isShown:` 编译失败）。

**矩阵 / 验证结果**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| 布局状态单测（红） | 新增 `ShellLayoutStateTests` 后运行路由命令 | 缺类型编译失败 | `cannot find 'ShellLayoutState' in scope`，TEST FAILED | 红已观察 |
| 构建 + 单测（绿） | 路由 `xcodebuild … test` 命令 | TEST SUCCEEDED | 2 suites / 4 tests 通过（含既有 `ShellStageTests`） | 通过 |
| 启动新外壳 | `open …/Debug/PlotWeaveNative.app` | 外壳窗口出现 | 进程 pid 21967，窗口 1678×1084 | 通过 |

**失败场景、尚未接通的能力与未验证原因**：

- 玻璃视觉效果（侧栏/工具栏/检查器材质、悬浮簇形状、浅深外观、减少透明度组合）需目验：本会话仍无屏幕录制授权，未取得截图。请仓库所有者直接目验当前运行实例，或授权"屏幕录制"后补拍归档至 `docs/assets/swiftui-react-flow/`。
- M02（侧栏收展/窗口调整下的命中一致）与 M13（外观/辅助功能组合）需画布接入后系统验证；M03 输入交接同理。
- WKWebView 宿主、打包 Web 资源与脱敏画布夹具（P1 第 2 项后半 + 第 3 项）未开始。
- 侧栏导航与检查器为占位内容，功能在 P3 接通（界面页脚已标注）。

**下一步**：P1 第 2 项后半——AppKit WKWebView 宿主加载打包 Web 资源；随后第 3 项接入确定性脱敏夹具。

## P1-2b/3 WKWebView 宿主与画布演示夹具（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 2 项后半 + 第 3 项（画布视觉首片）；同工作区未提交状态。

**交付内容**：

- **Web 侧（复用现有节点与内容样式）**
  - `src/editor/canvasRegistry.ts`：节点/连线注册抽为单一来源，`EditorCanvasRegion` 与演示页共用（新节点类型一处登记、两端可见）。
  - `src/native-canvas/`：确定性脱敏夹具 `demoGraph`（9 节点 / 7 边，覆盖全部六种节点与 sequence/branch/attach 三种连线，角色与地点全为虚构）；本地演示会话 `useDemoEditor`（连线校验复用 `graphRules` 纯函数、节点编辑复用 `NodeEditApi`/`mergeNodeData`/`beatFulfillmentMap`；无历史栈、无持久化、无 AI）；演示页 `NativeCanvasApp`（真实 ReactFlow + 常驻"内存演示数据 · 不落盘"徽标；图像生成调度按 §4.1 显式禁用为可观察 stub，不返回假成功）；宿主握手桥 `canvasHostBridge`（挂载后发 ready；浏览器开发环境静默跳过）。
  - 构建管线：根目录 `native-canvas.html` + `vite.native-canvas.config.ts`（相对 base、平铺产物）+ `npm run build:native-canvas`；产物输出 `native/macos/App/WebCanvas/`（gitignore），经文件夹同步成员打进 app bundle（实测 Resources 下平铺：`native-canvas.html/.js/.css`）。主应用构建不受影响。
- **Swift 侧（WKWebView 宿主）**
  - `WebCanvasState`（@MainActor）：loading/ready/failed 状态机（M01 种子：失败诊断可见、迟到 ready 不覆盖失败、retry 复位并驱动重载）。
  - `WebCanvasHostView`/`WebCanvasCoordinator`：公开 WebKit API——ready 握手（`canvasHost`）、导航失败诊断、15 秒就绪超时、retry 重载（reloadToken）、导航仅放行 `file://`（§4.1）、`allowsMagnification = false` 避免与 React Flow 双重缩放（M03 备注）。
  - `WebCanvasSection`：画布区 + 加载/失败覆盖层（含阶段说明与重试入口）+ 悬浮玻璃簇（非 ready 时隐藏）；`ShellStage` 更新为"画布已加载内存演示数据；保存、AI 与数据链路尚未接入"（`includesWebCanvas = true`、`persistEdits = false`），由测试守护。

**矩阵 / 验证结果**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| Web 红先 | 新增 demoGraph/NativeCanvasApp 测试后 `npx vitest run src/native-canvas` | 模块缺失失败 | `Failed to resolve import "./demoGraph"` 等两条 | 红已观察 |
| Web 绿 | 同上 | 全部通过 | 2 文件 / 9 测试通过（夹具经 graphRules 端点/成环校验、全类型覆盖、设定集可解析、确定性；演示页渲染/徽标/ready 握手/浏览器兼容） | 通过 |
| Swift 红先 | 契约测试更新后路由命令 | 类型缺失失败 | `no member 'persistEdits'` | 红已观察 |
| Swift 绿 | 路由 `xcodebuild … test` | TEST SUCCEEDED | 3 suites / 9 tests 通过 | 通过 |
| 前端路由检查 | `npm run format:check && npm run lint && npm run build && npm test` | 全绿 | format:check 通过；lint 0 error（仅 `useDebouncedSave` 1 条既有警告，与本次无关）；build 通过；test 120 文件 / 1477 测试通过 | 通过 |
| 演示产物形态 | `npm run build:native-canvas` | 平铺、相对引用 | `native-canvas.html` 内 `./native-canvas.js`、`./native-canvas-<hash>.css` | 通过 |
| 启动新实例 | `open …/Debug/PlotWeaveNative.app` | 窗口出现、画布资源入包 | pid 52683，窗口 1125×836；app Resources 含三个画布文件 | 通过 |
| 宿主内加载 | 测试运行日志 | WKWebView 实际加载 | app 宿主测试日志出现 `WebContent` 进程连接记录 | 通过（间接） |
| 失败路径实测（M01） | 所有者在无 WebCanvas 产物状态下重新构建并启动应用 | 显示"未找到画布资源"诊断 + 重试入口，不显示空白画布 | 2026-09-15 所有者实际触发，诊断与提示文案如实显示 | 通过（诊断路径按设计工作） |

**失败场景、尚未接通的能力与未验证原因**：

- 画布视觉与交互（节点渲染观感、拖拽/连线/平移/缩放、玻璃覆盖、浅深外观）待仓库所有者目验：本会话终端宿主仍缺"屏幕录制"与"辅助功能（AX）"授权（`screencapture` 与 `System Events` 均被拒），无法留截图或读取覆盖层状态。当前运行实例已在所有者屏幕上，确认后补截图归档 `docs/assets/swiftui-react-flow/`。
- M01–M03 系统验证待续：握手状态机已有单测，但"就绪前禁用原生编辑控件"依赖 P3 统一命令入口；M02 侧栏收展对画布命中的影响、M03 输入交接（触控板捏合在 WKWebView 下的手势路径）待画布目验后按矩阵补做。
- 外观同步（M13）：画布页浅深外观经 CSS 媒体查询跟随系统，在 file:// WKWebView 中未实测（无截图能力）。
- 演示页节点复制依赖 `crypto.randomUUID`（`src/uid.ts`）：WebKit 将 file:// 视为安全上下文，理论可用；若目验发现复制失败，登记边界并改为显式禁用。
- 生成调度 stub 的 `start` 仅 console 提示，属 §4.1"明确禁用并标注"范畴，真实接入在 P4。
- 运行时教训（2026-09-15 补记）：`native/macos/App/WebCanvas/` 为一次性产物，单独 `xcodebuild build`（或 Xcode ⌘R）不会重新生成它——无资源时应用按 M01 显示"未找到画布资源"诊断。为此新增 `npm run build:native` 组合命令（画布资源 + `xcodebuild build` 一条链），README 已改为按该命令获取可运行应用；当时只证实资源入包与进程启动，未验证实际画布；所有者随后提供加载超时截图，该次“恢复画布”判断已撤回，见下节修复证据。

**下一步**：所有者目验 + 补截图；随后 P1 第 4–6 项（Tauri 基线对比、Apple Figma 参考映射、外观/玻璃/面板稳定性验证）收敛收尾 P1。

## P1 画布加载超时修复（2026-09-15）

**复现证据**：所有者截图显示“画布在 15 秒内未报告就绪”。真实 WKWebView 测试 `WebCanvasLoadingTests.bundledCanvasRendersAndReportsReady` 同样超时，DOM 节点数为 0，捕获入口 `native-canvas.js` 资源加载错误；HTML、JS、CSS 均已存在于 app bundle。先前仅依据进程、窗口与资源存在而写下的“恢复画布”不成立，以本节的实际渲染验证为准。

**改动前关键状态与不变量矩阵（M01 子集）**：

| 前置状态 | 动作 / 顺序 | 预期可观察结果 | 不变量 / 所有者 / 入口 | 验证 |
| --- | --- | --- | --- | --- |
| 完整打包资源、初次启动 | `loadFileURL` → 执行脚本 → 挂载 React → ready | 宿主 ready，9 个演示节点可见且样式生效 | 构建配置与宿主共同保证 bundle 在公开 WebKit API 下可执行；组合构建和 Xcode 加载 | 先红（15 秒超时、0 节点），后绿（ready、9 节点） |
| 入口脚本已执行 | React Flow 完成挂载与尺寸测量 | 节点绝对定位、可见且有宽度，连线按画布坐标布局 | 原生 Web 入口负责引入 React Flow 基础 CSS；不能依赖未加载的 `EditorView` | 先红（9 个 DOM 节点中 0 个满足定位样式），补基础 CSS 后 9 个均通过 |
| 首次加载已失败 | retry → 重新加载完整资源 | 重新进入 loading，随后 ready、节点恢复 | `WebCanvasState` / `WebCanvasCoordinator`；重试与首次加载使用同一产物 | 真实第二次导航后 ready、9 节点及 CSS 通过；既有测试守护失败后迟到 ready 不覆盖诊断 |
| 资源缺失 / 导航失败 | 加载失败 | 可见诊断与重试入口 | 宿主不把失败解释为空项目；加载、导航回调 | 沿用既有缺资源实测与状态机测试；本次不修改失败处理 |

本次仅修复本地打包执行方式，不涉及持久化、用户数据、网络请求或桥接命令协议；存储并发等维度不适用。输入交接、外观与玻璃视觉仍按 M02/M03/M13 另验。


**修复内容**：`vite.native-canvas.config.ts` 输出 IIFE、内联动态导入并关闭模块预加载/CSS 分片；构建后仅将本入口的模块标签改为经典 `defer` 脚本，移除脚本/样式表的 `crossorigin`。该配置沿用 [Vite 6 构建选项](https://v6.vite.dev/config/build-options)与 Rollup 输出选项；未引入依赖或关闭 WebKit 安全检查。`src/native-canvas/main.tsx` 补引 `@xyflow/react/dist/style.css`。独立开发 HTML 保持 Vite 开发入口；主应用打包不变。

**运行证据**：

- 真实 WebKit 回归测试 `WebCanvasLoadingTests.bundledCanvasRendersAndReportsReady`：同一 app bundle 冷加载与失败后 retry 均 ready，9 节点均具有绝对定位、可见性和非零宽度，捕获的资源/脚本错误为空；修复后的两次加载合计约 0.30 秒（单次本机测试观测，不作为性能保证）。
- 2026-09-15 实际启动仓库内 Debug 应用后，原生窗口 AX 树出现 9 节点、7 条连线与 Web 缩放控件，加载/超时覆盖层已消失；本次会话已取得窗口截图，确认节点、连线、点阵与外壳显示。初次视口部分节点在可视区外，适配视图/窗口布局、拖拽与手势仍属后续 M02/M03 验证范围。
- 本机同时存在仓库内产物和 Xcode 默认 DerivedData 的同名应用。README 使用完整产物相对路径与 `open -n`，明确每次重建后启动新实例。

**检查与限制**：原生完整测试 4 suites / 10 tests 通过；前端 format/lint/build/test 通过（120 文件 / 1477 tests，lint 保留 `useDebouncedSave.ts` 的既有 `gates` 依赖警告）；`npm run build:native` 构建成功。原生测试最初在工具沙箱内无法连接 `testmanagerd`，获得自动批准后在沙箱外运行。未触及 Rust；未运行 SonarQube，未提交或推送。本次按所有者对可启动版本的修复需求保留演示应用产物；文档已按状态、命令与交叉链接进行结构化审阅，无独立文档自动检查。


## P1 阶段提交整理（2026-09-15）

提交前发现 `useDemoEditor` 长 152 行，超过工程函数上限；按图状态、连线、节点操作和派生读取拆为同模块内的职责函数，保持当前内存演示行为。

| 前置状态 | 动作 / 顺序 | 可观察结果 | 不变量 / 所有者 / 入口 | 验证 |
| --- | --- | --- | --- | --- |
| 初始演示图 | 补丁、复制、删除带连线节点 | 补丁保留其他字段；副本新 id、偏移；删除同步清理连线与目标设置面板 | `useDemoEditor`；NodeEditApi 的编辑入口共同维持图引用有效 | `useDemoEditor.test.ts`；临时移除删除边的副作用后用例失败，恢复后通过 |
| 设置面板打开 / 关闭，或 id 不存在 | 切换 / 关闭 / 复制未知 id | 面板正确切换，未知 id 不创建节点，派生分镜计数与节拍状态反映当前图 | `useDemoEditor` 的面板和派生读取 | 同上 |
| 已有剧情边和分镜宿主 | 校验自环、重复、成环、重复宿主，再建立合法边 | 非法连接不通过；合法边进入图，下一次校验识别重复 | 连线预览与 React Flow 落线入口沿用 graphRules | 同上 |

本次整理不新增业务能力；持久化、跨进程并发和模型请求未接通，不适用这些维度。原生端仍由真实 WKWebView 冷加载/重试回归保护。阶段提交只包含本分支改造内容，既有截图删除与根目录图片留在工作区。


**阶段提交前验证结果**：

- 仓库根目录 `npm run format:check && npm run lint && npm run build && npm test` 通过；121 文件 / 1481 测试通过，lint 仅保留 `useDebouncedSave.ts` 既有的 `gates` 依赖警告。新增测试中的 `Array.at` 已改用 ES2020 兼容索引，未提升项目编译目标。
- `npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 通过：4 suites / 10 tests；包含真实 WKWebView 加载、9 节点有效样式、失败后重试。
- `npm run sonar:gate` 生成最新覆盖率并通过 Quality Gate，新增代码未解决问题为 0。当前 Sonar 配置扫描 `src` 与 `src-tauri/src`；Swift 与原生资源加载由上述 Xcode 测试验证，不宣称 Swift 已受 Sonar 扫描。正式提交继续执行原有 pre-commit 钩子。
- 首次 ESLint 扫描原生压缩脚本时发生堆内存耗尽；仅忽略 `native/macos/App/WebCanvas`、`native/macos/build` 两个生成目录后恢复正常。已通过 ESLint `isPathIgnored` API 验证两个目录被忽略、`src/native-canvas/main.tsx` 仍在检查范围内。没有排除维护源码。
- TypeScript AST 检查本次新增函数与测试回调均不超过 80 行；图连线与编辑器装配各自保持单一职责。文档与工程配置已结构化复核，`git diff --cached --check` 通过。

本节是本阶段的验证快照，不表示保存、AI、完整手势或 Liquid Glass 视觉验收已完成。现有本地演示产物继续保留供所有者使用，均不进入提交；本次无推送或发布操作。

## P1-6 系统外观同步与面板生命周期（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 6 项的代码部分；`codex/swiftui-react-flow` 同工作区未提交状态。

**目标**：原生侧显式读取系统外观与辅助显示语义并同步给 Web（计划 §2.2「不能只假定媒体查询在目标 WebKit 上全部生效」）；验证侧栏收展、检查器开关等面板变化不重建 WKWebView、不重载页面（计划 §4.2）。握手与加载失败验证已由 P1-2b/3 覆盖（含缺资源实测与真实 WebKit 回归），本切片不重复。

**改动前关键状态与不变量矩阵（M13/M02 种子）**：

| 前置状态 | 动作 / 顺序 | 预期可观察结果 | 不变量 / 所有者 / 入口 | 验证 |
| --- | --- | --- | --- | --- |
| WKWebView 首次加载，系统处于任意外观/辅助组合 | document-start 注入宿主语义快照 → React 挂载后消费 | `<html>` 上 `data-host-color-scheme` 等四个语义属性反映宿主读取值 | 宿主语义单来源：`NSApp.effectiveAppearance` 与 `NSWorkspace` 辅助设置；`CanvasAppearanceState` | `NativeCanvasApp` 单测（注入值落属性）+ 真实 WKWebView 生命周期测试断言属性为 light/dark |
| 页面已挂载，宿主语义快照随后变化 | 原生刷新快照 → evaluateJavaScript 推送 → Web 校验并应用 | data 属性更新为新值；无效载荷（缺字段/非法枚举）被拒绝，属性保持原值 | 桥接载荷经边界校验（§4.1）；相同快照不重复推送 | `CanvasAppearanceStateTests`（编码往返、契约值域、仅实际变化通知、停止观测脱钩）+ 真实 WKWebView 测试注入受控 reader 改值推送 |
| 页面 ready（含 retry 重载后） | ready 握手 → 宿主推当前快照 | 重载后页面与宿主当前语义对齐，不残留构建期旧值 | 文档启动注入与 ready 推送共同保证加载完成后对齐；`WebCanvasCoordinator` | `bundledCanvasRendersAndReportsReady`（既有真实加载回归，覆盖 ready 路径） |
| 画布已 ready、窗口可见 | 切换检查器 → 收展侧栏 → 恢复 | WKWebView 实例 ObjectIdentifier 不变；页面 JS 探针不变（未重载）；9 节点仍在 | WebView 生命周期独立于面板可见性（§4.2）；`ShellLayoutState` / `WebCanvasSection` | `ShellWebCanvasLifecycleTests.panelTogglesKeepWebViewAndPageAlive`（NSHostingView + 真实 NativeShellRoot） |
| 无宿主桥（浏览器 dev 环境） | 挂载与推送均不发生 | 不抛错、不落属性 | 浏览器兼容：无桥静默跳过（沿用 ready 握手约定） | bridge 单测（无注入返回 null）+ 演示页既有无桥用例 |

**交付内容**：

- **Swift 侧**
  - `CanvasAppearanceState`（@MainActor @Observable）：宿主外观语义单来源——快照 = `NSApp.effectiveAppearance`（bestMatch light/dark）+ `NSWorkspace` 的减少透明度/增强对比度/减少动态效果；KVO 观测（effectiveAppearance 与三个辅助属性），reader 可注入供测试；仅实际变化通知，`payloadJSON` 为 Web 桥校验的 JSON 文本。
  - `WebCanvasCoordinator`：ready 握手后推送当前快照（retry 重载后重新对齐，不残留构建期旧值）；`startAppearanceSync` 承接变化推送，可选调用形式（`window.__pwApplyHostAppearance && …`）在 Web 端未注册前为安全 no-op。
  - `WebCanvasHostView`：document-start `WKUserScript` 注入 `window.__pwHostAppearance`，首帧即带语义。
  - `NativeShellRoot`：layout 与 appearance 参数化注入（应用内默认不变，测试驱动真实状态对象）；`ShellLayoutState.sidebarVisible` 经 `columnVisibility` 绑定成为侧栏收展单一来源（系统工具栏开关与测试同源）；`.task/.onDisappear` 启停外观观测。
- **Web 侧**
  - `canvasHostBridge`：`readInitialHostAppearance` / `setHostAppearanceHandler` / `HostAppearance`，载荷逐字段校验（colorScheme 枚举 + 三布尔），无效载荷丢弃不污染已应用状态；`main.tsx` 入口不变。
  - `NativeCanvasApp`：挂载时应用初始注入并注册推送，语义落到 `<html>` 的 `data-host-color-scheme` / `data-host-reduce-transparency` / `data-host-increase-contrast` / `data-host-reduce-motion`；卸载时移除入口。
  - `tokens.css`：宿主存在时 `color-scheme` 以宿主 data 属性声明为准（UA 部件一致）；媒体查询令牌块保持不动。

**矩阵 / 验证结果**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| Web 红先 | 新增 bridge/演示页外观用例后 `npx vitest run src/native-canvas` | 模块/函数缺失失败 | `setHostAppearanceHandler is not a function` 等 8 用例失败 | 红已观察 |
| Web 绿 | 同上 | 全部通过 | 4 文件 / 21 测试通过 | 通过 |
| Swift 红先 | 新增 `CanvasAppearanceStateTests` 后路由命令 | 类型缺失编译失败 | `Cannot find 'CanvasAppearanceState' in scope`，TEST FAILED | 红已观察 |
| Swift 绿 | `npm run build:native-canvas && xcodebuild … test` | TEST SUCCEEDED | 6 suites / 15 tests 通过（含 `panelTogglesKeepWebViewAndPageAlive` 1.6 秒真实窗口路径） | 通过 |
| 前端路由检查 | `npm run format:check && npm run lint && npm run build && npm test` | 全绿 | format 通过；lint 0 error（仅 `useDebouncedSave` 既有警告）；build 通过；122 文件 / 1489 测试通过 | 通过 |

真实窗口测试覆盖的完整链路：`NSHostingView(NativeShellRoot)` 挂载 → WKWebView 加载 9 节点画布 → 初始外观属性为 light → 注入页面探针 → 切检查器/收展侧栏/恢复 → WebView 实例同一、探针不变、9 节点仍在 → 受控 reader 改为 dark + 全辅助开启 → `refresh()` 推送 → 页面属性变 dark 且 `data-host-increase-contrast` 为 true。

**失败场景、尚未接通的能力与未验证原因**：

- 真实系统外观/辅助设置切换的人工目验（M13 完整矩阵：浅↔深、减少透明度、增强对比度、减少动态效果组合）待所有者执行——自动化测试以受控 reader 验证了推送链路，未模拟真实系统设置事件。P1 第 6 项暂不勾选，待此目验后完成（与第 3 项同模式）。
- `tokens.css` / `nodes.css` 的浅深、对比度、透明度令牌块未镜像 data-attr 选择器：宿主语义与 WKWebView 媒体查询同源（NSApp/NSWorkspace），当前无分叉场景，重复大块变量有漂移风险；M13/P5 实测发现某条媒体查询不生效时再按 data 属性补镜像。
- `data-host-reduce-motion` 语义已同步，但 Web 端尚无消费点（nodes.css 现有 `prefers-reduced-motion` 规则未镜像），随 M13 视觉收敛处理。
- 截图仍缺屏幕录制授权；本会话未启动应用实例（生命周期验证在测试宿主内完成）。
- 未运行 SonarQube 门禁：本次未提交、未推送（提交前按 `AGENTS.md` 执行）。
- `native/macos/build/` 与 `native/macos/App/WebCanvas/` 为一次性构建产物（gitignore），沿用所有者决策保留供启动，不进入提交。

**下一步**：所有者目验第 3 项画布交互与真实系统外观切换后勾选 P1 第 3、6 项；随后 P1 第 4–5 项（Tauri 基线对比、Apple Figma 参考映射与外观/玻璃验证）收敛收尾 P1。

## P1-4/5 Figma 参考记录、基线准备与所有者目验指引（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 4–5 项的可会话内部分；`codex/swiftui-react-flow` 同工作区未提交状态。本会话终端宿主与 ZCode Computer Use 均未获「屏幕录制」「辅助功能（AX）」「Apple Events」授权（`screencapture`、System Events 均被拒），视觉目验与截图只能由仓库所有者完成；应用实例已启动供直接目验（见下文指引）。

### Apple Figma 参考与控件映射（第 5 项前半）

官方入口 [developer.apple.com/design/resources](https://developer.apple.com/design/resources/) 当前 macOS 区列 **macOS 27 UI Kit**（Figma Community file [1651309434229735362](https://www.figma.com/community/file/1651309434229735362/macos-27)）；本分支构建目标固定为 macOS 26 SDK（见 P1-1 工具链记录），故采用同代 **macOS 26 UI Kit**（Figma Community file [1543337041090580818](https://www.figma.com/community/file/1543337041090580818/macos-26)，Apple 官方发布，含组件、文本样式、色彩样式与材质）为基准，macOS 27 kit 作为后续升级对照。两个链接经官方入口与检索结果确认；Figma 文件内部的具体页面/组件节点定位需在设计工具中打开后补齐（本会话无 Figma 访问能力，不预填未经验证的节点链接）。

控件映射（原生实现 → kit 通用规范条目）：

| 原生外壳实现（本分支） | macOS UI Kit 对应 | 说明 |
| --- | --- | --- |
| `NavigationSplitView` 导航侧栏 | Navigation sidebar / source list | 标准导航容器，玻璃由系统提供（§2.2） |
| 统一工具栏（`primaryAction`） | Window toolbar | 工具栏项位置与状态遵循 kit 标注 |
| 尾随检查器（`inspector`） | Inspector pane（trailing） | P3 接内容前为占位列表 |
| 悬浮玻璃簇（`glassEffect(.regular, in: .capsule)`） | Liquid Glass floating controls（capsule） | 自定义浮动控件的玻璃路径（§2.2） |
| 画布区 + 加载/失败覆盖层 | Content area | 不透明内容表面，不套玻璃（§2.2） |
| Web 画布令牌（tokens.css） | kit 色彩/文本样式仅作对照 | Web 内容样式由 CSS 令牌承载，不逐值复制 kit |

### 性能基线准备（第 4 项推进，夹具与指标规格定稿）

按计划 §7.2 固定以下夹具规格（实现与测量属后续切片，此处为定稿记录）：

| 夹具 | 节点 / 边 | 家族比例（剧本/对白/节奏/角色/场景/生成图） | 图片资产 | 视口与可见性 |
| --- | --- | --- | --- | --- |
| 常用-100 | 100 / ~110（sequence 70%、branch 20%、attach 10%） | 20/25/20/10/10/15 | 512² 与 1024×768 各半 | 1440×900@2x，fitView 后可见约 60 |
| 常用-500 | 500 / ~560 | 同上 | 同上 | 同视口，缩放后可见约 120 |
| 压力-1000 | 1000 / ~1100 | 生成侧重（生成图 40%） | 同上 | 25% 全览 |

指标（两宿主同机同夹具记录）：首次可交互（ready 握手）、拖拽/平移帧耗时 p50/p95、超帧预算长帧计数、JS 与原生主线程工作、消息频率/体积、内存峰值、反复开关 10 次趋势；60Hz 与 120Hz 分别测（M4 Max 内置屏支持）。帧预算按 §7.2：60Hz ≈16.7ms、120Hz ≈8.3ms。

已可引用的原生首片观测：真实 WKWebView 冷加载→ready 约 0.30 秒（`WebCanvasLoadingTests` 两次加载合计约 0.30 秒的单次本机观测，见「画布加载超时修复」节，不作为性能承诺）。

**Tauri 对比接缝（登记待做）**：演示夹具当前不在 Tauri 壳内，严格同夹具对比需二选一——(a) 以 Tauri dev 入口伺服 `native-canvas.html`（vite dev server 多页面可直接伺服该页）；(b) 构造同规模项目文件驱动 Tauri 完整编辑器（含持久化路径，超出 P1 范围）。P1 采用 (a) 的路径，属下一切片工作；未完成前不以浏览器单测或主观数据冒充基线。

### 所有者目验指引（第 3、6 项收尾与第 5 项视觉验证）

应用实例已启动（本次会话 `open -n` 新实例，系统当前为深色外观）。请按下列清单目验；全部通过后勾选计划第 3、6 项。截图需先在「系统设置 > 隐私与安全性 > 屏幕录制」为终端宿主授权，用 ⌘⇧4 窗口截图或 `screencapture -l <窗口id>` 归档至 `docs/assets/swiftui-react-flow/`（建议命名见括号）。

1. **画布交互（第 3 项）**：拖拽任一节点（位移跟随、无闪烁，`p1-canvas-dark.png`）；从节点端口拖出连线到另一节点（合法连接建立，非法目标被拒）；空白处拖拽平移；触控板捏合或 ⌘+滚轮缩放；左下角缩放控件与百分比正常（`p1-canvas-zoomed.png`）。
2. **系统外观切换（第 6 项 M13）**：控制中心或「系统设置 > 外观」切换浅色→画布背景/节点令牌随之变浅（`p1-canvas-light.png`），切回深色恢复；「系统设置 > 辅助功能 > 显示」逐项开「减少透明度」「增强对比度」（以及「减少动态效果」）观察原生玻璃与 Web 内容适配。
3. **面板与窗口（第 5 项，M02）**：工具栏收展侧栏、检查器开关（画布不闪烁、不重载）；调整窗口尺寸与全屏（`p1-sidebar-collapsed.png`）；确认悬浮玻璃簇覆盖处节点仍可正常命中交互。
4. **失败路径**（可选，已有实测记录）：删除 `native/macos/App/WebCanvas/` 后重新 `xcodebuild build` 启动，确认「未找到画布资源」诊断与重试入口。

观察结果（通过/异常现象）直接反馈即可作为勾选依据；异常将按矩阵行回到对应测试补回归。
