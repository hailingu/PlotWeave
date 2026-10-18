# SwiftUI/React Flow 迁移 P5 验证证据记录

> 任务：[issue #523](https://github.com/hailingu/PlotWeave/issues/523)（P5 视觉、输入法、VoiceOver 与性能验收尚无执行证据）。
> 分支：`fix/523-p5-acceptance-evidence`（基线 `dev` @ `10765e2`）；执行日期：2026-10-14（首轮）、2026-10-15（PR #574 评审修正轮，§3 数值以本轮为准）。
> 2026-10-17：[issue #572](https://github.com/hailingu/PlotWeave/issues/572) 在 `fix/572-tauri-perf-baseline`（基线 `67b0e03`）补齐 Tauri 共同模式基线；§3.4 数值以 PR #585 评审修正轮为准，不改写 §3.2 的历史原生面板轮。
> 本记录遵循[迁移计划 §7.3 模板](swiftui-react-flow-migration-plan.md#73-每阶段证据模板)；矩阵行引用见 §6。

## 0. 执行环境

2026-10-18 复测入口更新（[PR #604](https://github.com/hailingu/PlotWeave/pull/604)）：
默认 `sh scripts/test-native.sh` 保留功能回归并跳过五个压力测量；使用
`sh scripts/test-native.sh stress` 按原规模复测性能、内存及首拖。
本篇历史命令与数值保留；若直接复用下方 Xcode 测量命令，须在命令前设置环境变量
`TEST_RUNNER_PLOTWEAVE_NATIVE_STRESS_TESTS=1`，否则 Swift Testing 会显式跳过压力测量。
选择与验证边界见 [Native Regression And Stress](development/quality-gate-push.md#native-regression-and-stress)。

- 系统 / 硬件：macOS 27.0.1，Apple M4 Max（Mac16,5），内建 Retina 3456×2234（devicePixelRatio 2），观察帧间隔 p50≈17ms（≈60Hz；高刷模式未测）。
- 工具链：Xcode 27.0（27A266a）/ macOS SDK 27.0 / Swift 6 语言模式（钉版见[工具链记录](swiftui-react-flow-toolchain.md)）；Node 24.18.0（`.nvmrc`），vitest 4.1.11。
- 启动命令 / 数据根策略：原生侧 `npm run build:native-canvas` 后 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`；测量页为打包资源 `native-canvas.html#perf:N`（内存演示数据，不落盘、不触碰用户数据根）；Web 侧 `npx vitest run src/editor/nativeCanvas/`。

## 1. M13 — 浅深色与辅助功能组合（自动化切片）

2026-10-18 范围决策（[issue #569](https://github.com/hailingu/PlotWeave/issues/569)）：所有者明确要求不支持 VoiceOver，取消原生界面与画布的相关人工／Web AX 验收，按不计划支持关闭该 issue。此次仅确认系统设置中 VoiceOver 为关闭；未完成真实导航、朗读或 rotor 巡检，不记录为验收通过。字幕面板原已开启，本轮未改动其设置。原有键盘、语义标签、axe 与外观变体不变；输入法及视觉缺口仍分别由 #570／#571 跟踪。

- 命令：上述原生路由命令（套件 `CanvasAppearanceComboTests`，新增）。
- 步骤：真实 WKWebView 加载发货页 `#fixture`；对 9 组组合（浅/深 × 无 / 仅 RT / 仅 IC / 仅 RM / 全开）经受控读取器强制宿主快照并 `refresh()` 推送。
- 预期：四项语义属性落页且被 Web 令牌层实际消费（计算样式，非仅属性反射）。
- 实际 / 通过：9/9 组合通过——`color-scheme` 计算值跟随宿主；RT 或 IC 下画布控件 `backdrop-filter` 退化为 `none`、IC 下边框升为 2px；演示画布根类为 `canvas-root is-swift`。
- 同轮修复：演示/验证页此前固定 `className="canvas-root"`，Swift 宿主下 RT/IC 退化 CSS（前缀 `.canvas-root.is-swift`）不生效；现与生产 `EditorCanvasRegion` 同源判定（`isSwiftHost()`）。
- 后续补强（2026-10-16，[#568](https://github.com/hailingu/PlotWeave/issues/568) 修复）：reduce-motion 此前无属性驱动的令牌消费路径（RT/IC 有、RM 无），现已接线——动效退化规则补 `:root[data-host-reduce-motion='true']` 属性分支（五个样式表），`useAutoLayout` 的 JS 动画与媒体查询/宿主属性取或；RM 组合增加节点卡计算 `transition-duration` 等价断言（降级 ⇔ 宿主属性或媒体查询任一为真），属性驱动路径修复前该断言在真实 WebKit 上失败（3 组合），修复后 9/9 通过。
- 信息性观察：本机媒体查询 `prefers-reduced-motion` 为 false，与真实系统设置一致；宿主快照与媒体查询的真实系统切换分叉场景仍未实测（断言经强制快照构造，机器无关）。
- 未通过 / 未执行（各自独立 issue，#568 已由上述后续补强解决、不在本清单）：
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

#### 第 17 条评审修复：关键状态与不变量矩阵

进程差集的元素数无法证明逐页归属；本轮由测试侧共享串行门负责阻止宿主内其它 WebKit 套件进入归因窗口。入口包括直接创建 WKWebView、挂载 NativeShellRoot 的套件及检查宿主无画布的启动套件；各套件同时保留内部 `.serialized`。#575 修复收尾（2026-10-18）：测试代码不再直接构造 `WKWebView`，直接构造类夹具统一经 `IsolatedWebViewFixture.makeWebView`，构造前证明持有共享许可，未持门抛 `exclusiveSuiteScopeRequired`；经 shell 挂载的套件在产线代码内构造，仍由 trait 与评审保证。

| 前置/状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方 | 验证 |
| --- | --- | --- | --- | --- |
| 两个套件同时请求 WebKit 资源 | 首个进入并在 await 挂起，第二个请求进入 | 第二个直到首个作用域退出后才能执行 | 任一时刻最多一个套件拥有归因窗口 / WebKitTestIsolation | 并发作用域回归 + 原生完整套件 |
| 作用域抛错或任务取消 | 退出作用域，再请求同一门 | 错误向上传递，后续作用域仍能执行 | 失败不得遗留许可或允许重叠 / 共享门 | 抛错、取消恢复回归 |
| 未持有共享门 | 请求本页 PID 差集 | 显式拒绝，不产生可用于内存断言的集合 | RSS 基线只能在隔离作用域内建立 / WebProcessMemorySampler | 门外采样回归 |
| 窗口已挂载，归属或就绪检查抛错 | 测试提前退出，再转交共享许可 | defer 先拆卸窗口内容并关闭窗口 | 失败不得把活跃页面遗留给下个套件 / 性能夹具 | defer 路径结构化审查 + 真实生命周期套件；未注入真实 PID 污染 |
| 本页复用既有 PID，另一套件欲启动新页 | 持门采基线→装载→差集，另一套件等待 | 外来套件无法在窗口内启动；空差集必须抛错 | 不能把复用加外来启动的单元素差集当作本页 / 门与采样器 | 共享门竞争回归、差集歧义回归、真实 WKWebView 路由 |
| 五次销毁/重建 | 同一套件持门完成所有周期与采样 | 每次只接受单元素差集，每个累计样本与宿主 RSS 均受界 | 前后基线使用同一隔离边界 / 性能套件 | WebCanvasPerformanceTests |
| 套件未挂门（新增或 trait 被移除）| 测试体经 `IsolatedWebViewFixture` 构造直接类夹具 | 构造即抛 `exclusiveSuiteScopeRequired`，首个夹具处失败并指认 #575 | 测试构造的 WKWebView 不得存在于共享许可之外 / IsolatedWebViewFixture | 门外构造回归 + 8 个迁移套件全绿 |

门不控制其它应用启动 WebContent；测量仍要求安静的本机环境。平台进程缓存回收只观测；持久化、重试及生产生命周期不变，不涉及本次修复。

#### 夹具、交互与采样口径

- 夹具：`src/editor/nativeCanvas/canvasPerfFixture.ts`（新增，vitest 14 项校验规模/比例/确定性/graphRules/句柄对齐/脱敏）。规模 100/500/1000；每 10 节点一个故事单元，家族比例 beat 30% / scene 20% / dialogue 20% / branch 10% / shot 10% / image 10%；边数 = 规模×0.9−1（含 sequence/branch/attach 三语义与跨单元桥接）；图片节点统一声明 1024×1024、`outputs` 恒空（无真实媒体字节）；窗口 1280×860 下初始 fitView（受默认 minZoom 0.5 限制）相交可见节点 18–22（交互前采样）。
- 脚本：`src/editor/nativeCanvas/canvasPerfScript.ts`（新增）在真实 React Flow 挂载树上派生真实鼠标/滚轮事件——拖拽（2 轮×20 步，目标取中心点在视口内的节点、每轮重取坐标，评审后修正）、平移（2×20）、缩放（2×16，正负交替）、画布控件（逐个点击）；宿主侧（`WebCanvasPerformanceTests`，新增）在脚本运行中切换真实原生面板（检查器 0.6s、侧栏收/展 1.5s/2.2s）。rAF 帧间隔按阶段统计 p50/p95/max/超预算数。
- 内存：`WebProcessMemorySampler.swift`（新增）以公开 proc API（`proc_listallpids`，buffersize 按字节传参 + `PROC_PIDTBSDINFO`/`PROC_PIDTASKINFO`）按「装载前后 WebContent pid 差集」归属本页进程。基线、装载、归属与采样均在 `WebKitTestIsolation` 的同一共享许可内；16 个 WebKit 资源创建/观察套件全部接入（直接创建 WKWebView、挂载 shell 及启动宿主观察），各套件内部也串行。门外调用、空差集或多元素差集均抛错，中止测量；不再以非中止的 `#expect` 继续建立 RSS 基准。反复开关以 5 次完整销毁/重建宿主画布（新窗口 + SwiftUI dismantle → coordinator 失效）采样，有界断言覆盖**周期自有 pid 的累计聚合**（含销毁后仍存活的进程）与**宿主 app 自身常驻内存**，循环后沉降 8 秒再采一次；进程退出按观测记录、不作硬断言（应用侧释放由 dismantle→失效套件保证）。

### 3.2 测量结果（本机，测试套件内，2026-10-15 评审修正轮）

| 规模 | 挂载→节点就绪 | 帧总量 | 总体 p50/p95/max | 拖拽 p50/p95/max（超33ms） | WebContent 内存（前→后） |
| --- | --- | --- | --- | --- | --- |
| 100 | 190ms | 263 | 17 / 18 / 23ms | 17 / 18 / 20ms（0） | 119.5 → 130.7MB |
| 500 | 422ms | 296 | 17 / 26 / 44ms | 17 / 27 / 36ms（1） | 289.3 → 316.0MB |
| 1000 | 1388ms | 333 | 17 / 46 / 84ms | 22 / 62 / 84ms（29） | 436.8 → 465.8MB |

- 本表来自第 17 条修复后的完整原生路由（2026-10-15 14:32–14:34，含失败路径窗口清理复核，基于 `200fef7` 的本地工作区）；此前各轮读数保留在 Git 历史，不与本轮精确数值混用。
- 平移/缩放/面板阶段：p95 18–32ms（1000 规模面板 p95 56ms / max 83ms）。
- 打开/关闭趋势（perf:100 × 5 次完整销毁/重建宿主画布，聚合口径）：周期自有 WebContent 的累计聚合 RSS 为 119.8 → 117.2 → 118.6 → 119.4 → 118.2MB、每次装载采样进程数均为 1，沉降末读为 0MB / 0 进程（观测）。宿主 app 同期为 637.4 → 637.8 → 638.2 → 638.7 → 639.1MB，末读 638.9MB，pre-loop 636.7MB；逐样本双有界均通过。宿主 RSS 包含同进程此前执行的其它套件，不将其绝对值与旧轮孤立测量混比。teardown+2s 每周期仍观察到一个进程，退出时序不作硬断言。对照：同一 WebView 内 5 次 `reload()` 曾测得单调上升（115.6→189.9MB，首轮记录）；重导航与销毁/重建是不同周界，2026-10-17 初始长循环仍增长，后续生产修复与末端趋稳验证见 [§3.5](#35-同视图重导航长循环issue-573)，[#573](https://github.com/hailingu/PlotWeave/issues/573) 的当前结果以该节末为准。
- 帧预算口径：60Hz ≈16.7ms；p50≈17ms 即贴预算运行，over16 计数见测试输出（p95 视角已列上表）。
- 消息频率/体积：演示页无宿主命令（就绪握手与外观推送之外为 0），桥接合并性能不构成本夹具瓶颈。

### 3.3 结论与边界

- 通过（安静环境下的结构性断言，进 CI 套件）：三规模节点/边计数、四阶段齐全、rAF 采样、拖拽位移/平移/缩放行程非零（拖拽目标为视口内可见节点、每轮重取坐标）、销毁/重建周期每个采样点的 WebContent **累计聚合**与宿主 app 内存均有界守卫（各 +400MB 界，含沉降末读）、共享门内每周期只接受单个新进程；进程退出时序按观测记录。
- 退化位置（按 §7.2「压力场景明确退化位置」记录，不计为未通过）：1000 节点拖拽 p95 约 60–70ms（多轮读数 62–70ms 波动，以同轮表格为权威）、超 33ms 帧约 20–29 个——压力规模下拖拽连续性显著退化，优化方向为既有渲染隔离/仅渲染可见元素等（后续任务）。
- 能力边界：WebKit 无 `longtask` 条目（报告 longTasks=null）；单刷新率（60Hz/dpr2）、单机；页面为打包演示入口而非生产编辑会话（无保存链/AI 面板参与）。WebContent 进程归属仍依赖全机 pid 基线差集，要求安静的本机环境；共享门阻止同一测试宿主的其它 WebKit 套件在归因窗口内启动页面，修复 [#575](https://github.com/hailingu/PlotWeave/issues/575) 的宿主内交错路径。若本页复用既有进程，空差集即抛错；多元素差集也抛错。**单元素差集本身不能证明逐页归属**：机器上其它应用不受测试门控制，其启动与本页复用同时发生仍可能误归属；本轮不宣称系统级独占或逐页 PID API。新增 WebKit 套件必须接入同一门；#575 修复收尾后，直接构造类夹具统一经 `IsolatedWebViewFixture.makeWebView`，门外构造即失败（2026-10-18），禁止退回仅依靠 `.serialized`、PID 数量或评审纪律的保证。
- 对比缺口：Tauri 同夹具基线已于 2026-10-17 由 [#572](https://github.com/hailingu/PlotWeave/issues/572) 的本轮共同模式测量补齐（见 §3.4）；2026-10-17 同 WebView 重导航的初始长循环仍增长；[#573](https://github.com/hailingu/PlotWeave/issues/573) 的后续修复及当前验收见 [§3.5](#35-同视图重导航长循环issue-573)。

### 3.4 Tauri 同夹具基线（issue #572）

#### 关键状态与不变量矩阵

| 前置 / 状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方 | 对应验证 / 缺口 |
| --- | --- | --- | --- | --- |
| 日常 `cargo test` 未提供测量 URL | 执行自动发现的测试目标 | 合同测试照常运行；真实 Wry 测量明确跳过，不等待外部服务器 | 常规回归保持自包含；`canvas_performance` 入口 | Rust 完整路由的无环境变量运行 |
| 本地生产画布资源已由 HTTP 伺服，规模为 100/500/1000 | 每规模启动独立 Tauri 子进程 → document-start 计时 → 节点与边全部就绪 → 300ms 沉降 → 同一脚本选项 | 返回版本化脱敏报告，输出 mount、viewport、四阶段帧统计与脚本前后 RSS | 夹具规模、脚本选项和报告口径只能有一个来源；页面 runner 与宿主校验 | URL / 报告合同测试 + 三规模真实 Wry 测量 |
| Swift 与 Tauri 做共同模式对比 | 两宿主顺序执行同一生产 bundle；Swift 收起原生面板且不中途切换，Tauri 不增加宿主操作 | 两边都有 `common-web` 记录；既有 Swift 原生面板压力轮单列 | A/B 不把 Swift 独有面板操作算入 Web 宿主差异；两性能套件 | 两宿主同轮实测；viewport 以页面报告为准，不预设完全相等 |
| URL、规模、页面报告或 JS 执行无效 | 解析配置 / 等待就绪 / 回收 evaluation | 明确错误并以非零状态结束；空载荷、错误载荷不得进入证据 | 配置与报告边界 fail closed；Tauri harness | 合同测试覆盖非法配置、错误结构、空载荷；真实加载失败以宿主导超时兜底 |
| 任一 drag/pan/zoom/panel 阶段或 total 没有 rAF 样本，或 p50/p95/max/over16/over33 缺失、为 null、布尔或为非法负数 / 小数 | 校验 frames，即使效果有效 | 整份报告被拒绝，不输出缺少或无法表示核心指标的宿主对比 | 总体与四阶段必须有独立帧样本、非负时长与无符号精确整数计数；报告校验器 | Rust 空阶段/null/负值/小数合同 + Swift 布尔/小数/负值合成无效帧与打印前抛出回归 |
| version、viewport 或 longTasks 结构无效（包括顶层 longTasks 字段缺失） | 在证据打印前校验元数据 | 拒绝版本漂移、非正 viewport、缺字段、布尔或负值的 longTasks；仅显式 null 表示能力不支持 | 两宿主报告元数据采用同一存在性、正值与结构约束；两宿主校验器 | 合成无效 version/viewport/longTasks（含 CFBoolean）回归 + Rust 缺失顶层字段时拒绝校验和证据格式化回归 + 真实报告 |
| 脚本轮数、步数或节奏需要调整 | 两宿主不携带参数调用 `__pwRunCanvasPerf()` | 页面 runner 的默认值同时驱动 Tauri 与 Swift | 脚本选项只能由 Web runner 拥有；宿主不得各存一份字面量 | 前端默认值行为回归 + 两宿主真实测量 |
| 已归属 WebContent PID 在脚本前或后不可读 / 已退出 | 读取该 PID 或宿主 RSS | 当前规模失败，不写 `webProcesses=0` 的有效证据 | RSS 采样只能成功或显式失败，不能用 0 冒充可读；两宿主对比采样器 | Rust 不可读 PID 合同 + Swift 合成丢失样本回归 + 真实前后采样 |
| 装载前后的 WebContent PID 差集为空或多于一个 | 在脚本运行前尝试归属内存进程 | 中止该规模，不输出可误用的内存对比 | 内存证据只接受单元素差集；采样器与独立子进程边界 | 差集纯逻辑测试 + 真实采样；外部应用不受控制，仍要求安静机器 |
| 页面已挂载后任一步骤失败或超时 | 关闭窗口并退出子进程，随后清理本次新建的应用目录 | 不遗留活跃测量页，不读写用户项目；整轮不得拿部分结果冒充通过 | 生命周期与清理守卫；失败不重试，重测由新轮显式开始 | RAII / `run_return` 路径 + 完整路由；不注入真实系统进程污染 |
| 两宿主取得至少一轮有效记录 | 汇总同机环境、构建修订、三规模数值与 100/500 p95 | 得出交互连续性不低于基线的结论，或列出具体未通过项 | 数值是证据而非 CI 性能阈值；迁移计划 §7.2 与 P5 记录 | PR #585 评审修正轮 100/500 均达标；前一轮 500 总体 p95 的 2ms 未通过保留为历史波动 |

持久化、保存重试和业务请求不属于该内存夹具，不变量维度不适用；测量不改变生产 IPC、存储或数据 schema。共同模式只消除「原生面板中途切换」这一额外变量，不宣称两种窗口外壳像素或布局完全相同。

#### 2026-10-17 PR #585 评审修正轮执行与共同模式结果

- 环境：macOS 27.0.1（26A434）、Apple M4 Max / 64GB、内建 Retina 3456×2234、dpr2；帧 p50≈17ms（约 60Hz，高刷未测）。Node 24.18.0、Rust 1.95.0、Xcode 27.0（27A266a）/ macOS SDK 27.0。
- 代码与资源：`dev` 基线 `67b0e03` 加本分支及 PR #585 评审修正接线；两宿主使用同一次 `PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas` 产物，`native-canvas.js` SHA-256 为 `d53342a5125f7cedfc3373e4eb2a0459d970d34007e40f74ba04b26772dfbee7`。生产 IIFE 经本机 `vite preview` 提供给 Tauri，Swift 从 app bundle 读取同一文件；两宿主均省略脚本参数，由 Web runner 的默认值单一驱动。
- 共同模式：相同 100/500/1000 夹具、边数 89/449/899、相同脚本选项与 300ms 就绪沉降；Swift 原生侧栏和检查器从装载前收起，运行中不切换，Tauri 不增加宿主操作。两宿主顺序执行，未并发测量。
- **`PW-PERF` 机器可读证据合同**：本节及迁移计划 §7.2 要求两宿主输出同一结构，固定 `PW-PERF host=<宿主> mode=<模式> scale=<规模>` 前缀，以及 `mountToNodes`、`visible`、`viewport=<宽>x<高>@<dpr>`、`total`、按 drag/pan/zoom/panel 排列的阶段、`longTasks` 和 `mem[<前> -> <后>]` 字段。合同测试只允许锁定这些机器字段与排列，不断言普通说明文案。
- 执行命令（仓库根目录）：

```bash
PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas
./node_modules/.bin/vite preview --config vite.native-canvas.config.ts \
  --host 127.0.0.1 --port 4173 --strictPort
PLOTWEAVE_CANVAS_PERF_URL='http://127.0.0.1:4173/native-canvas.html' \
  cargo test --manifest-path src-tauri/Cargo.toml --test canvas_performance
xcodebuild -project native/macos/PlotWeaveNative.xcodeproj \
  -scheme PlotWeaveNative -destination 'platform=macOS' \
  -derivedDataPath native/macos/build/DerivedData \
  -parallel-testing-enabled NO \
  -only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests test
```

| 规模 | 宿主 / 模式 | 挂载→节点就绪 | 实际 viewport | 初始可见 | 总体 p50/p95/max | 拖拽 p50/p95/max | WebContent 前→后 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | Tauri / common-web | 178ms | 1280×828@2 | 30 | 17 / 18 / 20ms | 17 / 18 / 18ms | 118.0 → 125.6MB |
| 100 | Swift / common-web | 209ms | 1280×860@2 | 30 | 17 / 18 / 21ms | 17 / 18 / 21ms | 118.9 → 124.1MB |
| 500 | Tauri / common-web | 449ms | 1280×828@2 | 35 | 17 / 20 / 29ms | 17 / 22 / 28ms | 262.6 → 279.9MB |
| 500 | Swift / common-web | 441ms | 1280×860@2 | 35 | 17 / 20 / 35ms | 17 / 18 / 22ms | 286.8 → 292.8MB |
| 1000 | Tauri / common-web | 1470ms | 1280×828@2 | 35 | 17 / 30 / 68ms | 17 / 28 / 43ms | 479.1 → 482.7MB |
| 1000 | Swift / common-web | 1519ms | 1280×860@2 | 35 | 17 / 27 / 87ms | 18 / 27 / 40ms | 436.7 → 457.6MB |

- 常用场景结论：100 的总体与拖拽 p95 两宿主均为 18ms；500 的总体 p95 均为 20ms，拖拽 p95 为 Tauri 22ms / Swift 18ms，p50 也均为 17ms。**PR #585 评审修正轮的 100/500 共同模式 p50/p95 均达到「新宿主不低于 Tauri 基线」**。
- 历史波动与单帧边界：`bffb18e` 首轮曾出现 Swift 500 总体 p95 22ms / Tauri 20ms 的 2ms 未通过格，原始数值保留在该提交，不改写为通过；本轮因评审修正改变代码与资源后重测取得上表，不以重复测量掩盖历史。评审修正轮的 500 总体 max 为 Tauri 29ms / Swift 35ms，over33 分别为 0/1；单轮 p95/max 波动仍不构成 CI 阈值，后续复测应同时检查 p95、max 与 over33。
- 挂载与压力规模：本轮 500 的 Tauri 挂载读数比 Swift 慢 8ms，100 快 31ms，1000 快 49ms；但 Tauri 起点是 document-start 的页面时钟，Swift 起点是宿主 `contentView` 赋值（含 WebContent 创建前段），双方另有约 100ms 轮询量化，所以这些差值不是严格同起点的耗时对比。本轮不为挂载设置通过阈值。1000 的总体与拖拽 p95 为 Tauri 30/28ms、Swift 27/27ms，只记录压力位置，不把单轮差异写成性能承诺。
- 同轮 `native-panels` 压力模式保持独立：100/500/1000 总体 p95 为 18/24/46ms，拖拽 p95 为 18/27/68ms，viewport 均为 1040×860@2。它验证原生面板切换成本，不进入上述共同模式 A/B。
- 内存：两宿主脚本前后 RSS 均按单元素 WebContent PID 差集采集；任一归属进程或宿主 RSS 不可读都使当前规模失败，不写 0 冒充有效证据。绝对值受宿主进程生命周期、viewport 与测试进程历史影响，不做跨宿主 app RSS 排名。本轮只满足 issue #572 的脚本前后记录，不替代 §3.2 的 Swift 销毁/重建周界，也不解决 #573 的重导航长循环。
- 结构断言与失败路径：Tauri 三规模节点/边、四阶段各自 rAF 样本、拖拽/平移/缩放效果均通过；Swift 性能套件 3 tests / 7 参数案例通过（63.142s），含既有内存周界。评审修正轮先有 3 份 Tauri 报告因缺阶段样本被拒绝；窗口居中置顶避免遮挡后取得上表，未放宽校验。非法远端 URL 实测以 `PW_PERF_URL_LOOPBACK_REQUIRED` 和退出码 1 失败，父进程按非零状态拒绝整轮；空 evaluation、错误信封、空阶段、不可读 RSS 和 PID 歧义另有 7 项合同回归。

### 3.5 同视图重导航长循环（issue #573）

2026-10-17 从本地 `dev` 的 `ddbdee7` 创建 `codex/fix-573-reload-memory`。以下初始复现及多轮调查按执行时状态保留，其中“未修复／未验收”描述对应的历史阶段。当前生产修复及完整回归见本节末“生产生命周期修复”：原 100 次守卫已转绿，后 50 次仅 +0.7MiB；#573 的同视图重导航场景通过本轮验收。完整销毁／重建宿主的 §3.2 结论仍不能替代同一 `WKWebView.reload()` 的验收。

#### 关键状态与不变量矩阵

| 前置 / 状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方与入口 | 验证 / 缺口 |
| --- | --- | --- | --- | --- |
| 独占 WebKit 测试许可；perf:100 已就绪 | 固定视图连续 reload 100 次；每次完整渲染后沉降 1 秒 | 逐次记录宿主与 WebContent RSS，末次再静置 15 秒 | 固定夹具、同一归属进程；性能套件与采样器 | `repeatedReloadsRecordLongMemoryTrend`；新增 +400MiB 回归守卫已红，未宣称平台化 |
| 旧文档仍有完整 DOM | reload 前写入旧页探针；等待探针消失、不再 loading，且 100 节点／89 边就绪 | 旧页不能冒充新一轮完成；失败或超时中止 | 就绪属于新文档；测试等待入口 | 真实 WK 重导航已执行；不以旧 DOM 数量单独判断 |
| 重导航进程更换、退出、不可读或差集歧义 | 每轮采样前复核 PID 集合；每份证据要求宿主和归属进程 RSS 可读 | 明确失败，不能用新进程低 RSS 或 0 充当平台化 | 同一进程贯穿趋势；采样器与测试 | 复用既有归属拒绝与丢失进程回归；本轮未主动制造真实进程切换 |
| 正常结束或任一步抛错 | defer 移除宿主内容并关闭窗口，随后释放共享许可 | 夹具不交给下一套件 | 资源归测试所有；挂载与清理入口 | 既有生命周期回归及结构化审查；系统外来 WebKit 应用仍要求安静环境 |
| 样本有效且循环结束 | 每样本及静置末读比较宿主与 WebContent 相对首读的 +400MiB 界 | 暴露宽松界也会被突破；另以末端增量判断是否平台化 | 有界守卫不能替代平台化验收；M15 | 已观察预期失败；尚无能转绿的生产修复，不放宽界或跳过用例 |

本夹具无持久化、模型请求或业务重试，这些维度不适用。进程重启恢复会改变本题的同进程周界，故以明确失败处理，不自动重试。没有施加全机内存压力或调用私有 GC API。

#### 长循环证据与对照

环境沿用 §0：macOS 27.0.1（26A434）、M4 Max / 64GB、dpr2、Xcode 27.0 / SDK 27.0；生产 `native-canvas.js` SHA-256 为 `d53342a5125f7cedfc3373e4eb2a0459d970d34007e40f74ba04b26772dfbee7`。下表的 MiB 均按 1,048,576 字节换算；采样器日志历史标记为 MB。各轮独立启动，不能混比绝对 RSS。标为干净采样的阶段没有运行堆扫描、Inspector 或 vmmap。

- 初次真实 shell 30 次重载：WebContent RSS 117.9→364.2MiB，最后 10 次仍增加约 39MiB；再静置 15 秒为 363.8MiB。该轮 7 个性能参数案例通过宽松守卫，并不满足平台化验收。
- 首次真实 shell 100 次重载：117.5→600.4MiB，静置 15 秒后 599.9MiB；+400MiB 守卫记录 20 处失败。该轮中途执行过 `vmmap` / `leaks`，只作为诊断复现，不用于与干净轮比较内存增量。
- 最终完整原生路由中的真实 shell 100 次干净采样：WebContent RSS 113.4→598.3MiB（第 20/50/90 次为 270.8/393.8/556.1MiB），静置 15 秒为 597.9MiB；宿主 530.7→548.4→548.3MiB，同一归属 PID 始终为 1 个。第 80–100 次和静置末读共 22 处 +400MiB 断言失败，全部属于新增长循环用例。最后 10 次仍增加 42.2MiB，未平台化。
- 独立 AppKit/WKWebView 最小宿主：不使用 SwiftUI、PlotWeave coordinator 或原生服务，加载同一生产 bundle；就绪由页面计数后发送消息，避免用原生 `evaluateJavaScript` 轮询。每轮新文档就绪后等待 100ms，同一基线差集 PID 连续 1,000 次，干净采样如下。最后 100 次仍增加 78.5MiB，静置 120 秒没有回落；中段出现一次明显下降，因此不是严格逐样本单调，但未观测到末端平台。

| 重载次数 / 状态 | WebContent RSS（MiB） | 宿主 RSS（MiB） |
| --- | --- | --- |
| 0 | 115.4 | 80.0 |
| 100 | 795.1 | 80.3 |
| 200 | 1190.6 | 80.4 |
| 500 | 1478.7 | 80.5 |
| 900 | 2276.5 | 80.5 |
| 1000 | 2355.0 | 80.5 |
| 静置 120 秒 | 2354.5 | 80.4 |

- 独立宿主前台置顶、每轮沉降 1 秒，100 次干净采样：WebContent RSS 118.2→606.0MiB；公开 `proc_pid_rusage` 的 physical footprint 145.1→472.5MiB；宿主 94.3→89.5MiB。该阶段结束后才打开 Inspector，后续读数不混入干净采样。
- 静态 DOM 对照（100 个 div、89 条 SVG 边，无 PlotWeave bundle／桥接，各 100 次、就绪后等待 100ms）：无页面脚本且用 navigation delegate 等待时 RSS 29.4→32.1MiB；仅增加原生 JS 探针/DOM 查询后 30.1→59.1MiB；不使用原生 evaluation、改为页面内执行简单赋值与 DOM 查询时 30.1→47.3MiB。说明较小的增长也可在应用外构造，但这些页面不同，不能据此认定与生产页有相同的持有源。

最小宿主为一次性本机诊断程序，未作为产品或新基准设施保留；其数据是本轮观测，仓库内可重复入口是下面的真实 shell 长循环测试。复现实验时须重新固定夹具、就绪方式、等待时间及 PID 归属，不能只比较尾部 RSS。

#### 已排查的边界与剩余工作

显式在非 persisted 的 pagehide 卸载 React 根、首次加载前关闭公开检查器开关、逐次清除 `WKWebsiteDataTypeMemoryCache` 的对照均未消除末端增长；这些实验接线已经撤回，没有作为生产修复提交。临时分配／释放 ArrayBuffer 也未带来回落，但不能据此推断已触发所有 GC 或系统内存压力路径。

前台 100 次之后，`heap` 的原生分配类型统计出现 101 个 HTMLDocument/LocalDOMWindow；Safari 官方 JS 堆快照却只列出 1 个 Document、2 个 Window（约 9.43MB JS heap），官方 Collect garbage 操作后原生类型计数仍未下降。保守引用扫描和分配类型计数不能证明对象仍由强引用持有；当前证据不足以区分真实存活对象、分配器保留与框架缓存。`leaks` 未报告大块泄漏也不能证明不存在跨导航持有。

尚需取得原生对象存活／持有链证据，定位可修复的持有源，并让同视图长循环及完整原生路由转绿。没有把重新创建 WKWebView、改阈值、缩短循环或跳过测试当作修复，也没有修改平台、工具链、生产生命周期或业务合同。当前仅为复现与调查草稿，不能合并为“已修复 #573”。

#### 回收链分层对照（2026-10-17）

本轮按“对象失去引用 → GC／析构 → 分配器复用 → 内存页归还系统”区分假设。实验使用一次性 AppKit/WKWebView 宿主加载上述同 SHA-256 生产资源的 `#perf:100`，窗口 1280×860；没有 PlotWeave 原生服务、项目存储或模型请求。页面起始脚本生成独立 token，在新文档的 100 节点／89 边完成后发就绪消息，不使用原生 JS evaluation 轮询。每次采样要求同一单元素新增 WebContent PID、RSS 与 footprint 均可读；超时、进程更换、歧义归属或 footprint 超过 3GiB 中止。测试顺序由宿主串行执行。

| 前置状态 | 动作与顺序 | 观察判据 | 不变量 / 责任方 | 验证与边界 |
| --- | --- | --- | --- | --- |
| 新进程、固定夹具就绪 | 50 + 50 次重载，分别沉降 100ms；采分配器快照 | 已分配字节与页面相关分配是否随批次累积 | 相同文档规模和 PID；临时宿主 / WebKit 分配器 | `proc_pid_rusage` + `heap` + `vmmap`；诊断轮与干净轮分开 |
| 100 次完成 | 静置 60 秒，再查相同地址和已分配字节 | 若旧批次退出，支持延迟回收；RSS 不下降不能替代此判断 | 不再新增导航；WebKit GC / 原生析构 | 空闲不保证触发所有 GC 路径 |
| 静置后 | 再做 50 次，每次沉降 2 秒 | 降速是否消除同次数的累积 | 新文档就绪与采样规则不变；宿主 | 同进程有历史影响，另以全新进程快／慢对照 |
| 150 次完成 | 导航无应用 bundle 的本地空白页，等待 30 秒 | 旧地址是否退出、占用是否回落 | 页退出与内存页释放分别观察；WebKit | 空白页仍注入同一文档探针；跨 URL 导航可进入页面缓存 |
| 空白页后 | 再载相同夹具并重载 50 次，静置 10 秒 | 先前空间是否足以复用、旧地址是否继续保留 | 同一进程；WebKit 分配器 | 快照地址相同不能排除期间释放后同地址重用 |
| 两个全新进程 | 各 50 次，分别沉降 100ms / 2 秒，随后静置 60 秒 | 隔离节奏对积压量的影响 | 趋势采样完成前不运行堆扫描或 profiler；宿主 | 每臂一次，不能当作重复测量的统计结论 |

本轮只改变重载节奏与页面生命周期。没有业务持久化、网络、连接池或外部依赖；这些维度不适用，也没有施加全机内存压力或调用私有 API。

诊断轮同一 PID 的采样如下。它运行过 `heap`、`vmmap` 和 Instruments 附加尝试，**不作为干净性能基线**。MiB 按 1,048,576 字节换算；“已分配”及“碎片”来自 `vmmap -summary` 的 WebKit Malloc zone，不能分别等同于业务存活对象与全部可归还空间。

| 检查点 | RSS（MiB） | footprint（MiB） | WebKit 已分配（MiB） | zone dirty+swap 碎片（MiB） | HTMLDocument 分配数 | 最早 101 个地址仍出现 |
| --- | --- | --- | --- | --- | --- | --- |
| 首次就绪 | 117.5 | 148.9 | 未扫描 | 未扫描 | 未扫描 | 不适用 |
| 快速重载 100 次 | 707.4 | 593.3 | 349.2 | 62.4 | 101 | 101 |
| 静置 60 秒 | 706.9 | 484.3 | 349.2 | 62.4 | 101 | 101 |
| 降速再重载 50 次 | 862.2 | 680.1 | 508.0 | 71.0 | 151 | 101 |
| 空白页并静置 30 秒 | 861.7 | 622.9 | 495.7 | 74.4 | 152 | 101 |
| 再载夹具、重载 50 次、静置 10 秒 | 967.7 | 905.4 | 681.6 | 90.6 | 203 | 101 |

每行 RSS/footprint 在检查点先读，随后才扫描分配器，不是原子快照；扫描会改变常驻状态。100 次后首个 `vmmap` 已报告 footprint 484.3MiB，随后 60 秒末仍为 484.3MiB，因此不能把全部 109MiB 下降归因于等待 60 秒。两份 VM 快照中 WebKit zone 的已分配／脏页／碎片几乎不变；同时 graphics owned-unmapped resident 从 141.0 降到 35.6MiB，提示其他页类别发生了变化，不证明旧 DOM 已回收。空白页阶段已分配下降约 12.3MiB，但最早记录的 101 个 HTMLDocument 地址全部保留；重新加载后已分配空间再增加约 185.9MiB，未观察到整个工作集进入可重复复用的平台。

`heap --sortBySize --noContent` 在 150 次后报告约 511.1MiB 的总分配，其中可识别类型包括 67,652 个 SVGPathElement（约 19.6MiB）、128,387 个 HTMLDivElement（约 17.6MiB）、126,840 个 HTMLSpanElement（约 17.4MiB）；它们是分配器枚举及类型识别结果，尚未建立每个对象的真实持有链。不能把 native 分配地址的保留直接升级为强引用泄漏结论。

尝试用 `xcrun xctrace record --template Allocations --attach <本轮PID> --time-limit 3m --no-prompt` 获取实际分配／释放事件；保存结束后工具退出 2，明确报告 `Target process is marked restricted and cannot be traced while System Integrity Protection is enabled`。因此没有可用的 malloc/free 事件历史，不能证明地址期间从未释放或排除同地址重用。未修改 SIP；`heap --addresses=WebCore::HTMLDocument --noContent <PID>` 和 `vmmap -summary <PID>` 仅提供离散快照。

两个全新宿主的干净趋势对照如下。每组先采完初始点、50 次重载及空闲末读，再运行堆与 VM 扫描；两组无 Instruments 附加。每次就绪后分别等待 100ms / 2 秒；整批耗时为 9.57 / 109.53 秒，约相差 11.4 倍。空闲配置为 60 秒，实际墙钟均约 63.6 秒（定时器调度和循环开销），不是精确 60 秒。

| 组别 | 初始 RSS / footprint（MiB） | 50 次后 RSS / footprint（MiB） | 空闲后 RSS / footprint（MiB） | 随后扫描 WebKit 已分配（MiB） | zone 碎片（MiB） | HTMLDocument 分配数 |
| --- | --- | --- | --- | --- | --- | --- |
| 快速，100ms | 113.7 / 145.5 | 479.6 / 495.3 | 479.1 / 301.7 | 204.0 | 45.1 | 51 |
| 慢速，2 秒 | 114.9 / 149.5 | 505.1 / 248.3 | 504.7 / 243.3 | 206.3 | 42.0 | 51 |

两组重载的 `pagehide.persisted` 均为 false，每组 50 次旧文档 token 各不相同；固定 PID、完整 1–50 循环和非零内存读数的结构校验通过。快组空闲后 footprint 下降约 193.6MiB，但 RSS 仅下降约 0.4MiB；慢组即时 footprint 较低，空闲后仍比初始高约 93.8MiB。两组最终 WebKit zone 的 allocation count 分别为 1,807,513 / 1,807,171，已分配约 204.0 / 206.3MiB，dirty 约 248–249MiB，文档分配数均为 51。单次实验表明节奏明显影响瞬时 footprint，但约 11 倍的降速没有消除分配器口径的累积；不能仅凭 RSS 平直认定完全没有回收，也不能只用空闲页保留或碎片解释新增的已分配字节。

据此，下一步优先追踪旧页面相关原生分配的释放条件与持有者；本轮未支持“仅数秒级回收滞后，降速即可消除累积”的解释；更长或条件触发的 GC／延迟释放仍未排除。这里没有取得强引用链或析构／free 事件，不能最终区分真实存活、等待回收和子分配器延迟释放，也未验证所有系统版本或达到数学意义的无界增长。每臂只执行一次，绝对 RSS 或 footprint 的组间差异不作为统计性能承诺。

本次临时程序通过 `xcrun swiftc -swift-version 6 -warnings-as-errors ... -framework AppKit -framework WebKit` 编译；诊断 200 次和干净对照各 50 次，共 300 次重载完成，正常清理三个自有宿主。语义校验覆盖固定 PID、新文档、精确循环、非零采样和诊断地址交集，均通过；Instruments 追踪失败单独记录，未冒充通过。未改生产源码或版本化测试，本次不重跑完整原生套件，以下既有失败状态保持不变。文档经过矩阵到实测结果的结构化审查、Prettier 与 `git diff --check`；一次性可执行文件、trace、日志及模块缓存在记录结果后清理。

#### 具名对象与组件回收追踪（2026-10-17）

本轮进一步按“具体对象是否还活着、通过什么路径被保留”检查。一次性 Vite 入口直接加载现有 `NativeCanvasApp`、100 节点／89 边夹具及样式，使用生产 React；只在临时构建中插入探针，未改生产源码或依赖。它与上轮原封不动的生产资源实验不同：入口增加可重复 `createRoot → render → root.unmount → root=null` 的控制，省去正式入口的部分职责，bundle 未压缩，因此绝对内存不能作为生产基线。临时 AppKit/WKWebView 宿主保持 1280×860、固定单个 WebContent PID、非零 RSS/footprint、单操作超时与 3GiB footprint 中止规则；只传递 JSON 字符串，不把 DOM／store 对象传给原生或检查器控制台。

| 前置状态                | 动作与顺序                                                        | 观察判据                                         | 不变量 / 责任方                                                   | 实测与边界                                                             |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 同一文档、每轮全新夹具  | 挂载并确认规模，卸载后等待 120ms，再独立任务采样                  | store、图数组、DOM、组件标记的弱引用与 finalizer | 探针仅持有 WeakRef、弱键和字符串元数据；临时入口 / React 生命周期 | 共 120 轮，最终 11 类各 120 个目标均回收；标记不能代表所有 React Fiber |
| 已知持有／释放对象      | 强持有阳性对照，立即释放阴性对照；随后清空阳性引用                | 弱引用结果与快照 GC root 路径相符                | 探针不能自持有目标；诊断工具                                      | 阴性回收；阳性经 Window 属性持有，清空后回收                           |
| 每轮卸载完成            | 统计 window/document 监听、timer、RAF、Observer                   | 是否随轮数增加活动资源                           | 弱记录不能反向持有回调／Observer；资源包装器                      | 最终只有一个页面级 selectionchange 监听；一次性监听不作残留判断        |
| 新进程、相同诊断 bundle | 每页挂载→卸载→reload；与从不挂载组各 20 次对照                    | 原生 Document 分配是否随导航累积                 | 每次新 token、pagehide.persisted=false、同一 PID；宿主            | 均通过结构校验；跨 realm 后不再用旧页 finalizer 判漏                   |
| 卸载前仍有 Observer     | 先显式 disconnect 全部三个 Observer，再卸载／重载 20 次           | 与普通卸载组比较原生分配数                       | 每页恰好三次 disconnect、观察目标归零；临时包装器                 | Document 仍为 21，不支持该条件单独足以解决                             |
| 检查器连接、卸载完成    | 每页最多三次快照与独立任务采样；11 类均回收且无活 Observer 才导航 | 禁止把未确认回收的页面纳入成功对照               | 有界确认与失败即停；临时驱动                                      | 5 次确认后导航，第 6 页未满足而停止；不是完成了 20 次的实验            |

追踪的 11 类为 React Flow store、nodeLookup、edgeLookup、组件生命周期标记、editor、nodes 数组、edges 数组、nodeEditApi、canvas DOM、首个节点 DOM 和首条边 DOM。每个目标附一个非枚举诊断标记；WeakRef/FinalizationRegistry 的元数据只保留字符串。50 轮首次采样各类尚有最近 3 个目标存活，稍后全部回收；100／120 轮即时采样各剩最近 1 个，后续快照与独立采样也全部回收。最终 1,320 个目标均弱引用清空且收到 finalizer，360 个 ResizeObserver 的弱引用全部清空，mount/cleanup 为 120/120，根容器为空、节点／边 DOM 数为 0，外观回调为 undefined。没有发现这些被追踪目标在同文档内按代累积。

资源探针只覆盖 window/document 上非 once 监听、timer、RAF 与三类 Observer，不代表所有资源。最终活动 timer/RAF 均为 0；唯一留下的是首次 React 根创建时安装的 document selectionchange 委托监听，此后 120 轮数量不变。Observer 元数据的历史 targets 数即使为 1，也不能推翻其 WeakRef 已清空的结果。阳性对照在 100 轮后的快照中有明确路径 `GC root → Structure → Window.__pwStrongControl → Object`；清空属性后弱引用与 finalizer 均确认回收。阴性对照也回收，说明探针能够区分已知持有与已知释放。

导出的 Web Inspector v3 堆图按[官方节点／边格式](https://github.com/WebKit/WebKit/blob/main/Source/WebInspectorUI/UserInterface/Workers/HeapSnapshot/HeapSnapshot.js)校验引用 ID，并遍历 GC root 路径。100 轮与沉降后的 120 轮快照可见对象 selfSize 合计为 8,388,287／7,825,867 字节；Array 类节点均为 151、Map 均为 15。WeakRef 节点从 1,404 增至 1,684，恰好对应新增 20×(11 个目标 + 3 个 Observer) 的探针记录；它们保留弱引用容器和字符串元数据，不表示业务目标仍活着。后份快照已没有目标的诊断标记边。这个诊断台账本身会增长，不能直接把总 Object／string 节点增长判成应用泄漏。

检查器确认回收的跨导航对照得到一个具体的暂存候选。首个试跑在第二页一次快照后未能确认全部回收而停止，额外快照后清空；独立重试限定每页最多三次，前 5 页均满足全部目标回收才导航，第 6 页仍剩 nodes／edges 数组而触发 `PW_GC_NOT_CONFIRMED`。第三次快照捕获的具名对象路径包括 `GC root → FunctionCodeBlock → JSLexicalEnvironment → initialState → nodes/edges`，以及同一 initialState 的 nodeLookup／edgeLookup；部分 DOM 的最短路径仅到内部根，未给出原生持有者。随后独立采样中 lookup／DOM 已回收，数组仍存活；再取一次快照后，数组也弱引用清空且收到 finalizer。依赖中的 Zustand 确有 initialState／getInitialState 闭包，但该路径只能证明快照时的保留，不能证明应用永久强持有、JIT 根的具体来源或该闭包就是 #573 根因。此次没有放宽失败判据、继续把它计作完整 20 次成功实验。

三个未连接检查器的全新宿主对照如下，先完成趋势采样再运行 `heap --sortBySize --noContent <PID>` 与 `vmmap -summary <PID>`。MiB 按 1,048,576 字节换算；每臂一次，未追加本轮长时间空闲测量，不作统计性能承诺。

| 20 次重载的操作                                         | 初始 RSS / footprint（MiB） | 末读 RSS / footprint（MiB） | 随后 WebKit 已分配（MiB） | HTMLDocument 分配数 |
| ------------------------------------------------------- | --------------------------- | --------------------------- | ------------------------- | ------------------- |
| 加载 bundle，从不挂载画布；用两次 report 对齐控制调用数 | 38.4 / 41.1                 | 69.2 / 61.2                 | 10.0                      | 1                   |
| 每页挂载后显式 React 卸载                               | 42.1 / 40.4                 | 244.4 / 206.8               | 45.6                      | 21                  |
| 卸载前 disconnect 全部三个 Observer                     | 38.5 / 41.1                 | 226.5 / 237.0               | 45.0                      | 21                  |

三组均有 21 个不同 boot token、20 次 pagehide.persisted=false、固定 PID 与完整规模／清理校验；挂载两组各有 2,400 个 SVGPathElement、4,202 个 HTMLDivElement 和 4,200 个 HTMLSpanElement 原生分配，从不挂载组为 0／2／0。检查器连接的部分对照在第 6 页停止时仍有 6 个原生 HTMLDocument 分配，虽然前 5 次导航前这些具名 JS 目标和 Observer 已确认回收。检查器、导航时序和覆盖范围均有限，不能据此排除所有未追踪 JS 对象，也不能把这些原生计数直接升级为真实强引用泄漏。

同文档组的原生 HTMLDocument 在 50／120 轮均仅为 1，地址相同；但 WebKit zone 已分配仍从 51.1 增至 88.8MiB，最终诊断 RSS/footprint 为 521.0/117.4MiB。它包含探针、检查器和分配器扫描影响，证明“部分具体对象已回收”与“RSS 回落”不是同一判据，也不证明全部原生分配已经释放。结合无检查器的重载组，下一步应缩小触发跨导航原生 DOM 分配保留的最小组件／渲染路径，并取得原生持有或释放事件；尚没有依据提交全局 disconnect、强制 GC 或改写 Zustand 的生产修复。上一轮 SIP 阻止分配事件追踪的缺口保留，本轮未修改系统保护或重试 Instruments。

本轮一次性宿主经 `xcrun swiftc -swift-version 6 -warnings-as-errors ...` 编译，Vite 构建通过；日志语义校验覆盖 120 轮计数、11 类目标的弱引用／finalizer、资源基线、对照对象引用链、三组 20 次导航及部分 GC 对照的失败即停，均符合各自判据。部分 GC 对照明确未完成目标轮数。诊断 bundle SHA-256 为 `3f331eaba63b70485e836e331023e76c0e73520f21edb329d6e091738fa1624f`，用于区别本轮资源与上轮生产资源；一次性入口／宿主、堆图、日志与模块缓存在记录结果后删除，自有宿主正常退出。没有改生产源码或版本化测试，本轮未重跑完整原生套件；#573 仍未修复，PR #586 保持调查草稿。

#### 分层渲染触发条件对照（2026-10-17）

本轮目标是缩小跨导航原生分配保留的触发条件，沿用 #573 的 P3 定位，不将候选升级为生产修复。macOS 27.0.1（26A434）、Xcode 27.0（27A266a）、Swift 6 语言模式；一次性 AppKit/WKWebView 宿主与生产 React 构建直接加载现有组件和依赖。每臂全新宿主，1280×860、相同页面与样式；各版本 bundle 内包含相同的应用模块，按模式选择挂载内容，没有调用正式入口的诊断初始化。它不是原封不动的生产入口，未压缩 bundle 的绝对内存不能与前轮生产资源直接比较。

| 前置状态                               | 操作与事件顺序                                                                                    | 预期可观察结果 / 不变量                                          | 责任方与验证结果                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 全新宿主、未挂载                       | boot 记录 token、单元素新增 WebContent PID 和非零 RSS/footprint                                   | 同一臂不更换 PID；不同文档不复用 token                           | 临时宿主；20 臂均通过，仍以本机无外来进程干扰为前提                               |
| 各渲染模式                             | mount→规模就绪→120ms→unmount→120ms→reload，共20轮                                                 | 每页挂载／清理1/1；根为空、节点／边归零；非空模式确实提交根DOM   | 临时入口和驱动；400轮通过，最终第21页未挂载                                       |
| 有节点的 Flow 已复现                   | 同 bundle 下以空 Flow 对照；只改 nodesDraggable=false                                             | 不把边、业务组件或实际拖拽误判为必要触发条件                     | 默认节点3次独立进程均为21个Document，空Flow两次均为2；关闭拖拽仍为21              |
| 监听器分配偏多                         | 普通 DOM 的 onclick 与 React 的 onClick 各加共享空回调，无实际点击                                | 只诊断回调初始化，保留相同卸载、导航和对照                       | 原生／React分别为1／4个Document；未重现21个累积                                   |
| 尺寸读取／观察                         | 原生100节点读rect与computed width；另一臂RO确认100个交付后，卸载前逐个unobserve、disconnect并置空 | 每页实测100次有效尺寸读取或至少100个有效RO条目；清理入口执行完整 | 两臂20轮均通过，Document分别为1／3；未等同于Flow完整测量／状态更新路径            |
| 趋势结束                               | 先末读内存，再执行heap和vmmap                                                                     | 检查器／堆扫描不进入趋势；只传JSON原始值，不暴露DOM或store引用   | 20臂共420个唯一boot、400次pagehide.persisted=false；无检查器、WeakRef台账或强制GC |
| 异常／超时／PID歧义／footprint超过3GiB | 中止当前臂，退出自有宿主                                                                          | 部分或无效结果不计作完成20轮                                     | 一次入口未boot的早期构建试跑因启动超时排除；修正构建后全部有效臂完整重跑          |

下表每行都是独立宿主的一次20轮运行。所有初读 RSS 为37.7～38.3MiB、footprint为40.2～40.8MiB；从启动到末次干净采样耗时12.39～14.96秒，扫描耗时不在其中。末读先于原生扫描，两个口径不是原子快照。“WebKit已分配”是vmmap的BYTES ALLOCATED，不是zone保留地址空间、allocation count或全部业务存活字节；M按MiB记录。

| 渲染模式                              | bundle | Document分配数 | JSEventListener分配数 | WebKit已分配（MiB） | 末读RSS / footprint（MiB） |
| ------------------------------------- | ------ | -------------- | --------------------- | ------------------- | -------------------------- |
| 仅加载 bundle                         | v1     | 1              | 4                     | 10.2                | 60.1 / 60.8                |
| 原生 DOM 100 节点                     | v1     | 1              | 4                     | 10.9                | 60.6 / 80.0                |
| 空 React 根                           | v1     | 1              | 4                     | 11.6                | 64.0 / 64.3                |
| React 普通 100 节点                   | v1     | 2              | 4                     | 12.5                | 75.5 / 85.8                |
| 空 React Flow                         | v1     | 2              | 9                     | 19.6                | 72.9 / 83.3                |
| 完整 NativeCanvasApp，100 节点／89 边 | v1     | 21             | 4533                  | 94.0                | 234.2 / 207.0              |
| 原生 DOM 100 节点＋89 SVG 路径        | v1     | 1              | 4                     | 10.8                | 67.1 / 81.5                |
| 默认 Flow 100 节点，无边              | v1     | 21             | 4109                  | 66.0                | 158.5 / 186.8              |
| 默认 Flow 100 节点＋89 边             | v1     | 21             | 4198                  | 54.1                | 166.1 / 168.1              |
| 空 Flow 复测                          | v2     | 2              | 9                     | 19.3                | 71.6 / 84.9                |
| 默认节点复测                          | v2     | 21             | 4004                  | 53.9                | 152.2 / 180.7              |
| 默认节点，关闭拖拽                    | v2     | 21             | 4109                  | 64.6                | 155.4 / 169.7              |
| 原生 DOM 复测                         | v3     | 3              | 4                     | 10.9                | 63.2 / 82.0                |
| React 普通节点复测                    | v3     | 3              | 4                     | 22.1                | 77.4 / 81.7                |
| 原生 DOM，onclick 空函数              | v3     | 1              | 4                     | 11.1                | 67.3 / 79.9                |
| React 普通节点，onClick 空函数        | v3     | 4              | 204                   | 12.4                | 79.5 / 82.9                |
| 原生 DOM 再复测                       | v4     | 1              | 4                     | 11.0                | 64.8 / 82.9                |
| 原生 DOM，尺寸与样式读取              | v4     | 1              | 4                     | 10.9                | 64.6 / 83.0                |
| 原生 DOM，ResizeObserver              | v4     | 3              | 4                     | 10.9                | 65.7 / 76.4                |
| 默认节点再复测                        | v4     | 21             | 4109                  | 63.1                | 156.3 / 162.1              |

四次有效构建的 SHA-256 如下；v2～v4每次扩充因子后都在新bundle内重跑相应控制，旧进程全部退出后才重建。模式和参数仅存在于临时入口，没有修改生产组件或依赖。

- v1：`c8f358ad6d1d3bb07d3837e8e6213a1188f1125c6e73a43d455bd77d49537b19`。
- v2：`af66fdb5cfc9ccd10a1b6aec75153eb6627f594f123dcefbb3ce03d78c552d3b`。
- v3：`f948286f51f1593b18b105336be54586cbb940fe5f563c0064375cad9535cba0`。
- v4：`cd178d03a6ddc1017eaa52d11fe1c8d2c06d6f615e1c7d14c52dcd5f3cd199ac`。

本轮把“足以复现分配保留”的范围缩到 React Flow 默认节点路径：不需要挂载应用自定义节点、NativeCanvasApp生命周期／性能钩子，也不需要边、背景、控件或实际拖拽。默认100节点无边的三次Document均为21，HTMLDivElement分别为4,116／4,002／4,116；对照空Flow的Document均为2、Div均为16。普通DOM、React普通元素及纯SVG在本轮快照中剩1～4个Document，并非全部立即回收，但没有出现Document数达到21的模式。完整画布仍为21，因而没有通过缩小入口把原现象一起消掉。

监听器数量、简单尺寸API和ResizeObserver均未独立给出足够解释。关闭节点拖拽仍为21个Document，说明该默认拖拽初始化条件不是本轮必要项；简单点击回调、尺寸读取和已显式清理的原生RO未重现同样模式，不能进一步推导所有监听、Observer或测量状态都已排除。依赖中的NodeWrapper、Handle、useNodeObserver和updateNodeInternals仍共同存在于有节点的路径，尚未拆开。尤其不应因JSEventListener约4千就直接认定它是持有根：该计数没有表达引用方向，也没有给出创建／销毁历史。

原理边界仍是两层生命周期：[WebKit的JS wrapper说明](https://docs.webkit.org/Deep%20Dive/Architecture/JSWrappers.html)区分JS包装对象与C++实现对象；C++存活本身不保证对应JS包装对象存活，反向可通过包装对象的引用计数保留C++对象。因此，上轮具名JS对象回收与本轮原生类型分配保留可以同时出现；本轮没有跨realm弱引用追踪，不能把上轮同文档结果套用到这里的每个旧页。原生快照仍不足以区分真实持有、等待GC／析构和子分配器延迟释放。未取得malloc/free历史或C++持有链，不宣称已找到WebKit、React或Flow的具体缺陷。

下一步最小二分应比较“默认节点含Handle”与“相同NodeWrapper下只渲染静态内容的自定义节点”，再根据结果拆Handle子树或节点观察／内部尺寸更新；保留空Flow和默认节点的独立进程控制。拿到触发后仍须确认原生释放条件，才选择保留交互能力的生产修复。本轮没有全机内存压力、延长空闲或其他系统版本对照；无业务网络、存储、锁、连接池或下游负载，吞吐、排队、CPU和I/O不属于本次目标。每臂一次，只有关键控制做独立复测，不作统计性能承诺。

验证：一次性宿主通过Swift 6 `-warnings-as-errors` 编译，四份有效Vite生产构建通过；日志语义校验覆盖20个正常退出的宿主、400轮挂载／卸载／导航、420个唯一文档、逐页规模和空根、固定PID、非零内存、测量／RO交付判据。结构化审查核对矩阵到结果、vmmap列含义、控制版本和结论边界；文档没有配置的自动化语义检查。临时入口／宿主、模块缓存、堆扫描和日志在记录结果后清理。没有修改生产源码或版本化测试，本轮未重跑完整原生套件；下述既有失败仍未解决，#573和PR #586继续保持未修复／调查草稿状态。

#### Handle 子树与端口测量对照（2026-10-17）

目标是继续缩小上轮默认节点路径的触发条件。沿用本机 macOS 27.0.1 / Xcode 27、生产 React 与同一应用模块集合，使用一次性 Swift/WKWebView 宿主和合成节点，不改生产源码、依赖或版本化测试。本轮仍按 #573 的 P3 极端重载场景调查，尚未确认普通使用影响或完成修复。

先在同样的自定义节点类型、NodeWrapper、100 节点布局和固定节点样式下，仅比较标签与“标签＋两个真实 Handle”；然后用普通 DIV 复刻 Handle 的稳态 class、data 属性与顺序；最后保留端口样式，仅去掉供 Flow 识别端口的 `source/target` 类。新增入口和探针均先记录矩阵，再执行；每次扩充 bundle 后重跑相关控制。所有组均无边，不实际点击或拖拽。

| 前置状态                                  | 动作与顺序                                                             | 不变量／责任方                                                                            | 验证结果或缺口                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 每臂新宿主                                | 初读→20 次 mount、120ms 等待、unmount、120ms 等待、reload              | 临时宿主逐次检查唯一新增且固定的 WebContent PID、非零 RSS/footprint；安静环境归属前提保持 | 16 个独立宿主共 320 轮；每臂 21 个唯一 boot、20 次 pagehide.persisted=false、正常退出           |
| 挂载完成                                  | 确认实际节点正尺寸、端口 DOM 数、store 的 connectOnClick               | Flow 初始化已完成；临时入口仅返回 JSON 原始值                                             | 各非空组 100 个节点、0 边；静态组 0 端口，真实／仿制端口组 200；关闭点击组逐页确认 onclick 为空 |
| 同一自定义节点                            | 保留 NodeWrapper、观察／拖拽基础设施与固定 style，只改变子树           | 节点包装与清理路径保持一致；临时组件负责                                                  | 静态节点三次 Document 均为 2；真实 Handle 为 21，关闭点击仍为 21                                |
| 普通 DIV 端口                             | 不使用 Handle 组件、hooks、订阅或端口回调，另组仅补空 mouse/touch 回调 | v2 起逐页确认 nodeLookup 内 handleBounds 总数 200；测量已实际完成                         | 无事件与空回调组均为 21；不据此排除 Flow 其他组件和全局事件                                     |
| 相同端口样式                              | 仅去 source/target 类，保留两个端口 DIV、其余 class/data 与标签        | v3 每页仍有 200 个端口 DOM，但 handleBounds 为 0；合并 CSS 中两类均无样式规则             | 同 bundle 两次完整对照均为 21→2；不是视觉／连线功能验收                                         |
| 卸载与末页                                | React cleanup→空根→导航；最后先读内存再做 heap/vmmap                   | mount/cleanup=1/1；root、节点、边、端口归零，flow/store 引用清空；扫描不进入趋势          | 320 轮语义校验通过；末页未挂载，累计 336 个唯一 token；没有检查器、弱引用台账或强制 GC          |
| 失败、超时、PID 歧义、footprint 超过 3GiB | 中止并退出自有宿主                                                     | 无效或部分运行不计为完整结果                                                              | 本轮有效运行均完成；未故意制造崩溃／不可读 PID 等失败，本轮守卫不是故障注入回归                 |

下表每行各重载 20 次，均为独立宿主。Document 与 LocalDOMWindow 分配数逐行相同；Div 和监听器也是 heap 的原生分配计数。WebKit 已分配取 vmmap 的 BYTES ALLOCATED，M 按 MiB 记录，不是 zone 地址空间或 allocation count。末读早于两项原生扫描，口径并非原子快照；绝对内存不与正式生产资源入口混比。

| 渲染模式                           | bundle | Document | Div   | JSEventListener | WebKit 已分配（MiB） | 末读 RSS / footprint（MiB） |
| ---------------------------------- | ------ | -------- | ----- | --------------- | -------------------- | --------------------------- |
| 空 Flow                            | v1     | 5        | 46    | 19              | 19.6                 | 84.4 / 91.5                 |
| 默认节点                           | v1     | 21       | 4,116 | 4,109           | 76.6                 | 158.1 / 185.0               |
| 自定义静态节点                     | v1     | 2        | 116   | 109             | 33.6                 | 94.0 / 124.0                |
| 自定义真实 Handle                  | v1     | 21       | 4,004 | 4,004           | 76.8                 | 163.3 / 190.7               |
| 默认节点，关闭点击连接             | v1     | 21       | 4,116 | 109             | 73.5                 | 155.5 / 186.6               |
| 自定义 Handle，关闭点击连接        | v1     | 21       | 4,002 | 4               | 55.2                 | 157.9 / 187.6               |
| 静态节点复测                       | v2     | 2        | 116   | 109             | 32.4                 | 93.5 / 120.6                |
| 真实 Handle，关闭点击复测          | v2     | 21       | 4,116 | 109             | 75.1                 | 156.0 / 185.1               |
| 普通 DIV 端口，无端口事件          | v2     | 21       | 4,116 | 109             | 72.5                 | 152.7 / 183.8               |
| 普通 DIV 端口，空 mouse/touch 回调 | v2     | 21       | 4,004 | 4               | 70.1                 | 157.1 / 188.8               |
| 静态节点再复测                     | v3     | 2        | 116   | 109             | 34.3                 | 95.8 / 121.0                |
| 普通 DIV 端口，无端口事件          | v3     | 21       | 4,116 | 109             | 72.6                 | 150.8 / 181.3               |
| 相同端口去 source/target 类        | v3     | 2        | 316   | 109             | 27.8                 | 96.9 / 124.9                |
| 普通 DIV 子元素去全部 class        | v3     | 3        | 630   | 214             | 32.8                 | 108.3 / 126.9               |
| 普通 DIV 端口独立复测              | v3     | 21       | 4,116 | 109             | 70.6                 | 150.8 / 179.9               |
| 去 source/target 类独立复测        | v3     | 2        | 316   | 109             | 27.7                 | 99.9 / 124.1                |

三份有效 Vite 生产 bundle 的 SHA-256 分别为：

- v1：`2c4f1e5a63c085e1d2d15a8df436eed8f5749cf7c3c721a8d590b348d7f9397a`。
- v2：`62228e930be7800b2379cf06f4133683f1c33f38aab26d667a18d95470066381`。
- v3：`c47abada27bca4191e606e2df47edd7bd620ff4d281536232d6254e5212400d4`；最后两臂复测未重新构建。

本轮最窄的有效差异是**端口是否被识别并进入测量**：静态节点为 2；真实 Handle 和普通 DIV 仿制端口均为 21；仿制端口去掉 source/target 类后为 2，独立复测保持差异。普通 DIV 子元素去掉全部 class 的组为 3；空 Flow 本轮为 5，比上轮的 2 更高，不能当成完全回收的零基线。各组的小幅残留和 RSS 不回到初值仍需与跨导航的 21 个 Document 模式区分；本轮不是长时间平台化或统计性能证明。

点击连接和 Handle 内部订阅不是本轮现象的必要条件。自定义 Handle 关闭点击后，JSEventListener 从 4,004 降到 4 而 Document 仍为 21；在新 bundle 复测时监听器为 109，Document 仍为 21。无 Handle 组件、无端口事件回调的普通 DIV 也重现了 21。监听器计数随残留对象、时序和采样变化，不能据此指定监听器为持续持有根；关闭点击也没有修复 Document 累积。

对本地已安装依赖的检查进一步定位到 `@xyflow/system` 的 `updateNodeInternals → getHandleBounds`：该函数分别对节点执行 `.source` / `.target` 的 querySelectorAll，再遍历命中端口，读取 getBoundingClientRect、getAttribute 和尺寸，返回数值／字符串组成的 bounds。去类组仍完成节点本身的尺寸测量，端口集合不再命中，传入 Flow 的端口 bounds 从 200 条变为 0 条。因此，**端口 DOM 查询、集合／元素包装、矩形／尺寸读取或后续状态更新**是下一步应拆的候选范围；本轮改变的是 class，尚未单独替换测量函数或排除所有 DOM class 处理差异，不能直接认定 bounds store、某个 DOM API、React 或 WebKit 已被证明有缺陷。没有直接持有 DOM 的 bounds 字段，也不等于所有临时包装或调用栈已完成释放。

下一步以此处为最小入口，保持实际端口交互不变，先做 querySelectorAll／集合遍历与逐端口几何读取的分层对照，再判断是否需要跨 realm 包装对象及原生释放链追踪。删除端口类会影响连线识别，禁用交互或保留错误尺寸都不作为生产修复。本轮仍没有 malloc/free 历史或 C++ 持有链，无法区分持续引用、等待 GC／析构与分配器延迟释放；此前同文档具名 JS 对象回收的结论不外推到本轮每个旧页。

验证：临时宿主通过 Swift 6 `-warnings-as-errors` 编译，三份有效 Vite 生产构建通过；16 个宿主／320 轮／336 个唯一文档的日志语义审计通过，宿主均正常退出。结构化审查核对矩阵到结果、各 bundle 控制、测量判据和 vmmap 列含义；文档没有配置的自动化语义检查。一次性资源、脚本、模块缓存、堆扫描和日志在记录后清理。无业务存储、网络、锁、连接池或下游负载，吞吐、排队、CPU 和 I/O 不属本轮目标；未改变 SIP、使用私有 API 或施加全机内存压力。没有改生产或版本化测试源码，未重跑完整原生套件；下述既有失败继续保留，#573 与 PR #586 仍未修复／未验收。

#### 端口查询缓存与卸载前失效对照（2026-10-17）

本轮继续拆分上节的端口测量路径，成功标准是保持端口 DOM 不变，分别检验原生查询、遍历、几何读取与 bounds 写入，并找到可独立复测的释放条件。当前分类为调查证据，仍沿用 #573 的 P3 极端重载范围；没有修改生产源码、版本化测试或依赖，也没有确认普通使用影响。环境为同一 macOS 27.0.1 / Xcode 27；本机 WebKit.framework 的 CFBundleVersion 读数为 `22625.1.29.11.28`。

先用三份一次性 Vite bundle 保留相同应用模块集合和生产 React，仅对自定义节点的两个精确端口查询作诊断替换；然后使用完全不加载 React、Flow 或应用模块、没有 Element 原型改写的独立原生 DOM 脚本。四阶段均在执行前补充矩阵；每次构建／切换资源后重新建立对应控制。所有组为 100 节点、0 边，非静态组 200 个端口；Flow 组固定 connectOnClick=false，端口均为无事件回调的普通 DIV。独立原生脚本仍复用同一 CSS 和公开 API 宿主，绝对内存单列。

| 前置状态                          | 动作与顺序                                                                                               | 不变量／责任方                                                                                                 | 对应验证与缺口                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 每臂新宿主                        | 初读→20 次 mount、120ms 等待、unmount、120ms 等待、reload→末读→heap/vmmap                                | 宿主检查唯一新增且固定的 WebContent PID、非零 RSS/footprint 与 3GiB 上界；安静环境归属前提保持                 | 26 个独立宿主、520 轮、546 个唯一 token；每臂 21 次 boot、20 次 pagehide.persisted=false、正常退出；单元素差集仍非系统级归属证明 |
| 静态／完整端口测量／跳过原生查询  | 同 NodeWrapper 与 style，临时包装仅匹配节点上的 .source/.target，其他调用透明转发                        | DOM 端口 0/200/200，handleBounds 0/200/0；100 个节点均有正尺寸；mode 控制不引入跨页 DOM 引用                   | v1 阴／阳性为 1/21，跳过查询为 2；v2 完整／跳过为 21/3，v3 完整为 21                                                             |
| 查询后丢弃／再遍历／读取后丢弃    | 原生 qSA 后分别只读 length、Array.from 遍历、再读 rect/id/position/offset，向 Flow 返回空数组            | 每页 200 次原生查询、200 命中；前三者遍历为 0/200/200、端口 rect 为 0/0/200，bounds 均 0；临时包装负责         | 三组均为 21；端口几何与 bounds 状态写入不是该触发条件的必要步骤                                                                  |
| 完整测量的返回形状／查询 API 对照 | rect 复制为同值普通对象；另组仅把两次精确 qSA 替为 getElementsByClassName，Flow 仍 Array.from 后测量     | rect-copy 仍 200 次原生 rect 与 200 bounds；live 组 qSA 为 0、live 查询与 rect 均 200、bounds 200              | rect-copy 为 21；live 两次为 2/1，全部 20 页几何摘要与各自完整组一致；动态交互／NodeList API 合同未验收                          |
| 不挂载 React／Flow 的原生 DOM     | 同布局、正尺寸检查；分别无查询、qSA、querySelector、getElementsByClassName                               | 原生方法直接调用，不经过原型包装；查询组各 200 调用／命中，端口 rect 与 bounds 均 0；root.replaceChildren 清理 | 分别为 3/21/4/3；原生 qSA 新宿主复测仍 21；首次仍加载公共 bundle，后续纯脚本消除此边界                                           |
| 卸载前使相关查询失效              | 原生组先对 100 个查询节点逐个 replaceChildren；或对 200 端口同步移除并加回 source/target，再执行正常卸载 | 挂载语义完全不变；清理计数为 100 节点／200 端口／100 次子树变更或 400 次 class 变更；Flow 挂载仍有 200 bounds  | 原生清子树／相关 class 均为 2；Flow 相关 class 两次均为 2；几何摘要与完整组一致；未修改 React 所属子树结构                       |
| 无关 class 对照                   | 同样 200 端口、400 次 class 变更，改为增加再移除 pw-unrelated，再正常卸载                                | source/target 成员保持不变，操作次数与同步卸载顺序相同；不在修改和 root.unmount 之间 await                     | 两次均为 21；任意 class 写入或多做清理操作不足以解释相关 class 组的下降                                                          |
| 无框架独立脚本                    | 无查询／qSA／qSA 后清各查询节点子树，各新宿主 20 轮                                                      | 没有 React、Flow、应用模块导入或原型包装；同宿主、DOM、CSS、计数与清理判据                                     | 结果见下表；这是独立脚本控制，不能将所有绝对内存与公共 bundle 混比                                                               |
| 清理、导航或失败                  | 每页 root/节点/边/端口/bounds 归零、flow/store 引用清空再导航，末页不挂载；异常／超时／PID 歧义即终止    | JSON 原始值跨桥，mount/cleanup=1/1；末读在扫描之前；finally 仅退出自有宿主                                     | 全部有效运行完成语义审计；未故意注入失败，无 Inspector、强制 GC、弱引用台账、私有 API 或全机内存压力                             |

下表每行各为独立宿主的 20 次重载。Document 与 LocalDOMWindow 原生分配数逐行相同；StaticElementList 和 Div 也是分配计数，不能单凭类型计数指定持有根。WebKit 已分配取 vmmap 的 BYTES ALLOCATED（M/K 分别按 MiB/KiB 换算），末读 RSS/footprint 早于扫描，二者不是原子快照；没有把 zone 地址空间当实际分配字节。

| 模式                       | 资源 | Document | StaticElementList | Div   | WebKit 已分配（MiB） | 末读 RSS / footprint（MiB） |
| -------------------------- | ---- | -------- | ----------------- | ----- | -------------------- | --------------------------- |
| 静态自定义节点             | v1   | 1        | 3                 | 2     | 14.8                 | 104.8 / 104.4               |
| 普通 DIV 端口，完整测量    | v1   | 21       | 4,066             | 4,116 | 56.9                 | 153.0 / 166.6               |
| 跳过两类原生端口查询       | v1   | 2        | 6                 | 316   | 28.5                 | 98.5 / 125.2                |
| 仅 qSA 后丢弃结果          | v1   | 21       | 4,069             | 4,230 | 67.5                 | 156.8 / 184.7               |
| qSA＋遍历后丢弃            | v1   | 21       | 4,069             | 4,116 | 69.2                 | 156.5 / 185.6               |
| qSA＋端口读取后丢弃        | v1   | 21       | 4,069             | 4,234 | 72.1                 | 162.3 / 188.9               |
| 完整测量，rect 数值复制    | v1   | 21       | 4,066             | 4,116 | 63.3                 | 153.0 / 175.5               |
| 完整测量复测               | v2   | 21       | 4,069             | 4,118 | 73.1                 | 160.6 / 187.6               |
| 跳过查询复测               | v2   | 3        | 18                | 630   | 28.6                 | 102.0 / 131.2               |
| Flow 改用 live collection  | v2   | 2        | 6                 | 4     | 34.5                 | 97.8 / 124.4                |
| 原生 DOM，无查询           | v2   | 3        | 12                | 307   | 20.1                 | 65.3 / 100.1                |
| 原生 DOM，qSA              | v2   | 21       | 4,063             | 4,004 | 53.5                 | 123.4 / 161.5               |
| 原生 DOM，querySelector    | v2   | 4        | 12                | 610   | 11.1                 | 66.8 / 100.0                |
| 原生 DOM，live collection  | v2   | 3        | 13                | 608   | 13.7                 | 66.3 / 100.3                |
| 完整测量再复测             | v3   | 21       | 4,063             | 4,116 | 73.6                 | 152.0 / 180.5               |
| 原生 DOM，qSA 复测         | v3   | 21       | 4,064             | 4,105 | 57.2                 | 120.3 / 155.5               |
| 原生 qSA，卸载前清节点子树 | v3   | 2        | 209               | 305   | 15.5                 | 74.2 / 108.5                |
| 原生 qSA，卸载前切换相关类 | v3   | 2        | 6                 | 305   | 18.5                 | 70.8 / 103.6                |
| Flow，卸载前切换相关类     | v3   | 2        | 209               | 316   | 29.2                 | 103.6 / 125.3               |
| Flow，卸载前切换无关类     | v3   | 21       | 4,064             | 4,118 | 63.8                 | 170.4 / 192.3               |
| Flow，live collection 复测 | v3   | 1        | 3                 | 2     | 15.8                 | 116.5 / 139.9               |
| Flow，切换相关类复测       | v3   | 2        | 6                 | 316   | 28.0                 | 98.4 / 123.8                |
| Flow，切换无关类复测       | v3   | 21       | 4,072             | 4,234 | 74.8                 | 160.8 / 182.4               |
| 纯脚本，无查询             | pure | 3        | 9                 | 304   | 8.0                  | 44.5 / 87.8                 |
| 纯脚本，qSA                | pure | 21       | 4,066             | 4,205 | 24.3                 | 64.5 / 110.9                |
| 纯脚本，qSA＋清节点子树    | pure | 3        | 9                 | 605   | 5.7                  | 49.5 / 90.3                 |

资源 SHA-256：

- v1 脚本：`e33941f9310469307b1cff0794e65513334034f31933fa061aed44577d411e17`。
- v2 脚本：`eeffe15aae765cba3047f8acad48bd17dfc52d7c6cbf9990e90a06cdbd73087f`。
- v3 脚本：`f7fcf75be3a7cf2cf9c5027337efaa563d6a70df7f6c6dbd5e72584544adb98b`。
- pure 脚本：`5297c954020c8013737b61dc3cc1907fc68e8ae676d639df4fe7aca998cc1f64`。
- 四阶段 CSS 相同：`9809a2cc55585a43b012b2bea3217da26ce584994a6e7c0ac80e8bd96f151941`；宿主源码：`ab43bb85e72c66ff726ee6be2ebe72fc019038d6850d0513fba7d847c80f81aa`。v3 最后两项复测未重建 bundle。

复现最小条件可表述为：用原生 DOM 创建 100 个节点，各含一个 .source 和一个 .target 子 DIV；验证正尺寸后，对每节点调用两次 querySelectorAll，只读取结果长度而不保存；以根的 replaceChildren 移除整个图，再在同一个 WKWebView 内导航到新文档。重复 20 次后为 21 个 Document。只在卸载步骤先对 100 个节点各调用一次 replaceChildren，再移除整个根，结果为 3。纯脚本没有端口几何、Flow store、React root、端口事件回调或应用模块；保留共同 CSS 和宿主意味着不能外推到所有页面、浏览器版本或导航类型。

Flow 的保留测量对照同样有效：live collection 两组和相关 class 失效两组均仍有 200 个端口 bounds；每页坐标／尺寸和方向摘要与对应完整组一致（Σx=14,200、Σy=3,200、Σwidth=Σheight=1,600、top/bottom 各 100，逐页比较容差 1e-7）。这只覆盖固定合成布局的摘要；尚未验证逐端口映射、动态增删、嵌套节点、缩放、拖拽和真实连线，不能将临时原型替换或 class 切换直接纳入生产实现。querySelector 的单元素返回也不等价于多端口查询。

源码交叉核对使用 WebKit 官方仓库固定修订 `a5cb75b185b29fd58ceb6bdb72e67443e03cf918`，尚未确认该修订与本机 WebKit 二进制完全一致：

- ContainerNode 的 querySelectorAll 可将结果交给 Document 缓存；Document 以查询上下文的弱键保存条目，条目包含 Ref<NodeList>。弱键本身不说明条目里的强引用已释放。[ContainerNode.cpp](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/ContainerNode.cpp#L1341)、[Document.cpp](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/Document.cpp#L1321)、[Document.h](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/Document.h#L2567)。
- StaticElementList 保存 Vector<Ref<Element>>，所以 JavaScript 局部 NodeList 变量离开作用域，并不能单独证明原生结果中的元素引用已经释放。[StaticNodeList.h](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/StaticNodeList.h#L76)。
- Document 的子树失效逻辑沿起点及祖先处理上下文；class 失效还比较被查询 class 的成员变化。修改整体祖先与修改各查询节点内部，因而具有可检验的差异；本轮“相关类有效、无关类无效”的结果与这个机制一致。[Document.cpp](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/Document.cpp#L1362)、[Node.cpp](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/dom/Node.cpp#L1066)。
- 该修订的 critical memory release 路径也会清理查询结果缓存；本轮没有触发该内部路径或施加内存压力，不能据当前残留断言内存压力下也永不回收。[MemoryRelease.cpp](https://github.com/WebKit/WebKit/blob/a5cb75b185b29fd58ceb6bdb72e67443e03cf918/Source/WebCore/page/MemoryRelease.cpp#L146)。

**当前最强解释是查询结果缓存及其失效／释放路径参与了旧文档保留。** 依据是 qSA 后立即丢弃仍为 21、无框架脚本复现、StaticElementList 约 4,000 个的同步累积，以及两类有针对性的卸载变更可降到 2～3；相同次数无关 class 变更仍为 21，端口几何与 bounds 状态写入不是必要步骤。它比仅观察 RSS 不下降更能缩小方向，但仍是机制推断：没有本机 WebKit 的 C++ 持有图、malloc/free 历史或与系统构建逐项匹配的源码，尚不能指定该弱键容器中的确切条目、析构顺序或缺陷行。原生对象分配尚存也不能排除未来 GC、缓存清理或内存压力释放；低计数组 1～4 个 Document 和 RSS 高水位不代表所有资源已回收，也未证明长期平台化。

下一步优先把卸载前失效的候选放到真实 NativeCanvasApp／shell 的验证夹具中：挂载期间保持端口和连线语义，覆盖空图、多个端口、节点删除／重建、重复清理、销毁与导航次序；再用生产资源执行既有 100 次重载回归和完整原生路由。替换查询 API 涉及静态／live 集合语义，卸载 class 变更涉及观察器和 React 清理次序，两者都需要独立行为回归后才能选生产方案。当前不引入全局 Element 补丁、修改依赖文件或关闭端口交互。

验证：一次性宿主通过 Swift 6 -warnings-as-errors 编译，三份 Vite 生产构建与纯脚本 node --check 通过；26 宿主／520 轮／546 个文档的挂载、卸载、事件顺序、固定 PID、数值和清理计数语义审计通过，宿主均正常退出。新增证据逐项核对矩阵与原始日志、几何摘要、单位和上游固定修订，文档没有配置的自动化语义检查；仅格式化本轮新增段落并执行 git diff --check，原有文档字节保留。一次性脚本、宿主、模块缓存、构建、扫描和日志在记录后清理。无业务存储、网络、锁、连接池或下游负载，吞吐、排队、CPU 和 I/O 不属本轮目标。没有修改生产或版本化测试源码，未重跑完整原生套件；下述既有失败、迁移计划 M15/§7.2 未验收与 #573／PR #586 未修复状态继续保留。

#### 真实 shell 的导航时失效与重新查询反证（2026-10-17）

本轮将上节候选带入现有 `NativeShellRoot → WebCanvasHostView → native-canvas.html#perf:100 → NativeCanvasApp` 路径。使用当前分支正式 Vite 生产资源和真实节点／边组件，未替换 React Flow、查询 API 或 Element 原型；临时 Swift Testing 套件只负责注入导航探针和采样。短轮四臂在同一原生测试进程内串行，qSA 长轮两臂在第二个进程内串行，live 长轮在第三个进程内执行；每臂新建独立 WKWebView，但并非七次独立宿主冷启动。`NativeHostServices(dataRoot: nil)` 隔离业务存储，图为内存合成夹具，未覆盖真实项目的 NativeHostApp 加载／保存路径。环境继续为本机 macOS 27.0.1／WebKit 22625.1.29.11.28，Xcode 27.0／SDK 27.0、M4 Max 64GB、DPR 2；#573 的 P3 范围保持不变。

执行前矩阵与验证映射如下。失效操作同步发生于旧页的 pagehide，React root 此时仍挂载；没有调用 root.unmount，也没有提前删节点、禁用连接或让不完整图进入下一轮。它与前节“先失效，再显式卸载”的次序不同。

| 前置状态                       | 动作／顺序                                                                 | 预期观察                                             | 跨转换不变量及所有者                                                                          | 验证／缺口                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 新 shell，独占 WebKit 套件范围 | 挂载正式生产夹具，再安装探针；后续页在 document-start 安装                 | 新 token、100 节点／89 边／210 端口、同一可读 PID    | shell 保持同一 WKWebView；测试每臂只归属一个新 WebContent PID                                 | 每轮检查正节点尺寸和 89 个非空、无 NaN/Infinity 的 SVG 边路径；PID 歧义即失败，不是公开 page→PID 映射证明 |
| 完整图即将导航                 | 正常 pagehide／210 端口各增删无关 class／移除加回自身 source 或 target     | 区分相关失效与相同操作量的一般 DOM 变更              | 探针同步完成且保留端口 source/target 成员集合、节点／边／端口数；每个受测旧页 persisted=false | 短轮三臂各 20 次；相关和无关处理均每页 420 次 class 操作                                                  |
| 已执行相关 class 失效          | 同一 pagehide 回调内，再对 100 节点各 qSA(.source/.target)，读取长度后丢弃 | 检验重新填充查询结果能否恢复文档累积                 | 查询与前节触发点相同；不保存 NodeList，不增加几何或 store 写入                                | 反证臂每页 200 次查询／210 命中，共 20 次导航                                                             |
| 每臂首末完整页                 | 现有 `__pwRunCanvasPerf` 执行拖拽、平移、缩放、控件                        | 四阶段完成，前三类效果均为正，图数量保持完整         | 所有臂同一脚本与选项；不修改正式入口                                                          | 每臂两次；只证明本轮交互与渲染，未创建新连接、删除／重建节点、改变端口数或验证空图                        |
| 探针观察与长轮                 | 短轮 ready 使用 live collection；长轮沿用既有回归的 qSA 节点／边就绪查询   | 区分观察器查询与生产端口查询，验证长循环下候选仍有效 | 内存采样用 JSON 原始值，不把 DOM／NodeList 跨桥；同一固定 PID                                 | 首末交互脚本仍有共同 qSA；短、长轮观察方式分别记录，不能混为完全相同负载                                  |
| 每臂结束或失败                 | 最后静置采样后才 heap/vmmap；移除自有 handler、关闭自有 window             | 趋势读数不包含扫描影响；失败不记为完整有效臂         | 测试只销毁自有资源，没有 Inspector、强制 GC、私有 API 或全机内存压力                          | 未注入故障；原生类计数不提供 malloc/free 历史或 C++ 持有图                                                |

短轮四臂各 20 次重载，均完成 21 个唯一文档；Document 与 LocalDOMWindow 数量相同。下表 RSS 均为 WebContent、单位 MiB，分别取第 0／10／20 次和随后静置 5 秒；WebKit 已分配使用 vmmap 的 BYTES ALLOCATED，M 按 MiB 换算，扫描 footprint 不与此前 RSS 当作原子快照。

| pagehide 模式      | Document | StaticElementList | Div   | WebKit 已分配（MiB） | RSS 0／10／20／+5s（MiB）  |
| ------------------ | -------- | ----------------- | ----- | -------------------- | -------------------------- |
| 正常导航           | 21       | 4,200             | 5,088 | 81.5                 | 125.3／293.9／310.1／310.0 |
| 无关 class 增删    | 21       | 4,200             | 5,088 | 86.3                 | 123.4／204.5／232.5／232.5 |
| source/target 失效 | 1        | 200               | 888   | 54.9                 | 121.2／180.2／182.4／182.3 |
| 相关失效后重新 qSA | 21       | 4,200             | 5,088 | 85.2                 | 122.2／205.0／232.3／232.2 |

**相关失效降低了真实画布的旧文档累积；在相同回调内重新查询，又将结果恢复为 21／4,200。** 无关 class 的同量操作无效。这比单纯“多等一会”或观察 RSS 下降更支持查询缓存的失效／重新填充解释；正常组和无关组的 RSS 差别也说明不能用单一高水位代替对象计数。相关组末页仍挂载，因此 200 个 StaticElementList 包含当前 100 节点的查询结果，不能把它们全叫作泄漏对象；1 个 Document 也不等于所有原生分配均回到初值。

随后追加三臂各 100 次，末读前静置 15 秒。前两臂沿用原有回归的 qSA 就绪探针；第三臂仅把就绪查询改为 live collection，仍要求新 token、100 节点／89 边和相同几何，端口失效及其余脚本不变。三臂都完成结构诊断；+400MiB 原有守卫以逐样本事后审计保留失败，未为了采满趋势而把超限样本判为通过。

| 就绪探针／pagehide 模式       | Document | StaticElementList | Div    | WebKit 已分配（MiB） | RSS 0／50／100／+15s（MiB） | 后 50 次 RSS 增量（MiB） |
| ----------------------------- | -------- | ----------------- | ------ | -------------------- | --------------------------- | ------------------------ |
| qSA／正常导航                 | 101      | 20,398            | 85,248 | 358.8                | 120.6／498.8／697.1／696.8  | 198.3                    |
| qSA／端口相关失效             | 100      | 2,378             | 85,038 | 351.0                | 123.7／497.4／697.8／697.4  | 200.4                    |
| live collection／端口相关失效 | 1        | 200               | 888    | 57.6                 | 121.9／200.0／201.8／201.4  | 1.8                      |

qSA 正常组从第 58 次开始超出初值 +400MiB，共 44 个样本超限（含静置末读）；qSA 端口失效组从第 59 次开始，共 43 个样本超限。live 就绪组的 WebContent 样本无超限；三臂宿主样本均无超限。live 组第 0／20／40／60／80／100 次 RSS 为 121.9／179.9／200.0／201.1／201.2／201.8MiB，显示本次窗口后半段趋稳，仍不是无限时长、所有机器或版本的平台化证明。

**仅减少端口查询列表仍不足以释放整页。** qSA 就绪组中，相关处理让列表从 20,398 降至 2,378，但约 100 个旧／当前 Document、85,000 个 Div 和约 697MiB 的 RSS 仍在。保留同样数量断言而使用 live collection 的长轮则降至 1／200。两类就绪调用会查询整图节点和边，其静态结果可能继续保留整个子树；这些结果不因 source/target 成员变化而必然失效。结合上节固定源码和本轮 API 对照，**探针的额外查询结果参与了保留**是当前证据支持的解释，不能将所有残留都算在生产端口查询或某个 React 组件上。第三臂使用新的原生测试进程，冷暖宿主、时序和 GC 差异未完全消除；仍需交换顺序复测或取得条目级原生持有链，不能把类型数量当作确切缓存归属证明。前节无框架原生 DOM 的复现仍成立，观察因素不撤销原有触发证据。

资源标识：本轮正式 `native-canvas.js` SHA-256 为 `d53342a5125f7cedfc3373e4eb2a0459d970d34007e40f74ba04b26772dfbee7`，HTML 为 `dc20c5bba072edb16c4142760e1e300a4d8134a2d8e4279fef8383adb8240914`，CSS 为 `52557223074ffc43abd0e2640ed2005a43cda787f20afa94acd8ae2001080bf6`。所有臂共用这份资源。首末交互脚本固定 drag/pan/zoom 各 1 轮、各 8 步、stepMs=16、settleMs=150；控件阶段保持现有脚本实现。

可复核顺序：在已有测试宿主的独占 WebKit 套件范围内，创建 1280×860 的 NativeShellRoot（demoMode=true、demoFragment=perf:100、隔离 services）；等待 100 节点／89 边；记录唯一新 WebContent PID；首次页安装探针，后续页通过 WKUserScript document-start 安装。先执行一次公共交互脚本，再逐轮 WKWebView.reload，等待新 token 和完整夹具、静置 1 秒，检查同 PID、尺寸／路径与 RSS；末页再次运行相同交互脚本，静置后采样，再扫描。pagehide 通过 live collection 枚举端口，相关臂对每个端口同步移除并加回其 source 或 target；无关臂改为临时 class 的增删；重新查询臂在相关处理后立即对每节点调用两次 qSA。只把计数、数值、token 和布尔值传回原生；未传节点内容。

仍需验证的生产边界：在卸载到导航之间，任何后续代码重新执行相同查询都可能恢复保留；本轮反证直接展示了这一点，因此仅有“注册一个 pagehide 监听器”尚不能保证生产监听器次序和全部入口。动态多端口增删、空图、连接创建／删除、节点销毁／重建、重复清理、导航取消、BFCache 恢复、页面内切换和 NativeHostApp 项目会话尚未覆盖。当前 source/target 处理是诊断注入，没有纳入生产代码或更改依赖。固定上游修订提供的机制解释和本机二进制不匹配的限制继续沿用上节，仍无确切 C++ 持有根证明。

验证与清理：`npm run check:size`（含临时测试时 741 文件）及 `npm run build:native-canvas` 通过；三次 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO -only-testing:PlotWeaveNativeTests/PW573ShellDiagnosticTests test` 均退出 0，每次仅执行 1 项临时诊断测试，套件耗时分别为 143.851s、278.013s、139.524s。这些测试检查完整性与采样有效性，不能替代上述内存超限的失败结论。7 臂／380 次重载／387 个全局唯一文档、394 条内存记录和 14 次交互的 JSON 语义审计通过；每次交互的拖拽、平移和缩放效果均为正，最小值分别约 170.317px、116.482px、0.724。全部 380 条 pagehide 记录均 persisted=false、类成员和图数量保持不变，全部 7 个固定 PID 可读且互不相同。未确认逐端口 bounds 映射或真实连线创建／删除语义。

临时套件移除、一次性 DerivedData 和扫描日志清理，原有 WebCanvas 资源逐字节核对一致；没有保留生产或版本化测试修改。文档仅追加本节，原有字节保持不变；新增段落经 Prettier、`git diff --check` 和矩阵／数据／范围的结构化审查，没有配置的文档自动化语义检查。没有业务存储、网络、连接池、锁或下游负载；吞吐、排队、CPU 和 I/O 非本轮目标。

下一步应同时处理**实际销毁入口及探针观察效应**：验证在统一页面销毁顺序中先失效相关查询上下文、再同步 React 卸载、最后导航，能否连同额外 qSA 结果一起释放；测试应保留避免额外静态查询结果的语义等价就绪断言和含额外查询的压力对照，不能只换探针后宣称修复。需要覆盖前述动态行为和失败／恢复，再选择最小生产实现并运行既有长循环回归与完整原生路由。本轮没有修改生产代码，没有使版本化回归转绿，未重跑完整原生套件；下述历史失败、#573／PR #586 的未修复状态和 M15/§7.2 的未验收状态保持。

#### 真实 shell 的同步卸载次序与脱离节点重查（2026-10-17）

本轮验证上节提出的完整次序：**失效端口查询 → 实际 React root.unmount → WKWebView 导航**，同时保留原长循环回归的额外 qSA 就绪查询。仍由 NativeShellRoot／WebCanvasHostView 装配 perf:100 的真实 NativeCanvasApp，100 节点／89 边／210 端口，隔离 services、环境和窗口规格沿用上节。与上节未改写正式资源不同，本轮使用一次性 Vite pre-transform，仅在正式 main.tsx 的 createRoot 处保存实际 root 并暴露诊断 dispose；调用先清空句柄、同步 unmount，重复调用返回 0。未保存替代 root、改写 Element 原型、替换 Flow 或修改维护中的源文件。实验 JS SHA-256 为 `9dbe4a61438f12169db62c95b3c422c3f8b510f94e83d52bf8c6a298be3f014e`，HTML／CSS 与上节一致；不能将此实验 bundle 称作未改写的正式产物。main.tsx 的前后 SHA-256 均为 `3690e0b7dcb415b562e2ffe4a7e1c00bdb99780260d88579162fb5a2065e9d20`。

执行前矩阵及结果映射如下。每次操作都在旧页一个同步 pagehide 回调内完成，不 await；脱离节点的引用只存于该回调局部数组，回调后丢弃。观察器只传 JSON 原始值，无 Inspector、强制 GC、私有 API 或全机压力。

| 前置状态                       | 动作／顺序                                                                     | 预期观察                                             | 跨转换不变量及所有者                                            | 验证／缺口                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 独占 WebKit 测试范围，新 shell | 挂载实验入口，沿用 qSA(.react-flow__node/.react-flow__edge) 就绪检查           | 新 token、完整图和唯一可读 PID                       | 测试不以旧页满足就绪；同一 WKWebView／固定 PID，所有臂同 bundle | 每轮正节点尺寸／有效 SVG 路径；不是公开 page→PID 映射证明        |
| 完整旧图即将导航               | 正常导航／仅实际 root.unmount                                                  | 区分全图观察查询与节点内部查询残留                   | 卸载由入口拥有的真实 root 执行，未用 DOM.remove 代替 React 卸载 | 各 20 次；卸载臂调用返回 1、重复返回 0，根元素子数及图数量均变 0 |
| 完整旧图即将卸载               | 端口 source/target 移除加回，再 root.unmount、导航                             | 检查组合能否消除旧文档累积                           | 类成员、完整图计数与正尺寸检查先通过，再移除图；入口句柄清空    | 短轮 20 次和两次 100 次，保留额外 qSA 就绪压力                   |
| 根元素已清空，旧节点已脱离页面 | 对局部保存的 100 个旧节点各 qSA(.source/.target)；另一臂随后再次失效局部旧端口 | 检查卸载后重新填充是否恢复保留，以及再次失效能否逆转 | 200 次重查／210 真实命中；所有节点引用只在回调内                | 重查两次各 20，重查后再失效 20；并非无命中的空查询               |
| 首末完整新图                   | 共用现有脚本拖拽／平移／缩放／控件                                             | 四阶段完成，前三类效果为正                           | 所有臂同选项，末页保持挂载以区分当前对象                        | 每臂两次；未验证逐端口 bounds、连接增删、动态端口或空图          |
| 正常结束／结构失败             | 静置末读后才 heap/vmmap；移除 handler、销毁自有 window、恢复资源               | 不用扫描后的内存代替此前趋势；异常即中止有效臂       | 仅清理自有一次性输出；原 +400MiB 守卫另逐样本审计               | 未注入导航失败、取消或 persisted=true；完整原生套件未重跑        |

8 个独立 WKWebView 共完成 **320 次重载、328 个全局唯一文档、336 条内存样本、16 次公共交互**。第一原生测试进程串行执行五个 20 次对照和候选 100 次；第二进程先执行候选 100 次，再执行卸载后重查 20 次。第二次候选从新宿主进程开始，没有前五臂预热；这减少了宿主顺序混杂，仍不是 OS／WebKit 全缓存冷启动或独立 GC 条件。每臂固定且可读的 PID 互不相同。下表 Document 为 heap 的 HTMLDocument，各臂 LocalDOMWindow 数相同；RSS 单位 MiB。

| pagehide 次序（各 20 次）            | Document | StaticElementList | Div    | WebKit 已分配（MiB） | RSS 0／10／20／+5s（MiB）  |
| ------------------------------------ | -------- | ----------------- | ------ | -------------------- | -------------------------- |
| 正常导航                             | 21       | 4,238             | 17,248 | 111.2                | 117.8／215.6／257.8／257.8 |
| 仅 root.unmount                      | 21       | 4,200             | 5,088  | 90.1                 | 123.5／196.9／226.2／226.1 |
| 失效 → unmount                       | 1        | 200               | 888    | 58.8                 | 122.8／167.1／175.3／175.2 |
| 失效 → unmount → 重查旧节点          | 21       | 4,200             | 5,088  | 90.8                 | 124.7／294.8／487.1／487.0 |
| 失效 → unmount → 重查 → 再失效旧端口 | 1        | 200               | 888    | 57.2                 | 123.1／181.4／186.8／186.7 |
| 第二宿主进程：失效 → unmount → 重查  | 21       | 4,200             | 5,088  | 88.1                 | 122.8／208.1／235.5／235.4 |

| 失效 → unmount（各 100 次） | Document | StaticElementList | Div | WebKit 已分配（MiB） | RSS 0／50／100／+15s（MiB） | 后 50 次增量（MiB） |
| --------------------------- | -------- | ----------------- | --- | -------------------- | --------------------------- | ------------------- |
| 第一宿主进程，短轮后        | 1        | 200               | 888 | 54.9                 | 123.2／293.7／294.2／293.7  | +0.5                |
| 第二宿主进程，首臂          | 1        | 200               | 888 | 54.1                 | 117.7／393.6／392.7／392.2  | −0.8                |

两次长轮均保留 qSA 就绪压力，后半段趋稳且末端只见当前文档；第二次绝对 RSS 更高，说明末端 Document 不再累积不意味着全部 resident pages 或高水位归还。两个卸载后重查对照虽然绝对 RSS 相差很大，旧文档／列表／Div 数却一致；不能仅凭 RSS 变化指定某组件泄漏。336 条样本逐项审计均未超过各臂初值 +400MiB，宿主也无超限；**20 次阴性对照仍累积 21 个文档，阈值未超不等于回收正确**。本轮未重跑版本化 100 次正常导航的失败用例，不能把临时诊断通过换成正式回归转绿。

本轮范围内，完整次序消除了已观测的旧文档累积，而**单独 React 卸载不足，卸载完成后重新查询仍能恢复旧页保留**。再次失效局部保存的脱离端口后，对照又回到 1 个 Document／200 个 StaticElementList。这种“失效—重填—再失效”可逆结果，使问题进一步收敛到查询上下文及其销毁次序；不是泛指 React 组件都没卸载。单独 unmount 的根元素已经清空，仍有 21 个 Document／4,200 个列表；这也说明“画面已消失”和“旧原生 DOM 已释放”是不同的可观测条件。当前末页仍挂载，1 个 Document／200 个列表包含当前图，不是零分配或所有内存恢复初值的证明。固定 WebKit 源码提供的解释继续适用，但类型计数和行为对照仍不提供确切 C++ 条目持有链或无限期不可回收证明。

可复核步骤：以一次性 Vite 插件只转换 main.tsx 的 createRoot 调用，保留原配置其余构建选项；编译原生测试宿主。在独占套件范围内每臂创建新的 1280×860 shell，首次就绪后安装探针，后续通过 document-start 注入；每页保留 qSA 就绪查询，采样几何使用 live collection。每轮 reload、等待新 token 和完整夹具、静置 1 秒、校验同 PID 后采 RSS。pagehide 先局部取得节点和端口；相关处理每端口移除加回其 source/target，共 420 次 class 操作；再调用实际 dispose 两次验证幂等。重查臂此后在旧节点上调用 200 次 qSA、只读长度；再失效臂追加 420 次操作。首末页运行上节相同公共交互脚本；短轮末静置 5 秒，长轮 15 秒；最后趋势读数之后才 `/usr/bin/heap -s --noContent PID` 和 `/usr/bin/vmmap -summary PID`。WebKit 已分配是 vmmap 对应 malloc zone 的 BYTES ALLOCATED，RSS 和扫描 footprint 不是原子快照。

验证：实验构建命令为 Node 24.18.0 的 `node node_modules/vite/bin/vite.js build --config <一次性配置>`（沿用正式 Vite 配置，其 pre-transform 如上），成功；`npm run check:size` 含临时测试时 741 文件通过。两次 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO -only-testing:PlotWeaveNativeTests/PW573LifecycleDiagnosticTests test` 均退出 0，各执行一项临时结构诊断，耗时 305.245s／169.698s；不是完整原生路由。JSON 语义审计核对全部数量、token、PID、尺寸、路径和操作次序：320 条 pagehide 全部 persisted=false；300 次实际卸载均返回 1、重复返回 0，根元素及可见图数量清空；失效前后 source/target 成员、完整图计数、正尺寸及有效路径数量一致，未逐节点比对尺寸或坐标。60 个重查旧页均为每页 200 次查询／210 命中，再失效臂每页共 840 次 class 操作，其余相关臂 420 次。16 次公共脚本均完成四阶段，拖拽／平移／缩放效果最小值约 170.317px／116.482px／0.724；没有页面探针错误。逐项矩阵中未覆盖边界按表保留，没有以测试数或覆盖率替代语义证据。

生产实现仍有边界：本轮只控制同一回调内部次序，首次页探针在应用监听器之后安装，后续页 document-start 安装；未证明其他生产监听器不会在清理后重新查询。不能只增加一个 pagehide 回调就宣称覆盖全部退出入口。persisted=true/BFCache、取消／恢复、页面内切换、动态端口／节点增删、连接创建／删除及 NativeHostApp 项目会话仍未覆盖，后续实现必须由真实页面／会话生命周期拥有、阻止清理后重查，并保留恢复语义。该研究不涉及业务存储、外网、连接池、锁或下游；吞吐、排队、CPU 和 I/O 非目标。

临时 Swift 套件和一次性构建／扫描输出已清理，预存 WebCanvas 三个文件恢复后逐字节与备份一致；维护中的生产和测试源码无新增修改。文档仅追加本节，原有字节不变；新增段落经 Prettier、`git diff --check` 和矩阵／数据／范围结构化审查，没有配置的文档自动化语义检查。尚未选定和提交生产修复，没有使既有版本化长循环回归或完整原生路由转绿；#573、PR #586 草稿及 M15/§7.2 未验收状态继续保留。

#### 生产生命周期修复（2026-10-17，PR #586）

本轮将候选落实为生产代码，沿用 #573 的 P3 同视图重导航范围。`nativeCanvasPage.ts` 拥有唯一 React root、诊断订阅及启动状态，在异步初始化前注册永久离页清理；先清空所有权，释放订阅，失效现存端口查询，同步 `root.unmount()`，最后再次失效局部捕获的旧端口。后置阶段覆盖卸载期间的重查，局部数组不跨回调保留。`NodePort` 的稳定 ref 在节点／分支选项被移除时执行同一失效，覆盖早于页面终止已删除的端口；重新渲染不执行脱离清理。只移除并加回端口原有的 source／target 类，保持成员集合；没有改 Flow、Element 原型、查询 API、依赖或内存阈值。

实施前矩阵记录于本次任务计划，以下映射至提交中的回归和实测：

| 前置状态                     | 动作／顺序                                           | 可观察结果                                    | 不变量 owner／入口                                 | 验证与边界                                                                 |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| 已挂载真实画布               | 永久 pagehide；重复退出                              | 同步清空 root 和端口，订阅只释放一次          | Web 入口拥有 root／订阅，清空所有权先于回调        | main.test.tsx；真实 NativeHostApp 卸载与长循环                             |
| 初始化未完成                 | 永久退出后收到订阅                                   | 释放迟到订阅，不再挂载或接收事件              | 入口 disposed 守卫覆盖异步完成                     | 延迟初始化与重复退出测试                                                   |
| 已挂载／启动中               | persisted=true，再恢复或完成启动                     | 保持同一树及入口拥有的订阅                    | 入口不永久销毁缓存页面                             | 两项入口测试；现有 Swift 桥仍结束 pagehide 通道，不承诺端到端 BFCache 恢复 |
| 多端口图                     | 前置失效 → React 卸载 → 后置失效                     | 根为空，脱离端口类成员保持                    | 页面清理＋共享 handleQueryCache                    | 真实多端口入口测试、正式资源 heap 诊断；历史脱离节点重查对照保留           |
| 删除分支选项或节点           | 局部 ref 脱离；随后页面退出                          | 旧端口也失效，存活端口身份不变                | NodePort ref 与页面终止入口共用清理                | PortCanvas 的实际 DOM mutation／成员集合断言；真实项目 20 次循环与原生堆   |
| 同一页面普通重渲染／项目往返 | 更新选项或切换首页                                   | 稳定端口不执行脱离失效；页面仍可编辑          | 稳定 ref；既有应用／编辑 owner                     | PortCanvas 存活端口观测；真实项目保存和重开                                |
| 空图／节点重建               | 增删端口、删除节点，可选重建；保存、卸载、加载新文档 | 空根卸载安全，恢复预期图和实际磁盘数据        | NativeHostApp 写入 owner 与 coordinator.loadCanvas | 新原生参数化回归 2 案例，隔离数据根；不以裸 WK reload 伪造桥会话换代       |
| 初始化或清理抛错             | 异步拒绝／外部 unlisten 失败                         | 结构化错误；仍释放其余资源，无迟到挂载        | Web 入口异常路径                                   | 两项错误回归；PW_CANVAS_INITIALIZATION_FAILED／PW_CANVAS_DISPOSE_FAILED    |
| 保存失败／取消退出／加载重试 | 原生既有恢复入口                                     | 保留页面、失败稿及明确重试资格                | 既有 Swift/Web 保存与退出 owner                    | 完整原生套件；无 beforeunload／可见性／普通路由卸载                        |
| 固定图连续导航               | 原样保留 qSA 就绪断言、100 次及同 PID 要求           | 所有有效样本满足原 +400MiB 双界，末端趋势趋稳 | 既有性能测试与采样器                               | 完整原生路由及临时公开分配统计；不以换探针或换进程换取通过                 |

TDD：入口的真实 React 夹具在修复前永久离页仍有 1 个根子元素，最小回归按预期失败；端口删除在补充自身清理前没有发生相关类失效，也观察到预期失败。实现后两文件 11 项通过；后续完整检查见下。新增入口测试使原生 main 模块首次有测试导入，因其仍由 native-canvas.html 的独立 Vite 构建加载，在既有 Sonar 分类守卫登记生产入口；没有将其归为测试或增加排除。

第一次只实施终止清理的候选（JS SHA-256 `3a6a5d8f553ff1bedc41acc9e757e34f2b1ff3b1756431e9ba92677ac9bab55b`）已使原 100 次守卫通过：RSS 117.4／187.6／299.6／323.5／323.4／323.9MiB（0／20／50／80／90／100），静置 15 秒为 323.5；宿主 190.1→212.9→212.8MiB。但真实项目每页创建分支、插入／删除选项、删除节点、返回首页保存后再加载，两个各 20 次的独立视图末读仍为 10／9 个 Document、18／16 个 StaticElementList。该候选不作为最终实现验收；此观察促成 NodePort 自身清理。

最终生产构建通过普通 `npm run build:native-canvas` 生成；JS SHA-256 为 `1af4b0eecfbd29c41327039823878414d580c067f72d32568019198fe2428a23`，html/CSS 与上节原资源相同。Xcode app 实际打包 JS 与该文件逐字节同 SHA；没有临时 Vite 改写或只供诊断调用的 root API。诊断使用独占 WebKit 套件、真实 NativeShellRoot 和正式资源；以下 allocated 类型计数来自趋势采样之后的公开 heap，不是精确 C++ 持有链证明。

| 最终构建的诊断路径                     | 次数／末页   | Document／LocalDOMWindow | StaticElementList | Div   | RSS 起点→末次→静置（MiB） |
| -------------------------------------- | ------------ | ------------------------ | ----------------- | ----- | ------------------------- |
| NativeHostApp 动态增删，视图 A         | 20／空编辑器 | 1／1                     | 未列出            | 27    | 74.9→101.8；无额外静置    |
| NativeHostApp 动态增删，视图 B         | 20／空编辑器 | 1／1                     | 未列出            | 27    | 74.2→121.1；无额外静置    |
| perf:100，原 qSA 就绪                  | 20／完整图   | 9／9                     | 362               | 7,983 | 117.8→332.5→332.5（+5s）  |
| perf:100，新原生宿主进程，逐页卸载观察 | 100／完整图  | 5／5                     | 282               | 4,435 | 115.3→430.5→430.1（+15s） |

动态 A/B 在同一原生测试进程内串行，随后执行静态 20 次；100 次在新的原生测试进程单独执行，均非 OS 全缓存冷启动。每个视图要求唯一、固定、可读 WebContent PID，不更换进程稀释趋势。动态每轮实际创建分支、端口数 3→4→3→0、删除节点、返回首页保存、经 coordinator 加载新文档再打开项目；两份 heap 都在空图采样后、最终可选重建节点前取得，不能误解为对含分支末页的计数。两项原生案例随后分别验证空图或重建节点的卸载、重载和真实磁盘内容。

静态短轮仍有旧分配，因此没有以 20 次宽松守卫通过作唯一结论。延长至 100 次后，RSS 在第 50／80／90 次为 427.0／427.0／427.1MiB，后 50 次共 +3.5MiB，后 20 次也 +3.5MiB；宿主 190.1→212.6→212.5MiB。100 条实际 pagehide 观察均为 persisted=false，且在生产清理之后根子元素和端口数均为 0。20 次与 100 次末读分配分别为 9 与 5 个 Document，而非随导航数逐次累加；仍有当前页之外的分配，不能宣称每页立即析构或所有 resident pages 归还系统。类型统计不等同于确切持有链，长轮趋稳与已修复的具体缓存失效／卸载入口共同构成本题验收依据，不扩大成应用不存在其他泄漏的保证。

临时诊断仍保留原 qSA 新页就绪数量、100 节点／89 边和同 PID 约束，没有强制 GC、Inspector、全机内存压力或私有 API。100 次观察器只在生产监听器之后发送标量 JSON（persisted／根子元素数／端口数），未传 DOM，也不重查脱离节点。所有 RSS 先于 heap；20 次轮使用 heap -s，100 次使用与历史轮相同的 heap -s --noContent，统计的是工具识别的已分配类型，不是对象可达性。没有用扫描后的 RSS 替代干净趋势。仅终止清理候选的动态试验为 55.568s；最终动态试验的 55.885s 包含在动态＋静态 20 次的 2 tests / 2 suites、86.419s 中，静态 100 次为 1 test / 1 suite、132.006s，均退出 0。

保留边界：完整 BFCache 桥恢复、实际鼠标新建／删除连线手势、任意规模／任意 WebKit 版本的长期内存，以及异常退出后的未保存稿恢复，不由本轮数据建立；既有图操作、端口连接、保存取消和加载重试按完整回归验证。没有修改文件 schema、数据根或 Swift 生产服务。

最终正式回归（临时诊断已撤回）：`npm run check:size`（743 文件）、`npm run build:native-canvas` 和完整 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test` 全部通过，285 tests / 62 suites，306.424s，退出 0。原 `repeatedReloadsRecordLongMemoryTrend` 的循环、qSA 就绪、同 PID、1s／15s 等待和 +400MiB 双界均未修改：WebContent RSS 在 0／20／50／80／90／100 次为 113.7／195.0／299.2／299.4／299.2／299.9MiB，静置末读 298.7；后 50 次 +0.7MiB、后 20 次 +0.5MiB。宿主首读 518.6MiB、末次 520.2、静置 520.5，全部 102 份样本双界通过。实际保存失败恢复、退出取消、加载重试、原生项目及端口／节点状态回归均通过；这些结果替代修复前的整套失败状态，原始失败保留如下。

最终前端路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 全通过，233 文件／3,250 项测试。初次沙箱内完整测试有 18 项失败：17 项依赖系统进程身份或监督权限，另一项暴露原生生产入口漏登记；登记真实入口并在具备进程权限的环境复跑后全部通过，没有跳过用例。新增原生用例初版误将裸 reload 当成桥会话换代而超时，改用既有 coordinator 文档加载入口后两案例通过，未改变桥合同。`scripts/**` 路由的 `npm run check:size && npm test -- scripts` 也通过（16 文件／371 项）。临时 Swift 诊断及原生构建输出已清理，预存 WebCanvas 三文件逐字节恢复。文档仅新段落经 Prettier；结构化审查核对状态／矩阵／数字与资源哈希，更新迁移计划及 UI 生命周期，`git diff --check` 通过；没有配置的文档自动化语义检查。

历史失败（实施生产修复前）：新增重载回归用例时的完整原生路由已执行：`npm run check:size`（740 文件）和 `npm run build:native-canvas` 通过；`xcodebuild ... -parallel-testing-enabled NO test` 执行 284 tests / 62 suites（306.684s），283 项通过，新增长循环用例失败（22 issues），退出码 65。既有回归通过不改变整套未通过的结论。文档无配置的自动化语义检查；已结构化核对矩阵、逐轮采样、诊断限制及迁移计划 M15/§7.2 的未验收状态，Prettier 与 `git diff --check` 通过。

仓库内复现命令（`-only-testing` 的 Swift Testing 函数名包含括号）：

```sh
npm run check:size
npm run build:native-canvas
xcodebuild -project native/macos/PlotWeaveNative.xcodeproj \
  -scheme PlotWeaveNative -destination 'platform=macOS' \
  -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO \
  test '-only-testing:PlotWeaveNativeTests/WebCanvasPerformanceTests/repeatedReloadsRecordLongMemoryTrend()'
```

## 4. 本轮代码变更与验证汇总

- 前端：`canvasPerfFixture.ts`（+测试）、`canvasPerfScript.ts`（+测试）、`main.tsx` hash 装配、`NativeCanvasApp`/`useDemoEditor` 支持注入图、演示页 `is-swift` 修复。路由检查全绿：`format:check`、`lint`、`check:size`（719 文件）、`typecheck:strict`、`build`、`npm test`（230 文件 / 3146 项）。
- 原生：`NativeShellRoot`/`WebCanvasSection` 增加 `demoFragment`（默认 `fixture` 不变）；新增 `CanvasAppearanceComboTests`、`WebCanvasPerformanceTests`、`WebProcessMemorySampler`；`WebCanvasLoadingTests` 补 7 边渲染断言。原生路由完整套件 252 项 / 57 套件通过。
- 评审轮（PR #574 review 5521422435，2026-10-15）：拖拽目标改为视口内可见节点；`proc_listallpids` 的 buffersize 按字节传参（本机实证：按元素数传参只暴露约 1/4 缓冲区）；内存周界测试改为完整销毁/重建宿主画布并显式暴露进程池复用（差集为空即失败）。修正后前端 3146 项 / 原生 252 项全绿，§3.2 数值为修正轮记录。
- 评审轮二（PR #574 review 5526951136，2026-10-15）：周期内存断言改为周期自有 pid 的累计聚合 + 宿主 app 内存双有界（此前仅比较当前周期 RSS，销毁残留进程与宿主持有不在断言内）；`canvasPerfFixture.test.ts` 断言体提取为独立函数满足 80 行可执行单元上限。双侧套件复跑全绿（前端 3146 / 原生 252），§3.2 趋势数值为聚合口径记录。
- 评审轮三（PR #574 review 5527061716，2026-10-15）：聚合内存断言改为**逐样本**（中间峰值同样受界，沉降期退出不再留下断言盲区）；拖拽脚本每轮重取节点矩形（第二轮起旧坐标已离开被拖节点，会再次绕过命中测试）。双侧套件复跑全绿（前端 3146 / 原生 252），§3.2 为本轮数值。
- 评审轮四（PR #574 review 5527217491，2026-10-15）：沉降末读的进程回收由观测改为断言（30 秒受界等待后 `webContentProcessCount == 0`，此前「完全回收」只被记录未被断言）；迁移计划 §7.2 的 p95 概要与证据表对齐并区分总体/拖拽口径（此前 500 规模数值沿用旧一轮，口径未标注）。
- 评审轮五（PR #574 review 5527774215，2026-10-15）：拖拽目标的可见性判定从「矩形与视口相交」收紧为「中心点在视口内」（被视口边缘裁剪的相交节点中心可能在屏外，按下点仍绕过命中测试）；`visibleNodeCount` 改为交互前采样（此前在拖拽/平移/缩放改动视口之后才读取，与「初始 fitView 可见」口径不符，跨规模不可比）。
- 评审轮六（PR #574 review 5527896489，2026-10-15）：`mountToNodes` 的就绪时间戳改为在 300ms 沉降等待之前捕获（此前读数含人为等待，指标名不副实，修正后 465/429/1507ms）；概要中的 1000 节点拖拽 p95 与同轮表格对齐并注明单轮波动（概要用约值，表格为权威）。
- 评审轮七（PR #574 review 5528497529，2026-10-15）：0 进程回收断言存在跨套件污染路径（其它 WKWebView 套件的 WebContent 可进入归因集合）；隔离实验进一步实测进程退出时序为 WebKit 进程缓存 TTL（10–30+ 秒波动），固定窗口内的 count==0 断言测的是平台时序而非应用行为——据此把进程回收转回记录观测（逐周期 teardown+2s 残留 + 沉降末读，应用侧释放由生命周期套件断言），跨套件串行门登记 #575。
- 评审轮八（PR #574 discussion 4279531439，2026-10-15）：归属曾收紧为**恰好 1 个** pid；第 17 条新证据推翻其充分性——本页复用加外来新建仍产生单元素差集，不能据此宣称污染已被阻止。
- 评审轮九（PR #574 第 17 条，2026-10-15）：根因为缺少跨套件窗口所有权，PID 数量守卫无法替代隔离。新增基于公开 `TestScoping` 的共享异步许可，覆盖 16 个 WebKit 资源套件的完整作用域（包括 await 与 teardown），同时保留套件内部 `.serialized`；采样器检查持门前置条件并对歧义抛错。未新增生产 API、SPI 或依赖。先运行并发回归观察预期失败，再实现许可；取消与抛错均释放许可。§3.1 矩阵由 `WebKitTestIsolationTests` 的 5 项回归（并发独占、抛错释放、取消释放、门外拒绝、空差集拒绝）及完整原生路由验证：**257 项 / 58 套件全部通过（135.559s；补齐失败路径 defer 清理后的最终复核）**；`npm run check:size` 724 文件通过，`npm run build:native-canvas` 通过（保留既有 500kB chunk 提示）。双 PID 拒绝由单元素守卫检查，本轮未制造两个真实新进程；跨套件碰撞由作用域并发回归验证，未强制 WebKit 自主选择某个复用 PID。系统外来应用仍为安静环境前提，不再将单元素差集视为充分证据。
- 2026-10-17（#572）：新增 opt-in `canvas_performance` Tauri/Wry harness 与 6 项纯合同回归；每规模独立子进程、独立数据根、同步 evaluation + worker 异步结果轮询、公开 proc API 内存采样和显式失败退出。Swift 性能套件新增共同 Web 模式并输出 host/mode/viewport；既有原生面板压力模式和内存周界保持不变。首轮未修改生产 IPC、存储或依赖；评审修正轮仅为 Web runner 增加同源默认配置，见下条。
- #572 先红后绿与真实边界：合同测试先因测量模块缺失失败，实现后 6/6 通过，并以实际 Swift 编译器结果锁定 12.5ms 按半偶规则显示为 12ms；首次真实 Wry 运行揭示 async Promise evaluation 返回空及失败退出码未传播，改为 worker 轮询和显式原子退出状态后三规模通过，非法 URL 实测退出码 1。完整 `src-tauri` 路由通过（`check:size` 740 文件、workspace drift 0、`cargo fmt --check`、`clippy --all-targets -D warnings`、`cargo test`，库 385 项及合同 6 项均绿）；完整 native 路由通过（280 tests / 62 suites，175.660s），共同模式之外的既有回归未退化。
- #572 文档结构化审查：已核对 §3.4 的矩阵到实测映射、迁移计划状态/M15/§7.2、P1 历史规格与解决注记；#573 与人工验收缺口保持独立，`git diff --check` 通过。文档没有配置的自动化语义检查。
- PR #585 首轮评审（review 5551499836）：逐阶段缺样本与 RSS 不可读改为 fail-closed，脚本选项收归 Web runner 默认值，`PW-PERF` 精确 token 测试补上 §3.4 机器合同引用。三项行为回归均先红（缺省选项 TypeError、RSS Result 缺失编译错误、空阶段断言失败）后绿；前端 232 文件 / 3242 项、Rust 库 385 项与合同 7 项、native 280 tests / 62 suites（175.985s）全绿。最终实测另确认 3 份缺帧报告被拒绝而未进入证据。
- PR #585 后续评审（comment 4297921455）：补 `samples>0` 但 p50/p95 为 null 的拒绝分支，total 与四阶段统一要求数值百分位，Swift 经同一帧指标 helper 断言；null 百分位合同先红后绿，Rust 库 385 项与合同 7 项、native 280 tests / 62 suites（175.377s）全绿。上述权威实测报告各字段均已是数值，不需要以新测量替换。
- PR #585 后续评审（comment 4298097186）：Swift 共同/原生面板对比在脚本前后均要求宿主 RSS 可读且归属进程数不下降，失败不打印证据；销毁/重建趋势仍允许 0 进程观测。合成丢失样本先因守卫缺失编译失败，随后 `comparisonMemoryRejectsLostTrackedProcess` 实际执行通过；完整 native 281 tests / 62 suites（176.108s）全绿。权威表内每次采样均为 1 个归属进程，不需要替换。
- PR #585 后续评审（comment 4300770844）：Swift 证据打印前的节点/边、阶段、帧指标与交互效果统一改为显式 guard + throw，非抛出的 `#expect` 不再允许无效报告落日志。中途 `#require` 方案实测仍记录 3 issues，未冒充通过；改显式抛出后 `frameMetricsRejectMissingSamplesAndPercentiles` 与内存守卫均实际通过，完整 native 282 tests / 62 suites（175.165s）全绿。
- PR #585 后续评审（comment 4300883388）：`maxMs/over16Ms/over33Ms` 纳入抛出校验，并同轮对齐 `version`、正数 viewport 与非空 longTasks 结构；六类无效帧及三类无效元数据均先红后绿。最终 `frameMetricsRejectMissingSamplesAndPercentiles`、`reportMetadataRejectsInvalidVersionViewportAndLongTasks` 实际通过，完整 native 283 tests / 62 suites（176.222s）全绿。
- PR #585 后续评审（review 5555620878）：Rust 非空 longTasks 校验 samples/maxMs，over16/over33 改无符号整数并拒绝负时长；Swift 同步拒绝负帧统计与 longTasks。畸形计数/longTasks 合同先红后绿，Rust 库 385 项与合同 8 项全绿；native 最终 283 tests / 62 suites（176.725s）全绿。期间一次未触及的 `ShellHomeNavigationTests` 960×600 几何失败已保留记录，同套件重跑 8/8 与最终全量均通过。
- PR #585 后续评审（comment 4301510681）：Swift 数值入口统一经公开 CoreFoundation 类型检查排除 `CFBoolean`，计数字段另要求无小数部分，version/viewport/效果/longTasks 共用同一正值与整数约束。真实 `JSONSerialization` 布尔夹具先触发 6 项失败，修复后全部通过；完整 native 283 tests / 62 suites（176.161s）全绿。
- PR #585 后续评审（comment 4301636590）：Rust 在允许 `longTasks=null` 前先校验顶层字段存在，缺失字段不能被 `Value` 索引转换成“不支持能力”的证据。缺字段回归先观察到校验错误放行，修复后报告校验和 `evidence_line` 均拒绝缺失，显式 null 的正常报告仍通过；Rust 完整路由（规模、drift、fmt、clippy 与全部测试）通过，库 385 项、合同 8/8 全绿。
- 文档无配置的自动化语义检查；已按结构化审查核对 §3.2 逐项输出、§3.3 结论、迁移计划 M15/§7.2 与 Swift 测试规范，三个文档的 Prettier 检查通过。
- 一次性产物（DerivedData、打包 Web 资源、/tmp 日志）验证后清理；未触碰用户数据根。

#### CI 默认脚本回归的时钟隔离（2026-10-17，PR #586）

提交 `431e6d5` 的 [CI run 742](https://github.com/hailingu/PlotWeave/actions/runs/39044591680) 前端 3,250 项中有 1 项失败：`canvasPerfScript.test.tsx` 的默认参数测试超过默认 5,000ms；Rust、原生与 gate-evidence 均通过。这不覆盖或撤销上节本地全量通过的记录，但该提交的远端 CI 整体失败。

默认 runner 的实际等待约 4.1 秒，与 100 节点渲染、事件处理和 CI 调度共同消耗同一个 5 秒测试期限。本地未修改测试的单次基线为 4,268ms；因此单机通过不足以保证共享 runner 稳定。此次只在默认参数测试中控制 setTimeout／clearTimeout、rAF／cancelAnimationFrame 和 performance 时钟，通过异步推进执行真实 runner 与 React Flow；仍断言四阶段顺序和报告逻辑时长大于 3 秒。显式短脚本的真实时钟交互测试保持不变，afterEach 先卸载再恢复时钟。

本轮只改测试与证据文档，未改生产 runner、默认参数、内存修复或任一测试超时阈值。以下矩阵在修改前记录于任务计划；计时边界属于测试 owner，真实性能测量仍属于原生 WKWebView 套件。

| 状态／转换                     | 不变量与可观察结果                                                 | 验证                                                                                          |
| ------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 宿主省略参数                   | 真实 runner 保留默认阶段顺序与逻辑时长，不依赖 CI 实际睡眠         | 受控时钟默认参数回归；临时将生产默认等待归零时，报告 121ms，在大于 3,000ms 的断言处按预期失败 |
| 显式短脚本                     | 真实时钟与真实画布仍证明拖拽／平移效果，不把虚拟时钟读数当性能测量 | 原有交互测试不改；两项测试共同通过                                                            |
| 默认测试结束／后续真实时钟测试 | 卸载并恢复测试拥有的时钟，执行顺序不影响后续行为                   | 573–582 十个随机顺序种子，各独立运行两项测试，共 20 项通过；覆盖默认测试先运行的顺序          |
| CI 共享机器调度变慢            | 默认参数合同不再要求约 4 秒真实等待与渲染合计小于 5 秒             | 修改后默认测试单次 139ms，十次 141–196ms；最新提交的远端结果按对应 CI 记录判定                |

变异验证结束后生产文件逐字节恢复，`git diff --exit-code -- src/editor/nativeCanvas/canvasPerfScript.ts` 通过。完整前端路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 全通过：233 文件／3,250 项测试，53.70s。文档无配置的自动化语义检查；已结构化核对 CI 状态、时钟边界、矩阵和变异／重复运行结果。本轮未另跑本地原生构建，因为没有修改生产或 Swift；原生行为以上节本地全量和 `431e6d5` 的 CI 原生通过为依据，新提交仍会执行完整 PR CI。
