# SwiftUI/AppKit 原生外壳：当前工具链与升级记录

> 本页保留 2026-10-04 独立工作树的工具链升级与演示验证记录。2026-10-07 已将完整业务实现恢复到当前主目录，当前实际环境为 Xcode 27.0 / SDK 27.0 / macOS 27.0.1；原生 CI 通过 `DEVELOPER_DIR` 显式选择 27.0。本次构建、132 项原生回归与其余检查见[合入记录](swiftui-react-flow-integration.md)，下方旧测试数值和“未接通”描述仅代表原执行时状态。

> 原始升级约定：2026-10-04，仓库所有者明确要求将 Swift 开发规范升级为 Xcode 27.0，并构建、验证和启动 `codex/swiftui-react-flow` 的原生应用。本记录保留升级依据；[P1 证据](swiftui-react-flow-p1-evidence.md)与[P2 合并证据](swiftui-react-flow-p2-evidence.md)中的旧版本、测试数量与结论仍属于各自历史执行。
> 原始执行状态：本机工具版本、原生构建、16 项 XCTest 与应用启动已验证通过；托管 CI 尚未执行，完整视觉、交互与辅助功能验收仍未完成。

[Swift 开发规范](development/swift-standard.md) · [开发工作流](development/workflow.md) · [改造计划](swiftui-react-flow-migration-plan.md)

## 所有者决策与本机工具链（2026-10-04）

| 项目 | 当前约定／实测值 | 依据 |
| --- | --- | --- |
| Xcode | 27.0，Build `27A266a` | `xcodebuild -version` |
| Swift 编译器 | 6.4，`swiftlang-6.4.0.34.1 clang-2100.3.34.1` | `xcrun swift --version` |
| Swift 语言模式 | Swift 6，`SWIFT_VERSION = 6.0` | 现有原生工程配置 |
| macOS SDK | 27.0 | `xcrun --sdk macosx --show-sdk-version` |
| 本机运行系统 | macOS 26.6.2，Build `25G83` | `sw_vers` |
| 已选开发工具目录 | `/Applications/Xcode.app/Contents/Developer` | `xcode-select -p`；使用已有选择，本次未修改全局选择 |
| 最低部署目标 | macOS 26.0，`MACOSX_DEPLOYMENT_TARGET = 26.0` | 现有原生工程配置 |
| 原生 scheme／产品 | `PlotWeaveNative`／`PlotWeaveNative.app` | 已提交共享 scheme，Debug 构建 |

Swift 6.4 是编译器版本，项目仍采用 Swift 6 语言模式；SDK 27.0 是编译 SDK，最低部署目标继续为 macOS 26.0。原生工程的 `CreatedOnToolsVersion = 26.6` 记录创建时使用的工具，不作为当前编译工具链的约定。

## CI 与本地验证的关系

原生 CI 使用 `xcode-27` runner；2026-10-07 通过 `DEVELOPER_DIR` 选择 `/Applications/Xcode_27.0.app/Contents/Developer`，在构建前检查 Xcode 精确为 27.0、macOS SDK 精确为 27.0，再执行画布资源构建与现行原生路由。Frontend/Rust jobs 继续使用 `macos-15`。

2026-10-12，[PR #526 修复](swiftui-react-flow-pr526-fixes.md)将测试宿主隔离提前到共享 scheme 的 TestAction 环境，不再依赖 bundle 加载时序；自动场景仅显示惰性宿主，各测试显式创建并销毁真实外壳／WKWebView，避免测试连接建立前的 split／inspector 约束循环。CI 与现行 `native/**` 路由统一追加 `-parallel-testing-enabled NO`。App-hosted 的真实窗口、焦点与退出委托共享 `NSApplication`，各 suite 的 `.serialized` 不隔离兄弟套件；串行执行完整目标，不删除测试或放宽断言。下方旧命令及数值保持各次原始执行状态。

2026-10-04 核对的[官方 xcode-27 镜像清单](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)列出默认 Xcode 27.0（`27A266a`）及 macOS SDK 27.0；该镜像运行于 macOS 27.0。本次本地运行系统为 macOS 26.6.2，本地构建／启动结果与托管 CI 结果分别记录。旧 `macos-26` runner 的 Xcode 26.6 约定保留在原合并证据中，现行配置以本记录及 `.github/workflows/ci.yml` 为准。

## 原始构建、测试与启动记录（2026-10-04）

工作分支：既有授权分支 `codex/swiftui-react-flow`；起始提交 `08653d2`。工作树为独立原生运行工作树；Tauri 业务基线与原生内存演示的职责边界沿用改造计划。

| 验证项 | 实际命令／检查 | 当前结果 |
| --- | --- | --- |
| 工具链版本 | 上表命令确认 Xcode 27.0、Swift 6.4、SDK 27.0 及本机系统 | 已实测；编译器与语言模式分别记录 |
| 文件规模 | 仓库根目录 `npm run check:size` | 通过 |
| 原生路由测试 | `xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` | 6 套件、16 测试通过，`TEST SUCCEEDED` |
| 可运行应用构建 | 仓库根目录 `npm run build:native`，先生成画布资源，再构建原生应用 | 通过，`BUILD SUCCEEDED` |
| 二进制部署目标与 SDK | `xcrun vtool -show-build native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app/Contents/MacOS/PlotWeaveNative` | `minos 26.0`、`sdk 27.0`，与现行约定一致 |
| 启动本次构建 | `open -n /Users/guhailin/.codex/worktrees/swiftui-react-flow-run/PlotWeave/native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app` | 启动成功；本次观察进程为 PID `93155`，`ps` 确认其可执行路径与本次新构建应用一致 |
| 可观察就绪 | CUA 读取实际应用的辅助功能树（AX） | 观察到 `PlotWeave` 窗口、两侧占位面板，以及仅在 `phase == ready` 时显示的 `100%` 控件；未见加载／失败遮罩 |
| CI 配置格式与差异 | 仓库根目录 `npx prettier --check .github`、`git diff --check` | 通过 |
| 托管 CI | 当前原生 job 在 `xcode-27` 上执行版本检查与路由 | 未触发；本地结果不替代对应提交的 CI 结果 |

上述 AX 观察支持应用与画布进入就绪状态；本次没有以截图确认全部节点、连线和徽标，也没有完成全部拖拽交互或辅助功能验收。本次升级没有接通 Swift FFI 保存链路，原生演示仍使用内存夹具。真实项目保存／退出屏障、完整视觉与辅助功能验收依旧按 P2 后续阶段验证，本次工具链结果不能把这些未实现能力记为通过。

执行期间出现 Xcode CoreDevice 插件引用系统框架时的 `Symbol not found` 环境诊断；macOS 构建、测试与启动实际均成功。本次只记录该诊断，未修改系统安装或全局开发工具选择。

本任务只变更文档与 CI 配置，没有源码变更，未提交或推送，也未重新运行 frontend／Rust／Sonar Git 门禁。已启动的应用和 `native/macos/build/` 构建目录保留供用户运行；纯测试报告及不影响运行的中间产物按任务结束清理要求处理，不删除所启动的应用。
