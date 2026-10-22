# PlotWeave

**PlotWeave** 是一款面向短剧创作者的可视化桌面工具。它把剧本、场景、角色、道具和剧情分支放到同一张可编辑画布中，让创作者可以直观看见故事结构，组织多线叙事，并将成果导出为可继续加工的文档。

## 可以做什么

- 在无限画布上创建、编辑、连接和整理场景、桥段与对白节点。
- 编排多线剧情、反转与多结局，并通过缩放和导航浏览完整故事。
- 管理角色、场景、道具等设定，并把它们与剧情节点关联。
- 多选节点后进行六方向对齐；可开启 22 单位网格吸附。对齐、拖动和方向键移动均支持撤销和重做，键盘每次移动单独记一步历史。
- 导出 Markdown 剧本（含分镜附录）。
- 导出结构化 JSON，保留完整节点、分支、设定与资产引用，便于备份或接入其他工具。JSON 不会打包媒体文件，也不包含 AI 会话。
- 在画布内为图片节点生成角色垫图、场景底图或分镜关键帧；生成结果保存为项目资产。此功能需要配置兼容的 AI Provider。

## 如何理解 PlotWeave

- **画布**是故事的全景图：节点承载叙事内容，连线表达剧情流向。
- **分支**把选择、反转和不同结局直接呈现在故事结构中。
- **设定**集中管理角色、地点与道具，使它们在不同场景中的引用保持一致。
- **项目文件**保存画布与设定；导出的 Markdown 或 JSON 是面向阅读、交换和后续处理的交付格式。

## 当前版本与获取方式

当前发布版本为 [v0.3.0](https://github.com/hailingu/PlotWeave/releases/tag/v0.3.0)。本版发布已有的 SwiftUI/AppKit 原生界面、Swift 业务服务与 React Flow 画布，包含保存反馈、资产操作协调、媒体与模型网络边界及画布投影更新改进；完整范围和验证边界见[发布说明](docs/releases/v0.3.0.md)。

目前 Release **仅提供源码归档**，尚未提供经过 Developer ID 签名、公证及安装验收的 macOS 安装包。请勿将 GitHub 自动生成的源码压缩包当作可直接安装的应用。

## 从源码运行

当前支持平台为 **macOS**；**不支持 Windows**，不提供 Windows 构建、测试或发行支持。非 Unix 平台仅提供源代码：仓库源码在非 Unix 目标上保持可编译（[issue #546](https://github.com/hailingu/PlotWeave/issues/546)），需要 Windows 版本的使用者须自行构建并自担风险——平台能力差异（如库资产删除/恢复协议依赖的 Unix 文件身份与目录持久性屏障原语）会在运行时按能力缺失拒绝，不做官方验证。

v0.3.0 源码已实现 SwiftUI 首页、编辑工具栏、大纲、检查器、设定、图库、AI、导出与设置界面，存储、素材、密钥和模型服务均由 Swift 承接。React Flow 保留画布与单一编辑会话。该原生实现最初在历史分支 `codex/swiftui-react-flow` 上开发，2026-10-13 经 [PR #526](https://github.com/hailingu/PlotWeave/pull/526) 合入 `dev`，该分支现已被删除。保留的 v0.2.0 源码以其[历史发布说明](docs/releases/v0.2.0.md)为准；原生开发数据与旧 Tauri 数据的隔离边界不变。

原生构建需要 macOS 26.0+、[Node.js 24.18.0](.nvmrc) 与 Xcode 27.0／macOS SDK 27.0：

```bash
nvm use
npm install
npm run build:native
open -n native/macos/build/DerivedData/Build/Products/Debug/PlotWeaveNative.app
```

默认入口运行真实项目应用；`#fixture` 仅为不落盘的隔离演示。原生开发数据位于 Application Support 下独立的 `dev.plotweave.PlotWeaveNative.development` 目录，不读取旧 Tauri 数据或历史 Keychain。AI 功能需要重新配置可用的 Provider。PlotWeave **不支持 VoiceOver**（[所有者决策，issue #569](https://github.com/hailingu/PlotWeave/issues/569)）。真实公网 TLS 与计费模型尚未验收；真实中文输入法与性能保留已登记边界。当前支持范围、自动验证和已取消的验收项见[当前功能、证据及验收边界](docs/swiftui-react-flow-current-state.md)。

保留的 Tauri 基线另需 [Rust 1.95.0](rust-toolchain.toml)，通过 `npm run tauri dev` 启动。上述源码构建均不等同于经过签名、公证与安装验收的发行安装包；完整开发与验证步骤见[开发工作流](docs/development/workflow.md)。

## 文档

- [v0.3.0 发布说明](docs/releases/v0.3.0.md)与 [v0.2.0 历史发布说明](docs/releases/v0.2.0.md)
- [数据模型与项目格式](docs/data-model/README.md)
- [界面与交互设计](docs/ui-design.md)
- [SwiftUI/AppKit + React Flow 改造计划](docs/swiftui-react-flow-migration-plan.md)与[当前功能、证据及验收边界](docs/swiftui-react-flow-current-state.md)
- [开发与贡献指南](docs/development/workflow.md)

## 开发与贡献

开发者请从 `dev` 创建任务分支，并先阅读 [AGENTS.md](AGENTS.md) 与[开发工作流](docs/development/workflow.md)。分支策略、PR 持续集成、质量门禁、仓库结构、技术栈及发布步骤统一维护在开发文档中，不在产品 README 中重复。

## 许可证

[MIT](LICENSE)
