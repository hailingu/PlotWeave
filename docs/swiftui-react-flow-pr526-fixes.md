# PR #526 评审与原生 CI 修复（2026-10-12）

范围：[PR #526](https://github.com/hailingu/PlotWeave/pull/526) 的两条评审意见及 [CI run 38198236563](https://github.com/hailingu/PlotWeave/actions/runs/38198236563)。起始提交 `eb0043214917a73072cbbad407419922111fab20`，既有授权分支 `codex/swiftui-react-flow`。CI 的 frontend／Rust 成功；native 编译成功后，宿主在测试连接建立前触发 `NSGenericException`（窗口约束更新循环），退出码 65。

## 实现前关键状态与不变量矩阵

| ID | 前置状态、动作／事件顺序 | 预期可观察结果 | 不变量、所有者与入口 | 验证计划／缺口 |
| --- | --- | --- | --- | --- |
| R1 | 生图 URL 为 IPv4 非全球地址或其 IPv6 映射、兼容、NAT64／6to4 形式→分类 | 拒绝基准测试、保留、文档、协议用途及原有私网地址 | `NativeNetworkPolicy` 拥有地址分类；不能因表示形式放行内部目的地 | 地址表与边界回归；依据 IANA 特殊用途注册表 |
| R2 | 初始 DNS 含公网与非公网混合结果／URL 直接使用非公网 IP→下载；公网首跳→重定向非公网 | 返回 `PW_NETWORK_REFUSED`；初始拒绝不连接，重定向拒绝不发第二跳 | `NativePublicDownload.fetch` 的所有入口逐跳校验全部结果并固定连接 IP | 注入解析／传输回归；真实公网 TLS 未验证，无真实网络调用 |
| R3 | 合法公网 IPv4／IPv6→下载；相对重定向→成功 | 保留原 URL／TLS 主机身份与获准地址，成功返回受限字节 | 下载策略收紧不能破坏合法固定地址、超时、取消及大小上限 | 既有下载／HTTP framing 回归及新增合法地址分类 |
| R4 | 首页收到规范毫秒时间／无小数 ISO 时间／非法或缺失时间／损坏占位 | 两种合法时间显示相对时间；坏值不虚构时间，损坏诊断优先 | `NativeProjectProjection`／项目行仅拥有展示，不改写原时间或磁盘排序 | 真实 SwiftUI／AX 相对时间回归及投影解析；不涉及写入、重试或并发 |
| R5 | Xcode 启动真实 SwiftUI 测试宿主→测试 bundle 尚未加载→窗口与画布初始化 | 测试可建立连接并执行；仅使用内存夹具，不开启用户数据 | App 入口拥有测试模式；SwiftUI 场景尺寸、导航栏约束必须收敛 | 原生路由复现、启动隔离回归；CI 结果须绑定修复后的提交 |
| R6 | 欢迎→编辑／设置→欢迎、收展面板、关闭等待批准 | 同一 WKWebView 与保存 owner 保留，欢迎卡片仍为 480×632 pt | 场景／欢迎 presenter 只拥有展示；导航及关闭继续由既有 owner 批准 | 既有真实窗口、WKWebView 与关闭回归；视觉、IME、VoiceOver 仍为原有缺口 |
| R7 | 完整 app-hosted 目标的多个套件→同时操作窗口、焦点、布局和关闭委托 | 全部断言在各自夹具环境成立；正常并发服务行为仍由其异步回归覆盖 | AppKit 的 NSApplication 是进程级共享状态；验证调度拥有全局隔离，各 suite 的 `.serialized` 不隔离兄弟套件 | 默认并行完整路由复现 8 项干扰失败；CI 与 Scope Routing 改为 `-parallel-testing-enabled NO`，完整目标串行复核，不删除用例或放宽断言 |

地址依据：[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)。单实例边界、付费模型和存储格式不扩展；异步下载沿用既有绝对截止时间、取消和逐跳校验，新增策略不引入重试或共享可写状态。

## 验证结果

本机环境：Node 24.18.0、Xcode 27.0（27A266a）、macOS SDK 27.0。以下命令均在仓库根目录执行，使用隔离夹具，不访问真实模型服务或用户项目。

- R1 先红：旧分类器在 IPv4／转换形式及特殊 IPv6 表中出现 89 项预期错误放行；修复后 `NativeNetworkPolicyTests` 通过。补充 ISATAP 与地址边界，全球可达例外保持。
- R2 先红：`specialUseTargetsNeverReachAnotherTransportHop` 出现 16 项预期失败，初始直接／混合 DNS 返回字节，重定向继续连接。修复后返回稳定拒绝码且连接计数正确；R3 的固定 IP／TLS 身份、相对重定向、超时／取消、体积和 HTTP framing 既有回归通过。成功夹具使用注入的普通全球 IP，文档地址移入拒绝表；无真实网络连接。
- R4 先红：实际 SwiftUI／AX 展示中，添加毫秒时间未增加相对日期字段；无小数时间与非法值的对照通过。修复后这三种展示情况及 `projectDatesPreserveMillisecondsAndRejectInvalidMetadata` 的日期精度、元数据保真、缺失值和损坏诊断优先规则通过。
- R5：新增启动契约测试先因缺少 `NativeLaunchMode` 失败；共享 TestAction 与入口实现后，三项策略及实际测试环境检查通过。原 CI 的启动异常与测试 bundle 加载时序之间为风险推断；明确启动标记消除了该依赖，对应托管 CI 仍须以修复提交的运行结果确认。
- 集中命令：同一 `xcodebuild` 路由追加 `-only-testing:PlotWeaveNativeTests/NativeHomeViewTests`、`NativePublicDownloadTests`、`NativeNetworkPolicyTests`、`NativeLaunchModeTests`、`NativeFormsTests` 五个目标，**30 tests／5 suites 通过**。
- R6／R7：完整默认并行运行 **186 tests／48 suites，8 项失败**，涉及工具栏几何、检查器请求、侧栏、画布宽度恢复与退出委托；相同完整目标串行执行 **186 tests／48 suites 全通过，TEST SUCCEEDED**。现行命令：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData -parallel-testing-enabled NO test`。大小检查 723 个维护文件通过；画布构建 403 模块通过（保留既有大 chunk 提示）。
- `.github/**` 的 `npx prettier --check .github`、scheme 的 `xmllint --noout native/macos/PlotWeaveNative.xcodeproj/xcshareddata/xcschemes/PlotWeaveNative.xcscheme` 与 `git diff --check` 通过。AGENTS／文档无配置的自动语义检查；结构化审阅已核对路由一致性、矩阵、原生专属网络边界、历史证据及交叉引用。

源码、测试及配置均在文件上限内，新增／修改单元未超过 80 代码行；未配置复杂度工具，嵌套与函数跨度已人工审阅。地址策略、日期展示与启动判定各有明确 owner，没有新增服务依赖或可写文档副本。真实公网 TLS、计费、视觉、IME、VoiceOver 与全屏人工验收仍保留原有缺口。提交／推送门禁及修复后托管 CI 的结果在 PR 描述中绑定实际提交，不以历史结果替代。
