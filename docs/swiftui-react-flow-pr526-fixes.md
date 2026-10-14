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

R1–R3 的上述记录覆盖当时已选特殊用途表和下载入口。后续第26条指出名义 `2000::/3` 的保留／未分配空间仍被放行，已建 [issue #528](https://github.com/hailingu/PlotWeave/issues/528) 后续修复并于 2026-10-13 完成（见 R40 修复记录）；不能将既有绿色表测试解释为完整分配状态正确。

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

## 页面进程失效的退出回执

提交 `a4aeca9` 的 [CI #598](https://github.com/hailingu/PlotWeave/actions/runs/38224155233) frontend／Rust／native 全通过，native 为 **208 tests／50 suites**。随后读取到基于 `12a4314` 的新 P2：内容进程收到退出事件后死亡，事件投递本身已成功，页面却无法再发出取消／批准。此独立故障入口属于原退出屏障范围，按该提交的一轮后续意见处理。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R27 | 当前页面已收到退出事件→内容进程终止、导航失败或拆除；未就绪启动退出→同类失效；重载→明确重试 | 实际延迟系统决定回复 false 一次、意图和监听资格清除；未进入延迟决定时不虚构系统回复；恢复不自动退出，明确重试成功回复 true | coordinator 拥有页面失效入口，NativeHostServices 只允许当前连接撤销 HostQuitController 的资格；router／媒体／退出在同一失效入口撤销；旧页迟到失败不能取消新页意图 | 真实 WK 收到退出事件后调用公共 delegate 失效回调，四类失效 × 就绪／未就绪，重载和重复取消；同服务替换页后旧回调迟到；真实 OS 杀死 WebKit 子进程未执行，ready timeout／资源缺失复用失效入口并结构化复核 |

- 有效先红：真实 WK 页面已收到退出事件，新增选集 **5 tests／1 suite、40 处问题**，均对应旧实现未撤销退出／监听资格及由此错误批准或恢复；首次夹具直接 load 但未 reset failed phase 的 46 处结果不作为行为证据，已改用实际 `state.retry()`／`reloadIfNeeded`。
- `NativeHostServices` 用弱当前 coordinator 身份绑定退出监听；`invalidateQuitListener` 只允许该页取消意图、清除监听与 event adapter。`WebCanvasCoordinator.invalidateSession` 同时撤销 router、媒体、退出和就绪任务；进程终止、两种导航失败、拆除走同一入口，就绪超时和缺失资源也复用。首次连接仍按既有合同保留启动缓冲；已失效页面的缓冲清除，恢复后必须明确重试。没有新增桥命令、保存副本或承诺崩溃后恢复未落盘编辑。
- 修复后集中退出／实际 WK **20 tests／5 suites 全通过**。页面失效用例覆盖四类入口 × 监听就绪／未就绪八种组合，验证一次 false、无虚构系统回复、清除 pending／listener、重复失效幂等、真实重载后不自动批准、明确重试 true；旧页迟到进程回调不能取消当前页的真实已投递退出。真实 WK 文件阻挡恢复仍通过。公共 delegate 回调按故障入口调用，未用 OS 杀死真正 WebKit 子进程；就绪超时／缺失资源未增加独立时钟或 bundle 注入，已结构化复核统一入口和取消任务守卫。
- 最终完整 native 路由 **725 维护文件、403 模块构建通过，210 tests／50 suites 全通过，TEST SUCCEEDED**（72.642 秒），包含此前全部退出、窗口绘制帧和所选特殊文件回归。新增／修改 Swift 单元均低于 80 代码行，文件低于硬上限；未配置复杂度工具，人工复核当前页身份、取消顺序及失败入口。文档无自动语义检查，已结构化同步 owner、全部入口、恢复规则与缺口；完整门禁和最新 CI 在 PR 绑定最终提交。

## 设置滚动与密钥草稿

提交 `f597c64` 的 [CI #599](https://github.com/hailingu/PlotWeave/actions/runs/38226506264) 全通过，native **210 tests／50 suites**。读取到基于先前提交的一轮新 P2：grouped Form 的供应商卡片离开渲染范围触发行级 `onDisappear`，清空仍在打开设置页内的未提交密钥；本次按独立滚动触发条件处理。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R28 | 设置页输入合成未提交密钥→供应商卡片滚出／返回；同页 ready→loading→ready 替换 Form；提交→桥失败；整页关闭／重开；供应商删除后同 ID 重现 | 滚动或同页供应商区域重建保留输入与 Save 可用；提交前消费明文，桥失败不缓存；整页离开或供应商删除清除草稿，重开或删除后重现不回显 | 设置页拥有按 provider ID 隔离的短期密钥草稿，行呈现不拥有清理权限；持久设置与 IPC 投影仍不包含明文，普通字段 patch 不带 key | 真实 SwiftUI grouped Form／SecureField／NSScrollView 滚动与区域重建、Save 状态，提交失败后清除、删除重现及整页重挂无草稿；合成只读投影，无真实凭据／模型／用户数据；迟到旧行 setter 的身份守卫结构化复核，未独立注入该回调 |

- 本机实际滚动往返未复现行回调清除，不把该通过算作行为红灯；首次滚动坐标／抛错语法的夹具问题亦排除。使用同一已挂载设置页的既有 ready→loading→ready 状态，实际观察供应商 SecureField 全部从原生树移除后恢复，**1 test／1 suite、2 处预期失败**：草稿为空、Save 禁用。输入前已验证真实 SecureField 绑定使 Save 可用，故不是未更新绑定的夹具假象；此结果证明行所有权无法满足同页生命周期，不声称本机已直接复现虚拟化滚动触发行级回调。
- `NativeSettingsView` 以页级 provider ID 字典绑定各卡片 SecureField，移除行级清理；普通字段仍由原草稿拥有。整页 `onDisappear` 清除所有草稿，ready 投影移除供应商时过滤身份，旧行 setter 不能重建已删除 ID；加载态不视作删除。提交先清除页级输入，再复用已有 `takeKeyArguments` 的修剪与消费，不扩展持久／投影合同。
- 集中命令 `xcodebuild … -parallel-testing-enabled NO -only-testing:PlotWeaveNativeTests/NativeSettingsDraftLifecycleTests -only-testing:PlotWeaveNativeTests/NativeFormsTests test` **6 tests／2 suites 通过，TEST SUCCEEDED**（2.243 秒），包含实际删除首供应商后同 ID 重现不回显，以及提交桥失败后清稿、整页重挂和普通字段 patch 无密钥。仅用合成输入和无 coordinator 的只读状态，未调用真实服务。所有新增／修改 Swift 单元低于 80 代码行，源文件 397 行、测试 140 行；无配置复杂度工具，人工复核生命周期、身份过滤及提交顺序。UI、密钥数据模型、P4 与 F08 已结构化同步；文档无配置自动语义检查。
- 仓库根完整 native 路由 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test` **全部通过：726 维护文件、403 画布模块、211 tests／51 suites，TEST SUCCEEDED**（75.439 秒）。五份同步文档的 `npx prettier --check` 与 `git diff --check` 通过；最新提交／推送的全门禁和 CI 结果在 PR 按最终提交绑定。真正虚拟化离屏回调、物理字符串零化、IME／VoiceOver 仍不由这些合成窗口回归证明。

## 原生意图进入退出屏障

`f597c64` 的一轮后续评审指出新的独立 P2：原生 `send` 的任务尚未跨桥或等待 Web fingerprint admission 时，保存队列可仍为空；退出可能提前批准。以下矩阵在生产修改前记录，处理当前 PR 内原生编辑与退出的交界，不扩展保存合同或自动重试。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R29 | 原生字段提交→立即退出，桥调用或 fingerprint 被确定性闸门挡住；在途请求成功／失败→退出或明确重试；保存冲刷期间出现新原生意图；页面替换／失效 | 退出先等待当前页所有已登记意图，再交给 Web 固定点冲刷；失败取消退出，保留诊断；最终批准仍有原生意图则拒绝并允许重试；旧页不能授权新页退出 | NativeApplicationState 同步登记 send／awaitable request futures，当前 coordinator 负责退出资格；Web 仍拥有图文档和保存队列，批准点必须无未完成原生意图 | 真实生产 WK 的桥前／fingerprint 闸门、失败回执及实际项目磁盘稿件；最终批准期间有在途意图的宿主命令拒绝；重复退出、失败重试与页面代次回归。真实系统菜单／Dock 与物理进程终止保留 P5 缺口 |

- 首次函数选集实际执行 0 项、首次生产夹具未等待打开项目的投影而收到 `PW_STALE_PROJECT`，两者排除行为红灯。修正后旧实现 **9 tests／2 suites、13 处预期问题**：桥前与 fingerprint 两种闸门未放行时提前 true、pending 被消费、磁盘缺少最后字段；失败回执也无法取消已批准的退出；退出投递后新增请求仍可批准。夹具仅在负向观察窗口等待 1 秒，没有增加产品延时、重试或放宽断言。
- `NativeApplicationState.enqueueNativeIntent` 在 `send` 返回前同步登记 future，awaitable `request` 共用登记；当前页弱 coordinator adapter 先将它们排空，再投递 Web 退出事件，Web 继续拥有文档与保存固定点。任何请求失败取消本次退出，不自动重放失败动作。最终 `app_exit` 若有晚到原生请求，拒绝为 `PW_NATIVE_INTENTS_PENDING`，Web 按原失败通道取消并保留窗口，显式重试重新冲刷；页面代次更新／失效取消并清空旧 futures。
- 排空新增 await 路径的邻接回归先红：**7 tests／1 suite、1 处预期失败**，取消退出后旧任务仍迟到投递退出事件。排空结束与最终 event adapter 均检查任务取消，阻止旧投递重放。该测试以实际 delivery 返回作为观察点，不靠等待估计事件是否已发生。
- 修复后集中 `NativeProductionLifecycleTests`、`WebHostBridgeTests`、`HostQuitTests`、`NativeWindowLifecycleTests`、`NativeApplicationStateTests` 和 `NativeSettingsDraftLifecycleTests` **21 tests／6 suites 全通过，TEST SUCCEEDED**（10.043 秒）。三种生产闸门验证桥前／fingerprint 最后字段实际落盘、失败时 false／诊断保留及明确重试 true；宿主最终批准验证晚到意图被拒绝、取消可达和后续重新批准，取消旧 delivery 回归不重放事件。原页面失效／重连／身份回归仍通过；未单独调用真实系统菜单或注入真实计费请求。
- 源码 224／215／380 行，测试 279／285 行，修改单元低于 80 代码行；无配置复杂度工具，人工复核同步登记点、两个原生入口、弱页归属、await 前后取消检查与最终批准的主线程同步守卫。持久化、UI、P3 与 F05 已同步，文档无自动语义检查；Prettier 与 `git diff --check` 通过。
- 仓库根完整 native Scope Routing（与 R28 的完整命令相同）**726 维护文件、403 画布模块、214 tests／51 suites 全通过，TEST SUCCEEDED**（79.420 秒）。最终提交／推送门禁与 CI 在 PR 按最终 commit 绑定；测试只使用注入服务根和合成字段，不触达真实数据、Keychain 或模型。P5 人工验收和真实 WebKit 进程 kill 仍保留既有缺口。

## 原生请求退役与 AI 发送草稿

`b8c83fa` 的一轮后续评审指出两条独立问题，以下矩阵在生产修改前记录。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R30 | 同一保留页面累计超过 4096 次字段编辑后导航；旧已退役 ID 重放；早请求仍在途而后请求已完成；身份冲突、请求满载与新页面 | 长期编辑／导航继续接收；近期重复共享结果，退役重复明确拒绝且不重做；在途不丢失，真正满载才拒绝；真实页面更新后重置 | coordinator 为当前页所有生产原生意图分配单调 ID；Web 维护有界结果和退役水位，保证每个身份至多执行一次，项目往返不重置该水位。既有 Web→Swift opaque 请求容量合同保持独立 | 超过 4096 次真实 SHA admission 后的可观察编辑／导航、旧重放不改变结果、乱序完成及在途重复、冲突／非法 ID／容量恢复／新页；真实 WK 观察生产 ID 和 reload 归属。无限计数溢出明确拒绝，不模拟数千年连续操作 |
| R31 | 真实原生编辑框输入→发送；桥或 Web owner 拒绝／延迟成功；等待期间用户修改文字或重复发送；面板离开／页面更换 | 拒绝保留原稿并展示错误、允许明确重试；仅成功回执且当前草稿仍等于提交快照时清空；迟到结果不清除新输入，等待期间不重复提交 | NativeAiView 拥有未提交草稿与当前提交 token；NativeApplicationState 同步登记 future 并报告结果，Web AI owner 继续拥有用户消息和回合，不新增重试或第二线程 | 真实 SwiftUI TextEditor／发送按钮，隔离 WK 的拒绝／成功闸门，修改后的草稿／重复提交／离开重挂；既有 Web busy／model／unmount admission 回归复用。实际计费请求和 IME 保留缺口 |

- Web 旧实现最小 R30 为 **1 failed／9 passed**：第 4097 个有序字段意图返回 `PW_REQUEST_LIMIT`。生产 Swift 身份观察经夹具就绪纠正后也先红：当前页重连与真实 reload 两处仍是 UUID 而非有序身份。原生 AI 初次 AX 骨架／窗口尺寸及 WK 重载未等待新文档的夹具错误不算行为红灯；修正后 **9 tests／2 suites、4 处预期问题**：AI 拒绝后文字为空／重试禁用，以及两个生产 ID 断言。SwiftUI AX 在动作同步禁用按钮时可返回失败；实际 visible error 证明动作进入生产边界，未送达仍会在有界等待失败。
- R30 将 `native:<正安全整数>` 的分配放在 coordinator，真实 `loadCanvas` 新 session 才重置；Web 只退役已完成有序记录并保留一个水位，缓存始终最多 4096 条。在途重复在水位判断前共享原结果，近期冲突继续拒绝，退役身份明确不重做。旧式 opaque 意图与 Web→Swift router 原有容量保持为独立边界，未新增协议字段、命令、存储 schema 或自动重试。
- R31 复用 `NativeApplicationState.send` 的同步登记和错误报告，增加 presentation completion；旧页只能报告失败，不能成功消费当前草稿。原生 AI 用提交 token 和原稿快照等待回执，拒绝不清稿、等待期间禁用重复提交、离开取消该 presentation token；用户改过文字则成功也不清稿。既有 Web Promise 等待回合落定，模型失败／取消合同保持。
- 集中 Web `npx vitest run src/platform/nativeShell.test.ts src/editor/nativeCanvas/nativeAiShell.test.tsx` **22 tests／2 files 通过**：超过窗口的编辑／导航、退役重复无副作用、旧在途共享及冲突、满载恢复、非法身份／新页隔离与实际 SHA admission；既有 AI busy、模型资格、即时 reservation、卸载和晚回复回归复用。原生集中四套件 **16 tests／4 suites 全通过，TEST SUCCEEDED**（11.432 秒），含真实 TextEditor 的桥拒绝、两种 Web 拒绝后明确重试、成功清稿／新输入／重挂三种条件，以及实际 WK 页面身份重连／reload、生产退出最后字段落盘与投影身份。只用合成提示和本地页，无真实模型、用户数据或 Keychain。
- 仓库根完整 native 路由 **727 维护文件、403 画布模块、218 tests／52 suites 全通过，TEST SUCCEEDED**（81.895 秒）。前端完整路由的静态／严格类型／构建通过；首轮沙箱测试 **17 failed／3120 passed** 均属既有钩子夹具的 `ps` 进程查询被拒绝（`spawnSync ps EPERM`），系统权限下保持原断言重跑为 **219 files／3137 tests 全通过**（52.47 秒）。源文件 285／230／233／393 行、两份 Swift 测试 231／333 行，新增或修改单元低于 80 代码行；人工复核退役／在途顺序、真实页面重置和两个发送入口的所有权，无配置复杂度检测工具。桥合同、UI、迁移 P3/P4 与 AI 数据模型已同步；文档无自动语义检查，结构化复核和 Prettier／diff 检查通过。
- 未逐个注入完整回合中的真实付费提供商异常、中文 IME 或物理 WebKit kill；上述 admission 失败采用实际 WK 返回合成结构化错误，Web 模型／busy／卸载资格由既有 owner 回归覆盖。真实页重新加载后 UI token 的迟到 callback 交叉场景未单独注入；page/session 失效和 UI 离开重挂分别有回归，回执的成功代次检查及提交 token 守卫已结构化复核。原有独立宿主请求容量边界及 P5 人工验收保持明确。

## 首页失败恢复与历史 Rust 边界文档

`29deb37` 的一轮后续评审新增两条独立 P2：原生首页重试仅刷新列表；crate 顶层文档仍把历史 C ABI 写成当前 Swift 服务入口。R32 在生产修改前记录；Rust 文档只同步既定所有权，不改变 ABI 合同，不构造 prose 文本断言。

R32 邻接恢复补查（在本分支生产修改前补记）：列表重读连续返回相同诊断字符串时，读取 owner 未换身份；恢复只需阻止在途重复领取，读取落定后必须重新开放明确重试。原生 app.retry、菜单和 Web 显式入口均由同一恢复 adapter 管理；变更／打开的旧身份与领取保护保持。选定新的真实 App／intent 行为测试观察第二次失败后第三次重读成功；实际 Swift 列表连续 I/O 故障未独立注入，原生资格控件和真实 WK owner 接线复用上述验证。

该补查在 `33a12ad` 上先红 **1 failed／12 skipped**，第三次恢复仍被已领取资格拒绝。修复后只在读取落定且身份仍为当前身份时释放读取领取；旧读取／新变更用例保护已有的身份失效，不作为新增先红证据。最终集中 **79 tests／3 files**、完整前端 **220 files／3151 tests**（53.72 秒）通过，静态、严格类型和生产构建通过；当前资源下完整 native **220 tests／52 suites，TEST SUCCEEDED**（83.447 秒），404 画布模块、729 维护文件通过。恢复 adapter 108、Web 测试 329 行，修改单元低于 80 代码行；UI 与迁移／桥合同同步。实际 Swift 列表连续 I/O 故障仍未独立注入，不将 Web owner 的注入回归冒充该层证明。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R32 | 列表读取／打开／新建／重命名／复制／删除失败→原生点击恢复；重命名 sheet 已关闭；非幂等创建族已部分提交或提交状态未知；旧恢复点击晚于新的失败或成功 | 列表恢复重新读取，打开恢复原 ID，变更恢复原参数并等待其完成；重命名原稿仍由既有回调保留；不可安全重试的失败不显示重试且命令不能重做；旧恢复身份明确拒绝，成功清除对应错误，刷新列表不得冒充变更重试 | App 的现有 openFailure、useHomeActionFeedback 与列表 owner 拥有失败及恢复资格；原生只投影错误来源、恢复资格和身份，app.retry 验证当前身份后调用同一 owner。桥传输错误的刷新与退出保存错误不承诺业务重试；现有尝试序、后台保存恢复和创建族对账继续生效 | 实际 App＋原生 intent 测试六类恢复、目标／原名、部分提交／未知、旧身份及优先级；生产 WK＋隔离 Swift 磁盘和原生按钮验证打开失败修复后重新打开、重命名失败同名重试落盘。既有 Web 尝试乱序与后台恢复测试复用；系统权限／fsync 全阶段注入、真实用户数据和 P5 人工验收不在本次新增验证内 |

- 有效行为先红：隔离首页测试的退出监听前提补齐后，旧实现 **10 failed**，其中最小重命名用例明确观察原稿没有保存，其他用例缺少恢复资格。新增并发邻接用例在无领取守卫时 **1 failed／11 skipped**，两次新传输身份都成功重做同一复制。原生首轮三处夹具错误分别只读取 AXTitle 和平面 name，纠正为公开 AXTitle／AXDescription 与版本化 project.name，不算生产行为证据。
- `useNativeHomeRecovery` 按既有错误优先级投影来源／资格／身份，`app.retry` 验证身份并同步领取，再等待既有 open 或 mutation callback；后者现在返回原 Promise，Tauri UI 仍由 void 事件入口调用。旧身份、成功后身份和已领取身份拒绝；部分提交／未知的创建族不给重试。原生按钮显示具体恢复动作，桥传输诊断的“刷新列表”明确使用 null 身份，不重放业务。重命名 sheet 保持原呈现，其原参数保存在既有 Web 闭包中，不新增草稿持久化、业务命令或自动重试。
- 集中 `npx vitest run src/App.nativeRecovery.test.tsx src/App.test.tsx src/useHomeActionFeedback.tauri.test.tsx` **77 tests／3 files 通过**，含新增 R32 十二项：五种操作恢复、列表恢复、原稿保存、创建族部分提交／未知、旧身份／成功后身份、并发领取与列表优先级／显式刷新。既有尝试乱序和同文档后台恢复回归保持。原生集中 `ShellHomeNavigationTests`／`NativeHomeViewTests` **21 tests／2 suites，TEST SUCCEEDED**（30.612 秒），实际原生按钮＋生产 WK＋隔离 Swift 磁盘验证修复文件后重新打开原 ID、重命名原稿实际落盘与刷新投影，以及允许／禁止重试的真实 AX 控件。
- 完整前端路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 通过，**220 files／3149 tests**；完整 native 路由与 R30 的完整命令相同，**729 维护文件、404 画布模块、220 tests／52 suites，TEST SUCCEEDED**（83.730 秒）。`cd crates && npm --prefix .. run check:size && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` 通过，core **130**、FFI **4**、ABI **7** 项；均使用钉版 Node 24.18.0。两份 crate 文档与实际 NativeHostServices、既定迁移决定及 Rust 标准结构化核对，未改变 ABI 或添加文本断言。
- 修改单元人工复核低于 80 代码行，App 788、恢复适配 99、原生首页 392 行；两份 Swift 测试 266／452、Web 新测试 255 行，文件 cap 检查通过。UI、双向桥与功能补齐合同同步；文档无配置自动语义检查，结构化审阅与 Prettier／diff 检查通过。新原生集成从与 sheet 相同的 app.rename 意图进入，实际 sheet 键入／关闭由呈现和回调归属结构化复核，未单独自动操作该 sheet；传输错误刷新使用 Web 显式 null 路径回归，未独立点击失联页面的刷新控件。真实 IME／VoiceOver、系统 fsync 全阶段注入、计费请求与 P5 人工验收仍保留既有缺口。

## 设置字段与投影回执

`e0de9ee` 的一轮后续评审新增两条独立 P2：默认模型选择携带另一字段的旧快照；服务文字的旧投影覆盖更新的本地输入。以下矩阵在生产修改前记录，复用现有 settings owner、原生表单及保存固定点，不新增配置副本或自动重放。

本节保留 R33–R34 当时的实现与验证记录。后续第25条新增 A→B→A，使新稿再次等于前一权威值，原值比较保护未覆盖该时序；所有者转 [issue #527](https://github.com/hailingu/PlotWeave/issues/527) 后续修复，当前状态及缺口见 [R39](#服务文字回改缺陷的后续修复r39)，其授权修复见文末 [R39 修复记录](#r39-修复记录2026-10-14issue-527-授权修复)。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R33 | ready 设置；聊天→图像或图像→聊天连续选择，第一项的投影尚未返回；单字段置空、旧式双字段、非法／空补丁及 closing | 两项选择都保存；缺席字段保留 owner 当前值，显式 null 只清指定项；非法输入无写入，旧式双字段仍有效 | NativeSettingsView 只提交发生选择的字段；useNativeSettingsShell 按当前同步快照合并并在边界校验，现有 close saver 是唯一持久化入口 | 实际原生 Picker＋生产 WK＋隔离 Swift 磁盘延迟投影；真实 Web intent 先红、两顺序／null／旧式／拒绝边界；实际计费模型不调用 |
| R34 | 服务名称／地址／模型输入新文字；较早投影回执到达→继续输入；最新确认、干净字段外部更新；失败、provider 删除或页面重挂 | 旧回执不替换更新草稿，后续键入基于完整新稿；干净字段接收权威更新，模型确认不消费光标文字的空白；失败保留普通文字，移除／重挂由当前快照重新播种 | NativeProviderSettingsForm 拥有普通输入草稿；只读 provider 是同步基线，Web owner 与既有 saver 继续拥有配置；密钥仍由页级保密生命周期管理 | 实际 NSTextField／模型多行控件与有序投影，继续键入后的真实 Web 及磁盘结果；失败和干净更新邻接、删除／重挂；真实中文 IME、VoiceOver 保留 P5 缺口 |

CI #603 首次执行 frontend 只有临时目录清理 `ENOTEMPTY`（语义断言未失败），native 在首页往返的 AppKit 更新约束发生 NSGenericException；同一提交仅作一次证据重跑，第二次 frontend 220 files／3151 tests、scripts 15 files／314 tests、native 220 tests／52 suites（122.532 秒）和 Rust 全通过。两处根因尚未证明，不将重跑绿色称作根因修复，也未放宽断言、排除测试或增加盲目重试。

- Web 最小单字段回归先红 **3 failed／18 skipped**：两种选择顺序及显式 null 都被旧边界拒绝。真实原生夹具最初的私有 barrier 调用、将 SwiftUI 菜单误认成 NSPopUpButton、未等投影／菜单挂载等错误均排除行为证据。修正后名称／地址有 **4 处预期失败**，旧回执替换新输入，下一次输入的实际磁盘稿件也被截短；默认选择的两种顺序各有 **1 处预期失败**，另一字段实际保存回旧值。
- `NativeSettingsView` 只提交自身默认选择；`useNativeSettingsShell` 校验存在字段并在同步 owner 快照上合并，缺席保留、null 清除，完整双字段旧载荷仍可用。`NativeProviderDraft.receive` 逐字段比较前一权威值与当前草稿，较早回执不得消费新输入；模型按规范化语义确认并保留原始多行文字。未新增磁盘 schema、依赖、业务命令或自动重放，普通草稿与保密密钥仍分属原 owner。
- 当前资源下集中原生 `NativeSettingsEditingTests`、`NativeFormsTests`、`NativeSettingsDraftLifecycleTests` **10 tests／3 suites 全通过，TEST SUCCEEDED**（5.069 秒）。真实原生选择器＋生产 WK＋隔离 Swift 磁盘证明两顺序都保存、旧回执后继续输入不截短；模型草稿确认、干净字段外部更新及未确认稿重播种在生产 draft owner 边界验证，原密钥滚动／提交／删除／重挂回归保持。首次绿灯使用旧构建的 Web 命令边界而超时，重建当前画布后通过，不冒充生产回归失败。
- `npx vitest run src/settings/SettingsView.native.test.tsx` **21 tests／1 file 通过**；新增三项覆盖单字段两顺序、显式 null、空／未知／非法类型，既有完整双字段、未就绪／关闭、失败恢复、并发键／普通字段及退出固定点验证复用。完整前端 Scope Routing 的格式、lint、尺寸、严格类型、生产构建及 **220 files／3154 tests** 通过；完整串行 native Scope Routing 的 **730 维护文件、404 画布模块、224 tests／53 suites，TEST SUCCEEDED**（85.287 秒）。所有服务只使用临时根、合成文字与凭据，无真实配置、Keychain 或计费模型。
- 原生设置源 407、Web adapter 252 行；新增 Swift 控件测试 228、原生表单测试 128、Web 设置测试 769 行，文件 cap 通过。新增／修改执行单元人工复核低于 80 代码行，无配置复杂度工具；检查两字段键白名单、提交前完整校验、同步快照、三个普通字段比较及真实页投影顺序。Provider 数据模型、UI、迁移 §4.2 与桥合同同步，文档无自动语义检查；结构化复核和 Prettier／diff 检查通过。
- 实际中文 IME、VoiceOver、模型 DisclosureGroup 多行控件的旧回执交叉操作，以及普通字段真实页面重挂／供应商删除的 UI 组合未新增自动操作；后两者依赖稳定 ForEach 身份／新稿播种与既有生命周期回归，模型旧回执由生产 draft owner 语义测试覆盖。未注入真实 WebKit 进程 kill 或完整系统故障；保留 P5 缺口。Git 门禁及最终 CI 证据按最终提交绑定在 PR。

## 初始外观的就绪条件

CI #604 的完整原生目标执行 224 tests／53 suites，新增设置回归通过，只有 `ShellWebCanvasLifecycleTests.panelTogglesKeepWebViewAndPageAlive` 的初始 light 断言失败。日志没有返回具体属性值（`<not evaluated>`），不能据此证明根因；代码核对确认原初始就绪只等待九个节点，而 Web 外观消费及 native ready 回推独立完成。以下矩阵在测试调整前记录，只补齐断言的就绪前提，不修改生产外观、窗口或桥行为。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、责任方与入口 | 选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R35 | 夹具节点已渲染，初始 host 外观仍可能在途→面板往返→明确 dark／辅助显示回推 | 独立等待实际语义属性 light 后才进行原初始断言；dark 也读取实际值后断言；属性缺失仍在原 5 秒外观期限内失败 | 生产 appearance reader／consumer 拥有外观，测试等待被断言的观察值；九节点、页内哨兵、WK 身份、栏宽及对比度断言保持，失败不重跑／不捕获 JS 错误 | CI 初始断言失败作为真实输入；集中与完整串行 WK 回归；未确定性重现 CI 当时的缺失属性或 Swift Testing 异步宏内部路径，保留根因证据缺口 |

- `waitForHostColorScheme` 复用原 dark 等待的 5 秒／50 毫秒采样；初始 light 先取得实际值再作原断言，错误继续抛出，超时仍返回不匹配值供断言失败。不增加测试重跑、生产延时或宽度稳定等待。集中 `ShellWebCanvasLifecycleTests` **3 tests／1 suite 全通过**（2.737 秒），保持 marker／Debug inspection／页面及面板回归。
- 仓库根完整串行 native 路由 **730 维护文件、404 画布模块、224 tests／53 suites 全通过，TEST SUCCEEDED**（87.023 秒）。测试文件 225 行，修改单元人工复核低于 80 代码行；没有配置复杂度工具。文档无自动语义检查，已核对失败证据、等待对象、原期限及保留断言；Prettier／diff 检查通过。生产源、前端／Rust、工具链、命令和存储合同未修改，本轮未额外运行其独立完整路由；Git 操作仍要求新生成前端／Rust 覆盖率与完整 Sonar 门禁。

## 反向宿主请求退役与 Web 最终退出协调

所有者在第22、23条评审后授权“继续修复两条并同步相关合同”。以下矩阵先于生产修改记录；R36 扩大原明确保留的 Web→Swift 容量合同，R37 补 Web 写入的最终批准窗口，不混同此前 R30／R29 的原生方向修复。复用现有请求身份、四源保存 owner、失败保稿与明确重试，不增加计费重试、恢复副本或磁盘 schema。

| ID | 前置状态／动作顺序 | 预期可观察结果 | 不变量、owner 与入口 | 选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R36a | 规范生产请求累计4096次完成→保存／退出→重放已退役ID | 新命令继续，真实稿件落盘并可批准退出；旧ID明确拒绝，无第二次副作用 | HostCommandRouter 只退役已完成规范身份；invokeSwiftHost 分配现有 sessionId:正整数，不自动重放 | 最小真实 Swift 存储／退出回归先红；近期重复、参数冲突、长期页面接线；不访问用户根 |
| R36b | 乱序完成、旧请求仍在途、全部在途／opaque满载→新命令→完成／新页 | 在途重复共享；真满载仍拒绝，完成后可明确继续；新页清除旧权威 | 请求窗口有界，退役水位拒绝旧重放但不能丢失在途 Task；实际 loadCanvas 拥有重置 | 确定性入场闸门、非幂等副作用、旧式身份与新session／失效；不调用计费模型 |
| R37a | Web四源干净或已冲刷→退出开始→最终原生批准仍在途→新Web编辑 | 开始退出即暂停用户输入及新业务操作；最终封口后持久化写入口显式拒绝，状态与脏稿不变 | 页级入场闸 open→draining→sealed；画布状态／viewport／markDirty、AI thread、设置 update 及 App 文档 owner 的最终写入口守卫；原生意图另受入场闸约束 | 真实 useEditorDocument＋useExitFlush 最小先红；干净／脏稿分支、四 owner、原生回执被挡、失败解锁后再次编辑 |
| R37b | 退出前已接纳的 Web 模型／生图／资产导入／项目动作仍在途→迟到结果写状态→四源保存落定 | 等完整业务操作（含结果交付），提交 React 更新及保存 effect 后再冲刷；只在所有操作及四源都空闲的同步跨度内封口，不丢已接纳结果 | 整体异步业务的入口登记拥有 future，不能以单次 IPC 结束替代；现有 owner 继续唯一持有状态与错误，draining 允许既有工作完成 | 真实资产 drop／文档保存磁盘回归；AI、设置／密钥及项目导航邻接回归；失败保稿／重复退出／卸载释放及明确重试；Dock／IME／VoiceOver 保留 P5 缺口 |

- **R36 红→绿与邻接**：`HostRequestRetirementTests.completedProductionRequestsAllowSaveAndQuit` 在原实现先出现五项预期失败：4097 次真实保存和其后的退出均被容量拒绝，磁盘仍是旧名称、没有批准，旧回放也未退役。修复后以隔离 `NativeHostServices`／真实 `NativeProjectStore` 保存最新稿并批准退出；低序号在途重复与乱序完成、水位重放、4096 全在途拒绝后明确恢复、实际新 session 与非法／最大安全序号共四项新回归。包含既有 opaque 容量与生命周期的集中 **11 tests／3 suites 通过**（1.574 秒），旧式满载合同保持。
- **R37 红→绿与 owner**：原 `useEditorDocument` 在最终 `app_exit` 回执被挡时仍接受集标题新稿，最小测试先红；最终真实 owner 回归明确拒绝集标题、AI 批次数、完成视口与设置 update，状态及 settings 待存登记不变。真实 Web 资产 drop 从导入／校验 IPC 到实际 React 图和索引提交，再通过生产序列化／保存链写入临时项目文件；批准时磁盘已包含媒体及引用。另以同一次 React 批次“编辑→退出”验证尚未执行保存 effect 的稿件也被等待；最终批准失败释放输入，新稿再次实际保存后明确重试成功。没有用 mocked save 次数代替结果。
- **实际 WK／Swift 磁盘**：新增 `NativeProductionLifecycleTests.webFinalApprovalSealsCleanAndDrainedDocuments` 两参数路径；使用真实 Web document 键盘删除作为退出前的 Web 写入，带回执 handler 代理只拦最终批准，原始请求／frame／coordinator 原样继续。干净与待冲刷页面都具有实际 inert，最终阶段的新 Web 撤销事件被阻断；放行后 Swift 文件分别保持正确节点数。与 R36 和既有退出失败／原生意图回归集中 **8 tests／2 suites 全通过**（10.675 秒）。夹具曾错误假设默认梗概及 WebKit 属性可写，另曾缺少回执并发注解；修正为明确基线和协议一致代理后通过，这些不属于产品先红证据。
- **实现边界**：新页级协调器只持有操作／提交 future 和单一租约，无文档副本；完成移除、失败／卸载释放，旧释放不影响新页租约。`useExitGuardedCallback` 以实际提交的修订 effect 确认状态，不能以 Promise 回执或空 `flushSync` 代替；无变化的 App AI 保存保留原“编辑器零额外提交”合同。图测量／选中只更新会话态；真正持久化写入才参与封口。App 798、router 171、新 Swift 请求测试 158、生产生命周期测试 350 行，修改执行单元人工复核低于 80 代码行，未创建检测工具或工程豁免。
- **验证与缺口**：最终静态检查（格式、ESLint 零警告、尺寸、严格类型）及前端生产构建通过；当前资源的完整串行 native 路由 **737 维护文件、229 tests／54 suites 全通过，TEST SUCCEEDED**（89.927 秒）。画布、AI、生图、App、设置／密钥、桥及退出租约集中 **9 files／172 tests 通过**，完整前端 **223 files／3161 tests 通过**；新 Git 门禁结果按最终提交补入 PR。沙盒禁止 `ps`／testmanagerd 的执行不作为产品失败，正常本机环境完成检查。桥、UI、迁移、持久化、AI 和 Provider 设计已同步；纯文档无自动语义检查，结构化复核身份／水位、唯一状态 owner、失败恢复及引用完成。未新增真实计费模型／生图、真实页面 4096 长会话洪泛、Web AI 最终封口与密钥的实机交叉操作、菜单／Dock／IME／VoiceOver 或进程 kill；前者由确定性边界与既有 owner 回归覆盖，后者仍属 P5 人工缺口，未挂载回合／未提交草稿及强制退出仍保持原边界。

- **末次复核纠正**：首次提交门禁被 Sonar 的七项新代码问题阻止（五处 React setter 命名、Promise await 与 iterable 写法）；仅调整对应表达，退出协调行为保持。调整后集中 5 files／88 tests 与 AI／历史／生图 3 files／81 tests、生产构建及静态检查通过。本机一次误用 CI 的 Xcode 安装路径未启动原生测试，确认默认 Xcode／SDK 均为 27.0 后改用已选工具链；另一次漏串行参数使 54 个共享 NSApplication 套件并行启动、出现 23 issues，不作为完成证据。补回仓库规定的 `-parallel-testing-enabled NO` 后，最终完整 229 tests／54 suites 全通过（89.927 秒），保留全部断言。完整 Git 门禁按最终提交在 PR 记录。

## 导入媒体与索引失败恢复（R38）

第24条 [P2 评审](https://github.com/hailingu/PlotWeave/pull/526#discussion_r4250345857) 指出媒体已落位而索引写入失败时，重复导入留下不可见文件。所有者于 2026-10-13 授权“继续修复并同步合同”，扩展资产 §7.2 的导入恢复；以下矩阵在生产修改前记录。复用既有身份日志、受信目录句柄与隔离统计，不采用按名称删除、不扫描历史孤儿、不重放导入或计费动作。

| ID | 前置状态／动作与顺序 | 预期可观察结果 | 不变量、owner 与入口 | 实现前选定验证／缺口 |
| --- | --- | --- | --- | --- |
| R38a | 正常导入；校验、备份、临时媒体或日志登记失败→明确重试 | 成功媒体和索引一致、事务退役；媒体最终落位前的失败不产生新孤儿 | NativeLibrary 在已持锁期间准备完整索引，媒体临时文件 fsync 后登记真实身份，日志耐久后才 rename | 真实服务、磁盘字节与只读控制目录故障；首次失败行为回归先红 |
| R38b | 媒体落位→索引提交前失败→列表／再次导入／重启 | 保留原错误；恢复将确认未提交的同一身份隔离，摘要恰一次累计；不继续积累无证据媒体 | NativeLibraryJournal 拥有导入证据与恢复，未解决导入阻止进一步写入；无身份绑定删除能力时隔离区物理保留 | 确定性存储阶段闸门、实际文件占位失败、重复恢复及重试后的新索引／媒体 |
| R38c | 索引已 rename→目录耐久屏障失败或事务收尾失败→恢复 | 已提交媒体继续可用，核对并同步当前权威索引后才退役证据，不误隔离或回滚 | 失败不等同未提交；实际索引及所有活动文件身份共同决定引用，所有引用入口保持媒体可恢复 | 索引落位后确定性失败、同身份不同 relPath 引用、中断隔离后新增引用仍保留副本统计、真实文件读取；物理断电未验证 |
| R38d | 索引损坏、规范化会丢弃成员、迁移挂起、媒体身份替换或不可信日志→恢复／新写入 | 原媒体／日志保留，证据警告可见，写入暂停；修复权威状态后明确重试 | 局部视图或无法读取的引用不能证明媒体未提交；恢复不会覆盖后来文件或用新身份清掉旧证据 | 损坏索引、非法成员、替换 inode／symlink、日志异常及恢复后可用性；不自动猜测修复 |
| R38e | 恢复隔离／日志写失败、journal 半上限、多个待恢复条目→再次恢复 | 保留事务或完整新统计，失败不制造重复计数；容量拒绝先于媒体最终落位 | 同一对象联合持久化事务与统计；导入／删除、列表、媒体打开和项目复制共用同一锁／恢复入口 | 实际目标占位、原生边界回归及 openMedia／source 替代入口；并发由既有 actor＋flock 序列化，无新并发通道 |

本轮仅修改 native 导入与恢复及相关合同，Tauri 历史导入不迁移到新协议；未知旧孤儿的来源无法由本次日志推断，仍须人工核对。

- **先红与邻接先红**：`unwritableControlDirectoryDoesNotAccumulateUnindexedMedia` 通过真实控制目录权限故障在旧实现执行 1 test／1 suite、出现 1 处预期失败，三次失败导入累积最终媒体，原索引保持。修复后，对中断隔离再出现同身份硬链接的邻接转换新增 `activeReferenceAfterInterruptedQuarantineKeepsCleanupVisible`，10 tests／1 suite 出现 6 处预期失败：三次恢复均缺少保留项数／字节。补齐身份核验副本的联合统计后全部通过。首次修复编译曾因 Sendable closure 捕获可变 ID 拒绝，改为固定身份值；编译错误不作为行为红灯。
- **矩阵对应**：R38a 使用上述权限故障及 `failureAfterRecordingBeforePlacementRetiresWithoutCleanup`，验证日志登记后尚未 rename 的中断不留最终文件；正常成功、校验与损坏备份沿既有 `NativeLibraryTests`／`NativeLibraryRecoveryTests`。R38b 的 `indexFailureReconcilesOnceAcrossRestartAndRetry` 在媒体落位后用实际目录占位阻断索引写，分别以列表／openMedia／source 进入恢复，核对真实新旧字节、重复恢复与再次导入的权威结果。R38c 的 `indexRenameFailureKeepsCommittedMediaAvailable` 在真实 index rename 后、目录 fsync 前注入抛错，证明新索引及媒体保留，不将注入声称为 OS 实际返回 fsync 错误；两个硬链接用例核对跨路径活动身份和额外隔离副本可见。R38d 覆盖语法损坏／非法成员、后来普通文件／symlink、活动引用打不开三类，重复读取不改原索引或证据，进一步导入被拒绝；既有日志异型、迁移超限回归保持。R38e 的 `recoveryJournalFailureRetainsEvidenceAndCountsOnce` 以真实只读控制目录阻断隔离后的日志提交，恢复三次恰累计一次；`oversizedImportJournalRefusesBeforeMediaPlacement` 与既有删除边界共同验证半上限及完整原件保留。
- **命令与结果**：仓库根执行 `npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`，最终 **738 维护文件规模检查、当前画布构建通过，240 tests／55 suites 全通过，TEST SUCCEEDED**（90.481 秒）。相同 Xcode 命令筛选 `NativeLibraryImportRecoveryTests`、`NativeLibraryRecoveryTests`、`NativeLibraryJournalBoundaryTests`、`NativeLibraryTests` 为 **26 tests／4 suites 通过**（3.540 秒）。Node 24.18.0、已选 Xcode 27.0／SDK 27.0；`bash scripts/check-static.sh` 的格式、ESLint 零警告、尺寸与严格类型通过。Git 操作仍另行生成新前端／Rust覆盖率并等待 Sonar，最终提交、门禁与确切 head 的 CI 记录在 PR。
- **设计与缺口**：资产 §7.2、持久化命令、UI、P4／F07 已同步登记顺序、未知状态保护、共同恢复入口、写入暂停和物理保留。纯文档没有配置自动语义检查，已结构化核对引用／合同／矩阵，Prettier 与 diff 检查通过。最大修改 Swift 源为日志 362 行，新增测试 295 行；修改单元人工复核低于 80 代码行、嵌套在标准内，圈复杂度 `N/A — no configured complexity tool`。没有修改 frontend／Rust 或 CI 配置，未额外执行其独立完整路由；Git 门禁与 PR CI 仍执行相应检查。所有故障只作用于合成临时根，不访问用户数据。真实满卷、物理断电、OS 进程 kill、NSOpenPanel／人工隔离区清理未实测；合成阶段故障、真实权限／目录占位、同卷硬链接和 actor 重启覆盖所选风险，不承诺自动释放隔离空间或修复无证据旧孤儿。

## 服务文字回改缺陷的后续修复（R39）

第25条 [P2 评审](https://github.com/hailingu/PlotWeave/pull/526#discussion_r4250704597) 是 `795f1cc4f18510d88cf0d578f0b107ddc41e4b2d` 首轮后续评审的新触发条件。原生名称、地址或规范化模型列表 A→B→A 后，新 A 再次等于上一权威值；`NativeProviderDraft.receive` 因值相等接受旧 B 投影，继续键入可能经原 saver 保存非预期文字。这是待修复缺陷，R34 的既有通过用例不能证明该转换正确。

所有者于 **2026-10-13** 明确要求创建后续修复 issue 并准备合并 PR。本条已创建 **[issue #527：P2(settings): 原生字段回改原值时旧投影覆盖新草稿](https://github.com/hailingu/PlotWeave/issues/527)**，保持 open、P2，修复延期到该 issue；本轮仅同步文档和处置记录，没有生产代码／测试／桥合同载荷修改。名称、地址及模型的保护设计要求仍在，尚未加入逐字段编辑身份或确认；issue 中的瞬时确认方案是待设计建议，不是已实现或本轮获准实施的功能。

| 后续 case | 前置状态／动作与顺序 | 后续修复应满足的结果／不变量及 owner | 当前证据与验证缺口 |
| --- | --- | --- | --- |
| R39a | ready A→实际输入 B→A→旧 B 投影→继续 C→关闭 | Native 普通字段保留新 A；Web owner／原 saver 最终保存 A+C | 只读核查 `receive` 与三个 binding；独立 ABA 控件／生产 WK／Swift 磁盘回归未执行，留给 #527 先红后绿 |
| R39b | 模型以不同原文回到规范 A→旧 B→最新确认→外部更新 | 编辑确认与值或规范化相等分开；保留光标原文，确认后干净字段仍跟随 | R34 已有模型语义与干净更新测试，仅证明已选路径；新回改及 IME／VoiceOver 未验证 |
| R39c | 请求先完成、投影被挡；同值无关投影；React 合并或旧 B 确认 | Native completion 不冒充投影确认；Web 必须把确认与确切快照配对，字段独立；global sequence／session 防乱序保持 | 现有生产 WK 夹具能独立暂停投影／排空请求；新身份合同及合并确认尚未实现／验证 |
| R39d | 非法元数据、未就绪／closing／不存在 provider、失败或旧式 patch | owner 变更前完整校验；失败保留普通稿，不自动重放；旧式输入兼容 | 当前错误、保存固定点及密钥测试保留；提议的元数据边界未实施，须由 #527 新增语义回归 |
| R39e | 确认后外部更新；另字段 pending；provider 删除、reload／重挂／session 失效 | 草稿与确认由当前字段／页面 owner 持有，后代不消费旧确认；元数据有界且不写磁盘 | 既有普通稿播种和密钥生命周期证据保留；新确认清理及三字段组合未验证，真实 kill 保留人工缺口 |

命令回执与只读投影独立交付，React 可合并中间状态；仅用请求完成、值再次相等或永久 dirty 都不能同时满足新稿保留和干净外部更新。后续实现须先记录矩阵、观察真实最小先红，再设计有界字段身份与快照配对，完成选定转换、设计同步、前端／原生完整路由及 Git 门禁／CI；具体验收条目在 #527。本轮文档无配置的自动语义检查，也不制造源码或普通文字镜像测试；检查记录及最终文档提交／CI 将补在 PR，基线 CI #607 不作为 ABA 已修复证据。

## IPv6 保留与未分配范围的后续修复（R40）

`2fc5a756e44cccacc0eb632ba2abc488ea6e0b30` 的第一轮后续评审新增第26条 [P2](https://github.com/hailingu/PlotWeave/pull/526#discussion_r4251017464)：`3ffe::1` 通过当前 `NativeNetworkPolicy.publicV6` 的兜底，但 [IANA 全球单播登记](https://www.iana.org/assignments/ipv6-unicast-address-assignments)将 `3ffe::/16` 标为 RESERVED，且 `2000::/3` 中未列的空间保留给未来分配。核查日期 2026-10-13，登记页更新日期 2025-10-10。这是 R1 当时特殊用途表以外的新分配状态触发，已创建开放的 **[P2 缺陷 issue #528](https://github.com/hailingu/PlotWeave/issues/528)**；分类缺陷待修复，合并处置需包含该开放问题。本轮仅同步文档，不修改生产分类器、网络策略测试或下载协议。

| 后续 case | 状态／入口及应维持的不变量 | 当前证据／验证缺口 |
| --- | --- | --- |
| R40a | literal 为 RESERVED／未分配的名义全球单播；classifier 必须拒绝，不能因 `2000::/3` 通过放行 | 编译实际 HostJSON 与 NativeNetworkPolicy，`3ffe::1`、`3000::1`、`3fff:1000::1` 均返回 true，缺陷真实复现；非完整分配表测试 |
| R40b | 已分配公网、特殊用途全球例外及 IPv4 转换表示；合法分类、连接固定与 TLS 原主机身份保持 | 同次实际执行 `2606:4700::1111` true、`fd00::1` false；现有 R1／下载回归保留，不能据两个对照宣称全部合法地址或 IANA 登记均正确 |
| R40c | 初始 DNS 全保留／混合答案、重定向到保留目标；拒绝先于连接，入口共用 classifier | NativePublicDownload 接线已读；新增保留段的 downloader 回归与真实路由未执行，#528 应以注入解析／传输证明拒绝不连接，同时保留 deadline／取消／大小语义 |

仓库根以 Xcode 27.0／SDK 27.0 执行 `xcrun swiftc -swift-version 6 -module-cache-path /private/tmp/pr526-r40-policy-check/cache native/macos/App/HostJSON.swift native/macos/App/NativeNetworkPolicy.swift /private/tmp/pr526-r40-policy-check/main.swift -o /private/tmp/pr526-r40-policy-check/check`，再运行临时 binary，退出 0。main 仅逐个调用真实生产谓词，不读取源码作普通文字断言、不调用网络／模型或用户数据；临时验证输出清理。上述真实 classification 不是 Swift Testing 新回归、不是已修复证据，也不证明实际 SSRF／内部泄露。当前测试还显式允许 `3fff:1000::1`，后续应一并审阅。

资产 §7.3、功能 F09 和本记录已区分已选特殊用途防线与分配登记缺口。纯文档无配置自动语义检查，检查及最终提交／CI 证据补于 PR；源码路由不因只读分类器核查而宣称重跑，既有 CI #608 首次全绿不代表本缺陷消除。#528 收录最小先红、分配前缀边界、合法例外／转换形式、literal／DNS／重定向、预算／取消和完整 native／Git 门禁／修复 CI 验收；策略表来源和更新机制待后续设计。实际特殊网络路由、真实公网 TLS 与计费模型未测试。

### R40 修复记录（2026-10-13，issue #528 授权修复）

`publicV6` 由名义 `2000::/3` 黑名单兜底改为 IANA 登记白名单 `globalV6Rows`（[全球单播分配登记](https://www.iana.org/assignments/ipv6-unicast-address-assignments)全部 ALLOCATED 行＋[特殊用途登记](https://www.iana.org/assignments/iana-ipv6-special-registry)全球可达的 `2001::/23` 例外；核对 2026-10-13，登记页 2025-10-10），`2001:db8::/32` 文档段自 APNIC `2001:0c00::/23` 行内扣除。实现顺序为先红后绿：

- 先红：`nonGlobalIPv6IsRefused` 扩展保留行与 `2001::/16` 间隙（10 项）、新增 `allocatedPrefixBoundariesFollowIanaRegistry`（21 项）、`globalAddressesRemainEligible` 移除 `3fff:1000::1`、`specialUseTargetsNeverReachAnotherTransportHop` 扩展保留目标与全保留 DNS（24 项），旧分类器共 57 项预期失败，方向均为错误放行。
- 修复后上述全部通过；独立编译真实 `HostJSON`＋`NativeNetworkPolicy` 谓词，`3ffe::1`／`3000::1`／`3fff:1000::1` 输出 false，`2606:4700::1111`（true）与 `fd00::1`（false）对照不变，与 issue #528 复现命令同构。
- 登记行核对修正两处初始误读：/12 行只覆盖 `X000–X00F` 首段（`2400::/12`＝2400–240f），故 `2410::/12`、`2610::/23`、`2620::/23`、`2630::/12`、`2a10::/12` 为独立登记行需单独收录；`2001:1::1–3` 为 /128 例外。
- 既有合法分配、全球可达例外、IPv4 转换形式、候选回退、原 hostname TLS 身份、共享 deadline／取消／大小上限回归全部保持；完整 native 路由（`npm run check:size && npm run build:native-canvas && xcodebuild … test`）、Git 静态／覆盖率／Sonar 门禁与绑定修复提交的 CI 证据见修复 PR。

静态表更新机制：IANA 新增分配需人工同步 `globalV6Rows` 并同批更新边界回归（资产 §7.3 已披露），无运行时同步；真实特殊网络路由、真实公网 TLS 与计费模型仍未测试。

### R39 修复记录（2026-10-14，issue #527 授权修复）

用户要求按 [issue #527](https://github.com/hailingu/PlotWeave/issues/527) 创建分支修复并推送 PR。以下矩阵在生产修改前记录并映射验证结果；确认规则为：投影可替换某字段当且仅当该字段值意义上干净（草稿＝前一权威值；模型按规范化列表）**且**该快照确认严格新于其全部待定编辑身份；快照确认达到或超越最新待定身份即清除之。

| case（映射 R39） | 前置状态／动作与顺序 | 结果与不变量 | 验证 |
| --- | --- | --- | --- |
| M1＝R39a | ready 草稿 A→输入 B（身份1）→回改 A（身份2）→旧 B 投影（确认1）→继续 C→关闭 | 旧 B 投影不消费新 A；继续键入与最终磁盘为 A+C | `revertedProviderEditKeepsNewerDraftAheadOfStaleEcho`：真实 NSTextField＋生产 WK owner＋隔离 Swift settings.json，先红 4 处（两字段被覆盖、两字段磁盘错误）后绿 |
| M2＝R39b | 模型原始多行稿规范化后回到旧列表→旧 B 回执→最新确认→外部更新 | 原始光标文字与空白保留；确认后干净字段仍跟随 | `revertedModelListKeepsRawMultilineDraftThroughStaleEcho`（draft 边界）＋既有 R34 模型语义测试 |
| M3＝R39c | 命令先完成投影被挡（M1 夹具）；同值无关投影；React 合并只发终态；确认与快照同批 | completion 不冒充确认；同值投影零动作；合并终态携带最终身份并清待定，`edits` 参与 Equatable 保证确认可观察 | M1 夹具 pauseProjections／drain 独立通道；`sameValueMergedConfirmationClearsPendingWithoutRewritingTheDraft`；TS `edit identities pair each applied field edit…`（同 tick 两个 intent 合并后配对正确）；全局 sequence 乱序仍由既有 `receiveProjection` 单调校验拒绝，未改动 |
| M4＝R39d | 非法元数据（未知／缺席字段、0／负／小数／字符串身份、非对象）；未 ready／closing／不存在 provider；旧式无 `edit` 补丁 | owner 变更前完整校验拒绝，save 不触发；旧式补丁应用但不记录确认 | TS `malformed edit metadata is rejected before the owner changes`＋既有 readyProvider／校验回归；`providerEditMetadata` 在 `patchCurrentProvider` 之前执行 |
| M5＝R39e | 确认后外部更新；另字段待定交叉；provider 删除／重挂／owner 卸载 | 逐字段独立；身份有界（每 provider 每字段仅最新），删除／卸载清理，磁盘 schema 与密钥生命周期不变 | `revertedAddressStaysAheadOfStaleEchoAcrossIndependentFields`、`revertedLabelKeepsNewerDraftAndFollowsAuthorityAfterConfirmation`；TS `edit identities stay bounded to current providers and do not survive owner remounts`；既有生命周期回归保持 |

- **实现**：Swift `NativeProviderDraft` 增加逐字段待定身份（`beginEdit`／`pendingEdits`），`receive` 在 R34 值比较之上叠加"确认严格新于待定"与"确认达待定即清除"；`NativeProviderProjection` 解码 `edits`（仅 label／baseUrl／models 的正整数，非法项视为无确认）并参与 Equatable。TS `useNativeSettingsShell` 为 `settings.patchProvider` 增加可选 `edit` 元数据（边界校验先于变更），`patchCurrentProvider` 在替换快照的同一同步步骤记录身份，投影为当前 provider 回显 `edits` 并对已删除 provider 修剪；卸载清空。身份不写 `settings.json`、不含密钥、无第二份可写配置、无自动重放。
- **先红**：WK ABA 回归在旧实现 4 处预期失败（`初始服务`/`https://fixture.example/v1` 字段被旧 B 投影改为 `名称甲`/回改地址，磁盘保存 `名称甲丙` 等）；TS 3 项新语义测试在旧实现失败（投影无 `edits`、非法元数据未拒绝）。Swift draft 级新用例依赖新 API（`beginEdit`），编译期即需新实现，不计入行为先红证据。
- **验证**：`npx vitest run src/settings/SettingsView.native.test.tsx` **24 tests／1 file 通过**；集中原生三套件 `NativeSettingsEditingTests`／`NativeFormsTests`／`NativeSettingsDraftLifecycleTests` **16 tests／3 suites 通过**。仓库根完整前端路由（format:check／lint 零警告／check:size 715 文件／typecheck:strict／build／`npm test` **228 files／3132 tests**）与完整原生路由（`npm run check:size && npm run build:native-canvas && xcodebuild … -parallel-testing-enabled NO test`，**248 tests／55 suites，TEST SUCCEEDED** 93.062 秒，Node 24.18.0／Xcode 27.0）通过。原生设置源 459、Web adapter 307 行，全部低于文件上限；新增／修改执行单元人工复核低于 80 代码行。
- **缺口**：真实中文 IME／VoiceOver、物理进程 kill 仍属 P5 人工缺口（沿 R34/R39 记录）；被动 effect 读取身份映射存在"提交后、effect 前到达的更新补丁"窗口，可能以较新身份配对较旧值发布一次，但值比较后备使该中间投影至多提前清待定而不改写脏草稿，随后投影自纠——未单独注入该时序的自动化回归。Git 门禁（新生成覆盖率＋Sonar）与绑定修复提交的 CI 证据在 PR 记录。
