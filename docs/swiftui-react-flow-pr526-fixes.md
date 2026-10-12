# PR #526 评审与原生 CI 修复（2026-10-12）

范围：[PR #526](https://github.com/hailingu/PlotWeave/pull/526) 的两条初次评审、提交 `c0bce19` 后一轮新增的两条真实缺陷（设置根／历史 ABI 取消）、提交 `9d34d25` 后一轮新增的原生版本配置缺陷，本地覆盖率门禁中复现的 watchdog 测试退出观察失序，以及 [CI run 38198236563](https://github.com/hailingu/PlotWeave/actions/runs/38198236563)。起始提交 `eb0043214917a73072cbbad407419922111fab20`，既有授权分支 `codex/swiftui-react-flow`。CI 的 frontend／Rust 成功；native 编译成功后，宿主在测试连接建立前触发 `NSGenericException`（窗口约束更新循环），退出码 65。

## 实现前关键状态与不变量矩阵

| ID | 前置状态、动作／事件顺序 | 预期可观察结果 | 不变量、所有者与入口 | 验证计划／缺口 |
| --- | --- | --- | --- | --- |
| R1 | 生图 URL 为 IPv4 非全球地址或其 IPv6 映射、兼容、NAT64／6to4 形式→分类 | 拒绝基准测试、保留、文档、协议用途及原有私网地址 | `NativeNetworkPolicy` 拥有地址分类；不能因表示形式放行内部目的地 | 地址表与边界回归；依据 IANA 特殊用途注册表 |
| R2 | 初始 DNS 含公网与非公网混合结果／URL 直接使用非公网 IP→下载；公网首跳→重定向非公网 | 返回 `PW_NETWORK_REFUSED`；初始拒绝不连接，重定向拒绝不发第二跳 | `NativePublicDownload.fetch` 的所有入口逐跳校验全部结果并固定连接 IP | 注入解析／传输回归；真实公网 TLS 未验证，无真实网络调用 |
| R3 | 合法公网 IPv4／IPv6→下载；相对重定向→成功 | 保留原 URL／TLS 主机身份与获准地址，成功返回受限字节 | 下载策略收紧不能破坏合法固定地址、超时、取消及大小上限 | 既有下载／HTTP framing 回归及新增合法地址分类 |
| R4 | 首页收到规范毫秒时间／无小数 ISO 时间／非法或缺失时间／损坏占位 | 两种合法时间显示相对时间；坏值不虚构时间，损坏诊断优先 | `NativeProjectProjection`／项目行仅拥有展示，不改写原时间或磁盘排序 | 真实 SwiftUI／AX 相对时间回归及投影解析；不涉及写入、重试或并发 |
| R5 | Xcode 启动真实 SwiftUI 测试宿主→测试 bundle 尚未加载→窗口初始化 | 测试可建立连接并执行；自动场景无业务资源，各测试仅使用隔离夹具，不开启用户数据 | App 入口拥有测试模式；SwiftUI 场景尺寸、导航栏约束必须收敛 | 原生路由复现、启动隔离回归；CI 结果须绑定修复后的提交 |
| R6 | 欢迎→编辑／设置→欢迎、收展面板、关闭等待批准 | 同一 WKWebView 与保存 owner 保留，欢迎卡片仍为 480×632 pt | 场景／欢迎 presenter 只拥有展示；导航及关闭继续由既有 owner 批准 | 既有真实窗口、WKWebView 与关闭回归；视觉、IME、VoiceOver 仍为原有缺口 |
| R7 | 完整 app-hosted 目标的多个套件→同时操作窗口、焦点、布局和关闭委托 | 全部断言在各自夹具环境成立；正常并发服务行为仍由其异步回归覆盖 | AppKit 的 NSApplication 是进程级共享状态；验证调度拥有全局隔离，各 suite 的 `.serialized` 不隔离兄弟套件 | 默认并行完整路由复现 8 项干扰失败；CI 与 Scope Routing 改为 `-parallel-testing-enabled NO`，完整目标串行复核，不删除用例或放宽断言 |
| R8 | 共享 TestAction 启动 app-hosted runner→测试连接建立→各测试显式创建真实外壳／WK 夹具 | 自动启动场景仅承载惰性测试宿主，不挂无 owner 的画布／split／inspector；测试拥有每个业务窗口的生命周期 | App 入口只在显式测试标记下使用惰性场景；普通启动仍用 NativeShellRoot，完整业务回归不能被跳过 | 第二次托管 native 仍在 SwiftUI.AppKitWindow（960×632）约束循环中启动失败，排除“仅凭标记和串行即可修复”；补实际宿主无画布回归先红，再复核完整路由与托管 CI |
| R9 | 已有设置为合法 JSON 但根为数组／null／标量→load_prefs 或 providerSecret；显式有效对象恢复／尝试写非对象 | 两个读取入口均报 PW_PREFS_CORRUPT 且保留原字节；有效恢复先私有备份；非对象写入报 PW_PREFS_INVALID 且不改原件 | NativePreferences actor 拥有健康设置必须是 JSON 对象的不变量；加载、保存与密钥迁移共用边界，未知对象字段仍保留 | 真实临时根的类型表、读取、恢复与无损写拒绝；actor 内无 await，不新增并发或重试状态 |
| R10 | 未分配 id→取消→未来分配同 id；排队→重复取消→派发；已派发／落定→取消；发送失败／free 排空 | 未知／已派发／落定取消为 no-op；只有排队请求返回 CANCELLED+NULL；其它成功回执保留，登记随派发或发送失败清除 | 历史 PwCore 队列登记拥有取消资格，提交、取消与派发在同一锁下转换；每个成功提交恰有一次回执，状态不能影响未来 id | ABI 先取消未来 id 先红；阻塞回调建立确定性队列后取消／释放及状态清理回归，不依赖睡眠竞速；当前 Swift 应用不链接该 ABI |
| R11 | 节点检查器窄／宽列、浅／深外观；系统使用 overlay／legacy 滚动条 | 文本使用实际可滚动内容宽度，标签与开关尾端对齐；滚动条自身宽度不算可编辑区域 | 检查器字段拥有内容布局，测试通过真实 AX 滚动区域与常驻栏实际宽度验证；不改系统偏好 | 托管 run 38202492214 四种字段宽度误差均为 17 pt；旧断言先红，按实际内容列核对相同填充契约，overlay 不扣栏宽 |
| R12 | 真实 editor 窗口被屏幕约束后→欢迎卡片→移除 presenter | 同一 writer 恢复原有实际 frame 与标题控件，不假设请求尺寸可放入屏幕 | NativeWelcomeWindowController 不拥有 editor 尺寸；移除回归快照采用已落定实际 frame，既有快速切换回归守护呈现前后 frame 一致 | 托管实际 1024×645、旧断言 1100×750；验证实际 geometry 保真，480×632 欢迎尺寸保持 |
| R13 | 小屏幕／正常编辑尺寸；欢迎返回 editor 时 split／inspector 仍有待执行布局 | 恢复交互与可见性前完成本窗口的待布局；可见画布尺寸一次落定、同一 WK 和保存 owner 保持 | NativeWelcomeWindowController 拥有 writer 显隐恢复，不能发布旧列几何；普通返回、快速 route supersede、替换窗口与关闭共用恢复入口 | 托管两种视口均先暴露 1024×645 再变 424×625；增加待布局隐藏窗口回归与小尺寸真实 WK 路径，先红后绿；不新增任意延时或放宽尺寸跳变断言 |
| R14 | Debug／Release 编译实际原生应用→首页读取 Bundle 版本 | CFBundleShortVersionString 为现有应用版本 0.2.0，与前端／Tauri 及已发布版本一致 | 原生 target 配置拥有应用营销版本；首页继续读取实际 Bundle，不硬编码显示或修改既有版本决策 | Debug 实际宿主 Bundle 回归先红；Release 构建后通过 plist 解析器核对真实产物；不涉及写入、恢复、并发或版本升级 |
| R15 | 独立期限／清理兜底→守卫对测试监督进程发送 SIGKILL→守卫先退出、监督进程随后退出 | 测试等待创建时已登记的真实 exit，断言 SIGKILL 与进程消失；安装组 absent 后哨兵仍存活 | 测试夹具拥有退出观察，不把守卫退出当成其它进程退出屏障；生产守卫、期限与组复用保护不变，正常 release／disconnect 路径仍要求监督进程存活 | 完整覆盖率连续两次因立即查询监督进程得到仍存活而失败；复用既有退出登记，不加睡眠或修改生产守卫，集中与完整门禁复核 |

地址依据：[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)。单实例边界、付费模型和存储格式不扩展；异步下载沿用既有绝对截止时间、取消和逐跳校验，新增策略不引入重试或共享可写状态。

## 验证结果

本机环境：Node 24.18.0、Xcode 27.0（27A266a）、macOS SDK 27.0。以下命令均在仓库根目录执行，使用隔离夹具，不访问真实模型服务或用户项目。

- R1 先红：旧分类器在 IPv4／转换形式及特殊 IPv6 表中出现 89 项预期错误放行；修复后 `NativeNetworkPolicyTests` 通过。补充 ISATAP 与地址边界，全球可达例外保持。
- R2 先红：`specialUseTargetsNeverReachAnotherTransportHop` 出现 16 项预期失败，初始直接／混合 DNS 返回字节，重定向继续连接。修复后返回稳定拒绝码且连接计数正确；R3 的固定 IP／TLS 身份、相对重定向、超时／取消、体积和 HTTP framing 既有回归通过。成功夹具使用注入的普通全球 IP，文档地址移入拒绝表；无真实网络连接。
- R4 先红：实际 SwiftUI／AX 展示中，添加毫秒时间未增加相对日期字段；无小数时间与非法值的对照通过。修复后这三种展示情况及 `projectDatesPreserveMillisecondsAndRejectInvalidMetadata` 的日期精度、元数据保真、缺失值和损坏诊断优先规则通过。
- R5：新增启动契约测试先因缺少 `NativeLaunchMode` 失败；共享 TestAction 与入口实现后，三项策略及实际测试环境检查通过。原 CI 的启动异常与测试 bundle 加载时序之间为风险推断；明确启动标记消除了该依赖，但提交 `c0bce19` 的 [CI run 38200674583](https://github.com/hailingu/PlotWeave/actions/runs/38200674583) 仍在测试连接建立前触发同一异常（frontend／Rust 成功），因此继续按 R8 隔离自动场景。
- R8 先红：`bootstrapDoesNotMountUnownedCanvas` 在真实宿主可见窗口中发现自动挂载的 WKWebView，出现预期失败；改为固定尺寸惰性宿主后 **4 tests／1 suite 通过**，完整目标 **187 tests／48 suites 通过**。各测试继续显式创建并销毁真实外壳／画布，普通启动保持生产入口；设置续修后的完整路由及对应托管 CI 结果在验证后记录。
- R9 先红：两条新增测试共 38 项预期失败：非对象根的 `load_prefs` 返回成功，凭据读取报缺 key，保存非对象覆盖原件并产生多余备份。根对象校验后 **NativePreferencesTests 13 tests／1 suite 通过**，五种损坏根的两个读取入口、原字节私有备份恢复、健康／损坏原件的无损写入拒绝均通过；既有未知字段、密文迁移和原子保存回归保持。
- R10 先红：取消尚未分配的 id 1 后，首个合法请求实际回执为 CANCELLED（2），预期 OK（0）。仅登记排队请求后 **FFI 4 单元测试＋7 ABI 集成测试通过**；确定性闸门验证重复取消、已派发／未来 id no-op、取消创建不落盘和 free 排空一次回执。单元测试另验证发送失败、取消派发后登记清空及锁中毒诊断恢复；纯内存 map／提交口持锁时不调用内核或宿主，既有 core 锁恢复内核为 crate-private，使用局部恢复适配而不扩展公开接口。
- 集中命令：同一 `xcodebuild` 路由追加 `-only-testing:PlotWeaveNativeTests/NativeHomeViewTests`、`NativePublicDownloadTests`、`NativeNetworkPolicyTests`、`NativeLaunchModeTests`、`NativeFormsTests` 五个目标，**30 tests／5 suites 通过**。
- R6／R7：完整默认并行运行 **186 tests／48 suites，8 项失败**，涉及工具栏几何、检查器请求、侧栏、画布宽度恢复与退出委托；相同完整目标串行执行 **186 tests／48 suites 全通过，TEST SUCCEEDED**。现行命令：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`。大小检查 723 个维护文件通过；画布构建 403 模块通过（保留既有大 chunk 提示）。
- `.github/**` 的 `npx prettier --check .github`、scheme 的 `xmllint --noout native/macos/PlotWeaveNative.xcodeproj/xcshareddata/xcschemes/PlotWeaveNative.xcscheme` 与 `git diff --check` 通过。AGENTS／文档无配置的自动语义检查；结构化审阅已核对路由一致性、矩阵、原生专属网络边界、历史证据及交叉引用。
- R8／R9 最终完整原生路由：同一现行命令 **189 tests／48 suites 全通过，TEST SUCCEEDED**，大小检查 723 文件与画布构建 403 模块通过。其前一次完整复核受到本机锁屏遮挡，AppKit 报 accessibility element window 低于 shield(2001)，系统锁屏标记为 Yes，窗口／AX 断言失败；保留该失败，解锁后完整重跑通过，不修改断言或放宽窗口契约。
- R10 完整 crates 路由：在 `crates` 执行 `npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`，大小、格式、Clippy 零警告通过；core **130**、FFI 单元 **4**、ABI 集成 **7** 全通过。根目录 `npm run format:check` 与 `git diff --check` 通过；文档结构化复核已同步健康设置根、两条读取入口、备份恢复、取消资格与历史 ABI 边界。
- 提交 `9d34d25` 的 [CI run 38202492214](https://github.com/hailingu/PlotWeave/actions/runs/38202492214)：frontend／Rust 成功，native 已完成全部 **189 tests／48 suites**，测试宿主启动与四条评审回归通过；剩余 **7 项几何失败**（R11 四项、R12 一项、R13 两项）。不以启动成功代替整体 CI 通过。
- R13 先红：`dismissFlushesPendingLayoutBeforeRestoringInteraction` 的真实 NSView 待布局在 writer 已可见且可交互后才执行，断言 `layoutWasHidden == true` 失败；在同一恢复入口先调用 `layoutSubtreeIfNeeded()`，再恢复 opacity、鼠标和辅助功能状态。新增小尺寸真实 WK 用例保留首帧尺寸与视口变化次数的原有断言；完整路由和托管结果在复核后记录。首次额外滚动条夹具尝试未找到 NSScrollView，且本机再次锁屏导致 AX／WK 访问超时，未将这些夹具前提失败当作行为复现；现改用已有公共 AX 查询，不猜测 SwiftUI 私有 view 类型。
- R13 后绿：同一路由追加完整 Swift Testing 方法标识 `-only-testing:PlotWeaveNativeTests/NativeWelcomeWindowTests/dismissFlushesPendingLayoutBeforeRestoringInteraction()`，**1 test／1 suite 通过**。未加括号的首次选集执行 0 tests，明确不作为通过证据。本机锁屏仍阻断需要可见桌面的 AX／WK 完整复核；托管 CI 会运行全部目标，最终结果在 PR 中绑定实际提交，不把单项通过称为全量通过。

- R14 先红：实际 app-hosted `applicationBundleUsesDesignatedVersion` 读取到 `0.1.0`，违反仓库既定 `0.2.0`，**1 test／1 suite 预期失败**。修正原生应用 target 的 Debug／Release `MARKETING_VERSION`，首页保持读取 Bundle；Debug 的完整 `NativeLaunchModeTests` **5 tests／1 suite 通过**，实际 Release `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -configuration Release -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData build` 成功，`plistlib` 读取该应用生成的 Info.plist，断言营销版本为 `0.2.0` 通过。首次直接用 Release 跑 `@testable` 目标因默认未启用 `-enable-testing` 而编译失败，未修改该生产边界；Release 验证采用真实生产产物。没有变更应用版本决策、内部测试 bundle 或发布流程。

- R11–R13 托管复核：提交 `3fa69c8f04fa0cc1a29779ebd20a54dfd6d9dbe8` 的 [CI run 38203944610](https://github.com/hailingu/PlotWeave/actions/runs/38203944610)，frontend／Rust／native 三项 job 均成功，native 完成全部 **190 tests／48 suites，TEST SUCCEEDED**；四种检查器字段、实际窗口 frame、四种保存视口／编辑尺寸组合及待布局先隐藏后恢复回归均通过。本机完整 AX／WK 复核仍受锁屏限制，未把单项本地通过当作全量通过；版本续修后最新提交的完整 CI 结果在 PR 中绑定。

- R15 先红：完整 `npm run test:coverage` 连续两次均为 **218 文件通过／1 文件失败，3123 tests 通过／1 test 失败**，失败点是守卫 exit 后立即查询另一监督进程仍存活。单独旧文件 5 项通过，印证退出事件无跨进程先后屏障的观测窗口。测试复用创建时的真实 exit 登记，等待监督进程实际退出并核对 `SIGKILL`，保留 code 1、进程消失及哨兵存活断言；正常 release／disconnect 保持监督进程存活，不改生产守卫或加睡眠。`npm run check:size && npm test -- scripts` 首次在受限沙箱因 `spawnSync ps EPERM` 出现 17 项环境失败；以门禁正常权限执行相同路由后，大小检查 **723 维护文件通过**，脚本 **15 files／314 tests 全通过**；该完整路由覆盖原有 release／disconnect、超时、进程组复用和 hook 身份场景。

源码、测试及配置均在文件上限内，新增／修改单元未超过 80 代码行；未配置复杂度工具，嵌套与函数跨度已人工审阅。历史 ABI 的未改动 `dispatch` 超过 80 代码行，作为既有债务记录，不在本次取消修复中扩展分发重构。地址策略、日期展示、启动判定、设置根与取消资格各有明确 owner，没有新增服务依赖或可写文档副本。真实公网 TLS、计费、视觉、IME、VoiceOver 与全屏人工验收仍保留原有缺口。提交／推送门禁及修复后托管 CI 的结果在 PR 描述中绑定实际提交，不以历史结果替代。
