# SwiftUI/AppKit + React Flow 改造：P2 证据记录

> 配套：[改造计划](swiftui-react-flow-migration-plan.md)（§7.3 证据模板、§6 状态矩阵）。本页只记录已实际执行的验证；未执行的检查明确标注原因。P1 及之前的证据见 [P1 证据记录](swiftui-react-flow-p1-evidence.md)。

## P2-1 前端宿主接口收敛（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P2 第 1 项（矩阵 M16/M17）；2026-09-15；`codex/swiftui-react-flow` 工作区未提交状态（叠加在 P1 待目验改动之上；提交与门禁按任务另行执行，本页不构成提交证据）。

**系统 / 工具链 / 硬件**：沿用 [P1-1 固定配置](swiftui-react-flow-p1-evidence.md#p1-1-工具链记录与原生工程骨架2026-09-15)（macOS 26.6.2 / Xcode 26.6 / Swift 6.3.3 / Apple M4 Max）；Node 由 `.nvmrc`（24.18.0）约束。

**启动命令 / 夹具 / 数据根目录策略**：仓库根目录执行下方验证命令；本切片不读写任何数据目录（Swift 宿主命令传输未接通，存储命令在该宿主可见失败，符合计划 §4.1「未接通的能力明确禁用并标注，不返回假成功」）。

**交付内容**：

- `src/platform/`（计划 §2.3 目标目录首个落地）：
  - `hostEnvironment.ts`：宿主识别单一来源——优先级 tauri（`__TAURI_INTERNALS__`）> swift（原生注入 `window.__pwNativeHost = {kind:"swift"}`，标记形状非法按纯浏览器对待）> browser（纯浏览器预览，唯一允许内存回退的宿主）；探测读调用时刻的全局 window、不缓存，与被取代的各处实时判定同语义。
  - `hostCommands.ts`：宿主命令传输统一入口 `hostInvoke`——swift 宿主拒绝为 `HostCommandUnavailableError`（稳定错误码 `PW_HOST_COMMAND_UNAVAILABLE`，错误携带命令名与宿主类别）；其余宿主路由到 `@tauri-apps/api/core` invoke（动态导入、首次解析即缓存，浏览器预览不预载 Tauri 模块，args 缺省不传保持与既有直调一致的调用形状）；`setHostCommandTransportForTests` 提供可控测试传输。
- 收敛 8 个 store/门面文件的宿主探测与命令调用（约 30 个 invoke 直调点、8 处 `isTauri` 判定全部改为平台单一来源）：`projectStore.ts`、`projectStore/tauri.ts`、`projectStore/saveChain.ts`、`settings/settingsStore.ts`、`library/libraryStore.ts`、`aiSessionStore.ts`、`editor/projectAssets.ts`（`tauriInvoke` 保留签名、内部委托平台传输，imagegen 域调用与 mock 不变）、`editor/ai/chat.ts`、`editor/imagegen/state.ts`（内联 `isDesktopTauri` 改为浏览器预览判定）。守卫语义统一为「内存回退仅限纯浏览器预览」：Swift 宿主与 Tauri 同走命令域，Swift 侧未接通时可见失败，不落内存模式。
- 原生侧（M17）：`WebCanvasHostView` 的 document-start userScript 在外观快照之外同批注入 `window.__pwNativeHost = {"kind":"swift"}`（函数更名 `documentStartHostScript`），注入先于任何应用脚本。
- 有意不属本切片：`useExitFlush.ts`（退出屏障，P2 第 5 项）与 `main.tsx` 的 `.is-tauri` 安全区标记（Tauri 专属视觉适配）维持原判定。

**矩阵 ID / 测试命令或步骤 / 预期 / 实际 / 结论**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| M16 先红（平台层缺失 + Swift 落内存） | `npx vitest run src/platform/`（实现前） | 平台模块缺失报错；Swift 宿主场景按旧实现落入内存模式（`loadAiSession` 返回空历史、`mediaUrl` 走浏览器内存路径等） | 3 文件失败：2 个模块缺失 + `memoryFallbackBoundary` Swift 方向 5 用例失败、浏览器对照 4 用例通过——红即缺陷本体 | 通过（先红观察到位） |
| M16 后绿（平台层全量） | `npx vitest run src/platform/` | 20 用例全绿：识别优先级/标记校验、tauri 透传/拒绝可见失败、内存回退边界（Swift 5 门面拒绝 + 浏览器 4 对照） | 3 文件 20 测试通过 | 通过 |
| M16 回归（既有宿主） | `npm run format:check && npm run lint && npm run build && npm test`（仓库根目录） | Tauri/浏览器行为与收敛前等价 | format/lint/build 通过（lint 0 错误、1 个既有 warning 在未改动的 `src/editor/useDebouncedSave.ts`，与 HEAD 一致）；125 文件 / 1509 测试全部通过（含全部 `.tauri.test.ts` 的 vi.mock 截击） | 通过 |
| M17 先红（宿主标记缺失） | `xcodebuild … test -only-testing:…/ShellWebCanvasLifecycleTests`（注入实现前） | 页面 `window.__pwNativeHost` 为 null | `Expectation failed: (marker → "null") == ("{"kind":"swift"}")` | 通过（先红观察到位） |
| M17 后绿 + 原生全量 | `npm run build:native-canvas && xcodebuild -project native/macos/PlotWeaveNative.xcodeproj -scheme PlotWeaveNative -destination 'platform=macOS' -derivedDataPath native/macos/build/DerivedData test` | 全部套件通过 | `** TEST SUCCEEDED **`；6 套件 / 16 测试通过（含真实 WebKit 回归：ready 握手、9 节点渲染、宿主标记注入、面板切换不重建页面） | 通过 |

**实现记录（测试基建发现）**：收敛初期各调用点各自 `await import('@tauri-apps/api/core')` 时，`projectStore.tauri.test.ts` 中「load_project 在途触发保存」的两条用例出现 mock 失效——保存链续延中的**重复动态导入**在该嵌套时序下绕过 `vi.doMock` 拿到真实模块（已用裁剪最小复现确认，非跨用例污染）。修复为 `hostCommands` 内 tauri 模块句柄「首次解析即缓存」：与 ESM 模块单例语义一致、消除重复解析，且让 mock 只需截获首次导入。这同时把 `invoke` 的调用形状（args 缺省不传）保持与收敛前一致，`settingsStore.tauri.test.ts` 的参数计数断言无需改动。

**矩阵覆盖说明**：M16 由平台层单测 + `memoryFallbackBoundary` 门面测试 + 既有 `.tauri.test.ts` 回归共同覆盖（Tauri 等价性、Swift 可见失败、浏览器内存回退三条分支各有断言）；M17 由真实 WebKit 页面上的标记读回覆盖（注入时机由 WKUserScript `.atDocumentStart` 保证）。`useExitFlush` 与 `main.tsx` 的 Tauri 专属检测不属 M16 范围（退出屏障归 P2 第 5 项）。

**失败场景、尚未接通的能力与未验证原因**：

- Swift 宿主命令传输本体未实现（P2 第 2 项起接 Rust FFI）：当前 Swift 宿主内调用任一存储门面都会得到 `PW_HOST_COMMAND_UNAVAILABLE` 结构化失败。主应用前端尚未被原生外壳加载，该失败路径目前仅由自动化测试覆盖，无真实用户路径。
- 原生外壳内主应用会话（含 store）的实机运行验证属 P2 后续项；本切片的原生验证仅覆盖宿主标记注入与既有画布回归。
- 未运行 SonarQube 门禁：本次未提交、未推送（提交前按 `AGENTS.md` 执行）。

**下一步**：P2 第 2 项——抽出 Rust 项目存储内核并接入 C ABI，验证分配/释放、异步完成、错误与取消；随后把 Swift 侧 `hostInvoke` 的 swift 分支接到真实传输。
