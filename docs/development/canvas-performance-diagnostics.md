# React Flow 拖动性能诊断

目标：在生产编辑器与原生演示画布中采集可比较的拖动证据，帮助区分事件处理、React 渲染与主线程调度问题。此变更属于前端／原生诊断源码与配套说明；复用现有 React Flow 回调、控制按钮、结构化 console 日志与公开 WebKit 检查 API，不增加依赖或改变文档／宿主协议。

## 使用与指标边界

画布左下角的「性能诊断」开关默认关闭，只在当前挂载会话生效。开启后拖动节点（含多选／选区整体拖动），松手后右上角显示最近一次汇总及可选择复制的 JSON，控制台输出 `[CanvasPerf]` 结构化记录。不会逐帧输出日志或更新诊断面板。

记录仅包含图规模、拖动节点数量、变更类型计数与时间统计，不含项目／节点 ID、剧本文本、坐标、资源路径或请求信息。关闭、失焦、切入后台与卸载结束采样；不保留无限事件数组。Performance Timeline 仅保留此画布最近一次 `plotweave.canvas.node-drag.editor` 或 `plotweave.canvas.node-drag.demo` measure，卸载时清除。

- `durationMs`：拖动开始至松手或中断的墙钟耗时，包含用户停顿，不等同 CPU 时间。
- `changes`／`handler`：拖动期间 `onNodesChange` 的批次数、变更类型数及同步处理耗时；React 调度、后续渲染与异步保存不包含在同步处理耗时内。
- `frames`：拖动期间 rAF 回调间隔的样本数、总量／最大毫秒及超过 32ms 的次数；首段从拖动开始算起，平均间隔可由 `totalMs / samples` 求得。它是主线程调度信号，不能当作实际显示帧率或 GPU 时间；32ms 是提示阈值，不是跨屏幕刷新率的丢帧判据。
- `react`：画布子树 Profiler 的提交次数、actualDuration 总量／最大值与 baseDuration 最大值；只计活动拖动段内收到的回调，不包含画布上层派生工作及松手后才完成的提交。无回调时为 null。普通生产构建停用 React Profiler，不能把 null 解读为零渲染开销。[React 官方说明](https://react.dev/reference/react/Profiler)。
- `reactEditor`（JSON 版本 2）：整个 `EditorWindow` 子树的同类统计，覆盖编辑器 controller 和原生投影在 render 中的同步派生工作。它包含 `react` 的范围，两组时间不能相加，也不能只用最大值相减定位上层成本；比较同一拖动段的提交次数和累计耗时，再用 CPU profile 确认。未覆盖原生 Swift 渲染、异步 effect、浏览器布局／绘制；演示入口没有整体边界，此字段为 null。
- `renderingMode`（JSON 版本 3）：本段开始时捕获的 `standard` 或 `reduced-effects`。诊断面板的「绘制特效」按钮可关闭节点阴影、内容 CSS 过渡和 Web 控件背景模糊／阴影进行对照；保留尺寸、文本、图片、端口与连线，不影响文档或历史。关闭诊断恢复标准，模式不持久化。段中切换以原模式结束旧报告，原业务拖动仍照常到松手。
- `input`（JSON 版本 4）：`events` 是进入 React Flow 拖动回调的独立源事件数，auto-pan 复用同一事件时不重复计算。`samples`／`totalMs`／`maxMs`／`over32Ms` 为事件 `timeStamp` 到该回调的时间，包含事件到达后的同步处理，不能视为硬件采样到显示的延迟。`intervals` 是独立事件回调的到达间隔，`invalidTimestamps` 计不在同一时间原点或无效的时间；无有效样本时 UI 显示未采到，不能按零延迟解释。[Event 时间与精度](https://developer.mozilla.org/en-US/docs/Web/API/Event/timeStamp)。
- `dom`（JSON 版本 4）：只观察本段主拖动节点。`updates` 统计位置回调，`matched` 统计回调到观察到内联 transform 与最新位置匹配的时间上界；包含观察器／采样调度，不包含匹配后的绘制或合成。`superseded` 计前一位置尚未观察到匹配就被新位置覆盖的次数，这可能是正常合并，并非错误次数。`frameSamples`／`behindFrames`／`maxPositionGap` 为已有 rAF 中有效的主节点坐标比较、仍有差距的采样次数与最大距离（画布单位，非屏幕像素）；`unreadableFrames` 单列节点移除／变换无法解析的刷新。`pendingAtStop` 表示结束时最新位置仍未匹配或无法读取，包括曾匹配后被旧坐标覆盖的情况。只读内联属性，不强制布局；DOMMatrix／MutationObserver 不支持、注册失败、父子节点或非零 origin 时此字段为 null，不虚报已跟上。
- `longTasks`：浏览器支持 `longtask` 时记录与本段拖动相交的长任务数量／总量／最大值，否则为 null。WKWebView 等环境的能力不足不阻断拖动，rAF 与同步计时继续工作。

### 原生生产 profiling 构建

在仓库根目录使用钉版 Node，通过显式环境标志启用 React 18 的生产 profiling renderer：

```bash
nvm use
PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

重新构建后退出旧应用再启动新实例，窗口不会热替换资源；开启画布性能诊断再拖动。`react` 和 `reactEditor` 应有实际回调样本。此模式保留生产优化，带有额外 profiling 开销，和普通构建比较时需明确模式；不是开发构建或 StrictMode 的双执行结果。[React profiling 构建说明](https://react.dev/reference/dev-tools/react-performance-tracks)。

未设置标志、设为 `0` 或其他值时，`npm run build:native` 仍生成普通生产资源；只有精确值 `1` 启用 profiling。原生 Vite 配置同时替换 `react-dom/client` 和 `react-dom`，保证 `createRoot` 与原生命令 `flushSync` 使用同一 renderer。不修改主应用 Vite 配置、依赖版本或宿主协议。

### 原生 WebKit 时间线录制

原生 Debug 构建已通过公开 `WKWebView.isInspectable` 开启检查入口；Release 默认关闭。`npm run build:native` 当前生成的原生 Debug 应用可检查，其中 Web 资源仍为普通或显式 profiling 的生产资源。[WebKit 检查 API](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)要求逐个 WebView 主动开启，新 SDK 的 Debug 构建不会自动开放。

1. 重新构建并退出旧应用、启动新实例。在 Safari「设置 → 高级」开启网页开发功能，进入「开发 → 本机」选择 PlotWeave 的画布页面（应用也可能显示为 PlotWeaveNative）。具体菜单文案随 Safari 版本和系统语言变化，见[官方开启说明](https://webkit.org/web-inspector/enabling-web-inspector/)。
2. 在独立 Inspector 窗口打开 Timelines，保留 Layout & Rendering、JavaScript & Events；先关闭 Screenshots、Memory 和 Allocations，避免附加记录影响对照。恢复标准绘制、关闭吸附，固定同一节点、缩放和窗口大小。
3. 开始录制，慢拖数秒，再快速拖动，停止录制；保存对应诊断 JSON。在 Timelines 按 ⌘S 导出录制，结合 Frames 与 Layout & Rendering 查看长间隔附近的 JS、布局、绘制与合成。[官方时间线说明](https://webkit.org/web-inspector/timelines-tab/)。录制可能包含页面内容、资源和请求信息，分享前确认内容；画布诊断 JSON 仍保持原脱敏边界。
4. 关闭 Inspector 后同条件再拖动，比较记录开销。若主线程工作短但刷新节奏仍接近 60Hz，再核对原生／WebContent／GPU 系统 profile 和显示条件；若时间线上长任务与间隔重合，按实际调用栈选择代码修复。只有优化前后同条件重复录制和体感改善，才能确认修复有效；当前平均 rAF 不能证明屏幕实际帧率。

## 排查顺序

先用相同项目、节点选择范围、缩放、外观、操作时长和构建模式重复拖动，记录图规模。修复前用户在关闭吸附后观察到卡顿与 78ms 的 rAF 间隔；后续已复现并修复点击回调引发的无关卡片执行，2026-10-09 用户确认修复后的拖动已经跟手，见「用户实测收敛」。没有真实机器 CPU／绘制 profile，不能将所有历史间隔尖峰归因于同一路径。短同步处理在粗粒度计时器上可能显示为 0ms，不能解读为完全没有成本。

1. P1：`handler.maxMs` 高，检查位置历史入口与同步状态更新；`react.maxMs` 高，结合浏览器 CPU profile 排查节点组件与订阅传播。[React Flow 官方性能建议](https://reactflow.dev/learn/advanced-use/performance)。拖动直接影响编辑操作，应优先验证。
2. P1：同步处理很短而 `frames.maxMs` 高，结合 Performance 录制检查样式、布局、绘制和长任务；不能仅凭一次间隔定位根因。
3. P2：随图规模增加而变差，比较不同节点／连线规模的上述指标；打开和关闭诊断各复测一次，估计诊断开销。
4. P2：CPU、内存／GC、异步保存 I/O、宿主桥和下游请求需要 Web Inspector／系统 profiler 的额外证据，本诊断不冒充这些测量。数据库连接池／服务器吞吐／锁竞争不属于本次浏览器拖动采样范围；若 profile 显示宿主或外部服务阻塞，再扩展调查。

绘制特效对照：保持同一 profiling 构建、关闭吸附，固定节点、缩放、窗口大小与鼠标路径，标准／简化各拖动多次，再切回标准复测。比较可感知跟手程度、rAF 尖峰频率与两层 React 指标；单个最大值容易受 GC／调度影响，不以一次差异下结论。若简化明显改善且 React 耗时接近，优先用浏览器录制拆分阴影／模糊／过渡；若没有改善，应继续检查 DOM 提交、布局、资源、WebContent／GPU 进程和原生主线程。React Flow 官方也建议在复杂图中检查阴影等样式的成本，但这不证明当前 15 节点样本的根因。[React Flow 性能说明](https://reactflow.dev/learn/advanced-use/performance)。

## 关键状态与不变量矩阵

### 单节点拖动的渲染范围（2026-10-08）

用户指出只拖一个节点却出现大量整体提交，需要直接验证无关组件的更新范围。当前两层 Profiler 嵌套：同一画布子树提交也被外层记录，277／277 不能相加，也不能证明全部 15 个节点或整个装配层执行了 277 次。139 批位置变更在当前受控 React Flow 中经过外部 React state 与 StoreUpdater effect 同步内部 store，接近两次提交的数量本身不作为缺陷判据。[React Profiler 语义](https://react.dev/reference/react/Profiler)。rAF 样本数记录采样回调，不是组件重渲染次数。

已复现并修复的扩散路径：`CanvasFlow` 内联创建 `onNodeClick`，每个外部位置更新都会改变它的引用；React Flow 的 NodeRenderer 把该回调传给全部 memo 节点容器，使未移动节点的 props 也变化。自定义节点组件未另包 memo，因此执行无关卡片内容。三个连续位置帧中，未移动卡片的执行计数从基线 3 增至 6；浏览器与 Swift 宿主入口均复现，多选时未选中的第三张卡也执行三次。稳定节点／空白点击回调后，未移动卡片的计数保持基线，被拖卡片仍更新。[React Flow 性能建议](https://reactflow.dev/learn/advanced-use/performance)要求稳定组件和回调。这一传播会随节点数量放大；本轮消除已证明的扩散，不以总体提交数代替实际节点执行测量。

最小范围：使用真实 React Flow 手势和真实场景卡片的渲染计数先复现，再稳定原生节点／空白点击接线。受控节点状态、画布更新、连线、历史、保存与诊断 Profiler 保留原 owner；不节流位置、不改框架或把必要提交隐藏在统计之外。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量、所有者／入口 | 测试／验证计划 |
| --- | --- | --- | --- | --- |
| R1 | 浏览器／Swift 宿主，诊断开／关，节点 A 已选中 → 拖动 A 多个位置帧 | A 正常移动；未移动 B／C 的真实卡片组件不额外执行 | `CanvasFlow` 稳定传给节点容器的点击回调；框架仅按实际节点变化更新容器 | 通过：真实节点组件计数与 DOM 坐标先红后绿；两个宿主入口用相同生产编辑器，诊断开启时也验证渲染范围 |
| R2 | 拖动／面板更新结束 → 普通节点点击／空白点击，或多选／端口／文本点击 | 原生检查器仍消费当前目标；多选和编辑交互保持 | 稳定回调仍依赖当前动作函数；不冻结选择或使用旧闭包 | 通过：既有 nativeEditorShell 的普通点击、空白、当前目标切换与组合键／端口／文本用例 |
| R3 | 单／多选拖动 → 松手 → 撤销／重做／保存 | 全部被拖节点更新；未拖节点保持；整段一步历史，保存最新落点 | 文档与历史 owner 不变；渲染隔离不能漏业务更新 | 通过：新回归验证多选卡片执行范围与位置、一步撤销；既有生产拖动／历史／保存回归 |
| R4 | 修复版原生画布，15 节点／15 连线、简化特效 → 拖动 1 个节点 | 用户操作体感跟手；输入与 DOM 统计仍可取得 | 原生产文档与诊断 owner 保持；实际体感不能由合成 DOM 或提交计数替代 | 通过：2026-10-09 用户提供版本 4 汇总，并明确答复「已经跟手」；本次反馈未覆盖标准特效、更大图或实际呈现刷新率 |

不新增持久化格式、宿主协议、异步队列或错误恢复入口，存储并发／重试沿用现有矩阵。测试测量实际卡片执行，组件输出仍来自真实实现，不替换 React Flow；合成 DOM 无法证明 GPU 呈现或真实机器体感改善，完成后仍需同项目实测。

### 原生 Web Inspector 与高刷新率调查（2026-10-08）

用户版本 4 样本：15 节点／15 连线，简化特效、吸附关闭，拖动 2103ms，193 个独立输入事件、194 批位置变更。输入到回调平均约 3.88ms／最大 32ms；193 次主节点位置更新均观察到 DOM 匹配，平均约 1.37ms／最大 2ms，未覆盖未匹配位置，结束无待匹配位置。3／116 个 rAF 位置比较仍有差距，最大 113.8 画布单位；这可能是提交之前的观察，不能当作屏幕或鼠标实际落后距离。React 画布／整体最大 2／4ms，也不包含后续绘制／合成。

用户确认显示器是 ProMotion／120Hz 或更高；本段 rAF 平均间隔约 17.59ms（约 56.9 次回调／秒），接近 60Hz，最大 87ms、3 次超过 32ms。P1 候选为嵌入式 WebKit 的刷新节奏或绘制／合成调度，影响持续拖动跟手程度；rAF 频率不等于显示帧率，一段平均值也不能证明宿主锁定 60Hz。[WebKit 开放问题 #294338](https://bugs.webkit.org/show_bug.cgi?id=294338)记录 WKWebView 高刷新率支持请求，但主要报告环境为 iOS，不证明当前 macOS 的根因。零星长间隔还可能来自 GC、布局、资源或原生主线程，需要时间线／系统 profile 区分。Web 简化特效未改善体感，并未覆盖 SwiftUI 底部缩放栏的玻璃合成。图规模拐点、宿主排队／锁与 I/O 尚无 profile；连接池及下游请求不在当前拖动同步链路中，只有录制出现相应阻塞再扩展。

后续标准模式样本仍为 15 节点／15 连线：1341ms、139 批位置变更、138 个独立输入事件。输入到回调平均约 6.67ms／最大 18ms，活动回调到达间隔平均约 8.33ms（约 120 次／秒）、最大 13ms，无超过 32ms 的间隔。138 次位置更新都观察到 DOM 匹配，平均约 1.41ms／最大 8ms，无未匹配覆盖或结束残留；只有 1／73 个位置刷新比较仍有差距。画布／整体 React 累计 89／134ms、最大 6／7ms，仍是嵌套统计，不能相加。

该段 78 个 rAF 间隔平均约 17.14ms（约 58.3 次回调／秒），唯一超过 32ms 的间隔为 83ms；除去这一段，其余 77 段平均约 16.29ms。输入回调约 8.33ms、rAF 约 17ms 的节奏差支持继续调查刷新／呈现调度，但不能证明每次回调均改变了像素或屏幕固定 60Hz。标准和简化下均观察到约 17ms 的平均 rAF，尚无特效改善的因果证据；两段拖动路径、速度和 Inspector 附加开销未核对，输入均值与最大 React／DOM 的差异不能作为严格 A/B 回归结论。83ms 尖峰的 JS／GC、布局、绘制、合成或宿主原因仍未知，`longTasks: null` 不能排除长任务。用户确认尚未录制 Timelines，当前收到的仍是版本 4 汇总 JSON，并非 Safari 导出的录制，I3 的证据缺口保持。

本轮最小范围：原生 Debug 构建在创建 WKWebView 时开启公开 `isInspectable`，补齐 Safari Web Inspector 录制入口；Release 保持公开 API 的默认关闭。原生构建配置与 Web 生产／profiling renderer 是独立维度，`npm run build:native` 当前使用原生 Debug 配置。先写真实宿主检查属性回归，再实施；不修改鼠标处理、受控节点同步或私有刷新率偏好。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量、所有者／入口 | 测试／验证计划 |
| --- | --- | --- | --- | --- |
| I1 | 原生 Debug → 创建真实生产宿主 → 夹具就绪 → 收展面板 | WKWebView 可检查，节点仍加载，同一页面／实例保持 | `WebCanvasHostView.makeNSView` 持有公开检查开关；面板更新不创建新会话、不重置检查属性 | 通过：真实宿主回归先观察缺少 opt-in 失败；Debug 聚焦与串行全量验证就绪、身份、页面存活和收展后的属性 |
| I2 | 原生 Release → 创建相同宿主 → 夹具就绪／面板更新 | WKWebView 不主动开启检查 | 编译配置控制入口；Web renderer 标志不能启用原生 Release 检查 | 通过：同一真实宿主套件在 Release 配置验证关闭边界、节点就绪与面板更新 |
| I3 | Debug 检查入口 → Safari 录制一次标准特效拖动 → 关闭 Inspector 再拖动 | 获取帧、布局／绘制、JS 时间线，并比较检查器附加开销 | 录制由用户开启；不自动读取内容或上传，诊断开关与 Web 编辑 owner 保持 | 真实用户机器录制待补；自动测试只能证明入口属性及页面存活，不能证明 120Hz 呈现或卡顿已修复 |

不新增持久化、网络、命令、重试或异步队列，存储并发和失败恢复维度沿用原宿主矩阵。最低部署 macOS 26.0 已覆盖公开检查 API 的可用性；加载失败／重试继续由既有状态与加载回归负责，不增加检查器专用恢复状态。验证使用临时源副本与相同工程／相对 DerivedData 路径，避免改写用户已有应用和资源；临时产物在完成前删除。

### 输入与 DOM 延迟（2026-10-08）

用户版本 3 对照：标准 1503ms／152 批位置更新／85 个 rAF 间隔／最大 55ms／2 次超过 32ms，简化 1432ms／103 批／83 个间隔／最大 40ms／3 次超过 32ms，体感仍不跟手。整体 React 最大分别 2ms／3ms；尚无证据支持特效是主要原因。安装版本的受控节点同步 effect 解释两次提交，未发现坐标取整或旧位置回写的项目代码；不能据此认定框架同步就是根因。

本轮范围：在版本 4 增加事件创建到拖动回调的时间、回调到主拖动节点内联 transform 匹配的观察延迟、rAF 时最新位置是否尚未匹配。只读 DOM 内联样式，不强制布局、不写节点、不合并或同步强刷更新。只观察主拖动节点；父子节点／非零 origin 与无法解析的变换明确表示未支持。DOM 匹配不代表屏幕完成绘制；硬件到事件创建、WebKit 合成与原生主线程仍是验证缺口。若输入延迟高，优先用 WebContent／宿主 profile 查事件处理与调度；若 DOM 延迟或落后采样多，检查受控同步与 DOM 提交；若两者都低而体感仍差，继续调查绘制／合成与显示刷新，不能继续用 render 耗时替代。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量、所有者／入口 | 测试／验证计划 |
| --- | --- | --- | --- | --- |
| L1 | 开启 → 拖动回调 → DOM 延后匹配／匹配后旧位置覆盖 → rAF → 松手 | 分别汇总输入时间、DOM 延迟与落后采样；不匹配时不虚报已更新 | latency sampler 只观察当前主节点；recorder 持有段与资源；两个画布入口传入真实事件 | 确定时钟与真实 DOM MutationObserver、位置回退回归通过；生产／演示手势保留坐标与历史 |
| L2 | 同帧连续事件／auto-pan 复用事件 → 多次位置更新 → DOM 追到最新位置 | 覆盖未匹配位置计入 superseded，复用事件不重复输入计数 | 固定空间保存最新位置，不保留轨迹、标识、内容或事件列表；只发布数值 | 连续更新、同事件更新、脱敏与刷新位置差通过；位置帧保持回调身份通过 |
| L3 | DOM 不可用／observer 注册失败／非法事件时间 → 拖动 | 缺失 DOM 为 null，时间无效计数可见，其余统计正常 | 能力失败不阻断业务回调；测量不改变节点几何 | 两种 API 缺失、非法时间／移除／变换／注册失败、原回调异常与父子／origin 降级通过 |
| L4 | 活动段 → stop／关闭／失焦／隐藏／卸载 → 过期 observer → 新段 | 末批观察排空，采样解除；旧段不改写，新段独立 | recorder 与 hook 生命周期释放观察器与元素引用；原业务 stop 始终执行 | 结束前尚未投递匹配、过期通知隔离及既有关闭／卸载／StrictMode／恢复回归通过 |

不新增持久化、宿主消息、重试或后台队列，存储并发维度不适用；真实显示与系统调度不由合成 DOM 证明。

### 绘制对照（2026-10-08）

用户 profiling 样本为 15 节点／15 连线、1197ms、61 批位置变更、122 次两层 React 提交，画布累计 50ms／最大 3ms，整体累计 83ms／最大 6ms，rAF 最大 88ms／2 次超过 32ms。两次提交与安装版本的受控节点更新及 StoreUpdater effect 同步内部 store 的链路相符；提交数本身不是缺陷证据。最大 React render 未覆盖 DOM 提交、布局、绘制、GC、系统调度与 Swift，不足以解释或排除卡顿。

P1 待验证假设：原生控件背景模糊、节点阴影和过渡参与绘制／合成尖峰。增加诊断面板内默认关闭的「绘制特效：标准／简化」对照，仅在诊断开启时生效；不修改标准外观，不添加未经验证的永久 GPU 提升。版本 3 报告记录本段的 `renderingMode`，避免混用模式。此对照改变特效组，不足以独立归因到某一条 CSS 或证明绘制是唯一根因。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量、所有者／入口 | 测试／验证计划 |
| --- | --- | --- | --- | --- |
| V1 | 诊断关闭／标准 → 开启 → 切为简化 → 拖动／撤销 | 当前画布取消阴影、过渡与 Web 控件模糊，报告标记简化 | hook 持有会话模式；节点、连线、尺寸、选择、历史与保存归原 owner，不重新挂载 | CSSOM 两种加载顺序通过；生产手势落点／一步撤销与演示入口模式接线通过 |
| V2 | 简化 → 标准／关闭诊断 → 再次开启 | 外观恢复标准；下段报告标记标准 | 模式仅影响本画布、只在开启诊断时生效，不持久化 | 两个根的 CSSOM 隔离与恢复、hook／生产开关回归通过 |
| V3 | 活动段 → 切换模式／关闭 → 新段 | 旧段以原模式结束，新段统计独立 | recorder 在开始捕获模式，不能事后改写报告；不遗漏业务 stop | recorder 独立快照、hook 活动段切换／恢复与真实编辑器手势切换后一步撤销通过 |

暂不增加保存、重试或宿主协议，沿用既有恢复矩阵。真实 GPU／布局效果依然需要同一节点、路径、缩放、窗口大小的标准／简化往返复测；若简化没有改善，继续用 Web Inspector／系统 profiler 排查提交、GC 与宿主，不能宣称此对照已经修复卡顿。

### 本轮补充（2026-10-08）

用户关闭吸附后的样本为 15 节点／15 连线、拖动 1050ms、99 批位置更新、同步计时 0ms、最大 rAF 间隔 78ms、3 次超过 32ms；换过节点，不能与上一段视为严格对照。计时分辨率会使短同步处理显示为零。已确认存在调度间隔尖峰，尚不能将其归因于 React、绘制、GC 或宿主。原生投影在编辑器上层每次渲染生成大纲并序列化，属于待测候选，现有画布子树统计无法覆盖。

本轮范围：补充显式生产 profiling 构建和编辑器整体 React 统计，保持普通构建、吸附、历史、保存和宿主协议。`react` 保留画布子树语义，新增 `reactEditor` 并将 JSON 版本升为 2；两者嵌套，不能相加。不依据缺失的 profile 提前修改业务热路径。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量、所有者／入口 | 测试／验证计划 |
| --- | --- | --- | --- | --- |
| S1 | 普通生产构建 → 同步挂载与更新真实 React Profiler | DOM 正常更新，无 Profiler 回调 | 原生 Vite 配置默认仍为普通生产；不改变主应用构建 | `vite.native-canvas.test.ts` 的未设置、`0` 与其他值三个实际打包／DOM 用例通过 |
| S2 | `PLOTWEAVE_CANVAS_PROFILE=1` → 同步挂载／更新，调用 `flushSync` | DOM 正常更新且 Profiler 回调携带数值 | 原生 Vite 将 `react-dom` 与 `react-dom/client` 解析到同一 profiling renderer；无依赖升级 | 同文件的真实生产回调用例先因缺少样本失败，实现后通过 |
| S3 | 生产编辑器开启诊断 → 拖动 → 上层与画布渲染 → 松手 | 一段报告分别包含整体和画布统计 | `EditorPerformanceBoundary` 注册当前画布 recorder；不混算两层、不提前发布，不采集内容 | recorder 两层确定数据用例与真实编辑器手势的两个样本断言先失败后通过 |
| S4 | 默认关闭／段结束／StrictMode 清理／卸载 → 后续上层提交／重挂载 | 不采样无活动段，监听随 owner 释放，新段可独立采样 | 边界与 hook 的注册／注销不遗留旧 recorder，不影响回调和坐标 | hook 在真实边界内的 StrictMode、段外提交、卸载／重新挂载、关闭／中断用例通过 |

本轮不新增保存、重试或并发队列；这些维度沿用 P1–P6。生产打包测试使用合成 DOM，不能替代真实 WKWebView 绘制／系统 CPU profile；后续需同节点、缩放和路径复测，并把整体与画布耗时同帧间隔共同判断。

所有者：`useCanvasPerformance` 管开关与原回调接线，`canvasPerformance` 管单段采样及浏览器资源，`CanvasPerformancePanel` 管可见报告。入口为生产 `EditorCanvasRegion` 和演示 `NativeCanvasApp`，均使用同一采样能力。诊断不新增保存／重试／网络请求，因此存储并发与下游重试不适用。

| 编号 | 前置状态、动作与顺序 | 预期可见结果 | 跨转换不变量 | 对应验证／缺口 |
| --- | --- | --- | --- | --- |
| P1 | 默认关闭 → 拖动 → 松手 | 节点照常移动，无采样／报告 | 原回调、坐标与历史语义保持；关闭时不读计时器／启动观察器 | `EditorCanvasRegion.performance.test.tsx` 默认关闭用例与 `useCanvasPerformance.test.tsx` 直通用例通过 |
| P2 | 开启 → 单／多节点拖动 → 变更 → 提交 → 松手 | 一段一份报告，图规模和类型／耗时统计正确 | 不逐帧发布；不收集内容或标识；历史与保存仍由原入口持有 | 性能集成测试的单／多选、坐标、一步撤销与日志／JSON 一致性通过；`canvasPerformance.test.ts` 确定时钟统计通过；既有位置历史／保存集成随全量测试通过 |
| P3 | 一段结束 → 下一段开始／重复 stop | 新段统计独立；重复 stop 不重复发布 | 有界资源，不跨段串样本 | recorder 的跨段、重复 stop 与最新 measure 取代测试通过 |
| P4 | 采样中 → 关闭／失焦／隐藏／卸载 → 重新开启 | 终止当前段，释放 rAF／观察器；新段可恢复 | 不遗留任务，不在卸载后更新 React 状态；保留原事件异常 | hook 关闭／失焦／隐藏／恢复及 StrictMode 测试通过；recorder 的卸载后过期帧、异常传播／恢复与 observer 断开测试通过 |
| P5 | 缺少 longtask／measure 能力，或 observer 注册失败 → 拖动 | 不支持的字段为 null，支持部分仍输出 | 诊断失败不吞原处理异常，不阻断编辑 | recorder 的 longtask 不可用／注册失败、measure 失败／清理失败降级测试通过 |
| P6 | React 普通生产构建 → 拖动；开发／显式 profiling 构建 → 拖动 | 前者 React 字段 null，后者记录实际回调样本 | 无样本不虚报为 0ms；两个画布入口一致 | recorder 有／无回调及演示真实拖动通过；生产 renderer 语义由 S1／S2 实际执行验证。真实 WKWebView profiling 性能／触控板仍未测 |

## 验证记录

2026-10-08，仓库根目录，Node 24.18.0：

- Red：`npm test -- src/editor/EditorCanvasRegion.performance.test.tsx` 因缺少诊断开关失败；时间线清理失败的新增用例也先观察到异常阻断报告，再修复。
- Green：`npm test -- src/editor/EditorCanvasRegion.performance.test.tsx src/editor/canvasPerformance.test.ts src/editor/useCanvasPerformance.test.tsx src/editor/nativeCanvas/NativeCanvasApp.performance.test.tsx` 所含 15 个新用例均在全量回归中通过。
- 前端 Scope Routing：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 各项通过；文件大小检查覆盖 712 个维护文件，全量测试为 214 个文件／3083 个用例。首次静态命令链的后续命令误用了默认 Node 22，随后显式设置整条命令链的 Node 24 PATH 重跑大小、类型与构建并通过。
- 首次全量测试的 17 个失败来自执行沙箱禁止 `ps`（EPERM）；在允许读取测试进程身份的环境重跑 `npm test`，全部通过。测试只操作临时 Git 夹具，不提交／推送工作仓库。
- 附加验证：`npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-diagnostics-verification` 通过，保留单文件 IIFE 大于 500kB 的构建提示；临时资源与本次 `dist/` 验证产物已删除，既有原生构建产物未改动。
- 结构化复核：报告字段、两处入口、隐私、事件／清理时序、模块依赖、函数／文件大小与 UI 文档链接；`git diff --check` 通过。文档没有配置的自动化检查。没有进行当前仓库的提交／推送，因此未运行 Sonar Git 操作门禁；没有改动 Swift／Rust，未执行 Xcode／Cargo 路由。

剩余证据缺口：真实用户项目、WKWebView 绘制／布局、触控板、内存／GC 和系统 CPU profile；本次交付诊断能力，不声称卡顿根因已定位或性能已修复。

### 生产 profiling 与整体统计补充验证

2026-10-08，仓库根目录，Node 24.18.0：

- Red：`npm test -- vite.native-canvas.test.ts` 在显式开启时因生产 Profiler 无挂载／更新样本失败；普通生产用例通过。`npm test -- src/editor/canvasPerformance.test.ts src/editor/EditorCanvasRegion.performance.test.tsx` 的新增两层统计用例因整体字段缺失／混算失败，再实现隔离汇总及外层边界。
- Green：新增生产打包语义 4 例、recorder 隔离 1 例、真实边界生命周期 1 例均通过；现有生产手势用例同时确认两层都有样本且保留坐标、历史、隐私与单次报告。
- 相关回归：`npm test -- vite.native-canvas.test.ts src/editor/canvasPerformance.test.ts src/editor/useCanvasPerformance.test.tsx src/editor/EditorCanvasRegion.performance.test.tsx src/editor/nativeCanvas/NativeCanvasApp.performance.test.tsx src/editor/EditorCanvasRegion.alignment.test.tsx src/editor/EditorCanvasRegion.keyboard.test.tsx src/editor/positionFrameRender.test.tsx src/editor/nativeCanvas/nativeEditorShell.test.tsx src/moduleGraph.test.ts`，10 文件／105 用例通过。
- 前端 Scope Routing：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict`、`npm run build` 和 `npm test` 全部通过；大小检查 714 文件，全量 215 文件／3089 用例。全量仍在允许测试夹具读取 `ps` 身份的沙箱外环境运行，没有仓库提交／推送。
- 实际原生资源构建：`PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-profile.ijoBP0/normal` 与 `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-profile.ijoBP0/profiling` 均通过；分别约 724.52kB／733.63kB，保留既有单文件大于 500kB 提示。临时输出与本轮 `dist/` 已删除；用户已有原生应用／WebCanvas 未改写。
- 结构化复核：显式模式边界、同一 renderer、报告版本／嵌套指标语义、注册清理、文档交叉引用与函数／文件大小；`git diff --check` 通过。文档无配置的自动化检查。未改 Swift／Rust，未跑 Xcode／Cargo；未提交／推送，未跑 Sonar Git 操作门禁。

该轮修复生产诊断缺口，未宣称实际卡顿已消失；后续用户已提供 profiling 与版本 3 特效对照，分析见本页「输入与 DOM 延迟」。此前间隔尖峰的具体来源仍未确定。

### 绘制对照补充验证

2026-10-08，仓库根目录，Node 24.18.0：

- Red：`npm test -- src/editor/canvasPerformanceEffects.test.ts src/editor/EditorCanvasRegion.performance.test.tsx src/editor/canvasPerformance.test.ts`，分别因特效未退化、画布模式状态缺失和报告未记录模式失败。CSS 用例读取真实样式交给 CSSOM 求值，没有源码文字／布局断言；Vite 的测试 CSS 导入替身不提供实际规则，改为读取真实文件后观察到预期的阴影断言失败。
- Green：同上三文件及 `src/editor/useCanvasPerformance.test.tsx`、`src/editor/nativeCanvas/NativeCanvasApp.performance.test.tsx`，5 文件／23 用例通过。新增 6 个用例覆盖 V1–V3，既有演示手势也确认简化模式的实际接线；真实 WebKit 绘制性能不由合成 DOM 验证。
- Scope Routing：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build` 通过，大小检查 715 文件；`npm test` 全量 216 文件／3095 用例通过，仍使用允许测试夹具读取 `ps` 身份的环境。
- 资源构建：`PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-effects.Dn9EVH/normal` 与 `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-effects.Dn9EVH/profiling` 通过，脚本约 725.40kB／734.51kB，保留既有单文件大于 500kB 提示。临时输出与本轮 `dist/` 已删除；用户已有 native 应用／资源未改动。
- 结构化复核：默认标准、原生／演示接线、两种 CSS 顺序、双画布作用域、段开始模式快照／中断、原业务 stop 与历史、文档指标／交叉引用、源码与函数大小；`git diff --check` 通过。文档无配置的自动化检查。未改 Swift／Rust，未跑 Xcode／Cargo；无提交／推送，未跑 Sonar Git 操作门禁。

后续用户提供的标准／简化样本体感均不跟手，首轮对照没有支持特效是主要原因；详见本页「输入与 DOM 延迟」。间隔尖峰仍未归因，该轮交付可逆诊断实验，没有永久改变标准绘制，也不宣称卡顿已修复。

### 输入与 DOM 延迟补充验证

2026-10-08，仓库根目录，Node 24.18.0：

- Red：`npm test -- src/editor/EditorCanvasRegion.performance.test.tsx` 的真实拖动因没有输入样本失败；新 sampler 测试最初无法导入缺失模块。新增「曾匹配后旧位置覆盖」用例先因结束时未标记落后失败，随后按结束时实际 DOM 匹配状态修复。
- Green：`npm test -- src/editor/useCanvasPerformance.test.tsx src/editor/canvasDragLatency.test.ts` 共 17 用例通过，包含 11 个新增用例；生产／演示入口在全量测试中确认真实手势产生输入与 DOM 数据，坐标、选择、脱敏和一步撤销保持。L1–L4 的对应结果见矩阵；行为异常测试在 act 内断言原错误，确保测试正确等待报告状态发布。
- 前端 Scope Routing：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build` 全部通过，大小检查 717 个维护文件；`npm test` 全量 217 文件／3106 用例通过（56.17s）。全量在允许测试夹具通过 `ps` 读取自身进程身份的环境执行，不进行当前仓库提交／推送。
- 资源构建：`PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-latency.CWqkti/normal` 与 `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-latency.CWqkti/profiling` 通过，脚本约 729.79kB／738.90kB；保留既有单文件大于 500kB 提示。仅生成验证资源；临时输出和本轮 `dist/` 已删除，用户既有 native 应用／资源未改动。
- 结构化复核：两个入口、只读内联变换、主节点坐标支持边界、复用事件、数据有界／脱敏、回调引用稳定、异常与观察器释放、报告版本和文档交叉引用、文件／函数大小；`git diff --check` 通过。文档没有配置的自动化检查。没有改 Swift／Rust，因此未执行 Xcode／Cargo；没有提交／推送，因此未执行 Sonar Git 操作门禁。

该轮完成延迟采样，未修复或确认实际不跟手根因。后续用户已提供版本 4 数据，并确认吸附关闭、使用 ProMotion／120Hz 或更高显示器；分析见本页「原生 Web Inspector 与高刷新率调查」。WKWebView 绘制／合成、实际呈现刷新率与系统调度仍需时间线证据。

### 原生检查入口补充验证

2026-10-08，Node 24.18.0、Xcode 27.0（27A266a）／SDK 27.0、macOS 27.0.1：

- 本轮修改 `native/macos/App/WebCanvasHostView.swift`、`native/macos/Tests/ShellWebCanvasLifecycleTests.swift` 和本页、UI §3.6、原生功能补齐说明；沿用已授权分支，不改此前前端诊断实现或用户文件。I1–I3 在生产修改前记录，I1／I2 验证通过，I3 仍等待用户机器时间线。
- 仓库根 `npm run check:size` 通过：717 个维护文件、65 个排除项。为保留用户已有原生 app／WebCanvas，复制当前源到 `/private/tmp/plotweave-inspector.m5xy8vmy/`，复用依赖，通过同一工程和相对 `native/macos/build/DerivedData` 路径运行验证，没有使用替代工程或改写原始构建。
- 临时副本根 `npm run build:native-canvas` 通过（403 模块），保留既有单文件大于 500kB 提示。该副本根执行原生路由的 `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`，默认并行 170 tests／45 suites 退出 65，出现 6 项问题：既有退出委托、检查器展开、工具栏几何及画布宽度恢复；新增检查入口回归通过。上述失败已有项目记录，没有放宽断言或宣称默认路由通过。
- Red／Green：同一 Xcode 命令追加 `-only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests`。Red 先在真实已加载页面观察到 `isInspectable == false`，新增测试两项断言失败；最小 Debug opt-in 后聚焦 3 tests／1 suite 通过。相同完整 Xcode 命令追加 `-parallel-testing-enabled NO`，170 tests／45 suites 全通过（62.906s），不视作默认并行夹具问题已修复。
- Release：同一 Xcode 命令追加 `-configuration Release ENABLE_TESTABILITY=YES -parallel-testing-enabled NO -only-testing:PlotWeaveNativeTests/ShellWebCanvasLifecycleTests`，3 tests／1 suite 通过，真实 WebView 检查属性为 false。`ENABLE_TESTABILITY` 仅供测试访问内部宿主，不设置 DEBUG 或修改工程。编译保留范围外 `NativePublicDNS.swift` 的既有 `String(cString:)` 弃用警告，AppIntents 元数据跳过提示及系统 WebKit 诊断；本轮源代码未产生新的编译警告。
- 日志保留在临时目录的 `inspector-red.log`、`inspector-green.log`、`inspector-native-full.log`、`inspector-native-serial.log` 与 `inspector-release.log`。验证源副本、依赖符号链接、生成画布、应用与 DerivedData 已清理；用户原始应用／资源保持。新方法与实质修改方法在 80 代码行内，Swift 文件分别 374／218 物理行；文档按指标语义、构建边界、状态矩阵与交叉引用结构化复核，文档无配置的自动语义检查，`git diff --check` 通过。

本轮未改前端／Rust，沿用此前前端全量通过证据，未重跑其完整路由或 Cargo。未提交、推送或发布应用，因此未运行 Git 操作的覆盖率／SonarQube 门禁与 PR CI。没有自动录制用户页面；真实 Safari 连接、120Hz 实际呈现、拖动绘制／合成和系统 profile 仍未验收，当前实现只补齐 Debug 检查能力，不宣称性能根因已经确认或卡顿已修复。

### 拖动渲染范围修复验证

仓库根目录，Node 24.18.0，沿用 `codex/swiftui-react-flow`：

- R1–R3 在生产修改前记录。Red：`npm test -- src/editor/EditorCanvasRegion.nodeRender.test.tsx`，浏览器／Swift 单节点与多选三个真实拖动用例均因未移动卡片计数从 3 增至 6 失败，节点坐标符合手势。Green：稳定点击回调后同三个用例通过；再补诊断开启时的浏览器／Swift 用例，同一文件 5 用例通过，诊断开关不扩大卡片执行范围。测试使用真实场景卡片与 React Flow，仅在卡片入口累加计数；Happy DOM 夹具固定画布几何以避免自动平移，并排空框架松手后的临时点击抑制，不修改生产交互。
- 聚焦：`npm test -- src/editor/EditorCanvasRegion.nodeRender.test.tsx src/editor/EditorCanvasRegion.performance.test.tsx src/editor/EditorCanvasRegion.keyboard.test.tsx src/editor/EditorCanvasRegion.alignment.test.tsx src/editor/positionFrameRender.test.tsx src/editor/EditorCanvasRegion.renderIsolation.test.tsx src/editor/nativeCanvas/nativeEditorShell.test.tsx src/editor/useNodeDragHistory.test.tsx`，8 文件／70 用例通过（补诊断开启用例之前）。当前目标／空白／组合键／端口／文本交互、实际坐标、整组历史和保存的既有回归保留。
- 前端 Scope Routing：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build` 全部通过，718 个维护文件；最终 `npm test` 全量 218 文件／3111 用例通过（52.15s）。全量测试的临时 Git 夹具获准通过 `ps` 读取自身进程身份，没有当前仓库提交或推送。
- 原生画布资源：`PLOTWEAVE_CANVAS_PROFILE=0 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-render.mdssH5/normal` 与 `PLOTWEAVE_CANVAS_PROFILE=1 npm run build:native-canvas -- --outDir /private/tmp/plotweave-canvas-render.mdssH5/profiling` 通过，脚本分别 729.93kB／739.04kB；保留既有单文件大于 500kB 提示。仅用于验证，临时资源和本轮 `dist/` 已删除，未改写用户已有原生应用／资源。
- 本轮源码为 `EditorCanvasRegion.tsx` 的稳定点击接线，新增 `EditorCanvasRegion.nodeRender.test.tsx`，同步本页、UI §3.6 与原生功能补齐说明。结构化复核回调依赖、节点更新 owner、三种手势与诊断开／关、矩阵结果、文档链接和文件／函数大小；两个源码文件分别 313／211 行，实质修改执行单位在 80 代码行内，`git diff --check` 通过。文档无配置的自动化语义检查。本轮未改 Swift／Rust，未重跑 Xcode／Cargo；无 Git 发布操作，未执行其 Sonar／覆盖率门禁。

已消除项目代码中由点击回调引用变化造成的无关卡片执行。受控节点外部状态与内部 store 的必要同步仍存在，因此两层 Profiler 的提交总数可能仍接近每批两次；这不抵消实际卡片执行范围的收窄。该轮交付时真实机器体感尚待复测；后续验收见下一节，本轮不据合成 DOM 宣称所有卡顿原因已消除。

### 用户实测收敛（2026-10-09）

用户提供修复后的版本 4 样本：简化特效，15 节点／15 连线，拖动 1 节点 1235ms，143 批位置变更；画布 React 285 次提交／累计 30ms／最大 2ms，编辑器 286 次／累计 67ms／最大 2ms。142 个独立输入事件，事件到回调平均约 7.18ms／最大 31ms，到达间隔平均约 8.45ms；142 次位置更新均观察到 DOM 匹配，平均约 1.04ms／最大 3ms，`superseded: 0`，结束没有待匹配位置。73 个 rAF 间隔平均约 16.85ms，最大 36ms／1 次超过 32ms。用户在询问本轮修复后的体感时明确答复「已经跟手」，R4 的真实操作验收通过。

`behindFrames: 49/73` 只表示采样回调执行瞬间，内联 transform 与最新回调坐标不同；不是屏幕落后 49 帧或 40.1 像素。当前 sampler 在 rAF 内立即比较，React Flow 的受控节点先更新外部 state，再由 StoreUpdater effect 同步内部 store；采样可能发生在同一次绘制之前的提交前。所有位置在最多 3ms 内观察到匹配、没有未匹配覆盖或松手残留，与「频繁看到短暂未提交位置」相容，但没有时间线就不能确认每次回调和绘制的具体顺序。React 也说明交互触发的 effect 及其更新不保证固定的绘制先后顺序，[effect 时序说明](https://react.dev/reference/react/useEffect#caveats)。因此本轮不据该计数增加节流、强制同步或新的调度实现。

提交数仍接近位置批次的两倍，与受控同步及嵌套 Profiler 的既有解释一致；实际卡片执行范围已由回归确认收窄，用户体感已改善。该样本与修复前拖动时长、特效及路径不构成严格 A/B，不能单凭累计耗时给出性能改善百分比或归因全部历史尖峰。Safari／系统 profile 未采集，标准特效和更大图未在本次反馈中复测，实际 120Hz 呈现仍没有证据；这些边界不扩张本次已通过的实际拖动验收。

本轮只补充本页、UI §3.6 和原生补齐记录，不改变源代码或生成资源。结构化复核样本算术、指标含义、R1–R4 结果与交叉引用；文档没有配置的自动语义检查，运行定向 Prettier 与 `git diff --check`。此前完整前端检查和 218 文件／3111 用例结果仍对应当前源码，本轮没有代码变化，不重复其完整测试、构建、Xcode／Cargo 或 Git 操作门禁。
