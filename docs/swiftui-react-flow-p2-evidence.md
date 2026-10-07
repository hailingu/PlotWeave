# SwiftUI/AppKit + React Flow 改造：P2 证据记录

> 配套：[改造计划](swiftui-react-flow-migration-plan.md)（§7.3 证据模板、§6 状态矩阵）。本页只记录已实际执行的验证；未执行的检查明确标注原因。P1 及之前的证据见 [P1 证据记录](swiftui-react-flow-p1-evidence.md)。

> 当前工具链同步（2026-10-07）：Xcode 27.0 / macOS SDK 27.0 与 `xcode-27` CI 配置见 [Xcode 27 工具链记录](swiftui-react-flow-p1-evidence.md#xcode-27-工具链同步2026-10-07)。下方 2026-09-15 与 2026-10-04 的版本、CI 配置及验证结果保留为历史证据。

> 当前工具链同步（2026-10-04）：所有者在完成本地 `dev` 合并后授权升级为 Xcode 27.0／Swift 6.4 编译器／macOS SDK 27.0；语言模式与部署目标仍为 Swift 6／macOS 26.0。当前记录见[工具链升级记录](swiftui-react-flow-toolchain.md)。本页 P2-1/P2-2 与原合并节的 Xcode 26.6、runner 及测试数值保留原执行含义，不用旧通过结果证明升级后的构建、测试或启动。

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

## P2-2 Rust 项目存储内核抽出与 C ABI（2026-09-15）

**阶段 / 日期 / 分支与代码修订**：P2 第 2 项（矩阵 M14 部分）；2026-09-15；`codex/swiftui-react-flow` 工作区未提交状态（叠加于提交 `96b332d` 之上）。

**交付内容**：

- `crates/`（独立 Cargo workspace，`AGENTS.md` 已加 `crates/**` 路由行、rust-standard 补 crate 布局节、`.gitignore` 加 `crates/target/`）：
  - `plotweave-core`：store 域（types/validate/persist/list/commands/copy + testutil + 各 tests）与 `isotime` 自 src-tauri 整体迁出（`git mv`，原测试随迁）；`projects_dir(app)` 的路径解析留宿主侧，内核改为注入路径的 `open_projects_root(data_root)`（§4.3 数据根由宿主注入）；内核函数转 `pub`（`create_project_in` 自原命令体抽出）。
  - `plotweave-ffi`（staticlib + rlib）：C ABI——`pw_core_new`（注入数据根开根，失败 NULL）/`pw_core_free`（排空回调并 join 后释放）/`pw_request_submit`（JSON 请求，非零 id，工作线程完成回调）/`pw_request_cancel`（未派发转 CANCELLED，未知/已落定 no-op）/`pw_string_free`；单工作线程串行执行（单写入者）、`catch_unwind` 包裹（panic 转结构化 ERROR，不跨 FFI）、9 个操作（listProjects/createProject/loadProject/saveProject/deleteProject/loadAiSession/saveAiSession/verifyProjectAssets/copyProjectAssets）逐字段校验载荷。
- src-tauri：新薄 `src/store/mod.rs`（9 个 `#[tauri::command]` 包装 + `projects_dir` 宿主解析 + 内核 re-export，外部 13 个文件的 `crate::store::X` 与 lib.rs 注册路径零改动）；`Cargo.toml` 加 path 依赖；`lib.rs` 的 `mod isotime` 改为 core re-export。

**矩阵 ID / 测试命令或步骤 / 预期 / 实际 / 结论**：

| 验证项 | 命令或步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| M14 先红 | `cd crates && cargo test`（实现前） | FFI 库缺失，ABI 集成测试无法编译 | `can't find library plotweave_ffi`；随后确定性单测（取消门/panic 包裹/坏请求）逐项转绿 | 通过（先红观察到位） |
| M14 后绿 + 迁移回归 | `cd crates && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | 全绿 | fmt/clippy 通过；core 75 + ffi 单测 3 + ABI 集成 5（创建→保存→重开恢复→删除全链、内核错误上浮（含「项目不存在」）、取消对未知/已落定安全、坏数据根/坏指针拒绝）全部通过 | 通过 |
| Tauri 宿主等价回归 | `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test` | 适配层不破现有行为 | fmt/clippy 通过；201 测试全绿（含 store 之外的 assets/library/prefs 域） | 通过 |
| 函数/文件规模 | `wc -l` 抽查 | ≤800/≤80 | 最大文件 `plotweave-ffi/src/lib.rs` 362 行；新增函数均 ≤80 行 | 通过 |

**矩阵覆盖说明**：M14 的「取消/释放/迟到回调」中，未派发取消、释放时序（free 前送达全部回执、join 后不再回调）、panic 不跨 FFI 与坏输入拒绝已由 Rust 侧 ABI 测试覆盖；已派发操作不中断、迟到结果照常交付的语义在 crate 契约中固定，真实 Swift 宿主的链接、主线程回投与 Web 进程终止注入待 P2-3/P2-4 接线时验证。Tauri 宿主行为等价性由随迁的 75 项 store 测试 + src-tauri 201 项全量测试守护。

**失败场景、尚未接通的能力与未验证原因**：

- FFI 尚未链接进 Xcode 工程、Swift 侧无真实调用：`hostInvoke` 的 swift 分支仍返回 `PW_HOST_COMMAND_UNAVAILABLE`，接通属 P2 第 3–4 项（桥接协议 + 编辑链路）。
- C 头文件未单独提供：当前契约以 `plotweave-ffi/src/lib.rs` crate 文档 + `# Safety` 段为准；真实 Swift 链接任务再落 `include/plotweave_ffi.h` 与 Xcode 集成。
- 前端路由检查未运行：本切片未触及 `src/**`。
- 未运行 SonarQube 门禁：提交时随钩子执行。

**下一步**：P2 第 3 项——打开夹具项目 → 编辑 → 防抖保存 → 关闭冲刷 → 重开恢复的端到端链路（Swift 侧接 FFI 传输，写入失败先加回归测试再实现恢复）。

## dev 合并兼容性同步（2026-10-04）

本节记录将当前本地 `dev` 合并进 `codex/swiftui-react-flow` 时的实现归属；上方 P2-1/P2-2 的日期、命令和测试数量保留为历史证据，不用旧结果代替本次验证。未接通的原生业务能力与 P2 后续项保持原边界。

- **宿主与命令传输**：`src/platform/hostEnvironment.ts` 保留 tauri > swift > browser 优先级以及仅纯浏览器可内存回退的约束，Tauri IPC 哨兵由 `src/ipc/runtime.ts` 的 `isTauriRuntime` 单独判断。`src/ipc/invoke.ts` 统一 SDK 动态绑定、命令传输、Swift 的 `PW_HOST_COMMAND_UNAVAILABLE` 与可控测试传输；`src/platform/hostCommands.ts` 以兼容名 `hostInvoke` 再导出该入口。store 门面采用 `IPC_COMMANDS` 和 `ipcInvoke`，保留 `dev` 的结构化诊断与 Swift 的明确失败语义。
- **画布目录**：演示源码迁至 `src/editor/nativeCanvas/`，避免 shell 运行时反向依赖 editor；独立 HTML、原生构建命令和资源目录保持原合同，不放宽模块图守卫。
- **保存存在性**：FFI 的 `saveProject` 支持可选布尔字段 `expectExisting`。缺省 `false` 允许初次保存；为 `true` 时调用 `persist_project_expect_existing`，在操作锁内确认原项目仍存在，删除后的迟到保存返回 ERROR 且不重建项目。非布尔值在 FFI 边界拒绝。保存的 NotFound 错误不携带 `[project_not_found]` 前缀，该稳定码仍仅属于加载入口。回归 `expect_existing_save_cannot_recreate_deleted_project` 覆盖已有项目保存、删除后拒绝、非法类型和缺省新建；Rust 侧已观察先红后绿，命令和全量结果随本次合并记录。
- **跨域回归夹具**：core 的 `test-support` feature 仅由 Tauri 的 dev-dependency 启用，生产 dependency 不启用；core 自身 `cfg(test)` 也提供故障夹具。共享操作锁与注入可经宿主适配再导出，以保留 `store::integration_tests::import_waits_for_delete_and_never_recreates_deleted_project` 和 `store::blocking_tests::slow_save_keeps_runtime_and_media_reads_responsive` 的跨域约束。
- **门禁范围**：维护源码大小枚举增加 `crates/` 与 `native/`，保留 800/1800 及索引/工作树各自受限语义。Rust 覆盖率执行 Tauri 与 crates 两个 workspace，将同一源文件/行合并去重后交给原 80% 下限；SonarQube 纳入 core/ffi 两个源目录与两份 manifest。CI 增加 crates 的路由检查与原生 job：frontend/Rust 使用 `macos-15`，native 使用 `macos-26`，先验证默认 Xcode 为 P1 钉版 `26.6`，再按原生路由构建画布并执行 `xcodebuild test`。2026-10-04 核对的[官方 runner 镜像清单](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)列有默认 Xcode 26.6。该设置尚须合并对应 PR 的实际 CI 结果，不能用本地测试代替；迁出源码不缩小门禁覆盖面。

### 合并门禁与覆盖率状态矩阵

覆盖率与 Sonar 输入分类由门禁脚本拥有，入口为 `scripts/rust-coverage.sh`、`scripts/sonar-quality-gate.sh` 与 CI 路由；迁移不得通过改变源目录而缩小检查范围。

| 前置状态 | 动作／时序 | 可观察结果 | 跨转换不变量及所有者 | 对应验证／缺口 |
| --- | --- | --- | --- | --- |
| 两 workspace 含重复的共享源文件/行 | 分别生成 Tauri 与 crates LCOV，再合并 | Tauri、core、FFI 均进入报告；同一 SF+行只占一次分母，任一报告命中即计覆盖 | 覆盖率脚本：源码迁出不能变成未测量，重复测量不得扭曲整体覆盖率 | `scripts/rust-coverage.test.ts` 共享行合并回归通过 |
| 任一 workspace 命令失败，或报告缺失／损坏 | 生成后验证每份报告，再进入合并与扫描 | 非零退出并阻断门禁 | 覆盖率脚本与 Sonar 门禁：有效片段不得掩盖另一份失败，低于 80% 不放行 | 新 workspace 失败回归及既有 Sonar malformed / below-floor 回归；完整 gate 结果待执行记录 |
| 历史被推树只有 Tauri manifest；迁移后树同时含 crates manifest | 现行脚本按被检树存在的 manifest 选择 workspace（issue #405） | 旧树仅测 Tauri，迁移后强制生成及验证双报告 | 覆盖率脚本：当前门禁适用历史树，但不可遗漏历史树实际存在的 workspace | `scripts/rust-coverage.test.ts` 历史树回归先红后绿，3 项跨 workspace 回归通过 |
| 故障注入仅在 `cfg(test)`／`test-support` 可用 | 对实际模块归属做 Sonar 源／测试分类 | 故障夹具作为测试输入分析，不计产品统计 | Sonar 测试范围：测试专用能力不计入产品，业务源码不靠排除豁免 | `scripts/sonar-test-scope.test.ts` 夹具语义回归先红后绿，相关组合共 10 测试通过 |
| 提交钩子向测试进程传入外层 `GIT_INDEX_FILE` | 标记测试在独立内层仓库暂存改动 | 内层树发生变化，外层索引字节保持不变 | Git 测试夹具：每次子 Git 操作只作用于该夹具，不能污染真实合并索引 | `gate-tree-marker.test.ts` 换树回归先红后绿，标记／夹具组合 32 测试通过 |

各门禁串行失败即停止，不涉及异步请求乱序或运行中业务恢复；报告重新生成的重试仍须验证被检树中实际存在的全部 workspace。真实 Swift FFI 请求与原生保存/退出的状态矩阵继续属于 P2 后续项，本次未接通。

本次前端兼容性验证（仓库根目录，Node 24.18.0）：直接 IPC 调用在 Swift 宿主错误成功、Tauri 哨兵存在但值为 `undefined` 时被 Swift 标记覆盖的两项回归先红后绿；`npm test -- src` 通过 183 文件 / 2629 测试，`npm run format:check`、`npm run lint`、`npm run typecheck:strict`、`npm run build` 与 `npm run build:native-canvas` 通过。演示迁目录后维持资源输出 `native/macos/App/WebCanvas`；模块图、宿主/IPC 与演示画布的 16 文件 / 139 测试聚焦回归通过。

文件规模守卫兼容性验证：10 个新增 roots/上限/索引/排除用例先红后绿，`npm test -- scripts/check-file-size.test.ts` 90 测试全绿；状态与不变量矩阵及分层验证记录见[File Size Guard](development/file-size-guard.md#native-shell-merge-state-and-invariant-matrix)。该报告仅覆盖已执行的前端与文件规模检查，不替代整个合并门禁。

本次原生路由已执行 XCTest，16 测试通过。Rust 两 workspace 的 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 与 `cargo test` 全部通过：core 130、FFI 单元 3、ABI 集成 6；Tauri 库 535，cleanup 集成 3、media leaf 集成 2 及 native/invoke 响应性夹具通过。模块图守卫元检查 150/150 通过，包含 core/FFI 的生产根无环与有限见证审计。FFI 复制到同项目按 dev 既有目的目录拒绝合同返回 ERROR，复制到独立项目成功，不放宽存储校验。

最终前端路由 `npm run format:check && npm run lint && npm run check:size && npm run typecheck:strict && npm run build && npm test` 全部通过，整仓 198 文件 / 2942 测试；hooks/scripts 路由 `npm run check:size && npm test -- scripts` 通过 15 文件 / 313 测试；`.github` 的 Prettier 检查通过。新鲜覆盖率及 SonarQube 在合并提交创建时由版本化 Git 钩子重新执行并记录，结论以该次门禁输出及待物化记录为准；本节的测试记录不替代提交门禁。Swift FFI 尚未链接、新宿主真实保存/退出和视觉目验仍未验证，不因分支合并视为完成。

## Xcode 27.0 升级衔接（2026-10-04）

所有者今日明确要求升级 Swift 开发规范后构建并启动原生版本。实测 Xcode 27.0（`27A266a`）、Swift 6.4（`swiftlang-6.4.0.34.1 clang-2100.3.34.1`）、macOS SDK 27.0；本机运行于 macOS 26.6.2（`25G83`），沿用已有 `/Applications/Xcode.app/Contents/Developer` 选择。Swift 6 语言模式与 macOS 26.0 最低部署目标保持。

现行原生 CI 改用 `xcode-27` 并检查 Xcode 27.0、SDK 27.0；原合并节的 `macos-26`／Xcode 26.6 为升级前记录。当前工具链与构建、测试、启动、画布就绪结果统一记录在[工具链升级记录](swiftui-react-flow-toolchain.md)，本地构建、16 项测试及窗口就绪已通过；托管 CI 未执行，完整视觉验收未完成。Swift FFI 保存/退出及完整视觉验收仍属于后续阶段。
