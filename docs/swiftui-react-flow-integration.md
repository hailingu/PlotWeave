# 原生实现合入当前分支（2026-10-07）

所有者要求把先前保存在独立工作树的完整 Swift 原生实现合入主目录 `/Users/guhailin/Git/PlotWeave` 的 `codex/swiftui-react-flow`。恢复来源为归档快照 `13653e19b09946b8156b35ec367597746fbc79d3`，共同基线为 `08653d21`。这是已实现代码的集成，不新增依赖或更改持久化合同；当前目录已有的 Xcode 27 配置及系统读取器 MainActor 修复保留。质量评估与工作区元数据属于已有独立修改。

## 集成状态与不变量

| ID / 所有者与入口 | 状态与顺序 | 可观察结果 | 不变量 | 验证 / 缺口 |
| --- | --- | --- | --- | --- |
| I1 / 原生启动、画布入口 | 从当前目录执行 `npm run build:native`；测试显式选择夹具 | 正常启动显示真实片库；夹具不读取用户数据 | 生产入口不退回内存演示，所有业务服务由 Swift 承接 | 构建、NativeProductionLifecycleTests、WebCanvasLoadingTests |
| I2 / NativeShellRoot、WebCanvasSection、工具栏和项目列表 | 编辑项目→首页/设置→重新打开同一项目；启动加载→首页；连续往返 | 同一 WebView，编辑内容保留，隐藏画布不占用键盘焦点，检查器偏好保留 | 原生导航不建立第二份可写图文档，不销毁会话 | 将旧 ShellHomeNavigationTests 迁到真实服务和路由；NativeProductionLifecycleTests |
| I3 / 外观读取器、宿主 | 外观通知、挂载/卸载、设置与面板切换 | 主线程读取 AppKit，旧会话不覆盖新投影 | Xcode/SDK 27、Swift 6 模式、最低部署 26 保持；只读投影与单一写入者 | CanvasAppearanceStateTests、NativeShellNodeSettingsTests、桥及生命周期测试 |
| I4 / 服务与保存/退出入口 | 保存成功、失败重试、异步乱序及退出冲刷 | 真实临时文件反映最新稿，失败有诊断且不错误关闭 | 数据根独立，设置/密钥/素材合同及保存顺序不变 | 快照原有 Swift 与前端行为测试；真实公网计费、视觉、输入法验收仍保留原缺口 |
| I5 / 三方合并、提交门禁 | 重叠文件协调→路由检查→静态/覆盖率/Sonar→提交 | 当前分支记录完整实现，主目录构建可重现 | 无关原有修改不覆盖、不清理；钩子不绕过 | 原始文件及 diff 已备份到临时集成目录，逐路径核对；最终检查结果待补充 |

| I6 / 宿主传输、事件分发与原生编辑动作 | 质量重构前后：同步抛错/异步拒绝、页面结束/超时/迟到回执、分发中退订、字段类型切换与无效目标 | 成功/失败和结构化机器码保持，当前分发快照不受回调退订影响，失效实体仍拒绝 | 仅拆分条件与函数；不放宽 WithReply Promise 合同、写入目标或保存历史语义 | 重构前运行现有原生动作/设置/AI/桥测试；追加非 Promise 拒绝和监听快照回归作为行为保持检查；全门禁重跑 |

本次不发布、推送或访问真实模型服务。既有人工验收缺口继续见[功能补齐记录](swiftui-react-flow-feature-parity.md)。多实例写入仍在原有单实例边界之外。归档源保持完整作为恢复点。

## 验证结果

集成后真实首页回归先观察到 6 个预期失败（画布未隐藏、隐藏画布保留焦点）；`WebCanvasSection` 随后接回现有宿主的 `isPresented`，3 个参数化用例通过。相同策略追加设置往返覆盖，纳入下方完整原生回归。测试始终使用临时数据根。

初次沙箱运行阻止 Swift 宏插件、Xcode 系统服务及 Git 钩子测试的进程身份查询；改为系统权限后重跑。已有 Xcode `project.xcworkspace` 文件保持原位；它是自动生成的工程工作区元数据，增加准确目录忽略以避免源文件规模守卫误判，不纳入提交。

本次实际环境：Node 24.18.0、Xcode 27.0（27A266a）、macOS SDK 27.0、macOS 27.0.1。当前目录的 `npm run build:native` 已直接执行，结果 `BUILD SUCCEEDED`，生产构建不含测试插件。

- 前端完整路由：`npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 的静态检查与生产构建通过；测试的沙箱重跑 `npm test` 为 208 文件、3040 项全部通过。
- 原生完整路由：`npm run check:size && npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` 为 37 套件、132 项通过（含参数化首页与设置往返），`TEST SUCCEEDED`。
- I1–I4 对应的生产页面、存储、导航、外观、桥、模型传输和退出测试均包含在上述通过结果中。I5 由本次显式暂存差异审查及提交钩子的完整门禁验证；提交须以 Quality Gate OK 且新增未解决问题为零为前提。
- CI 文件 `npx prettier --check .github` 与暂存差异检查通过。文档无配置自动语义检查；已人工核对构建入口、架构职责、日期与工具链记录，保留早期演示的历史证据。
- 托管 CI 未触发（本次未推送或创建 PR）；真实模型服务、实际系统面板、视觉、输入法、VoiceOver 与性能验收仍保留功能补齐记录中的缺口。测试服务仅访问隔离临时数据与合成传输。

首次完整门禁的前端覆盖率 97.05%、Rust 覆盖率 87.86%，但 Sonar 新增问题 15 个导致失败。问题涉及条件展开、函数复杂度与异步等待监督；按语义保持重构处理，不新增产品行为。相应现有测试及新增合同保持测试在重构前后均为 7 文件、131 项通过，不人为制造失败。严格类型检查、ESLint 与前端构建再次通过；修复后完整门禁由提交钩子重跑。本次构建保留在当前主目录供既有运行需求使用，新增前端构建、覆盖率及扫描原始产物结束时清理；原生正常运行产品沿既有启动授权保留，测试日志和中间产物清理。源码与原始修改备份保持为恢复点。
