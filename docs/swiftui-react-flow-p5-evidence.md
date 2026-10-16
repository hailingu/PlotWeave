# SwiftUI/React Flow 迁移 P5 验证证据记录

> 任务：[issue #523](https://github.com/hailingu/PlotWeave/issues/523)（P5 视觉、输入法、VoiceOver 与性能验收尚无执行证据）。
> 分支：`fix/523-p5-acceptance-evidence`（基线 `dev` @ `10765e2`）；执行日期：2026-10-14（首轮）、2026-10-15（PR #574 评审修正轮，§3 数值以本轮为准）。
> 2026-10-17：[issue #572](https://github.com/hailingu/PlotWeave/issues/572) 在 `fix/572-tauri-perf-baseline`（基线 `67b0e03`）补齐 Tauri 共同模式基线；§3.4 数值以 PR #585 评审修正轮为准，不改写 §3.2 的历史原生面板轮。
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
- 后续补强（2026-10-16，[#568](https://github.com/hailingu/PlotWeave/issues/568) 修复）：reduce-motion 此前无属性驱动的令牌消费路径（RT/IC 有、RM 无），现已接线——动效退化规则补 `:root[data-host-reduce-motion='true']` 属性分支（五个样式表），`useAutoLayout` 的 JS 动画与媒体查询/宿主属性取或；RM 组合增加节点卡计算 `transition-duration` 等价断言（降级 ⇔ 宿主属性或媒体查询任一为真），属性驱动路径修复前该断言在真实 WebKit 上失败（3 组合），修复后 9/9 通过。
- 信息性观察：本机媒体查询 `prefers-reduced-motion` 为 false，与真实系统设置一致；宿主快照与媒体查询的真实系统切换分叉场景仍未实测（断言经强制快照构造，机器无关）。
- 未通过 / 未执行（各自独立 issue，#568 已由上述后续补强解决、不在本清单）：
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

#### 第 17 条评审修复：关键状态与不变量矩阵

进程差集的元素数无法证明逐页归属；本轮由测试侧共享串行门负责阻止宿主内其它 WebKit 套件进入归因窗口。入口包括直接创建 WKWebView、挂载 NativeShellRoot 的套件及检查宿主无画布的启动套件；各套件同时保留内部 `.serialized`。

| 前置/状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方 | 验证 |
| --- | --- | --- | --- | --- |
| 两个套件同时请求 WebKit 资源 | 首个进入并在 await 挂起，第二个请求进入 | 第二个直到首个作用域退出后才能执行 | 任一时刻最多一个套件拥有归因窗口 / WebKitTestIsolation | 并发作用域回归 + 原生完整套件 |
| 作用域抛错或任务取消 | 退出作用域，再请求同一门 | 错误向上传递，后续作用域仍能执行 | 失败不得遗留许可或允许重叠 / 共享门 | 抛错、取消恢复回归 |
| 未持有共享门 | 请求本页 PID 差集 | 显式拒绝，不产生可用于内存断言的集合 | RSS 基线只能在隔离作用域内建立 / WebProcessMemorySampler | 门外采样回归 |
| 窗口已挂载，归属或就绪检查抛错 | 测试提前退出，再转交共享许可 | defer 先拆卸窗口内容并关闭窗口 | 失败不得把活跃页面遗留给下个套件 / 性能夹具 | defer 路径结构化审查 + 真实生命周期套件；未注入真实 PID 污染 |
| 本页复用既有 PID，另一套件欲启动新页 | 持门采基线→装载→差集，另一套件等待 | 外来套件无法在窗口内启动；空差集必须抛错 | 不能把复用加外来启动的单元素差集当作本页 / 门与采样器 | 共享门竞争回归、差集歧义回归、真实 WKWebView 路由 |
| 五次销毁/重建 | 同一套件持门完成所有周期与采样 | 每次只接受单元素差集，每个累计样本与宿主 RSS 均受界 | 前后基线使用同一隔离边界 / 性能套件 | WebCanvasPerformanceTests |

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
- 打开/关闭趋势（perf:100 × 5 次完整销毁/重建宿主画布，聚合口径）：周期自有 WebContent 的累计聚合 RSS 为 119.8 → 117.2 → 118.6 → 119.4 → 118.2MB、每次装载采样进程数均为 1，沉降末读为 0MB / 0 进程（观测）。宿主 app 同期为 637.4 → 637.8 → 638.2 → 638.7 → 639.1MB，末读 638.9MB，pre-loop 636.7MB；逐样本双有界均通过。宿主 RSS 包含同进程此前执行的其它套件，不将其绝对值与旧轮孤立测量混比。teardown+2s 每周期仍观察到一个进程，退出时序不作硬断言。对照：同一 WebView 内 5 次 `reload()` 曾测得单调上升（115.6→189.9MB，首轮记录）；重导航与销毁/重建是不同周界，长循环确认仍归 [#573](https://github.com/hailingu/PlotWeave/issues/573)。
- 帧预算口径：60Hz ≈16.7ms；p50≈17ms 即贴预算运行，over16 计数见测试输出（p95 视角已列上表）。
- 消息频率/体积：演示页无宿主命令（就绪握手与外观推送之外为 0），桥接合并性能不构成本夹具瓶颈。

### 3.3 结论与边界

- 通过（安静环境下的结构性断言，进 CI 套件）：三规模节点/边计数、四阶段齐全、rAF 采样、拖拽位移/平移/缩放行程非零（拖拽目标为视口内可见节点、每轮重取坐标）、销毁/重建周期每个采样点的 WebContent **累计聚合**与宿主 app 内存均有界守卫（各 +400MB 界，含沉降末读）、共享门内每周期只接受单个新进程；进程退出时序按观测记录。
- 退化位置（按 §7.2「压力场景明确退化位置」记录，不计为未通过）：1000 节点拖拽 p95 约 60–70ms（多轮读数 62–70ms 波动，以同轮表格为权威）、超 33ms 帧约 20–29 个——压力规模下拖拽连续性显著退化，优化方向为既有渲染隔离/仅渲染可见元素等（后续任务）。
- 能力边界：WebKit 无 `longtask` 条目（报告 longTasks=null）；单刷新率（60Hz/dpr2）、单机；页面为打包演示入口而非生产编辑会话（无保存链/AI 面板参与）。WebContent 进程归属仍依赖全机 pid 基线差集，要求安静的本机环境；共享门阻止同一测试宿主的其它 WebKit 套件在归因窗口内启动页面，修复 [#575](https://github.com/hailingu/PlotWeave/issues/575) 的宿主内交错路径。若本页复用既有进程，空差集即抛错；多元素差集也抛错。**单元素差集本身不能证明逐页归属**：机器上其它应用不受测试门控制，其启动与本页复用同时发生仍可能误归属；本轮不宣称系统级独占或逐页 PID API。新增 WebKit 套件必须接入同一门，禁止退回仅依靠 `.serialized` 或 PID 数量的保证。
- 对比缺口：Tauri 同夹具基线已于 2026-10-17 由 [#572](https://github.com/hailingu/PlotWeave/issues/572) 的本轮共同模式测量补齐（见 §3.4）；同 WebView 重导航堆增长的长循环确认仍归 [#573](https://github.com/hailingu/PlotWeave/issues/573)。

### 3.4 Tauri 同夹具基线（issue #572）

#### 关键状态与不变量矩阵

| 前置 / 状态 | 动作与事件顺序 | 可观察结果 | 不变量 / 责任方 | 对应验证 / 缺口 |
| --- | --- | --- | --- | --- |
| 日常 `cargo test` 未提供测量 URL | 执行自动发现的测试目标 | 合同测试照常运行；真实 Wry 测量明确跳过，不等待外部服务器 | 常规回归保持自包含；`canvas_performance` 入口 | Rust 完整路由的无环境变量运行 |
| 本地生产画布资源已由 HTTP 伺服，规模为 100/500/1000 | 每规模启动独立 Tauri 子进程 → document-start 计时 → 节点与边全部就绪 → 300ms 沉降 → 同一脚本选项 | 返回版本化脱敏报告，输出 mount、viewport、四阶段帧统计与脚本前后 RSS | 夹具规模、脚本选项和报告口径只能有一个来源；页面 runner 与宿主校验 | URL / 报告合同测试 + 三规模真实 Wry 测量 |
| Swift 与 Tauri 做共同模式对比 | 两宿主顺序执行同一生产 bundle；Swift 收起原生面板且不中途切换，Tauri 不增加宿主操作 | 两边都有 `common-web` 记录；既有 Swift 原生面板压力轮单列 | A/B 不把 Swift 独有面板操作算入 Web 宿主差异；两性能套件 | 两宿主同轮实测；viewport 以页面报告为准，不预设完全相等 |
| URL、规模、页面报告或 JS 执行无效 | 解析配置 / 等待就绪 / 回收 evaluation | 明确错误并以非零状态结束；空载荷、错误载荷不得进入证据 | 配置与报告边界 fail closed；Tauri harness | 合同测试覆盖非法配置、错误结构、空载荷；真实加载失败以宿主导超时兜底 |
| 任一 drag/pan/zoom/panel 阶段没有 rAF 样本 | 校验该阶段 frames，即使 total 与效果有效 | 整份报告被拒绝，不输出缺少阶段指标的宿主对比 | 四阶段各自必须有独立帧样本；报告校验器 | 空阶段合同回归 + Swift 同口径结构断言 |
| 脚本轮数、步数或节奏需要调整 | 两宿主不携带参数调用 `__pwRunCanvasPerf()` | 页面 runner 的默认值同时驱动 Tauri 与 Swift | 脚本选项只能由 Web runner 拥有；宿主不得各存一份字面量 | 前端默认值行为回归 + 两宿主真实测量 |
| 已归属 WebContent PID 在脚本前或后不可读 / 已退出 | 读取该 PID 或宿主 RSS | 当前规模失败，不写 `webProcesses=0` 的有效证据 | RSS 采样只能成功或显式失败，不能用 0 冒充可读；采样器 | 不可读 PID 合同回归 + 真实前后采样 |
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
- 文档无配置的自动化语义检查；已按结构化审查核对 §3.2 逐项输出、§3.3 结论、迁移计划 M15/§7.2 与 Swift 测试规范，三个文档的 Prettier 检查通过。
- 一次性产物（DerivedData、打包 Web 资源、/tmp 日志）验证后清理；未触碰用户数据根。
