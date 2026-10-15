# SwiftUI/React Flow 迁移 P5 验证证据记录

> 任务：[issue #523](https://github.com/hailingu/PlotWeave/issues/523)（P5 视觉、输入法、VoiceOver 与性能验收尚无执行证据）。
> 分支：`fix/523-p5-acceptance-evidence`（基线 `dev` @ `10765e2`）；执行日期：2026-10-14（首轮）、2026-10-15（PR #574 评审修正轮，§3 数值以本轮为准）。
> 本记录遵循[迁移计划 §7.3 模板](swiftui-react-flow-migration-plan.md#73-每阶段证据模板)；矩阵行引用见 §6。

## 0. 执行环境

- 系统 / 硬件：macOS 27.0.1，Apple M4 Max（Mac16,5），内建 Retina 3456×2234（devicePixelRatio 2），观察帧间隔 p50≈17ms（≈60Hz；高刷模式未测）。
- 工具链：Xcode 27.0（27A266a）/ macOS SDK 27.0 / Swift 6 语言模式（钉版见[工具链记录](swiftui-react-flow-toolchain.md)）；Node 24.18.0（`.nvmrc`），vitest 4.1.11。
- 启动命令 / 数据根策略：原生侧 `npm run build:native-canvas` 后 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`；测量页为打包资源 `native-canvas.html#perf:N`（内存演示数据，不落盘、不触碰用户数据根）；Web 侧 `npx vitest run src/editor/nativeCanvas/`。

## 1. M13 — 浅深色与辅助功能组合（自动化切片）

- 命令：上述原生路由命令（套件 `CanvasAppearanceComboTests`，新增）。
- 步骤：真实 WKWebView 加载发货页 `#fixture`；对 9 组组合（浅/深 × 无 / 仅 RT / 仅 IC / 仅 RM / 全开）经受控读取器强制宿主快照并 `refresh()` 推送。
- 预期：四项语义属性落页且被 Web 令牌层实际消费（计算样式，非仅属性反射）。
- 实际 / 通过：9/9 组合通过——`color-scheme` 计算值跟随宿主；RT 或 IC 下画布控件 `backdrop-filter` 退化为 `none`、IC 下边框升为 2px；演示画布根类为 `canvas-root is-swift`。
- 同轮修复：演示/验证页此前固定 `className="canvas-root"`，Swift 宿主下 RT/IC 退化 CSS（前缀 `.canvas-root.is-swift`）不生效；现与生产 `EditorCanvasRegion` 同源判定（`isSwiftHost()`）。
- 信息性观察：本机媒体查询 `prefers-reduced-motion` 为 false，与真实系统设置一致；宿主快照与媒体查询的分叉场景未实测。
- 未通过 / 未执行（各自独立 issue）：
  - reduce-motion 语义无属性驱动的令牌消费路径（RT/IC 有、RM 无）——[#568](https://github.com/hailingu/PlotWeave/issues/568)。
  - VoiceOver 真机巡检与 Web AX 树验证（测试宿主内 WKWebView 不暴露内容 AX 树）——[#569](https://github.com/hailingu/PlotWeave/issues/569)。
  - 中文输入法真机组合输入——[#570](https://github.com/hailingu/PlotWeave/issues/570)。
  - 视觉目验/截图/录屏（屏幕录制授权缺失）——[#571](https://github.com/hailingu/PlotWeave/issues/571)。

## 2. M14 — Swift 请求在途与进程异常（Swift 侧执行取证）

- 命令：上述原生路由命令；结果：**252 项测试 / 57 套件全部通过**（119.5s）。
- 与本行直接相关的套件及结果（真实 WKWebView 或真实存储根）：
  - `WebHostBridgeTests`（1.51s）：进程失效（`webViewWebContentProcessDidTerminate` 真实委托路径）、load/provisional 失败与宿主释放 × 退出监听在否的 8 组合；旧页失效不能取消新页退出；失效停止投影与原生意图；子框架无主框架权限；缺失回执显式失败。
  - `HostRequestLifecycleTests` / `HostRequestRetirementTests`（1.57s）：失效/新会话取消在途副作用；4096 窗口满载 `PW_REQUEST_CAPACITY`、乱序退役不丢在途 Task、退役水位拒绝旧重放。
  - `HostCommandRouterTests`（0.18s）：重复创建只落一次；失效页（崩溃后代）拒绝后续写入；退出监听回执。
  - `HostQuitTests` / `NativeQuitRecoveryTests` / `NativeProductionLifecycleTests` / `NativeWindowLifecycleTests`：退出屏障握手、失败留窗重试、页面换代取消延期终止、真实独立存储的编辑-冲刷-重开。
- 边界（非本轮新增，保持既有记录）：进程异常以真实委托方法模拟，未实际杀死 WebContent 进程；崩溃后未落盘编辑的恢复不作承诺（F11）。
- 结论：M14 的 Swift 侧在既有回归全量执行下通过；不改变该行历史 Rust ABI 证据的定位。

## 3. M15 — 固定规模图的持续操作与内存（首轮测量）

### 3.1 夹具与脚本

- 夹具：`src/editor/nativeCanvas/canvasPerfFixture.ts`（新增，vitest 14 项校验规模/比例/确定性/graphRules/句柄对齐/脱敏）。规模 100/500/1000；每 10 节点一个故事单元，家族比例 beat 30% / scene 20% / dialogue 20% / branch 10% / shot 10% / image 10%；边数 = 规模×0.9−1（含 sequence/branch/attach 三语义与跨单元桥接）；图片节点统一声明 1024×1024、`outputs` 恒空（无真实媒体字节）；窗口 1280×860 下 fitView（受默认 minZoom 0.5 限制）可见节点 26–32。
- 脚本：`src/editor/nativeCanvas/canvasPerfScript.ts`（新增）在真实 React Flow 挂载树上派生真实鼠标/滚轮事件——拖拽（2 轮×20 步，目标取视口内可见节点，评审后修正）、平移（2×20）、缩放（2×16，正负交替）、画布控件（逐个点击）；宿主侧（`WebCanvasPerformanceTests`，新增）在脚本运行中切换真实原生面板（检查器 0.6s、侧栏收/展 1.5s/2.2s）。rAF 帧间隔按阶段统计 p50/p95/max/超预算数。
- 内存：`WebProcessMemorySampler.swift`（新增）以公开 proc API（`proc_listallpids`，buffersize 按字节传参 + `PROC_PIDTBSDINFO`/`PROC_PIDTASKINFO`）按「装载前后 WebContent pid 差集」归属本页进程；反复开关以 5 次完整销毁/重建宿主画布（新窗口 + SwiftUI dismantle → coordinator 失效）采样，有界断言覆盖**周期自有 pid 的累计聚合**（含销毁后仍存活的进程）与**宿主 app 自身常驻内存**，循环后对进程回收做受界等待（30 秒窗口）并断言沉降末读数为 0 进程。

### 3.2 测量结果（本机，测试套件内，2026-10-15 评审修正轮）

| 规模 | 挂载→节点就绪 | 帧总量 | 总体 p50/p95/max | 拖拽 p50/p95/max（超33ms） | WebContent 内存（前→后） |
| --- | --- | --- | --- | --- | --- |
| 100 | 742ms | 263 | 17 / 18 / 21ms | 17 / 18 / 18ms（0） | 117.0 → 124.9MB |
| 500 | 749ms | 297 | 17 / 24 / 50ms | 17 / 30 / 36ms（2） | 248.5 → 300.7MB |
| 1000 | 1788ms | 339 | 17 / 45 / 89ms | 17 / 68 / 89ms（20） | 504.6 → 512.2MB |

- 平移/缩放/面板阶段：p95 18–32ms（1000 规模面板 p95 42ms / max 71ms）。
- 打开/关闭趋势（perf:100 × 5 次完整销毁/重建宿主画布，聚合口径）：周期自有 WebContent 的累计聚合 RSS 每周期恒约 118MB、进程数恒 1——**先前周期的进程在下一周期装载前已退出**，无残留累积；循环后在 30 秒等待窗口内沉降至 0 进程并断言（本机实测 ≤8 秒回收）。宿主 app 常驻内存 201.7 → 230.6MB，一次性 +29MB（pre-loop 198.6MB，WebKit 框架热身）后平台化。销毁后 2 秒内旧进程因 WebKit 进程缓存短暂存活（RSS 持平）。对照：同一 WebView 内 5 次 `reload()` 曾测得单调上升（115.6→189.9MB，首轮记录）——增长系重导航堆增长而非宿主销毁泄漏，长循环确认仍归 [#573](https://github.com/hailingu/PlotWeave/issues/573)。
- 帧预算口径：60Hz ≈16.7ms；p50≈17ms 即贴预算运行，over16 计数见测试输出（p95 视角已列上表）。
- 消息频率/体积：演示页无宿主命令（就绪握手与外观推送之外为 0），桥接合并性能不构成本夹具瓶颈。

### 3.3 结论与边界

- 通过（结构性断言，进 CI 套件）：三规模节点/边计数、四阶段齐全、rAF 采样、拖拽位移/平移/缩放行程非零（拖拽目标为视口内可见节点、每轮重取坐标）、销毁/重建周期每个采样点的 WebContent **累计聚合**与宿主 app 内存均有界守卫（各 +400MB 界，含沉降末读）、每周期归属到新进程，且沉降末读断言为 0 进程（30 秒受界等待）。
- 退化位置（按 §7.2「压力场景明确退化位置」记录，不计为未通过）：1000 节点拖拽 p95 68ms、超 33ms 帧 20 个——压力规模下拖拽连续性显著退化，优化方向为既有渲染隔离/仅渲染可见元素等（后续任务）。
- 能力边界：WebKit 无 `longtask` 条目（报告 longTasks=null）；单刷新率（60Hz/dpr2）、单机；页面为打包演示入口而非生产编辑会话（无保存链/AI 面板参与）；WebContent 进程归属依赖全机 pid 基线差集——WebKit 若复用进程池中既有进程，差集为空并以显式失败暴露（不静默测错对象），无关进程并发启动的误归属只会高估内存总和、不影响有界判断。
- 对比缺口：Tauri 同夹具基线未取得——[#572](https://github.com/hailingu/PlotWeave/issues/572)；同 WebView 重导航堆增长的长循环确认——[#573](https://github.com/hailingu/PlotWeave/issues/573)。

## 4. 本轮代码变更与验证汇总

- 前端：`canvasPerfFixture.ts`（+测试）、`canvasPerfScript.ts`（+测试）、`main.tsx` hash 装配、`NativeCanvasApp`/`useDemoEditor` 支持注入图、演示页 `is-swift` 修复。路由检查全绿：`format:check`、`lint`、`check:size`（719 文件）、`typecheck:strict`、`build`、`npm test`（230 文件 / 3146 项）。
- 原生：`NativeShellRoot`/`WebCanvasSection` 增加 `demoFragment`（默认 `fixture` 不变）；新增 `CanvasAppearanceComboTests`、`WebCanvasPerformanceTests`、`WebProcessMemorySampler`；`WebCanvasLoadingTests` 补 7 边渲染断言。原生路由完整套件 252 项 / 57 套件通过。
- 评审轮（PR #574 review 5521422435，2026-10-15）：拖拽目标改为视口内可见节点；`proc_listallpids` 的 buffersize 按字节传参（本机实证：按元素数传参只暴露约 1/4 缓冲区）；内存周界测试改为完整销毁/重建宿主画布并显式暴露进程池复用（差集为空即失败）。修正后前端 3146 项 / 原生 252 项全绿，§3.2 数值为修正轮记录。
- 评审轮二（PR #574 review 5526951136，2026-10-15）：周期内存断言改为周期自有 pid 的累计聚合 + 宿主 app 内存双有界（此前仅比较当前周期 RSS，销毁残留进程与宿主持有不在断言内）；`canvasPerfFixture.test.ts` 断言体提取为独立函数满足 80 行可执行单元上限。双侧套件复跑全绿（前端 3146 / 原生 252），§3.2 趋势数值为聚合口径记录。
- 评审轮三（PR #574 review 5527061716，2026-10-15）：聚合内存断言改为**逐样本**（中间峰值同样受界，沉降期退出不再留下断言盲区）；拖拽脚本每轮重取节点矩形（第二轮起旧坐标已离开被拖节点，会再次绕过命中测试）。双侧套件复跑全绿（前端 3146 / 原生 252），§3.2 为本轮数值。
- 评审轮四（PR #574 review 5527217491，2026-10-15）：沉降末读的进程回收由观测改为断言（30 秒受界等待后 `webContentProcessCount == 0`，此前「完全回收」只被记录未被断言）；迁移计划 §7.2 的 p95 概要与证据表对齐并区分总体/拖拽口径（此前 500 规模数值沿用旧一轮，口径未标注）。
- 一次性产物（DerivedData、/tmp 日志）验证后清理；未触碰用户数据根。
