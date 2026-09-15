# PlotWeave

**PlotWeave** 是一个面向短剧创作的可视化画布工具：将剧本、场景、角色与剧情分支组织为可编辑的节点图，在画布上完成从剧本构思到分集叙事的"编织"。产品形态对标 LibTV 这类短剧制作网站。

## 核心概念

- **剧本画布**：以节点表示场景、桥段、对白等叙事单元，以连线表示剧情流向。
- **分支叙事**：短剧常见的多线、反转、多结局结构，通过画布上的分支连线直观编排。
- **设定管理**：角色、道具、场景等设定与画布节点关联，保持剧情一致性。

## 功能规划

- [x] 画布编辑器：节点增删改、连线、缩放与导航
- [x] 剧本节点：场景 / 桥段 / 对白节点的结构化编辑
- [x] 分支与多结局编排
- [x] 角色与设定管理面板
- [x] 剧本导出（Markdown 纯文本，含分镜附录）
- [ ] 画布对齐与吸附
- [ ] 剧本导出：结构化格式（JSON）
- [x] 画布内 AI 图像生成（文生图首版）：图片节点生成角色垫图 / 场景底图 / 分镜关键帧，产物落项目资产（媒体节点 + 输入签名守护 + 协作式取消，详见 `docs/data-model.md` §13；图生图引用边、视频节点与 job 落盘恢复随演进）
- [ ] macOS 原生外壳：SwiftUI/AppKit 承载窗口、工具栏与面板，WKWebView 内保留 React Flow 画布并复用 Rust 内核；在 `codex/swiftui-react-flow` 分支按[改造计划](docs/swiftui-react-flow-migration-plan.md)逐阶段验证视觉与功能（P1 内存画布演示已实现，完整业务迁移待续）

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Tauri + React + React Flow（`@xyflow/react`）+ TypeScript |
| 后端 | Rust（Tauri 进程内 commands：数据模型、持久化、剧本解析与导出） |

桌面端由 Tauri 打包，前端负责画布交互，业务逻辑与文件读写下沉到 Rust 侧。

以上为当前实现。macOS 外壳改造的目标是 **SwiftUI/AppKit + WKWebView / React Flow + Rust 内核**；当前分支先建立计划，再依次交付原生视觉首片、持久化链路、原生编辑面板及完整功能回归。阶段状态与验证要求见[改造计划](docs/swiftui-react-flow-migration-plan.md)。

## 仓库结构

```
PlotWeave/
├── .githooks/      # 版本化的提交 / 推送质量门禁
├── scripts/        # SonarQube 门禁及其行为测试
├── src/            # React + React Flow 前端
├── src-tauri/      # Rust 后端与 Tauri 壳（commands、持久化、导出）
├── native/         # SwiftUI/AppKit 原生外壳（codex/swiftui-react-flow 分支改造中，P1 骨架）
├── docs/           # 项目文档（数据模型设计等）
├── AGENTS.md       # AI 代理协作规范
├── README.md
└── LICENSE
```

## 分支模型

`dev` 为**开发基线**，`main` 为集成 / 发布分支，两者均受保护：

- 任务分支一律从当前本地 `dev` 拉出，使用 `feature/`、`fix/`、`docs/`、`chore/` 前缀。
- 任务 PR 一律以 `dev` 为目标；只有来自 `dev` 的集成 / 发布 PR 才可合入 `main`。
- 禁止直接向 `main` 或 `dev` 提交、推送。

```
main ──●─────────────────── 集成 / 发布（受保护）
         \
dev ────●───●───●───●───── 开发基线（受保护）
          \       /
feature/  ●───●  ●──●      任务分支（PR → dev）
```

## 快速开始

```bash
nvm use            # 切换到 .nvmrc 指定的 Node 版本（24.18.0）
npm install        # 安装前端依赖
export SONAR_HOST_URL=http://localhost:9000 # 指向本机实际使用的 SonarQube
export SONAR_TOKEN=your-local-token         # 服务要求认证时设置，替换为本机令牌；也可用 PLOTWEAVE_SONAR_TOKEN（如写入 ~/.zshrc）
npm run hooks:install # 启用版本化的 pre-commit / pre-push hooks
npm run tauri dev  # 启动 Tauri 开发调试（Vite 前端 + Rust 壳）
```

常用校验命令：

- 前端：仓库根目录执行 `npm run format:check && npm run lint && npm run build`（`npm run format` 应用 Prettier 格式化）
- 后端：`src-tauri/` 目录执行 `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
- 原生外壳（`codex/swiftui-react-flow` 分支）：仓库根目录执行 `npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test`（需 Xcode 26.6 / macOS 26 SDK，工具链记录见 [P1 证据记录](docs/swiftui-react-flow-p1-evidence.md)）。要获得带画布演示的可运行应用，执行 `npm run build:native`（一条链完成画布资源构建 `build:native-canvas` 与 `xcodebuild build`），随后 `open native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app`；注意单独 `xcodebuild build` 不会重新生成画布资源，缺失时应用会显示"未找到画布资源"诊断。`native/macos/build/` 与 `native/macos/App/WebCanvas/` 均为生成产物，不提交到 Git。纯测试输出在验证后删除；本地演示构建在使用完后删除。

### 启动原生画布演示

```bash
# 在 PlotWeave 仓库根目录执行
nvm use
npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

`open -n` 启动本次构建的新实例，避免激活 Xcode 默认 DerivedData 中的旧同名应用。重新构建后需启动新实例；已运行的窗口不会自动替换资源。Xcode ⌘R 调试前先运行 `npm run build:native-canvas`。

原生资源采用单一 IIFE 脚本（经典 `defer` 入口）与独立 CSS，以适配 WKWebView 的 `file://` 加载；独立入口包含 React Flow 基础样式。验证须检查真实页面的节点与就绪通知，不能只检查资源是否入包。详见 [P1 加载修复证据](docs/swiftui-react-flow-p1-evidence.md#p1-画布加载超时修复2026-09-15)。

### 提交与推送门禁

仓库使用同一套 `pre-commit` 和 `pre-push` 门禁。启用 hooks 后，每次提交和推送都会依次：

1. 运行 `npm run test:coverage`，生成最新的 `coverage/lcov.info`，并确认报告非空、包含源文件和实际命中行。
2. 运行 `sonar-scanner` 并等待 SonarQube Quality Gate 完成。
3. 确认 Quality Gate 为 `OK`，且**新增代码**的未解决问题为 `0`（增量清零：按 SonarQube New Code 周期过滤，即 `sinceLeakPeriod`；存量历史问题另行治理，不阻塞提交）。

本机需安装 `sonar-scanner`，并在执行 Git 操作的终端环境中显式设置 `SONAR_HOST_URL`；这样可以避免新版扫描器在地址缺失时误连 SonarQube Cloud。服务需要认证时，通过本机环境变量 `SONAR_TOKEN` 提供令牌；未设置 `SONAR_TOKEN` 时回退读取 `PLOTWEAVE_SONAR_TOKEN`（可导出在 `~/.zshrc` 中，Git 钩子继承调用方终端的环境）。地址按本机环境配置，令牌禁止写入仓库。也可以用 `npm run sonar:gate` 手动执行完整门禁。

测试失败、覆盖率报告无效、扫描失败、Quality Gate 未通过、服务不可用或新增代码仍有未解决问题时，Git 操作会被阻止。同一工作树只允许一个门禁运行，以免并发扫描覆盖共享产物。应逐项修复新增问题并重复执行门禁，直到新增问题数归零；不得使用 `--no-verify` 绕过。

## 文档与协作

- AI 代理（ZCode / Codex 等）开始任何工作前，先阅读 [AGENTS.md](AGENTS.md)。
- 项目文档使用中文。
- 设计文档：[数据模型](docs/data-model.md)、[UI 规格](docs/ui-design.md)；已关闭 issue 的落地结论与保留边界见[设计同步记录](docs/design-sync.md)。
- macOS 外壳改造：[SwiftUI/AppKit + React Flow 开发与验证计划](docs/swiftui-react-flow-migration-plan.md)。

## 许可证

[MIT](LICENSE)
