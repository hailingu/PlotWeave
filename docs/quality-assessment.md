# PlotWeave 设计与实现质量评估（2026-10-24 历史快照）

本文记录 PlotWeave 在 2026-10-24 评估基线的设计与实现质量结论，给出分维度评分、综合评级、证据、排除口径和后续 issue。它不是工程门禁，不新增产品规范或数据契约；缺陷修复与验收以所链接 issue 为准。

**历史结论（2026-10-24）：8.7 / 10，A−。**

- **评估代码基线**：`dev` @ [`1332debe2ba7c4edd579d753045e894f33cfb298`](https://github.com/hailingu/PlotWeave/commit/1332debe2ba7c4edd579d753045e894f33cfb298)。
- **评估方式**：前端/React、Rust/Tauri、Swift 原生、测试与工程治理分域只读审查，直接复核关键代码、配置、tracker 和 GitHub Actions；随后仅为建档与更新本文，不夹带实现修复。
- **本轮 issue**：新建 [#801](https://github.com/hailingu/PlotWeave/issues/801)–[#809](https://github.com/hailingu/PlotWeave/issues/809)，共 6 项 P2、3 项 P3。它们在评分时尚未登记，因此计入本轮；后续复评作为已知 issue 不重复扣分，只跟踪修复和验证。
- **历史档案**：本轮之前的完整评估保留在[固定版本档案](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/quality-assessment.md)。历史 8.9/A−、9.2/A 等结论不再与“当前评分”混写。
- **基线一致性**：评估从 `42863bef` 开始，最终在 `1332debe` 复核；两版差异仅涉及已排除的 #717、#729 和门禁台账。本文所有扣分路径均在最终基线上重新确认。


## 后续修复状态（2026-10-26，issue #861）

下列九项已在 `dev@a014236e` 的历史中修复并合并。下文的评分、扣分表、测量和建议均是 `1332debe` 历史快照，不表示当前缺陷或待办；保留原始 8.7 / A−，本次文档同步没有重新评分，也不推算修复后的分数。未验证边界仍按原记录保留。

| Issue | 修复提交 |
| --- | --- |
| #801 | [`e4a4faa6`](https://github.com/hailingu/PlotWeave/commit/e4a4faa6) |
| #802 | [`3424527a`](https://github.com/hailingu/PlotWeave/commit/3424527a)（PR #835 含后续评审修复） |
| #803 | [`9d044436`](https://github.com/hailingu/PlotWeave/commit/9d044436) |
| #804 | [`a0403070`](https://github.com/hailingu/PlotWeave/commit/a0403070) |
| #805 | [`d6464241`](https://github.com/hailingu/PlotWeave/commit/d6464241) |
| #806 | [`dfeac3e2`](https://github.com/hailingu/PlotWeave/commit/dfeac3e2) |
| #807 | [`093ccc35`](https://github.com/hailingu/PlotWeave/commit/093ccc35) |
| #808 | [`874fc63e`](https://github.com/hailingu/PlotWeave/commit/874fc63e) |
| #809 | [`0b1eb037`](https://github.com/hailingu/PlotWeave/commit/0b1eb037) |

## 一、评分口径

采用 10 分制和显式权重。评级带：A+ 9.5–10.0、A 9.0–9.4、A− 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B− 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C− 5.5–5.9、D 4.0–5.4、E < 4.0。

扣分必须同时满足：

1. 有固定版本代码、配置、可访问运行记录或直接命令输出作为证据；静态结论与实测结论明确区分。
2. 触发属于正常操作、现实竞态、常见脏数据或明确支持的工程路径，不以不现实的极端边界制造扣分。
3. 不是评估开始前已经登记的 issue，不与既有 issue 更换措辞重复计算。
4. 不因 UI 自动化方案、已取消的 VoiceOver/视觉快照验收或所有者已明确决定的技术范围扣分。

评分是证据支持的整体判断，不按缺陷数量作算术扣减。同一问题在实现和测试中的证据可以互相解释，但不拆成多个虚假独立缺陷。

### 不直接作趋势比较

| 评估日期 | 代码基线 | 当时综合 | 计分结构 |
| --- | --- | ---: | --- |
| 2026-10-13 | `96fb373` | 9.1 / A | 历史口径，详见固定档案 |
| 2026-10-18 | `3cf7146` | 8.9 / A− | 9 个维度等权 |
| 2026-10-21 | `05c9df40` | 9.2 / A | 9 个维度等权 |
| **2026-10-24** | **`1332debe`** | **8.7 / A−** | **6 个维度显式加权** |

不同轮次的维度、权重和已知 issue 集合不同，分数只描述各自基线，不能单独解释为产品质量线性上升或下降。

## 二、当时综合结果

| 维度 | 权重 | 评分 | 评级 | 核心判断 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 9.3 | A | 数据所有权清楚，依赖方向有 AST 级机器守卫 |
| 前端状态与交互实现 | 20% | 8.0 | B+ | 保存体系成熟，但重命名、资产视图和键盘焦点仍有缺口 |
| 原生 Swift 桥接与生命周期 | 20% | 8.9 | A− | 会话身份、缓存和失效处理扎实，导出未完全纳入退出协调 |
| 持久化、安全与数据契约 | 15% | 9.1 | A | 原子写、身份绑定、损坏隔离、密钥与网络边界完整 |
| 测试与可靠性工程 | 15% | 9.0 | A | 行为、契约、真实宿主测试层次丰富，少数用例遗漏最终不变量 |
| CI、门禁与文档维护 | 15% | 8.2 | B+ | CI 真实有效，覆盖率复用来源、类型检查范围和文档同步有缺口 |
| **综合** | **100%** | **8.7** | **A−** | 核心工程能力为 A 档，局部状态一致性和门禁保证拉回整体评分 |

加权计算：`9.3×15% + 8.0×20% + 8.9×20% + 9.1×15% + 9.0×15% + 8.2×15% = 8.72`，按一位小数记为 **8.7 / A−**。

## 三、主要质量优点

### 3.1 架构约束可执行

- [`src/moduleGraph.test.ts`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/moduleGraph.test.ts#L97-L113) 同时要求运行时图和包含类型边的编译期图无环；同文件 [162–175 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/moduleGraph.test.ts#L162-L175) 守卫 model 不依赖框架或 editor 运行时，[432–434 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/moduleGraph.test.ts#L432-L434) 守卫 shell 到 editor 的方向。
- [`src/projectStore/tauri.ts`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/projectStore/tauri.ts#L305-L375) 在读取期间检查保存链身份；出现新写入会重新读取，避免交付写前旧快照。
- React 保留唯一可写编辑会话，Swift 原生视图消费投影并提交意图；Tauri/Rust 作为既有宿主和契约基线保留，不把三栈并存本身重新计为缺陷。

### 3.2 持久化与安全边界扎实

- Rust 原子写包含排他临时文件、文件同步、rename 前复核和父目录同步：[`store/persist.rs`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/crates/plotweave-core/src/store/persist.rs#L285-L370)。
- Swift 使用 no-follow、文件身份绑定和耐久原子写：[`NativeDirectory.swift`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/NativeDirectory.swift#L78-L170)。
- 原生桥校验会话、请求身份和参数指纹，并对完成回执实行有界缓存：[`HostCommandRouter.swift`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/HostCommandRouter.swift#L109-L159)。
- 图片下载逐跳检查 HTTPS、公网地址、大小、期限和取消：[`NativePublicDownload.swift`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/NativePublicDownload.swift#L56-L85)。

### 3.3 测试和 CI 提供真实保证

最终基线的 [CI 40081665766](https://github.com/hailingu/PlotWeave/actions/runs/40081665766) 已成功：

- 前端：266 个测试文件、3,559 项测试通过。
- 原生：377 项测试、84 个套件通过；8,819/9,995 行，88.23%，74/74 文件。原生覆盖率按既定策略仅为 report-only，不冒充百分比门禁。
- Rust：两个 workspace 的 fmt、Clippy、测试、依赖审计和双 workspace 漂移检查全部通过。
- Rust job 先构建真实前端，再执行 Wry → IPC → 落盘链路：[`ci.yml`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/.github/workflows/ci.yml#L116-L126)。测试数量不是唯一加分依据，模块 AST、真实宿主和磁盘结果才提供这些行为保证。

## 四、本轮扣分项与跟踪 issue

| Issue | 严重度 | 维度 | 问题 | 计分处理 |
| --- | --- | --- | --- | --- |
| [#801](https://github.com/hailingu/PlotWeave/issues/801) | P2 | 前端 | 连续重命名可让旧名称覆盖新名称 | 主要扣分 |
| [#802](https://github.com/hailingu/PlotWeave/issues/802) | P2 | 前端 | 资产写入跨重挂载后当前面板缺少列表失效 | 主要扣分 |
| [#803](https://github.com/hailingu/PlotWeave/issues/803) | P2 | 前端 | 删除确认框缺少设计声明的键盘焦点入口 | 中等扣分 |
| [#804](https://github.com/hailingu/PlotWeave/issues/804) | P2 | 原生 | 导出任务未登记退出屏障 | 中小扣分，不影响原项目 |
| [#805](https://github.com/hailingu/PlotWeave/issues/805) | P2 | 工程 | 慢路径复用 LCOV 未绑定被推 tree | 中等扣分，不声称已有事故 |
| [#806](https://github.com/hailingu/PlotWeave/issues/806) | P3 | 工程 | native-canvas 配置及根级测试漏出 tsc 文件集 | 小幅扣分 |
| [#807](https://github.com/hailingu/PlotWeave/issues/807) | P3 | 文档 | 门禁成本文档与 scoped push 现行策略矛盾 | 小幅扣分 |
| [#808](https://github.com/hailingu/PlotWeave/issues/808) | P3 | 文档 | Rust direct checks 漏列双 workspace 漂移检查 | 与文档维护一并评价，不按数量追加扣分 |
| [#809](https://github.com/hailingu/PlotWeave/issues/809) | P2 | 测试 | TLS 重定向回归以非阻塞通道读取请求数，完整门禁存在调度抖动 | 与测试可靠性一并评价，不按数量追加扣分 |

### 4.1 #801：连续重命名的最终写入不属于最新意图

每次重命名独立执行 load → rename → save：[`useHomeProjectActions.ts`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/useHomeProjectActions.ts#L48-L69)。尝试序号只控制反馈和恢复身份：[`useHomeActionFeedback.ts`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/useHomeActionFeedback.ts#L47-L50)，不会阻止旧尝试保存。

先发起 A、再发起 B 时，如果 B 先保存成功而 A 的读取随后完成，A 仍会后排入保存队列并覆盖 B。[`ProjectSaveQueue.append`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/projectStore/saveQueue.ts#L13-L18) 保证的是保存调用到达顺序，不是用户意图顺序。

现有[恢复测试](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/App.retryRecovery.test.tsx#L98-L128)已构造旧读取迟到，但只断言错误横幅，没有断言两次成功保存后的最终名称。建议按项目从动作发起时串行化完整操作，或在保存及后台恢复前作废旧意图；验收必须落到最终持久化名称。

### 4.2 #802：成功资产写入与面板重挂载之间缺少通知

[`useLibraryAssetList`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/editor/panels/AssetsPanel.tsx#L52-L68) 只在挂载时读取一次；[`LeftPanel`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/editor/panels/LeftPanel.tsx#L423-L443) 在切换标签时卸载资产面板。导入完成只更新发起实例：[`useAssetImport`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/editor/panels/AssetsPanel.tsx#L154-L181)。

如果新实例先读到 A，随后旧实例发起的 B 成功落盘，旧实例的 `setAssets` 无法更新新实例；库门面也没有列表版本订阅。当前面板可能持续显示旧值，直到再次挂载或其他同步。不同于 #719 的批量失败中断和 #700 的失败回收。

建议由库门面提供版本化失效通知，或让新面板与在途操作收口后再发布列表。回归应分别覆盖导入、名称和标签成功写入，并要求 B 落盘后当前实例无需额外交互即显示 B。

### 4.3 #803：删除确认框缺少键盘焦点入口

[`ConfirmDeleteDialog`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/home/Dialogs.tsx#L90-L126) 只监听 Escape，没有首控件聚焦或关闭归还；同文件重命名框已有主动聚焦。打开删除框还会关闭原菜单：[`HomePage.tsx`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src/home/HomePage.tsx#L74-L77)，原聚焦 menuitem 随之卸载。

这与 [`ui-design.md` §3.2](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/ui-design.md#L154-L155) 声明的“各自的焦点入口”不一致。扣分针对普通键盘路径，不要求 VoiceOver，也不评价 UI 自动化方案。建议至少补首控件聚焦和合理归还；若维持模态呈现，再复用现有焦点圈定能力。

### 4.4 #804：原生导出未纳入退出工作集合

[`NativeExportView.deliver`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/NativeExportView.swift#L69-L85) 直接创建 Task 调用 `services.perform`，没有经过 `NativeApplicationState.enqueueNativeIntent`。最终退出批准只检查 Web 原生意图和图库批次：[`NativeHostServices.finishQuit`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/NativeHostServices.swift#L126-L140)。

导出仍可能在等待系统面板或实际写入：[`saveText`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/native/macos/App/NativeHostServices.swift#L181-L201)。因此退出可以在交付尚未 settle 时获得批准。该问题只影响本次导出，不影响原项目，故未按 P1 或广泛数据丢失计分。建议登记直接系统交付并覆盖面板待决、写入中、取消、失败和成功时序。

### 4.5 #805：慢路径复用覆盖率没有来源绑定

[`.githooks/pre-push`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/.githooks/pre-push#L375-L400) 在快慢路径判定前把复用 LCOV 指向主工作树，随后可能进入非 HEAD 或脏树的临时 worktree。[`sonar-quality-gate.sh`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/scripts/sonar-quality-gate.sh#L308-L350) 只检查报告存在、可解析和达到 80%，不校验源码 tree。

[`quality-gate-push.md`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/development/quality-gate-push.md#L49-L51) 已承认复用值可能陈旧并建议完整门禁，但钩子没有自动升级。扣分针对门禁无法证明输入属于被推提交，不声称已经发生错误合并。优先建议慢路径自动提升为 full；如保留复用，则引入并校验栈级 tree/SHA 元数据。

### 4.6 #806：native-canvas 配置漏出 TypeScript 文件集

[`tsconfig.json`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/tsconfig.json#L20-L21) 和 [`tsconfig.strict.json`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/tsconfig.strict.json#L6-L7) 都只包含 `src` 与 `vite.config.ts`。本轮用 TypeScript 自身配置解析 API 实测：

```text
tsconfig.json:
  vite.config.ts: included
  vite.native-canvas.config.ts: EXCLUDED
  vite.native-canvas.test.ts: EXCLUDED
tsconfig.strict.json:
  vite.config.ts: included
  vite.native-canvas.config.ts: EXCLUDED
  vite.native-canvas.test.ts: EXCLUDED
```

因此两个 tsc 入口不能发现这些文件中的纯类型错误。Vite、Vitest 和真实原生构建仍有补偿，故为 P3。建议补文件集合并扩展 [`tsconfig-scope.test.ts`](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/scripts/tsconfig-scope.test.ts#L39-L60)。

### 4.7 #807：门禁成本文档内部矛盾

[`quality-gate-cost.md` 54–59 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/development/quality-gate-cost.md#L54-L59) 已记录 scoped push；同文 [365–375 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/development/quality-gate-cost.md#L365-L375) 仍声称所有钩子完整运行且没有环境变量或分支条件减少检查集。应区分 commit 完整门禁和 push scoped routing，不改变所有者决策。

### 4.8 #808：开发检查清单漏列漂移检查

[`workflow.md` 55–61 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/docs/development/workflow.md#L55-L61) 的 Rust direct checks 没有 `check:workspace-drift`，而 `AGENTS.md` 的两个 Rust Scope Routing 行及 [`ci.yml` 94–100 行](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/.github/workflows/ci.yml#L94-L100) 都实际要求它。该遗漏会把问题推迟到完整门禁或 CI 才发现，按文档维护质量一并计分。

### 4.9 #809：TLS 重定向回归的请求计数存在调度竞态

本轮首次完整 commit 门禁实际出现 417 项通过、1 项失败，失败为 `redirect_mixed_dns_answer_is_rejected_before_connecting`：首跳请求计数实际为 0、预期为 1。随后同一测试在默认 test target 上定向连续运行 10 次全部通过，确认需要按抖动处理，而不是把一次失败解释为生产下载策略失效。

[`download.rs` 的测试](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src-tauri/src/imagegen/tests/download.rs#L319-L347) 在第二次 DNS 拒绝后立即用 `try_iter()` 读取请求数；[TLS 服务](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src-tauri/src/imagegen/tests/download/tls_fixture.rs#L30-L46) 先 print 请求再发送响应，但 [stdout 读取线程](https://github.com/hailingu/PlotWeave/blob/1332debe2ba7c4edd579d753045e894f33cfb298/src-tauri/src/imagegen/tests/download/tls_fixture.rs#L65-L79) 与客户端断言没有 happens-before 保证。建议对必须到达的首跳复用现有 `recv_timeout` 有界等待，再以非阻塞方式证明第二跳不存在，不用固定 sleep 或放宽生产断言。

该发现属于测试可靠性维度的同类扣分证据，综合分保持 8.7，不按 issue 数量机械追加扣减。

## 五、排除项与未计分候选

### 5.1 已知 issue

评估开始时的 16 个开放 issue 全部排除：#717、#718、#719、#720、#721、#722、#723、#724、#725、#726、#729、#730、#731、#733、#741、#744。后续状态变化不影响本轮口径。

#801–#809 是本轮评估后新建立的跟踪项，不追溯取消本轮扣分；下一次复评应将它们视为已知质量债，避免重复处罚。

### 5.2 所有者决策与产品范围

- 三栈并存、Tauri/Swift 双实现、原生覆盖率 report-only、Node/Rust/Xcode 钉版及本机 Sonar 约束，不重新计为缺陷。
- VoiceOver 已取消、视觉快照验收已取消、仅支持 macOS、当前 Release 仅提供源码归档，不作为本轮代码质量扣分。
- **UI 自动化没有合适方案不扣分。**现有 DOM、真实 Wry、WKWebView/AppKit 回归仍按实际证明范围评价，不夸大为完整系统验收。

### 5.3 不现实或证据不足的候选

下列初筛候选未进入评分：

- 需要连续双故障的原生设置备份目录同步窗口。
- 缺少真实项目规模和进程限制证据的两轮资产文件描述符累积；本轮 shell 软限制实测为 1,048,575，不能据此证明现实项目会耗尽。
- 大载荷 MainActor JSON 编解码只有工作机制、没有可感知延迟测量，不按已发生卡顿扣分。
- Rust 非对象设置根与既有归一化/已知治理事项重叠，未换一种说法重复处罚。
- 单提交 PR 的 tip-lag 与 #548 既有证据治理重叠，未重复扣分。

### 5.4 不在本次评分内

本文的“设计”指软件架构、数据契约和交互设计，**不对视觉美感评分**。真实中文输入法、付费 Provider、公网 TLS、签名公证、安装包和完整系统人工验收仍按[当前功能状态](swiftui-react-flow-current-state.md)的边界处理。

## 六、验证记录

### 6.1 本地实际执行

工作目录均为仓库根，Node.js 为 24.18.0：

| 命令/检查 | 结果与边界 |
| --- | --- |
| `npm run check:static` | Prettier、ESLint 零警告、`check:size`、严格 TypeScript 全部通过；规模检查 checked=855、excluded=66 |
| `npx vitest run src/App.retryRecovery.test.tsx src/editor/panels/AssetsPanel.persistence.test.tsx` | 2 个文件、18 项测试通过；通过不否定 #801/#802 未覆盖的最终不变量 |
| TypeScript `readConfigFile` + `parseJsonConfigFileContent` | 直接得到 #806 所列 EXCLUDED 结果 |
| 首次 `git commit` 完整本地门禁 | 静态检查、前端覆盖率和大部分 Rust 测试执行后，因 #809 的 1 项调度抖动失败；417 项 Rust 测试通过、1 项失败，未创建提交，不记为通过 |
| 定向重复运行 #809 对应 Rust 测试 | 同一测试连续 10 次通过；只证明失败具有调度抖动特征，不宣称问题已修复 |
| `gh issue view`（#801–#809） | 标题符合 `P<n>(scope)`，每项恰好一个严重度标签，六项必需正文结构齐全 |

### 6.2 绑定基线的远端证据

[CI 40081665766](https://github.com/hailingu/PlotWeave/actions/runs/40081665766) 精确对应 `1332debe` 并成功。frontend、rust、native 结果见第三节；gate-evidence 在 dev push 事件按既有规则跳过，不写成执行通过。

本地遗留 `coverage/` 没有 commit/tree/run ID，不作为当前基线刚通过门禁的证据。版本化 gate-history 是 executor 自述台账，也不替代独立 CI 或真实 Sonar 响应。

### 6.3 未执行和置信度

- 首次 commit 门禁完成了前端覆盖率并进入 Rust 覆盖率，但 #809 中断了 Rust 阶段，后续 Sonar 未在该次运行执行；本轮未另行运行完整原生套件。代码基线质量结论使用精确 HEAD 的远端 CI，不把中断的本地运行写成完整通过。
- 未在真实桌面应用复现 #801、#802、#804 的完整时序，也未执行 #803 的物理键盘/WebKit 焦点验收；代码路径和所有权缺口为高置信度，实际发生频率为中等置信度。
- 未执行真实 Sonar 推送来证明 #805 曾造成误放行；该 issue 是门禁输入保证缺口，不是事故报告。
- 各审查角色对初筛候选是否计分曾有差异；按第五节的排除规则过滤后，最终引用的事实证据无冲突，无阻断性开放问题。

## 七、当时建议顺序（已完成修复）

1. **优先保护用户意图和可见结果**：#801、#802。验收应落到最终持久化值和当前视图，而不只检查错误横幅或存储内部状态。
2. **收口直接原生交付与键盘路径**：#804、#803。分别补退出工作集合和焦点契约，不扩大到已取消的 VoiceOver/UI 自动化范围。
3. **恢复门禁输入保证与执行确定性**：#805、#809。分别处理覆盖率来源绑定和 TLS 夹具有界等待；优先选择简单、可证明的方案，不增加不可验证的自述元数据或固定 sleep。
4. **消除静态与文档盲区**：#806、#807、#808 可随同相关工程改动处理，保持单项 issue 的独立验收。
5. 上述建议对应的 #801–#809 已完成修复，提交对照见开头后续状态。新一轮开发以当前代码和 tracker 实际状态为准；本文评分仅供历史参考，不回填或伪造本轮历史评分。
