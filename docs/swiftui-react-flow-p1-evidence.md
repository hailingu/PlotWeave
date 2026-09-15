# SwiftUI/AppKit + React Flow 改造：P1 证据记录

> 配套：[改造计划](swiftui-react-flow-migration-plan.md)（§7.3 证据模板、§6 状态矩阵）。本页只记录已实际执行的验证；未执行的检查明确标注原因。

## P1-1 工具链记录与原生工程骨架（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P1 第 1 项；2026-09-15；`codex/swiftui-react-flow` 工作区未提交状态（叠加在 P0 文档改动之上；提交与门禁按任务另行执行，本页不构成提交证据）。

**系统 / 工具链 / 硬件（此后固定为本分支构建配置）**：

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
