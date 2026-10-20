# Native Swift 覆盖率报告

对应 [issue #601](https://github.com/hailingu/PlotWeave/issues/601)，采用“先报告后立阈值”。日常功能回归必须成功采集新报告；默认没有 native 百分比下限。既有前端/Rust 80% 下限和 Sonar 源码范围保持不变，也不把 native 测试加入每次提交的统一成本。

## 运行与产物

从仓库根目录使用钉版 Node 与 Xcode；覆盖率解析遵循门禁已选择的 `PLOTWEAVE_NODE_BIN`，未设置时才从 PATH 选择 `node`：

```sh
sh scripts/test-native.sh
```

入口先构建画布，再串行执行既有真实 WKWebView/AppKit 功能回归，显式传入 `-enableCodeCoverage YES`。Xcode 构建使用 `-jobs` 与正整数 `PLOTWEAVE_GATE_CPU_BUDGET`，缺省固定为 4。压力测试仍需显式 `sh scripts/test-native.sh stress`；该模式关闭覆盖率 instrumentation，保留原测量选择和规模，不生成覆盖率报告。

正常回归通过独立临时 `.xcresult` 及 `xcrun xccov view --report --json` 生成：

- `native/macos/build/coverage/coverage-summary.json`：生产 App 计数、源文件清单、缺报项、阈值状态与生成时间。
- 同目录 `coverage-summary.md`：总数、逐文件表及缺报清单。
- 同目录 `xccov.json`：原始工具报告，含 target 和函数计数，用于进一步定位；其中的测试 target 不进入 App 汇总。

CI 将 Markdown 追加到 GitHub step summary，并以 `native-coverage-<run_attempt>` 上传上述三个文件。测试失败时仍尝试上传已有本轮产物；没有报告不掩盖原测试/采集步骤失败。成功后入口删除本轮大体积结果 bundle，失败时打印并保留诊断目录。上述 build 目录是可丢弃验证产物，不提交版本库。

## 统计范围与失败语义

汇总只取唯一的 `PlotWeaveNative.app` target 中、实际仓库 `native/macos/App/**/*.swift` 的逐文件 covered/executable 行数。它重新求和，不采用包含测试的总计或浮点展示字段。Tests、App 目录外生成代码及 WebKit 进程内 JavaScript 不计入该指标。

源文件清单独立扫描实际 App 目录：编译器未报告的文件单独列为 unavailable，不伪造为 0/0，也不假定为 100%。报告覆盖到的行有明确分母；清单缺口不代表未报告文件没有可执行代码。Xcode 测试宿主可能执行应用启动代码，因此行命中不是分支行为验收的替代。

构建、测试和 xccov 非零退出会阻断入口；缺少/重复 App target、无可测 App 行、无效行计数、重复或不属于当前清单的 App 源文件、不可读取 JSON 均阻断。每次正常回归开始先清除入口拥有的三个旧报告，避免失败后误用上一轮成功摘要。

## 显式下限

需要单次验证某个下限时：

```sh
PLOTWEAVE_NATIVE_MIN_LINE_COVERAGE=80 sh scripts/test-native.sh
```

空值选择 report-only；非空必须是 0–100 的十进制百分比。显式下限要求源文件清单完整，并以原始整数行数比较，不用保留两位小数后的值决定通过。低于下限或有缺报文件均非零退出，报告保留并标记 below-minimum 或 incomplete。默认 CI 不配置该变量；确立统一 native 下限需要后续基于基线的决定。

## 首次基线与验证边界

2026-10-19，在 dev `7dfabe5bce239769602ec2ce5cee1315ef6e295c` 上，macOS 27.0.1、Xcode 27.0 / SDK 27.0，CPU 4，压力关闭：真实功能回归 320 tests / 68 suites 通过；App 7372/9427 行，即 78.20%，报告 69/70 个 Swift 文件。当时唯一缺报文件是 `ShellStage.swift`，其无生产消费者的类型及自证测试已由 [#615](https://github.com/hailingu/PlotWeave/issues/615) 移除；这里保留的历史基线不能通过显式 80% 下限。

同一变更的正式公共入口复测为 320 tests / 68 suites 通过、7371/9427 行（78.19%），清单仍为 69/70。两次执行相差 1 行命中，报告按实际本轮计数保存，不固定或修饰百分比。

2026-10-19 的 #615 清理仅删除无生产消费者的阶段类型与两个常量自证测试。正式公共入口回归为 318 tests / 67 suites 通过；App 7371/9427 行（78.19%），清单为 69/69，无缺报文件。原缺口来自被移除的死类型，未增加产品排除、改变阈值或减少可测行分母；上方 #601 的历史基线与测试数量保留。

此变更建立报告链路及失败契约，没有为提高数字而补齐所有未测分支，也没有重新评分历史质量基线。覆盖率不验证视觉快照、VoiceOver 或真实 IME；既有验收边界保持不变。

## 共享资产契约向量

[#649](https://github.com/hailingu/PlotWeave/issues/649)／[#650](https://github.com/hailingu/PlotWeave/issues/650) 的[资产契约向量](../../crates/plotweave-core/testdata/asset-contract.json)是手工维护的 v1 JSON 测试数据，不生成生产代码，不增加依赖。`relPaths` 分别声明基础词法与活动索引判定，`mimes` 声明规范 MIME 判定；每例有可诊断的 `id`。修改已接受契约时，在这一份数据中增加普通值、拒绝值及近邻对照，再分别运行消费方，不能靠同步复制期望值掩盖分歧。

Rust 的 `store::validate::tests::shared_asset_contract_vectors` 与 Swift 的 `NativeAssetContractVectorTests.sharedAssetContractVectors` 各自调用真实叶子谓词，独立构建与运行；Web 的 `src/model/assetContract.test.ts` 通过 `parseProject` 检查活动路径隔离。两宿主另用真实临时项目验证保留引用上报、未修复保存拒绝、修复后保存／重开，以及隔离字节不被改写。前端仍是唯一归一化修复点，完整语义见[资产模型](../data-model/assets.md)。

运行方式：在 `crates/` 执行 `cargo test -p plotweave-core --lib store::validate::tests::`；在仓库根执行 `npm test -- src/model/assetContract.test.ts --maxWorkers=4` 与公开原生入口 `sh scripts/test-native.sh`。这些用例自然进入既有 Rust、前端和 native 回归，任一消费方偏离向量即由相应测试失败报告。CPU 预算仍固定为本机既有的 4，原生覆盖率保持 report-only、stress 显式 opt-in；向量不新增覆盖率地板，也不替代真实 UI 或网络验收。

## 安全传输与原生呈现用例（#657）

[#657](https://github.com/hailingu/PlotWeave/issues/657) 的基线取自 dev
`4fde8c0c2ad45a9f8cce167ce1988e713e39e8ea` 的既有 CI 报告：App
7433/9481 行、70/70 文件，无缺报；下表八文件当时均为 0 行命中。
本轮补的是可执行行为证据，默认仍为 report-only，不设置新的 native 下限，
不排除文件、不改统计方式；前端/Rust 80% 与固定 CPU 4 保持不变。

| 生产文件 | 验证行为 | 保留边界 |
| --- | --- | --- |
| `NativePinnedHTTP.swift` | 数值 IPv4/IPv6 端点、非公网及 origin 拒绝、直连建立报告与非直连证据拒绝、默认信任拒绝、原主机证书身份、实际 HTTP authority/路径/无凭据、同 URL 新响应、取消/期限关闭连接、超限响应拒绝 | 连接工厂将已验证端点重定向到测试拥有的回环 TLS 服务；未访问公网、真实代理或付费提供商，未验收所有网络设备/信任链 |
| `NativePublicDNS.swift` | 真实系统数值 IPv4/IPv6 解析、两个阻塞线程容量、取消后槽位仍归线程、期限返回、失败/完成释放槽位 | 系统阻塞解析不能被强制中断；测试不请求外部 DNS，不模拟其所有 C ABI 失败 |
| `NativeLibraryView.swift` | 经真实 sheet/service 加载持久化素材、实际搜索控件过滤、过滤不改磁盘 | 未遍历系统文件选择器、所有导入/删除确认/编组菜单分支 |
| `NativeLibrarySheet.swift` | 打开 service 共享 actor，真实加载完成后显示素材 | 未模拟服务根目录不可用的所有呈现分支 |
| `NativeLibraryForms.swift` | 实际表单编辑/保存动作、补丁可持久化并重开、空可选字段的 null 补丁、编组稳定 ID、空名称/忙碌禁用 | 服务层仍负责校验与原子写入；未遍历所有 Picker 组合 |
| `NativeLibraryThumbnail.swift` | 持久化无效图像的失败/重试控件，以及有效字节替换后的恢复 | 未做像素快照或每种图像解码器验收；受限文件读取及容量另有服务测试 |
| `NativeProjectSettingsView.swift` | 实际原生新增动作经生产 Web 创建角色、选择对应详情、原项目/条目持久化后重开 | 本轮未验证焦点敏感字段增量输入，未穷举地点、文档关系与删除确认组合；不建立第二份原生可写文档 |
| `NativeMarkdownText.swift` | 实际 SwiftUI 呈现标题、行内内容、引用、列表、代码，以及不支持格式的原文/恢复提示 | 不验收字体、像素布局、VoiceOver 或真实 IME |

网络入口仍由生产实现先校验 origin 和公网地址，再建立显式数值端点，并用原始
主机名配置 TLS 身份。测试观察到 `NWParameters.preferNoProxies` 原先为 false。它仅控制直连偏好，
SDK 明确允许失败后代理回退，不能据此声称严格禁用代理。生产实现读取 Network 建立报告，在发送 HTTP 请求前拒绝代理连接或报告缺失。
负例使用真实本地 TLS 连接与受控的非直连报告，断言服务端没有收到 HTTP 请求；
正例读取真实 Network 建立报告。未实测用户的系统代理、PAC 或企业网络配置，
也不声称 Network 在报告产生前绝不会尝试代理握手。
已有嵌入地址策略继续允许其中的公网 IPv4，拒绝其中的非公网 IPv4。

TLS 服务只绑定回环地址。测试运行时生成合成证书，在私有临时目录短暂存储密钥，
用 `kSecImportToMemoryOnly` 导入，随后删除目录，不修改用户 Keychain、系统信任、
代理、共享 Cookie 或缓存。默认信任负例不安装自定义验证器；正例仅在测试工厂中
提供合成锚点，仍调用 `SecTrustEvaluateWithError` 校验原始主机名，错误主机名负例
不能发送 HTTP 请求。失败可能由 Network 错误或已有单调期限收束；不据此宣称
所有证书失败均立即返回。原始查询串及端点不出现在错误文本中。

执行入口仍是 `sh scripts/test-native.sh`；新增用例自然进入常规回归与独立 App
覆盖率报告。`NativePinnedHTTPExecutionTests`、`NativeDNSOwnershipTests`、
`NativeNetworkExecutionTests`、`NativeLibraryPresentationExecutionTests`、
`NativeProjectSettingsExecutionTests` 和 `NativeMarkdownRenderingExecutionTests`
分别持有自己的套接字、线程、临时目录或窗口；压力测试继续显式 opt-in。
覆盖率命中与上述行为证据一起阅读，不能把非零行命中当作完整安全或视觉验收。
