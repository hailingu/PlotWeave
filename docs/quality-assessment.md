# PlotWeave 设计与实现质量评估

本文是对 PlotWeave 设计与实现质量的评估记录：给出分维度评分、综合评级与每条结论的证据。它不是工程门禁，不新增规范或契约。缺陷结论供排期参考；已有所有者决策的事项不因本记录而重新成为扣分项。

- **评估基线**：`refactor/retire-v0-flat-format` @ `96fb373ab5ede620ff04e084d3ac8eecde6cba1a`（`96fb373`，2026-10-13）。上一记录基线是 `8c8d655`（综合 9.2 / A），与本轮基线仅相差 1 个文档提交（上一记录本身），代码内容相同——本轮是在同一代码上以更深入的并行审查方法做的重新评估，不是对新代码的跟踪评估。
- **评估性质**：只读审阅加 issue 建档。五路并行深度审查（前端 / Rust / Swift / 测试体系 / 工程基建与文档），通读或抽查了 60 余个代表性文件的实际内容，并对关键扣分证据做了直接复核（如 library_journal 的 cfg 门控断裂、gate-history 与 git log 的逐提交咬合）。本轮新建 issue [#546](https://github.com/hailingu/PlotWeave/issues/546)–[#553](https://github.com/hailingu/PlotWeave/issues/553)，未修改产品源代码。
- **证据强度**：文件行数、依赖与断言统计、`git` / `gh` 状态由本次直接核对。覆盖率数值（前端 97.01%、Rust 85.57%）取自最近一次 pre-push 门禁生成的 `coverage/lcov.info` 与 `src-tauri/target/coverage/lcov-rust.info`。本轮**没有**重跑 Prettier、ESLint、`npm test`、`cargo test`、`xcodebuild` 或 Sonar；测试通过性与 Quality Gate 状态引用的是门禁自身证据链（`docs/development/gate-history.jsonl`）。
- **会话初评修正**：本轮口头初评曾给 **8.9 / A-**。所有者确认 Tauri/Rust 与 Swift 双份实现是为 native 效果的有意设计（与已关闭的 [#518](https://github.com/hailingu/PlotWeave/issues/518) 结论一致），不作为扣分项，撤回相关扣分（合计 −0.6）后为 9.0。随后统一适用本文既有的「所有者已裁决或已记录事项不重复扣分」规则——[#522](https://github.com/hailingu/PlotWeave/issues/522) 残留的登记边界断言、[#468](https://github.com/hailingu/PlotWeave/issues/468) 的函数上限执行方式、与 [#520](https://github.com/hailingu/PlotWeave/issues/520) 威胁模型重叠的密钥内存驻留——撤回三处重复扣分（合计 −1.1，影响三个维度各一档以内）。修正后综合分为 **9.1 / A**。

## 一、评分口径

8 个维度、10 分制、等权。评级带：A+ 9.5–10.0、A 9.0–9.4、A- 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B- 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C- 5.5–5.9、D 4.0–5.4、E < 4.0。

扣分只计有真实证据、且在正常使用或已记录脏数据下可达的问题。下列事项不计扣分：

- 三栈并存与 Tauri/Swift 双份实现。[#518](https://github.com/hailingu/PlotWeave/issues/518) 已关闭，所有者本轮再次确认为刻意设计；具体实现内部的缺陷（如 `lock.rs` 双份拷贝）仍单独计。
- 同用户替换 `projects/` 树、非 Unix 身份缺口、同用户恶意软件场景（仓库威胁模型已排除；[#520](https://github.com/hailingu/PlotWeave/issues/520) 为已登记边界，密钥派生材料常驻堆内存不擦除与之重叠，不另扣）。
- 不支持 Windows 的平台选择本身。但代码内部 cfg 门控自相矛盾（注释声称考虑 Windows 语义而实际无法编译）仍计，见 4.3 与 [#546](https://github.com/hailingu/PlotWeave/issues/546)。
- 门禁不做快速通道、CI 不跑本机 Sonar 的执行约束本身（托管 runner 不可达本机服务，已记录）。但绕过路径在服务端无任何兜底仍计，见 4.5 与 [#548](https://github.com/hailingu/PlotWeave/issues/548)。
- [#468](https://github.com/hailingu/PlotWeave/issues/468) 已裁决的 80 行函数上限执行方式（评审强制、不建工具、存量不批量迁移）。
- [#522](https://github.com/hailingu/PlotWeave/issues/522) 已登记归一化层遗留边界断言（6 处 `as unknown as`，位于未信任输入与 JSON 边界）。
- [#519](https://github.com/hailingu/PlotWeave/issues/519) 的 v0 小数 `updated_at` 排序差异。已知边界，且本分支已让该格式直接被拒绝。

## 二、综合结果

| 维度 | 评分 | 评级 |
| --- | ---: | --- |
| 架构与模块设计 | 9.5 | A+ |
| 代码质量与类型安全 | 9.4 | A |
| 健壮性与错误处理 | 9.0 | A |
| 测试与覆盖率 | 8.6 | A- |
| 工程基建与质量门禁 | 8.4 | B+ |
| 文档与治理 | 9.4 | A |
| 可维护性与一致性 | 9.0 | A |
| 安全性 | 9.5 | A+ |
| **综合** | **9.1** | **A** |

等权计算：(9.5 + 9.4 + 9.0 + 8.6 + 8.4 + 9.4 + 9.0 + 9.5) / 8 = 9.10，按一位小数记为 **9.1**。

与上一记录 9.2 / A 的比较：两轮维度划分不同（上轮 9 维加权、本轮 8 维等权），逐维不可直接对比。综合 −0.1 主要来自本轮更深的基建与测试审查新发现的缺口（[#548](https://github.com/hailingu/PlotWeave/issues/548) 服务端兜底、[#550](https://github.com/hailingu/PlotWeave/issues/550) 视图层回归、[#551](https://github.com/hailingu/PlotWeave/issues/551) 全链路 E2E），不是代码变差。唯一 B+ 是工程基建：门禁设计与执行深度是本轮观察到的最强项之一，失分集中在强制力终点是本机。

## 三、直接核对的规模

分析版本上的 `wc -l` 与 grep 统计：

| 对象 | 结果 |
| --- | --- |
| 前端 `src/**`（438 个 TS/TSX） | 生产 233 文件约 38,105 行；测试 207 文件约 57,825 行（1.52 : 1）；最大 `src/App.tsx` **798** 行 |
| `src-tauri/src`（Rust） | 72 文件约 19,583 行（含测试） |
| `crates/`（plotweave-core + plotweave-ffi） | 22 文件约 6,871 行；Rust 两 workspace 合计 525 个 `#[test]` |
| `native/macos`（Swift） | App 67 文件 8,709 行；Tests 56 文件 6,977 行、242 个 `@Test`（约 0.8 : 1） |
| `scripts/`（门禁与守卫脚本） | 17 文件约 6,984 行；脚本自身 Vitest 套件合计超过 200KB |
| 行覆盖（门禁 lcov 实测） | 前端 **97.01%**（7,952 / 8,197）；Rust **85.57%**（6,598 / 7,711）；门禁下限均为 80% |
| 开放跟踪 | 评估时开放 issue 19 个、开放 PR 1 个（[#533](https://github.com/hailingu/PlotWeave/pull/533)）；本轮新建 [#546](https://github.com/hailingu/PlotWeave/issues/546)–[#553](https://github.com/hailingu/PlotWeave/issues/553) 后开放 27 个 |

## 四、分维度结论

### 4.1 架构与模块设计 — 9.5 / A+

模块边界由机器强制而非约定：[moduleGraph.test.ts](../src/moduleGraph.test.ts) 对真实 `src` 依赖图（TypeScript AST 解析 import/re-export/动态 import，Tarjan SCC 环检测）断言运行时与编译期双图无环；model 层纯度有四层独立守卫（禁框架运行时依赖、运行时与编译期闭包方向、shell→feature 方向），白名单收敛到 2 条且登记理由，守卫本身有合成反例测试防误报。`plotweave-core` 零 Tauri 依赖，`src-tauri/src/store/mod.rs` 是纯适配层；Swift 侧 6 个 actor 域经命令白名单分发（`NativeHostServices.swift:81-109`）。桥接协议为版本化信封 + 会话绑定 + canonical JSON 指纹去重 + 4096 容量窗口与退役防重放（`HostCommandRouter.swift:68-112`），五层防护均有真实 WebKit 测试背书。

扣分：

- **−0.3** `src/App.tsx` 798 行贴着 800 行上限，编排 7 个以上域 hook 与多个跨页 ref 隧道，是全应用协调中枢。跟踪为 [#545](https://github.com/hailingu/PlotWeave/issues/545)（上一轮已建）。
- **−0.2** `crates/` 与 `src-tauri/` 双 Cargo workspace 独立解析（两份 Cargo.lock），`plotweave-core` 被双份解析编译，共享依赖版本漂移无机制防护；`native/macos/App/` 67 个文件一层平铺，层边界仅靠命名前缀。前者跟踪为 [#549](https://github.com/hailingu/PlotWeave/issues/549)；后者规模尚可控，不建 issue。

### 4.2 代码质量与类型安全 — 9.4 / A

类型卫生接近满分：生产代码 **0 个 `any`、0 个 `@ts-ignore`**；13 处 `@ts-expect-error` 全部用于负向类型契约测试，用法正当。TS 配置超 strict 标配（`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 进门禁）。Swift 侧 **0 个 `try!`、0 个 `as!`、0 个强制解包、0 个 `fatalError`**，27 处 `try?` 逐一抽查全部有正当理由。Rust 生产代码仅 2 处 `#[allow]`；全库 619 处 unwrap 中生产约 50 处，逐一抽查均为已论证的不变量（如 `persist.rs:508` 有祖先循环证明）。`clippy --all-targets -- -D warnings` 覆盖测试 target。

扣分：

- **−0.4** [batchSim.ts](../src/editor/ai/batchSim.ts)（536 行）15 处 `as` 断言加 `Record<string, unknown>` 动态键通用模拟引擎，AI 批量写画布核心路径的正确性靠测试而非类型。跟踪为 [#553](https://github.com/hailingu/PlotWeave/issues/553)。
- **−0.2** 内联 SVG 图标样板在 6 个文件复制，无共享组件；`NativeModels.swift:120-121` 缩进错位残留、`HostQuit.swift:166` 无括号混合 `||`/`&&`。均为琐碎项，不建 issue。

[#522](https://github.com/hailingu/PlotWeave/issues/522) 残留的 6 处 `as unknown as` 是已登记的加载边界断言，按本文规则不重复扣分。

### 4.3 健壮性与错误处理 — 9.0 / A

持久化正确性达到基础设施级严谨度：原子写四件套（`O_CREAT|O_EXCL` 随机临时名、write+fsync、rename 前复核、父目录 fsync 持久性屏障，`persist.rs:238-303`）；`library_journal` 实现完整可恢复删除提交协议；cap-std 受信句柄 + no-follow + (dev,ino) 身份绑定贯穿全库，且测试与生产共享故障注入路径。手写领域错误 enum + 完整 source 链，错误文案被契约测试逐字钉死。panic 治理成体系：FFI `catch_unwind`（`ffi/lib.rs:134-143`）、worker panic 折叠为结构化诊断（`blocking.rs:18-41`，刻意不打印载荷防密钥泄露）、锁中毒统一恢复。前端 98 个 catch 无一静默吞错（抽查的"空"catch 均有语义注释），保存失败有后台重试链与用户可见上浮。

扣分：

- **−0.5** `library_journal` 在非 Unix 平台无法编译：`recover.rs:20-23` 无条件 import 的符号在 `trash.rs:25-131` 全部是 `#[cfg(unix)]` 且无非 Unix 对应物；`fsync_dir` 非 Unix 变体签名（`Result<(), String>`）与 Unix 变体（`Result<(), LibraryError>`）漂移，且无 `From<String>`。扣分对象是代码内部 cfg 意图与可达性自相矛盾（`persist.rs:294` 等注释声称考虑 Windows 语义），不是平台选择本身；CI 仅 macOS 使该断裂无发现渠道。跟踪为 [#546](https://github.com/hailingu/PlotWeave/issues/546)。
- **−0.3** `native_quit.rs:92-102` 的 `extern "C" fn should_terminate` 未做 `catch_unwind`，回调内 panic 跨 FFI 边界 unwind 即 abort，可能中断退出屏障的在途保存冲刷——与 FFI 层的细致防护形成落差。跟踪为 [#547](https://github.com/hailingu/PlotWeave/issues/547)。
- **−0.2** 解析器类代码（`HostJSON`、library_index 迁移链）无 property-based / fuzz 测试，靠手写表驱动用例。建议级，不建 issue。

### 4.4 测试与覆盖率 — 8.6 / A-

体量与质量双高：前端测试：生产 1.52 : 1，Swift 约 0.8 : 1，Rust 525 个 `#[test]`；实测行覆盖前端 97.01%、Rust 85.57%。纪律硬指标全绿：**0 个 skip、0 个 `#[ignore]`、0 个快照、0 个 `.only`、0 个空断言**。真实集成不缺位：Rust 侧 `invoke_responsiveness.rs` 用真实 Wry 子进程断言 150ms 主线程响应预算；Swift 侧 `WebHostBridgeTests` 起真实 WKWebView 验证 iframe 注入拒绝与页面失效闭锁；HTTP 测试用本机真实 TCP/URLSession 夹具。[ipc/commands.test.ts](../src/ipc/commands.test.ts) 对 Rust `generate_handler!` 清单与前端常量做双向一致断言，fail-closed。门禁脚本自身有超过 200KB 的测试套件。

扣分：

- **−0.5** Tauri shell 缺「真实 webview 加载真实前端 bundle 调真实 Rust 命令」的全链路 E2E：前端 8 个 `*.tauri.test.ts` 全部 mock IPC 边界，`invoke_responsiveness` 只从 Rust 侧驱动；native shell 侧已有对应物（`WebCanvasLoadingTests`）而 Tauri 侧没有。跟踪为 [#551](https://github.com/hailingu/PlotWeave/issues/551)。
- **−0.4** SwiftUI 视图层无直接回归测试：`NativeSettingsView.swift`（407 行）、`NativeHomeView.swift`（392 行）等全靠状态/模型测试间接覆盖，无 snapshot/UI 测试。与 [#523](https://github.com/hailingu/PlotWeave/issues/523) 的一次性验收证据互补。跟踪为 [#550](https://github.com/hailingu/PlotWeave/issues/550)。
- **−0.3** 覆盖率门禁为全局口径：局部塌陷可被整体均摊掩盖（`src-tauri/src/lib.rs` 45.5%、`media_format.rs` 65.4% 在 85.57% 总量下隐形）；`NativeHostApp.tsx`、`nativeCanvas/main.tsx`、`store/mod.rs` 为 0% 盲区。80% 下限与实测的差距本身是已记录的余量设计，不另扣；此处扣的是口径与盲区。不建 issue。
- **−0.2** 4 处 10 秒真实时钟服务端夹具（`http_util.rs:344`、`prefs/tests.rs:257,287`、`imagegen/tests.rs:544`）与 1-2ms mtime 排序 sleep（`key_migration_tests.rs:148,154`），CI 高负载下有轻微 flake 面。不建 issue。

### 4.5 工程基建与质量门禁 — 8.4 / B+

设计深度远超普通项目：三钩子分工覆盖 revert/cherry-pick，`prepare-commit-msg` 兜底 `git commit --no-verify`；`pre-push` 按 ref 逐个分析，慢路径在临时 worktree 检出被推提交并 `npm ci` 后跑完整门禁，杜绝「检 A 推 B」；`GIT_NO_REPLACE_OBJECTS=1`、信号进程组分级清理、未分类后缀 fail-closed。证据链闭合：`gate-history.jsonl` 与 git log 逐提交咬合，覆盖率数值随代码漂移，证明是真实重跑。本地门禁与 CI 同口径单一事实源，Node/Rust/Xcode 钉版一致且 CI 有显式断言。已知绕过面（`git am` 等）在 quality-gate-enforcement.md 诚实记录。

扣分：

- **−0.8** 门禁强制力终点是本机：CI 不跑 Sonar（已记录原因）且前端 job 跑 `npm test` 而非 `npm run test:coverage`；hooks 需手动安装。`git push --no-verify` 可让未过 Sonar、覆盖率任意低的代码离机，服务端无任何拦截或告警。扣分对象不是「CI 不跑 Sonar」这一已记录约束，而是服务端兜底（门禁证据核验或分支保护）完全缺失。跟踪为 [#548](https://github.com/hailingu/PlotWeave/issues/548)。
- **−0.4** `main`/`dev` 未启用 GitHub 分支保护（AGENTS.md 自记 `protected: false`、无 ruleset），「禁止直推」是纯约定，与上一条叠加构成无人值守绕过路径。处置并入 [#548](https://github.com/hailingu/PlotWeave/issues/548) 候选方案，不单开。
- **−0.3** 无 Dependabot/Renovate，CI 无 `npm audit` / `cargo audit`；react 18、vitest 4、typescript 5.9 等对大版本 Latest 滞后且无自动提醒机制。跟踪为 [#552](https://github.com/hailingu/PlotWeave/issues/552)。
- **−0.1** ESLint 基线偏温和（recommended 加 2 条 type-aware，靠零警告门禁补偿）；合并提交消息格式不统一（多数为 "Merge pull request #N"，`d3683be` 用 Conventional 消息做合并提交）。不建 issue。

### 4.6 文档与治理 — 9.4 / A

文档是活文档：docs/ 下 19 个主题分层清晰；「改动必须同步设计文档」有真实执行证据（v0 退役后的专项同步提交 `8c8d655`，多份 data-model 文档表述一致并链接同一 issue）；本轮抽查 3 处文档与代码一致性全部通过。Conventional Commits 最近 30 条 0 违规；**0 个 TODO/FIXME 积压**——债务以 issue 编号内联在注释里，几乎每个非显然决策都可溯源。门禁诊断码有契约文档（26 处 PRE_PUSH_ 引用）；密钥封装写明威胁模型边界（`seal.rs:1-21`）。

扣分：

- **−0.4** `vite.config.ts:25` 注释的前端覆盖率基线（98.13%）已漂移到实测 97.01%——门禁不追踪基线，注释陈旧。琐碎编辑项，不建 issue。
- **−0.2** 注释密度极高（Rust `///` 约占 9%，Swift 几乎每个成员一条）带来注释漂移面；个别跨 actor 契约仅靠注释约束而非代码断言（`NativeProjectStore.swift:58`）。记录，不建 issue。

### 4.7 可维护性与一致性 — 9.0 / A

命名一致性高（hook 统一 `use*`、门面统一 `*Store`、归一化统一 `normalize*`）；文件 800/1800 行上限由工作树与索引双份测量强制执行，当前基线为空即全库无豁免；依赖注入贯穿 Swift 服务层；易漂移逻辑已单一来源化（复制命名规则、LIBRARY_KINDS 展示表）；运行时依赖仅 4 个。

扣分：

- **−0.5** 手写 pub/sub 模式重复且无编译期护栏：`aiSessionStore.ts:26-52` 与 `saveChain.ts:84-105` 各自重造 listener Set 加退订；8 个模块级可变单例（`saveChain.ts:27-75`）靠注释登记归属与生命周期，新增订阅路径没有类型层面保护（测试覆盖厚是缓解项）。不建 issue。
- **−0.5** `src-tauri/src/lock.rs` 与 `crates/plotweave-core/src/lock.rs` 逐字节相同（58 行，diff 验证），锁中毒恢复策略修订需人工双处同步。并入 [#549](https://github.com/hailingu/PlotWeave/issues/549)。

### 4.8 安全性 — 9.5 / A+

在「本地单用户桌面应用」威胁模型内做得扎实：密钥封装 PBKDF2 600k 轮 + AAD 绑定 + 迭代数 DoS 上界，机器标识不可用硬失败不回退弱材料；桥接五层防护（会话绑定、主框架加入口 URL 双重信任、请求指纹去重、容量窗口、退役防重放）全部落地且有真实 WebKit 测试；HTTP 层 URL 脱敏、跨域重定向剥离 Bearer 有专项测试；O_NOFOLLOW 加身份绑定防 TOCTOU 贯穿 Rust/Swift 双端；CI `contents: read` 最小权限；Sonar 令牌只经 curl stdin、校验字符集后 unset 防子进程继承。

扣分：

- **−0.5** `WebCanvasHostView.swift:176-182` 的 `pushAppearance` 用字符串插值拼 JS（内容来自 JSONEncoder，实际安全），而同文件 `dispatchEvent:304-310` 刻意改用 `arguments:` 传参——同一文件两种严格度不一致，是防御纵深一致性口子而非现实漏洞。不建 issue。

密钥派生材料常驻堆内存不擦除与 [#520](https://github.com/hailingu/PlotWeave/issues/520) 已登记威胁模型边界重叠，按本文规则不重复扣分。

## 五、本轮新建与故意不建的 issue

新建（均按 [issue 规范](development/issue-standard.md)，证据锚定 `96fb373`）：

| Issue | 对应维度 | 原因 |
| --- | --- | --- |
| [#546](https://github.com/hailingu/PlotWeave/issues/546) | 4.3 | P2：`library_journal` 非 Unix 编译断裂，cfg 门控与无条件引用自相矛盾 |
| [#547](https://github.com/hailingu/PlotWeave/issues/547) | 4.3 | P2：`native_quit` 退出回调跨 `extern "C"` 缺 panic 遏制 |
| [#548](https://github.com/hailingu/PlotWeave/issues/548) | 4.5 | P3：Sonar 与覆盖率门禁服务端无兜底，`push --no-verify` 可完全绕过 |
| [#549](https://github.com/hailingu/PlotWeave/issues/549) | 4.1 / 4.7 | P3：双 Cargo workspace 独立解析，`lock.rs` 逐字节双份维护 |
| [#550](https://github.com/hailingu/PlotWeave/issues/550) | 4.4 | P3：SwiftUI 视图层无直接回归测试（与 [#523](https://github.com/hailingu/PlotWeave/issues/523) 的一次性验收互补） |
| [#551](https://github.com/hailingu/PlotWeave/issues/551) | 4.4 | P3：Tauri shell 缺前端 bundle 到 Rust 命令的全链路 E2E |
| [#552](https://github.com/hailingu/PlotWeave/issues/552) | 4.5 | P3：CI 缺依赖与供应链检查（npm audit / cargo audit / Dependabot） |
| [#553](https://github.com/hailingu/PlotWeave/issues/553) | 4.2 | P3：`batchSim.ts` 15 处 `as` 断言，AI 写画布路径类型安全洼地 |

故意不建：

- [#545](https://github.com/hailingu/PlotWeave/issues/545)（`App.tsx` 余量）、[#520](https://github.com/hailingu/PlotWeave/issues/520)（密钥威胁模型边界）、[#521](https://github.com/hailingu/PlotWeave/issues/521)（生产路径 unwrap/expect）、[#523](https://github.com/hailingu/PlotWeave/issues/523)（P5 验收证据）、[#527](https://github.com/hailingu/PlotWeave/issues/527)、[#529](https://github.com/hailingu/PlotWeave/issues/529)、[#525](https://github.com/hailingu/PlotWeave/issues/525)、[#534](https://github.com/hailingu/PlotWeave/issues/534)–[#542](https://github.com/hailingu/PlotWeave/issues/542) 已经开放，不重复建单。
- [#522](https://github.com/hailingu/PlotWeave/issues/522) 残留边界断言、[#468](https://github.com/hailingu/PlotWeave/issues/468) 函数上限执行方式、三栈并存（[#518](https://github.com/hailingu/PlotWeave/issues/518)）均为所有者已裁决或已记录事项。
- 覆盖率全局口径与 0% 盲区、手写 pub/sub 重复、property-based 缺位：分别为已记录余量设计、测试厚缓解的低风险项与建议级项，记录于第四节对应维度。
- SVG 图标复制、`vite.config.ts` 注释基线漂移、合并提交消息格式、真实时钟夹具、ESLint 基线温和：严重度过低，不够 issue 门槛。

## 六、未运行的检查

`docs/**` 没有配置独立的自动化检查。本记录是文档替换，没有产品代码变更，因此评估过程没有运行 Scope Routing 中的前端、Rust 或原生测试命令；覆盖率与门禁状态引用的是门禁自身产物（lcov 与 gate-history.jsonl）。本文件的提交仍须走仓库既有的提交与推送门禁，那不是本评估已经完成的验证。
