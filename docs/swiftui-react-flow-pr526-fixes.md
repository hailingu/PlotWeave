# PR #526 评审与原生 CI 修复（2026-10-12）

范围：[PR #526](https://github.com/hailingu/PlotWeave/pull/526) 的两条初次评审、提交 `c0bce19` 后一轮新增的两条真实缺陷（设置根／历史 ABI 取消）、提交 `9d34d25` 后一轮新增的原生版本配置缺陷，提交 `3fa69c8` 后一轮新增的部分导入呈现／DNS 候选连接缺陷，本地覆盖率门禁中复现的 watchdog 测试退出观察失序，以及 [CI run 38198236563](https://github.com/hailingu/PlotWeave/actions/runs/38198236563)。起始提交 `eb0043214917a73072cbbad407419922111fab20`，既有授权分支 `codex/swiftui-react-flow`。CI 的 frontend／Rust 成功；native 编译成功后，宿主在测试连接建立前触发 `NSGenericException`（窗口约束更新循环），退出码 65。

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
| R13 | 小屏幕／正常编辑尺寸；欢迎返回 editor 时 split／inspector 仍有待执行布局 | 恢复交互与可见性前完成本窗口的待布局；可见画布尺寸一次落定、同一 WK 和保存 owner 保持 | NativeWelcomeWindowController 拥有 writer 显隐恢复，不能发布旧列几何；普通返回、快速 route supersede、替换窗口与关闭共用恢复入口 | 托管两种视口均先暴露 1024×645 再变 424×625；增加待布局隐藏窗口回归与小尺寸真实 WK 路径，先红后绿；后续真实 WK 采样明确限定可见页面的绘制帧，并记录原生 bounds 与隐藏状态；不新增任意延时或放宽尺寸跳变断言 |
| R14 | Debug／Release 编译实际原生应用→首页读取 Bundle 版本 | CFBundleShortVersionString 为现有应用版本 0.2.0，与前端／Tauri 及已发布版本一致 | 原生 target 配置拥有应用营销版本；首页继续读取实际 Bundle，不硬编码显示或修改既有版本决策 | Debug 实际宿主 Bundle 回归先红；Release 构建后通过 plist 解析器核对真实产物；不涉及写入、恢复、并发或版本升级 |
| R15 | 独立期限／清理兜底→守卫对测试监督进程发送 SIGKILL→守卫先退出、监督进程随后退出 | 测试等待创建时已登记的真实 exit，断言 SIGKILL 与进程消失；安装组 absent 后哨兵仍存活 | 测试夹具拥有退出观察，不把守卫退出当成其它进程退出屏障；生产守卫、期限与组复用保护不变，正常 release／disconnect 路径仍要求监督进程存活 | 完整覆盖率连续两次因立即查询监督进程得到仍存活而失败；复用既有退出登记，不加睡眠或修改生产守卫，集中与完整门禁复核 |
| R16 | 原生选择多文件→前一导入已落盘→后一读取／导入失败；全成功／取消选择 | 部分成功后列表显示已落盘的真实 ID 与媒体，保留失败提示并结束 busy；全成功无错误，取消不导入 | NativeLibrary actor 拥有权威索引；NativeLibraryModel 仅呈现，不因批次后段失败隐藏已提交项或自动重试 | 注入原生选择结果、真实临时文件与库 actor，分别验证读失败、空文件导入失败、全成功和取消；真实系统面板继续保留人工验收缺口 |
| R17 | 写操作失败→重读列表也失败；恢复期间关闭／旧结果迟到；其它 mutate 入口失败 | 列表不可恢复时保留最后有效快照并同时报告刷新失败；关闭后不发布旧结果；其它写入口共用恢复 | Model 的 generation／任务拥有呈现权限，失败重读不创建第二份索引或绕过只读／busy 守卫 | 真实坏目录、延迟选择关闭、失败 mutate 后权威外部更新回归；无数据格式、事务或自动重试变化 |
| R18 | 全部 DNS 地址已通过公网分类→首个连接失败→后续地址成功／全部连接失败 | 成功返回后续地址媒体；全失败返回网络错误；每次仍使用原 hostname／URL 与同一 hop 截止时间 | NativePublicDownload 拥有逐跳候选选择，NativePinnedHTTP 仍固定地址并验证 TLS；不重新解析或放行混合 DNS | 双栈成功、全地址失败与固定身份／deadline 回归；注入传输，不访问真实公网 |
| R19 | 地址尝试中取消／预算耗尽；策略或 framing 拒绝／HTTP 失败；重定向→下一跳 | 不尝试下一地址、不返回媒体；每跳重新验证全部 DNS，既有五跳／体积上限保持 | 仅 PW_DOWNLOAD_NETWORK 可推进候选，取消与共享截止时间不能因 fallback 重置，安全拒绝不得变成重试 | 新增取消、慢传输超时、终止错误与非 2xx／超大回复回归；沿既有混合 DNS、重定向、HTTP framing 覆盖 |
| R20 | 持久化主题描述当前原生保存→读者选择实现 owner 与数据根 | 明确直接 Swift 服务已实现，历史 C ABI 未链接；区分当前扁平真源与目录化／索引计划 | 设计文档拥有实现归属说明，不能把未链接 FFI 误写为 Swift 保存尚未可用 | 文档结构化审阅，对照 NativeHostServices、NativeProjectStore／Envelope／Directory 及既有 overview／功能补齐记录；纯文档不制造文本断言测试 |
| R21 | 保存前校验失败；原子 rename 后同步／复验失败；失败后重读／重试 | 提交前保留旧文档；提交后如实报错且新文档可能已落盘，不假称回滚或成功 | 既有 §10.5 两类失败合同由存储边界拥有；Swift actor／Rust 操作锁串行正常入口，外部媒体篡改不构成跨文件事务 | 复核现有 Rust 真实故障注入回归与 Swift 保存顺序；Swift fsync／写后媒体替换故障注入仍未覆盖，不用 Rust 回归冒充 Swift 证明 |
| R22（中间验证，最终见 R24） | ⌘Q／Dock 请求到达→保存失败或监听初始化失败；随后用户重试 | 取消当前系统退出，正常事件循环和原窗口保持；失败诊断与未落盘快照可修复，不悬置 AppKit 延迟退出 | NativeApplicationDelegate 拥有系统终止决定；先返回 terminateCancel，HostQuitController 继续持有意图，成功冲刷才重新 terminate | 实现前选定原生委托状态回归与真实 WK→项目文件被目录阻挡→失败诊断→文件恢复→退出重试；三项回归先红六处预期失败，集中 12／4 与完整 204／50 通过；初始化失败覆盖未就绪监听，不引入桥合同变化 |
| R23（中间验证，最终见 R25） | 启动前退出、关闭升级为退出、重复请求、重连后旧监听失权→当前页批准 | 仍只持有一个意图，未就绪不得批准；批准后再次进入 AppKit 时直接允许；已冲刷关窗后退出不等待销毁页面 | 现有 controller 负责意图／监听，delegate 负责最终系统动作；所有入口共享既有固定点屏障和单次批准 | 扩展集中状态回归并复用 HostQuitTests／NativeWindowLifecycleTests；真实 Dock／菜单手势、系统注销仍为人工缺口 |

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

- R16–R19 先红：仅增加原生选择注入边界而不改变批次循环后，集中 **17 tests／2 suites，12 项预期问题**：两种后段失败均隐藏已提交项，失败 mutate 未重读，恢复失败未保留双重错误，首个地址网络失败未尝试后续地址，取消中途连接未返回取消码。最初新增选择参数的编译失败不作为行为红灯；上述结果来自可编译的真实持久库与注入传输。
- R16–R19 后绿：集中 **17 tests／2 suites 全通过，TEST SUCCEEDED**。库资产 ID、媒体字节与重开列表一致，全成功／取消选择、读失败／空文件导入失败、坏目录恢复、其它 mutate 和关闭晚选择均通过；公共地址成功回退、全连接失败、共享 hop deadline、原主机身份、取消、慢传输超时、策略拒绝及 HTTP／体积终止回归通过。恢复重读期间的独立迟到 actor 回执未额外用闸门控制，发布前后 generation／取消守卫已结构化复核，关闭晚选择验证同一任务权限；真实系统面板、真实公网连接仍保留既有验收缺口。

- R1–R19 本机最终完整原生路由：用户确认解锁后，执行现行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`，**724 维护文件检查通过、403 模块画布构建成功、201 tests／49 suites 全通过，TEST SUCCEEDED**。真实窗口、AX、WKWebView、设置、部分导入、候选地址和实际 Bundle 版本均执行；此前锁屏失败保留为环境失败证据，未用跳过或放宽断言替代本次完整复核。

源码、测试及配置均在文件上限内，新增／修改单元未超过 80 代码行；未配置复杂度工具，嵌套与函数跨度已人工审阅。历史 ABI 的未改动 `dispatch` 超过 80 代码行，作为既有债务记录，不在本次取消修复中扩展分发重构。地址策略、日期展示、启动判定、设置根与取消资格各有明确 owner，没有新增服务依赖或可写文档副本。真实公网 TLS、计费、视觉、IME、VoiceOver 与全屏人工验收仍保留原有缺口。提交／推送门禁及修复后托管 CI 的结果在 PR 描述中绑定实际提交，不以历史结果替代。

## 提交 `148bf0b` 后一轮新增意见处置

- R20：持久化主题仍称宿主共用 Rust 内核、Swift 保存待 C ABI 接入，属真实文档同步缺陷。修正文档实现归属，逐项明确直接 Swift owner、独立开发根、扁平权威文件、同一 actor 写入／删除屏障、既有 legacy 差异及未验边界；不修改代码或数据格式。
- R21：“不得在提交后报告失败”的建议与既有 §10.5 合同不一致，按已记录边界处置，保留实现。Rust `persist_project_expect_existing` 与 Swift `saveProject` 均在写后复验；rename 后持久性屏障失败也必须报错。`store::commands::tests::save_directory_sync_failure_reports_error_with_new_doc_committed` 通过真实故障注入验证失败回执、新文档已提交和重试收敛。正常入口在 Swift actor／Rust 操作锁内串行，本地并发攻击者替换树不在现有单实例威胁模型；未新增跨文件事务或删除安全诊断。[资产 §7.1](data-model/assets.md#71-两个作用域)补明“整份拒绝”指提交前复验，避免把失败回执误读成全阶段回滚承诺。
- 本轮仅规范文档同步与边界澄清，不新增源代码或测试。结构化审阅核对 owner、布局、两类失败、威胁模型、现有回归与未验缺口；没有配置文档自动语义检查。集中执行 `cargo test --manifest-path crates/Cargo.toml --package plotweave-core --lib store::commands::tests::save_directory_sync_failure_reports_error_with_new_doc_committed -- --exact`，**1 项通过、0 失败**，确实执行目标而非零测试选集；完整提交／推送门禁及最新 CI 结果在 PR 绑定实际提交。

## 提交 `ac614d0` 后一轮退出意见处置

最终自查发现 `d81efc3` 一律先取消再重发会中止系统注销／重启／关机序列，因此该中间实现由下述纠正矩阵取代，不作为最终完成方案。前述通过证据只证明当时选定的应用退出路径，不能证明系统终止序列保真。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R24 | 监听就绪→系统退出→Web 四类保存失败／抛错／退出批准失败；页面错误投影可能先于原生取消回执；回执落定后修复并重试 | 首次 terminateLater 最终回复 false，清除旧意图、留窗和诊断；重试成功回复 true，不重新取消成功系统终止序列 | 原生 delegate 拥有 AppKit 回复；Web via Swift-only app_exit 的可选 cancel:true 报告失败，缺省仍批准；错误投影不代表退出回执已落定；Tauri 命令语义不变 | 新增 Swift Web 失败信号回归、真实 WK 文件阻挡恢复、委托 false→true 回归；真实 WK 测试须等待错误与 false 回执后再重试；真实注销不执行，验证同一回调的 AppKit 成功回复合同 |
| R25 | 监听未就绪时系统退出；监听初始化失败；事件投递失败；旧投递迟到／页面重连 | 未就绪先取消系统请求并保留启动意图；已延迟的桥失败／重连回复 false；旧任务失败不得取消新意图 | controller 负责事件任务取消与监听资格；delegate 只对实际等待的 terminate 回复一次，关窗失败不回复系统退出 | 未就绪、初始化 IPC 拒绝、真实投递失败、幂等取消、旧任务取消和重连回归；取消信号自身失败须保留双重诊断 |

- 中间方案 R22–R23 针对当前原生退出的真实 P2 缺陷：AppKit 的 [`terminateLater`](https://developer.apple.com/documentation/appkit/nsapplication/terminatereply/terminatelater) 必须收到最终 true／false 回复，旧实现只有成功回执，失败无法完成系统退出决定。复用既有意图缓冲，系统入口直接返回 `terminateCancel`，前端成功冲刷后才经带许可的 `NSApplication.terminate` 重新进入系统入口；失败和桥初始化未就绪均留在正常事件循环。没有增加桥命令、后台重试、保存副本或改变 Tauri 合同。
- 先仅增加测试注入的最终系统动作观察点，生产默认仍调用原先的批准回复；可编译的 **3 tests／2 suites 出现 6 处预期失败**，均为原入口仍返回 `terminateLater`。真实 WK 测试同时观察保存错误、可见窗口、目录阻挡解除后的最新节点落盘与错误清除；不以 mock 调用代替文件结果。
- 中间方案集中选择 `NativeQuitRecoveryTests`、`NativeProductionLifecycleTests`、`HostQuitTests`、`NativeWindowLifecycleTests`，**12 tests／4 suites 全通过**。完整 native 路由的大小检查 **725 维护文件通过**、生产画布 **403 模块构建成功**，**204 tests／50 suites 全通过，TEST SUCCEEDED**。初始化未就绪、事件投递失败、启动缓冲、重复请求、关闭升级退出、重连监听失权、已冲刷关窗后退出与真实 WK 失败恢复均通过。
- 系统终止动作在测试中注入观察回调，避免退出测试宿主；验证批准许可的下一次系统入口为 `terminateNow`，实际 `NSApplication.terminate` 由生产适配执行。真实 Dock／菜单手势和系统注销未执行，保留人工验收缺口。文档结构化审阅同步本主题、持久化 §10.0、UI §12.3、迁移计划与功能 F05；提交／推送门禁和最新 CI 在 PR 绑定实际提交。

## 最终退出纠正验证（R24–R25）

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R26 | 原生选择普通文件→FIFO（无 writer）、目录或 symlink；单 FIFO；先前已有导入成功 | 非普通文件快速拒绝，busy 落定、错误可见；已提交列表／媒体字节保留，不等待 FIFO writer 或进行字节读取 | NativeLibraryModel 所选文件边界非阻塞 open、no-follow；NativeMediaFile 从实际 descriptor 校验普通类型并拥有释放；不先 path 检查后有竞态地 open | 真实 mkfifo、目录、symlink 与普通临时媒体；旧 FIFO 由测试兜底 writer 释放后排空防止泄漏，断言在此之前已拒绝；普通读／部分成功既有回归复用，实际面板人工缺口保持 |

- 纠正保留就绪页面原来的 `terminateLater`／`reply(true)`，避免取消成功系统注销序列。Swift 的既有 `app_exit` 增加可选布尔 `cancel:true`，保存阻断、冲刷抛错、批准失败及初始化失败报告取消；缺省仍批准，非法类型拒绝。原生事件失败和替换就绪页主动取消，旧任务取消后的失败不影响新意图。初次未就绪的系统请求先取消并缓冲；恢复时仍要求当前监听批准。没有新增命令名或改变 Tauri 载荷、磁盘格式、保存 owner。
- 新 Web 失败信号回归先为 **5 failed／3 passed**；可编译原生选集 **5 tests／2 suites、16 处预期问题**，失败针对延迟回复、幂等取消、重连清除与实际 WK 失败后重试。新增注入只观察最终 AppKit 动作，不执行真实注销或退出测试宿主；夹具前提错误不计作行为红灯。
- 修复后 Web 四类退出选集 **27 tests／4 files 通过**；原生退出、窗口、实际 WK 四套件 **14 tests 通过**。最终额外的非法取消载荷测试纳入完整 native 路由：**725 文件规模检查、403 模块生产画布构建、207 tests／50 suites 全通过，TEST SUCCEEDED**。真实项目文件阻挡时回复 false、错误可见、窗口仍可用；恢复后回复 true、最新节点实际落盘、错误消除。成功路径使用原 AppKit 回复，不以重新发起 terminate 替代。
- 旧投递迟到的独立故障闸门未额外注入：取消任务的 catch 在检查 `Task.isCancelled` 后才能拒绝，已结构化复核；页面替换／投递失败和幂等取消由回归覆盖。信号自身传输失败同时保留保存与取消诊断；真实菜单／Dock 手势和系统注销仍是人工验收缺口。
- `useExitFlush` 提取同页屏障生命周期与监听初始化，新增／修改函数最多 67 代码行；Swift 单元均低于 80，文件低于硬上限。未配置复杂度工具，已人工审阅所有权、嵌套、释放与 await 前后守卫。完整前端路由、提交／推送门禁和最新 CI 结果在 PR 绑定最终提交。
- 最终前端路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 全通过：**219 files／3127 tests**，五个退出／设置文件 **45 tests** 集中复核通过。首轮全量为 3126 通过／1 失败，原因是更新中的设置夹具在发出退出前等待取消回执；纠正到实际失败事件之后，并将成功断言限定为无 cancel 参数，集中和完整路由重跑通过，不将夹具时序失败视作生产行为红灯。静态与类型无警告，文档结构化核对新失败参数、初始化、重连和成功系统序列；未配置文档自动语义检查。

## 所选特殊文件处置（R26）

- 提交 `d81efc3` 后出现新的真实 P2：所选 FIFO 的阻塞 open 在普通文件校验前等待 writer，Swift 任务取消不能打断该 syscall。最小回归在真实 FIFO 没有 writer 时 **6 tests／1 suite、1 处预期失败**，UI 仍 busy；测试随后用非阻塞兜底 writer 释放旧读取并排空，避免泄漏线程。
- 所选文件增加 `O_NONBLOCK`，保持 `O_NOFOLLOW`／`O_CLOEXEC`，并复用 `NativeMediaFile` 的实际 descriptor fstat 普通文件校验、字节上限与释放。没有先检查路径再打开的竞态，也没有新增轮询、超时、后台重试或 Web 文件路径能力。
- 集中 `NativeLibraryModelTests` **6 tests／1 suite 全通过**：特殊文件用例覆盖 FIFO／目录／symlink × 独立选择／前置普通文件六种组合；权威列表、已提交资产 ID、真实媒体字节一致，错误可见、busy 落定。既有完整／取消选择、后段失败、恢复失败、其它 mutate 和关闭晚选择均保持。完整 native 路由结果在最终提交前记录，系统 NSOpenPanel 仍保留人工缺口。
- R26 最终完整 native 路由：**725 维护文件规模检查通过、403 模块画布构建成功、208 tests／50 suites 全通过，TEST SUCCEEDED**。本次运行包含最终 R24–R25 退出回复、真实 WK 写失败恢复和图库特殊文件六种输入组合。文档无自动语义检查，结构化审阅同步资产、UI 与 F07；提交／推送门禁和最新 CI 在 PR 绑定最终提交。

## CI 异步回执与绘制帧复核

- 提交 `12a4314` 的 [CI #597](https://github.com/hailingu/PlotWeave/actions/runs/38214133018) 前端／Rust 通过，native **208 tests／50 suites、3 处问题**，均在 `failedQuitSaveCanRecoverWithoutDeferredAppKitTermination`：测试只等待 Web 错误投影，就断言原生意图清除和 false 回执，并过早发起重试。错误投影与 `app_exit(cancel:true)` 是独立异步消息，前者可先抵达；不能用错误已显示代替原生取消已完成。
- 复用 R24 的真实窗口／项目文件回归，把等待条件同时限定为错误可见、旧意图清除及实际 false 回执；之后才解除文件阻挡并发起新退出。保留原有 12 秒期限、全部失败／成功断言和实际落盘检查，不增加固定睡眠、重试掩盖或生产分支。此轮仅修复测试同步前提；行为红灯采用上述实际 CI 失败，复核结果在提交前记录。
- 真实 WK 退出集中 **2 tests／1 suite 通过**。随后完整 native **208 tests／50 suites、1 处问题**，退出已通过，但既有 R13 首帧回归在保存视口／1100×750 输入采到 **1605→1005** 的画布宽度变化（高度／transform 保持）。窗口级 `layoutIfNeeded()` 试验集中 **12 tests／2 suites 通过**，全量仍在缺失视口／960×600 输入采到 **1465→865**；增加原生 bounds／隐藏状态诊断后全量通过。集中三次重复的 xcresult 确认 **7 个测试、42 次参数／重复执行通过**，一次按方法筛选实际选中零测试，不计作验证。这些结果不能证明窗口级调用修复了问题，该试验已撤回，不保留额外生产分支。
- R13／N85 的验证语义是可见画布的绘制帧；原采样只检查窗口 opacity 和 editor 投影，并在任意 JavaScript 任务中读取几何，未区分尚未显示的 WK 页面及其旧 viewport。测试现在还检查 WK 本身可见，并在下一次 `requestAnimationFrame` 回调读取三个节点的实际几何与 transform；其绘制前回调语义见 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。首个采样帧仍参与尺寸／视口断言，不等待尺寸相等、忽略头部样本或自动重试；独立 1 秒期限仅使未到达绘制帧明确返回 `PW_CANVAS_FRAME_TIMEOUT`，并取消未执行回调。保留 40 次采样、原 30 毫秒间隔、原有视口条件及同一 WK 身份断言，诊断同时记录原生 bounds 与 hidden。实际物理屏幕逐帧画面未录像，不能将任意任务的旧尺寸直接断定为已显示的生产抖动；完整视觉验收仍为 P5 缺口。
- 最终回执／绘制帧修正集中 **9 tests／2 suites 全通过**，实际执行首页七项（含四种尺寸／视口组合）和真实 WK 生命周期两项；生产呈现、视口和保存 owner 未再变更。完整 native、提交／推送门禁及最新 CI 在最终提交绑定。
- 最终完整 native 路由 **725 维护文件检查、403 模块画布构建通过，208 tests／50 suites 全通过，TEST SUCCEEDED**（71.073 秒）。此结果来自撤回窗口级试验后的最终测试源，包含绘制帧采样、实际 WK 文件阻挡恢复和 FIFO 六种输入组合；不将前述失败／零选集算作通过。
