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
