# PlotWeave 设计与实现质量评估

本文是对 PlotWeave 设计与实现质量的评估记录：给出分维度评分、综合评级与每条结论的证据。它不是工程门禁，不新增规范或契约。缺陷结论供排期参考；已有所有者决策的事项不因本记录而重新成为扣分项。

- **评估基线**：`dev` @ `3cf7146`（2026-10-18）。上一份记录基线为 `96fb373`（2026-10-13，9.1 / A），两者维度划分与口径不同，不作为本轮跟踪对比；其记录的 [#545](https://github.com/hailingu/PlotWeave/issues/545)–[#549](https://github.com/hailingu/PlotWeave/issues/549)、[#552](https://github.com/hailingu/PlotWeave/issues/552)、[#553](https://github.com/hailingu/PlotWeave/issues/553) 等扣分点已在本基线核实关闭。
- **评估性质**：只读审阅加 issue 建档。按前端/React、Rust/Tauri、Swift 原生、测试体系、工程门禁、文档治理、产品交互、安全八个方向并行审查，并直接复核关键扣分证据（剧情流接缝纯函数复现、Rust 删除/读取路径、原生失败生命周期、CI 门禁核验器、设置/模态/焦点路径、GitHub 分支保护 API）。本轮新建 issue [#589](https://github.com/hailingu/PlotWeave/issues/589)–[#603](https://github.com/hailingu/PlotWeave/issues/603) 共 15 个；关闭截图/UI 自动化类 [#550](https://github.com/hailingu/PlotWeave/issues/550)、[#571](https://github.com/hailingu/PlotWeave/issues/571)。
- **证据强度**：文件行数、测试数量、依赖与 `gh` 状态由本次直接核对；覆盖率数值取自最近一次门禁产物（前端 96.91%、Rust 85.34%）。本轮运行了 `npm run check:size`、`npm run typecheck:strict`、`npm run lint -- --max-warnings=0` 与完整 `npm test`；**没有**重跑 `cargo test`、`xcodebuild` 或 SonarQube，Rust/Swift 结论是代码路径核实，不是本机运行验证（详见第六节）。

**后续状态更新（2026-10-19，#593）**：[PR #624](https://github.com/hailingu/PlotWeave/pull/624)
已在实现中将 gate-evidence 的核验器与 Node 版本固定到事件 base SHA，head 只作为 Git 对象读取，
修复本评估记录的“仅替换 PR 核验器即可中和检查”路径；issue 在 PR 合并并验证后关闭。
工作流定义本身仍由 PR merge 提供，台账仍为无签名自述，未实施独立执行器或 required review；
详见[证据边界](development/quality-gate-evidence.md#server-side-evidence-verification-issue-548)。
下列数值和八项 P2 计数保留为 `3cf7146` 的历史评估，不作为修复后当前评分；本次只更新 #593 状态，未重算综合评级。

**后续状态更新（2026-10-19，#596）**：节点已有独立键盘焦点虚线外环，设定集/资产删除按钮在键盘聚焦及行内焦点时显现；对应条目、issue 表和待办状态随本修复同步，历史评分未重算。焦点样式验证与物理键盘/系统窗口验收的区别见 [UI 设计](ui-design.md#26-无障碍变体)。

**后续状态更新（2026-10-19，#597）**：完成响应已与在途 Task 分离，并加入 8 MiB 总计／1 MiB 单条编码字节预算；淘汰保留身份指纹和防重放，详情及测量边界见[桥合同](swiftui-react-flow-feature-parity.md#桥合同)。本次同步 #597 状态，历史评分未重算。

**后续状态更新（2026-10-19，#603）**：Web 首页项目菜单的键盘激活改为按钮边界锚点并聚焦首项，Escape 归还触发器；指针定位及项目动作保留。DOM 行为测试覆盖定位、切换项目、取消与重命名焦点，未验收物理键盘／系统窗口；历史评分未重算。

**后续状态更新（2026-10-19，#614）**：历史 `pw_request_submit` 的 completion 入口用 `Option<PwCompletion>` 表达可空 C 函数指针，NULL 在 ID 分配／登记／入队前返回 0；队列仍只保存有效回调。Rust ABI 回归覆盖 NULL completion、core/request 和非法 UTF-8，排空后验证唯一有效回执与无创建副作用。当前 Swift 原生工程仍不链接该 ABI；未做真实 C 宿主链接验收，历史评分未重算。

**后续状态更新（2026-10-19，#600）**：目标保存／删除与列表维护测试统一 typed IPC 夹具、使用受控时钟／命令到达和链静止边界；快捷键测试逐例 cleanup 并核验监听卸载。Rust 项目锁、凭据及真实 invoke 回归改为明确释放门闸，150–200 ms 不再作为通过阈值，长超时仅兜底死锁。故障注入验证仍能检测播种越过保存链和同步阻塞回归；对应条目同步，历史评分未重算。

## 一、评分口径

9 个维度、10 分制、等权。评级带：A+ 9.5–10.0、A 9.0–9.4、A- 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B- 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C- 5.5–5.9、D 4.0–5.4、E < 4.0。

扣分只计有真实证据、且在正常使用或已记录脏数据下可达的问题。下列事项不计扣分：

- 三栈并存与 Tauri/Swift 双份实现（[#518](https://github.com/hailingu/PlotWeave/issues/518) 已关闭的所有者决策）。
- 同用户替换 `projects/` 树、非 Unix 身份缺口、同用户恶意软件场景（仓库威胁模型已排除；[#520](https://github.com/hailingu/PlotWeave/issues/520) 为已登记边界）。
- 不支持 Windows 的平台选择本身；库/项目媒体等明确记录的平台能力缺失。
- 门禁不做快速通道、CI 不跑本机 Sonar 的既有执行约束（托管 runner 不可达本机服务）；但本轮新发现的门禁证据核验器信任边界单独计。
- [#468](https://github.com/hailingu/PlotWeave/issues/468) 的 80 行函数上限执行方式、[#522](https://github.com/hailingu/PlotWeave/issues/522) 的归一化层已登记断言、[#519](https://github.com/hailingu/PlotWeave/issues/519) 的 v0 时间排序边界。
- 已关闭或已登记的 issue（含 #544–#549、#552、#553、#568、#572–#575 等）；截图/UI 自动化类缺口（#550、#571 本轮已按所有者决定关闭）。

## 二、综合结果

| 维度 | 评分 | 评级 |
| --- | ---: | --- |
| 架构与模块设计 | 9.4 | A |
| 代码质量与类型安全 | 9.3 | A |
| 数据持久化与健壮性 | 8.5 | A- |
| 测试与验证 | 8.8 | A- |
| 工程基建与质量门禁 | 8.7 | A- |
| 文档与治理 | 8.8 | A- |
| 可维护性与一致性 | 9.0 | A- |
| 安全性 | 9.4 | A |
| 产品与交互设计 | 8.6 | A- |
| **综合** | **8.9** | **A-** |

等权计算：`(9.4 + 9.3 + 8.5 + 8.8 + 8.7 + 8.8 + 9.0 + 9.4 + 8.6) / 9 = 8.94`，按一位小数记为 **8.9 / A-**。

结论：工程基础设施、类型安全、持久化协议和安全边界接近 A+；但本轮在正常交互（大纲拖拽分叉/汇合、AI 输入、键盘菜单）、预期失败路径（画布加载失败、设置保存失败、文档弹窗）和门禁证据链（PR 可控核验器）上找到 **8 个 P2**。其中大纲丢边可复现、原生画布失败是不可恢复的使用死路；因此不能进入 A（9.0+）。无 P1。

## 三、分维度结论

### 3.1 架构与模块设计 — 9.4 / A

强项：模块边界由可执行测试强制。`src/moduleGraph.ts` 用 TypeScript AST 构建真实依赖图，`src/moduleGraph.test.ts` 断言无环、model 层对 React/xyflow 无运行时依赖、shell 不反向依赖 editor 运行时；`useEditorController` 只做接线，文档/面板/持久化/历史/视图/图动作/AI 各自 hook 化；Rust `plotweave-core` 零 Tauri 依赖；native 侧 `NativeHostServices` 通过命令白名单分发，React 保留唯一可写编辑会话。

扣分：

- **P2** 原生画布失败后重试、关闭与退出路径均不可达：`.failed` → `invalidate` 清空 coordinator/route → `loading` 被当欢迎页 → 真实窗口 `alphaValue=0`/`ignoresMouseEvents=true`；重试按钮在被隐藏的窗口内，欢迎卡无重试入口；无 listener 时关闭/⌘Q 被静默取消。详见 [#590](https://github.com/hailingu/PlotWeave/issues/590)。
- **P3** `NativeExportView` 绕过 `HostCommandRouter` 直接调用 `services.perform`，系统命令不受会话校验/指纹去重/退役语义约束（与 [#598](https://github.com/hailingu/PlotWeave/issues/598) 的导出默认值问题相邻但不同）。

### 3.2 代码质量与类型安全 — 9.3 / A

强项：生产代码未发现 `any`/`@ts-ignore`；13 处 `@ts-expect-error` 均在负向类型测试。`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 进门禁；AI 命令为显式判别联合 + 穷尽 switch + `never` 守卫，宽化收口在 `nodes/patch.ts` 的受控出口。Swift 无 `try!`/`as!`/`fatalError`；Rust `clippy --all-targets -- -D warnings` 覆盖测试 target。

扣分：

- **P2** 设置防抖保存失败只 `console.warn` 并回填待存快照，设置页只展示 load/close 错误；用户会误以为设置已保存，直到关闭/退出才暴露（[#594](https://github.com/hailingu/PlotWeave/issues/594)）。
- **已修复（原 P3）** [#615](https://github.com/hailingu/PlotWeave/issues/615)：删除无生产消费者的 `ShellStage` 及两个自证常量测试；显式演示夹具改用当前用途说明，实际业务能力继续由现有状态/服务与行为测试体现。
- **P3** 约 18 处非空断言、203 处 `as` 仍属存量债务；多个 600–775 行文件超过评审阈值但在 800 行硬上限内。

### 3.3 数据持久化与健壮性 — 8.5 / A-

强项：原子写四件套完整（`O_EXCL` 随机临时名、write+fsync、rename 前复核、父目录 fsync）；`library_journal` 有删除事务、隔离区身份复核、崩溃恢复与故障注入；cap-std 受信句柄 + no-follow + `(dev, ino)` 身份绑定贯穿读取；前端保存链有单飞、代次重试、删除墓碑、卸载补交与退出冲刷。

扣分：

- **P2** `planSpliceIntoSpine` 在分叉/汇合图上删除节点的全部关联 sequence 边：`mine` 包含全部关联边并全部删除，而 `uniquePredecessor/uniqueSuccessor` 在多入/多出时返回 null，`adds` 只补一条。纯函数复现：`A→X, X→B, X→C` 拖 X 到 A 之后 → `removes=[a,b,c], adds=[A→X]`；汇合同理。`useOutlineDrop` 无危险预览且 600ms 后自动落盘，只能 ⌘Z 恢复（[#589](https://github.com/hailingu/PlotWeave/issues/589)）。
- **P2** `delete_project_files` 删除资产目录与 JSON 后没有 `projects/` 目录 fsync，写路径已有该屏障；崩溃/断电可能留下 JSON 已删但资产已落盘的孤儿目录，或资产已删但 JSON 保留的媒体全丢项目（[#591](https://github.com/hailingu/PlotWeave/issues/591)）。
- **P2** `read_verified_file` 用 `read_to_string` 无字节上限，`list_project_metas` 在全局 `projects_op_lock` 内逐个全量读取/解析；单个异常膨胀/损坏项目 JSON 可无界分配并阻塞保存/删除。库索引与设置都有 1 MiB 限读（[#592](https://github.com/hailingu/PlotWeave/issues/592)）。
- **已修复（原 P3）** [#597](https://github.com/hailingu/PlotWeave/issues/597)：完成 Task 不再驻留，回执有默认 8 MiB 总预算／1 MiB 单条上限，超限及淘汰后仅保留身份摘要，重复不重执行。在途响应及临时编码内存不计入该预算，未以此声明进程 RSS 上限。

### 3.4 测试与验证 — 8.8 / A-

强项：233 个 Vitest 文件 / 3,250 用例、539 个 Rust `#[test]`、287 个 Swift `@Test`；前端 96.91%、Rust 85.34% 行覆盖；0 skip、0 snapshot、0 `.only`、0 `#[ignore]`。Rust 用真实文件系统/Wry 子进程，Swift 用真实 WKWebView/AppKit 宿主，IPC 命令表与 `generate_handler!` 双向一致，CSS/TSX 守卫用 PostCSS/TS AST。

扣分：

- **已修复（原 P3）** [#601](https://github.com/hailingu/PlotWeave/issues/601)：日常原生入口显式启用覆盖率，导出 App 逐文件计数、缺报清单及 CI 摘要/产物；默认先报告，显式下限按未舍入计数且要求完整清单。2026-10-19 基线为 7372/9427 行（78.20%）、69/70 文件，`ShellStage.swift` 缺报（该死类型及自证测试随后由 #615 移除，现行报告清单为 69/69）；不把缺报伪装为 0/0，不以测试 target 提高数值。前端/Rust 80% 下限不变；[口径与边界](development/native-coverage.md)。
- **已修复（原 P3）** [#600](https://github.com/hailingu/PlotWeave/issues/600)：目标保存／删除测试以受控 Promise、时钟和链静止边界替代真实 sleep；Tauri 测试共用 `ipc/invoke` 夹具，快捷键测试逐例 cleanup 并核验监听归零。Rust 三类响应性回归以门闸持有期间的兄弟任务／心跳推进判定，时间仅观察；不声称全仓库已消除真实延迟。
- **已修复（原 P3）** [#616](https://github.com/hailingu/PlotWeave/issues/616)：前端 nativeCanvas 每个生产 TS/TSX 文件独立要求 80% 行覆盖，全局 80% 保留；新文件自动纳入，无新增低覆盖豁免或产品排除。真实 V8 已复现全局 96.95% 时四个低覆盖文件分别失败，并补生产入口、命令/错误和撤销行为测试。其他目录仍只有全局下限；CI 普通测试核验策略配置，实际覆盖率由本地必需门禁执行。

### 3.5 工程基建与质量门禁 — 8.7 / A-

强项：四个版本化钩子 fail-closed；`pre-push` 按 stdin ref 逐唯一提交分派，非 HEAD/脏树进入临时 worktree 并按被推树锁文件 `npm ci`；`GIT_NO_REPLACE_OBJECTS=1`；gate-history 记录 tree/head/QualityGate/覆盖率；GitHub API 实测四项 required checks、`enforce_admins=true`、force push/删除禁用；Node/Rust/Xcode 钉版，`cargo audit` 阻断漏洞级 advisory，Dependabot 周粒度分组到 dev。

扣分：

- **已修复（原 P2）** [#593](https://github.com/hailingu/PlotWeave/issues/593)：[PR #624](https://github.com/hailingu/PlotWeave/pull/624) 固定检出事件 base SHA，从 base 读取 `.nvmrc` 与 `scripts/verify-gate-evidence.ts`，只获取 head 对象并按精确 SHA 核验 head 台账；替换 PR 中的核验器不再改变判定。原 tip-lag 语义未变。**保留边界**：工作流定义仍由 PR merge 提供，作者若同时改写 workflow 仍能改变检查；没有新增 approving review 要求、保护规则或独立执行器，台账仍不是本地门禁真实执行的独立证明。
- **已修复（原 P3）** [#618](https://github.com/hailingu/PlotWeave/issues/618)：npm high/critical 与执行错误现在阻断 frontend；cargo-audit 固定版本，CI Actions 固定已验证的完整上游 SHA。隔离 high lockfile 实际退出 1，当前真实 npm 与双 Cargo 审计均无漏洞；informational 仍沿用既有策略，未新增 ignore 或改项目锁文件。Runner/advisory 数据仍动态更新，不声称整套 CI 位元级复现。原「CI 重复执行 scripts 套件」由 [#617](https://github.com/hailingu/PlotWeave/issues/617) 修复。

### 3.6 文档与治理 — 8.8 / A-

强项：`docs/` 约 11k 行，数据模型按主题拆分；UI 规格含状态矩阵、令牌契约、无障碍与验收边界；AGENTS.md 对分支/提交/门禁/审查轮次有可执行规则；门禁证据文档诚实记录 tip-lag 与“自述证据不是独立证明”；CSS 令牌契约明确支持/拒绝/保留边界。

扣分：

- **P3** `workflow.md` 第 89 行称“不断言 branch protection 已配置”，同一文件第 95 行又称已启用；AGENTS.md 与 API 均证实已启用。入口文档否定实际强制策略（[#602](https://github.com/hailingu/PlotWeave/issues/602)）。
- **P3** `README.md`、`workflow.md`、`file-size-guard.md` 仍把当前原生实现挂在已不存在的 `codex/swiftui-react-flow` 分支；远端只有 `dev`/`main`（并入 [#602](https://github.com/hailingu/PlotWeave/issues/602)）。
- **P3** `vite.config.ts` 注释仍写 98.13% 覆盖率基线，门禁实际 96.91%；不单独开单。

### 3.7 可维护性与一致性 — 9.0 / A-

强项：命名一致；800/1800 行上限由 `check:size` 强制执行，当前 744 个维护文件、64 个排除项、无祖父豁免；运行时依赖仅 4 个；重复度政策与共享夹具实际收敛；`check:workspace-drift` 防双 Cargo workspace 漂移，`plotweave-core::lock` 成为单一来源。

扣分：

- **P3** `sheetTokensEngine.ts` 775 行 + 约 4k 行守卫代码，维护成本高但确实抓到了真实令牌/对比度问题，记为取舍；最大测试文件 1,775/1,800 行，后续拆分压力大。

### 3.8 安全性 — 9.4 / A

强项：API key 封装 PBKDF2 600k + AES-256-GCM + provider AAD、迭代数上界、机器标识不可用硬失败；桥接有版本化信封、主框架+精确入口 URL 双重信任、规范化指纹去重、4096 容量窗口与退役防重放；图像下载逐跳 DNS + 公网 IPv4/IPv6 分类 + 重定向复验；HTTP 错误脱敏、Bearer 跨源剥离；cap-std + no-follow + 身份绑定。无现实可利用漏洞。

扣分：

- **已修复（原 P3）** [#614](https://github.com/hailingu/PlotWeave/issues/614)：`pw_request_submit` 用可空入口类型并在入队前拒绝 NULL completion，返回 0 且不消耗 ID、不派发或产生回调；core/request NULL 行为保留。该 ABI 仍不在当前原生工程链接。
- **P3** `WebCanvasHostView.pushAppearance` 用字符串插值拼 JS（内容来自 JSONEncoder，实际安全），与同文件 `dispatchEvent` 的 `arguments:` 严格度不一致；防御纵深一致性口子，非现实漏洞。

### 3.9 产品与交互设计 — 8.6 / A-

强项：三层设计令牌 + 8 个偏好环境；选中卡“1pt 边框 + 1pt 外轮廓”保持尺寸；对齐/吸附/键盘移动/整段拖拽一步撤销/导出焦点陷阱/分隔条键盘调宽有真实状态矩阵；错误、加载、空态大多分开；原生首页有 `ProgressView`、空态与恢复按钮；导出弹窗是真正的键盘模态。

扣分：

- **已修复（原 P2）** [#596](https://github.com/hailingu/PlotWeave/issues/596)：节点包装层的 focus-visible 虚线外环与卡片选中框并存；设定集/资产行 focus-within 显示删除按钮，按钮 focus-visible 立即可见并有轮廓。原键盘命令与保存入口未变，测试边界见文首更新。
- **P2** 设定文档弹窗缺少模态契约：只有 `<dialog open aria-label>`，没有 `aria-modal`/焦点移入/圈定；`useAppSettingsShortcut` 只按 `aria-modal` 挂起，编辑长文档时 ⌘, 打开设置会卸载编辑器并丢失草稿（[#595](https://github.com/hailingu/PlotWeave/issues/595)）。
- **P3** Web/Tauri AI 输入行没有发送按钮，只能按 Enter；原生有显式发送（[#599](https://github.com/hailingu/PlotWeave/issues/599)）。
- **P3** 首页首次加载空列表显示“没有匹配「」”，与“加载完前不显示空状态”的注释相反。**已修复（原 P3）** [#603](https://github.com/hailingu/PlotWeave/issues/603)：键盘项目菜单以触发按钮定位并聚焦首项，Escape 返回；指针路径保留。
- **P3** 原生导出默认 `outline = true`，Web/设计规格默认关闭，同一项目两壳默认输出不同（[#598](https://github.com/hailingu/PlotWeave/issues/598)）；编辑器没有“保存中/已保存”的正向状态，只有失败横幅。

## 四、本轮 issue

| Issue | 维度 | 严重度 | 摘要 |
| --- | --- | --- | --- |
| [#589](https://github.com/hailingu/PlotWeave/issues/589) | 3.3 | P2 | 大纲拖拽在分叉/汇合剧情流上删除全部关联 sequence 边 |
| [#590](https://github.com/hailingu/PlotWeave/issues/590) | 3.1 | P2 | 画布加载失败后重试、关闭与退出路径均不可达 |
| [#591](https://github.com/hailingu/PlotWeave/issues/591) | 3.3 | P2 | 删除项目缺少 projects 目录持久性屏障 |
| [#592](https://github.com/hailingu/PlotWeave/issues/592) | 3.3 | P2 | 项目控制文件读取无字节上限且列表在全局锁内全量解析 |
| [#593](https://github.com/hailingu/PlotWeave/issues/593) | 3.5 | 原 P2，已修复 | PR #624 固定 base 核验器；workflow-definition 与自述证据边界保留，合并后关闭 |
| [#594](https://github.com/hailingu/PlotWeave/issues/594) | 3.2 | P2 | 设置防抖保存失败没有用户可见诊断 |
| [#595](https://github.com/hailingu/PlotWeave/issues/595) | 3.9 | P2 | 设定文档弹窗缺少模态契约，⌘, 可丢失未保存草稿 |
| [#596](https://github.com/hailingu/PlotWeave/issues/596) | 3.9 | 原 P2，已修复 | 节点独立焦点环与侧栏删除按钮焦点显现，合并后关闭 |
| [#597](https://github.com/hailingu/PlotWeave/issues/597) | 3.3 | 原 P3，已修复 | 完成响应字节预算与摘要退役；合并后关闭 |
| [#598](https://github.com/hailingu/PlotWeave/issues/598) | 3.9 | P3 | 原生导出默认开启创作大纲，与 Web/设计规格不一致 |
| [#599](https://github.com/hailingu/PlotWeave/issues/599) | 3.9 | P3 | Web/Tauri AI 输入行缺少发送按钮 |
| [#600](https://github.com/hailingu/PlotWeave/issues/600) | 3.4 | 已修复（原 P3） | 受控交错、共享 IPC 夹具与监听清理 |
| [#601](https://github.com/hailingu/PlotWeave/issues/601) | 3.4 | 已修复（原 P3） | Swift App 覆盖率报告、缺报清单及显式可选下限 |
| [#602](https://github.com/hailingu/PlotWeave/issues/602) | 3.6 | P3 | workflow/README 分支保护与原生分支描述不一致 |
| [#603](https://github.com/hailingu/PlotWeave/issues/603) | 3.9 | 已修复（原 P3） | 键盘菜单按钮锚点、首项聚焦与 Escape 归还 |

已关闭：[#550](https://github.com/hailingu/PlotWeave/issues/550)（SwiftUI 视图层截图/UI 自动化回归）、[#571](https://github.com/hailingu/PlotWeave/issues/571)（视觉目验/截图录屏）按所有者决定标记 `known-boundary` + not planned；不表示相应验收已通过。保留 [#570](https://github.com/hailingu/PlotWeave/issues/570)（中文输入法真机组合输入，人工 IME 验证）与 [#551](https://github.com/hailingu/PlotWeave/issues/551)（Tauri 全链路 E2E，不依赖截图），因为它们不属于“需要截图才能进行”的 UI 自动化。

## 五、结论与修复优先级

**历史基线综合 8.9 / 10，A-**（A- 上沿；#593 后续修复状态见文首，未重新评分）。A 档要求所有维度至少 9.0 且无正常路径 P2；本轮 8 个 P2 中，大纲丢边是可复现的数据丢失、原生画布失败是不可恢复的使用死路，因此不能进入 A。无 P1。

修复优先级：

1. 剧情流接缝对 fan-out/merge 明确拒绝或保留多入/多出边；补真实大纲拖拽回归（#589）。
2. 原生失败恢复：失败时保留 coordinator/route 或让欢迎卡暴露重试；无 listener 的关闭/退出走可见降级（#590）。
3. Rust 删除目录 fsync；项目控制文件限读并避免在全局锁内全量解析（#591、#592）。
4. **已完成 #593 实现修复（PR #624）**：核验器与 Node 版本取事件 base SHA，PR head 仅为 Git 数据；不再作为待修复项。工作流定义的外部强制保护/required review 尚未实施，需单独的所有者治理决定，不包含在本次已修复承诺中。
5. 设置错误可见、文档弹窗模态（#594–#595）；**本变更已完成 #596** 的画布/侧栏焦点样式。
6. P3：原生导出默认、AI 发送、文档一致性（#598、#599、#602）；**已完成 #597** 的桥接完成响应预算，以及 **#603** 的首页菜单键盘入口、**#600** 的目标测试确定性、**#601** 的 Swift 覆盖率报告、**#616** 的前端 nativeCanvas 逐文件下限。

预计修复上述 P2 后可回到 **9.2–9.3 / A**；若只按已知 issue 口径（不含本轮新发现），项目接近 9.1/A。

## 六、验证记录

已运行（仓库根，Node 24.18.0）：

- `npm run check:size`：`SIZE_CHECK_COMPLETE checked=744 excluded=64 passed=true`。
- `npm run typecheck:strict`：exit 0。
- `npm run lint -- --max-warnings=0`：exit 0。
- `npm test`：233 文件 / 3,250 用例，3,233 通过；17 项失败集中在 `scripts/gate-tree-marker.test.ts`、`scripts/pre-push-refs.test.ts`、`scripts/sonar-quality-gate.test.ts`，根因是沙箱 `spawnSync ps EPERM`（进程身份/监督夹具），不是产品代码失败；其余 230 个文件通过。
- 用 `tsx` 直接调用 `planSpliceIntoSpine` 复现 fan-out/merge 丢边；`gh api` 核实分支保护与远端分支。

未运行：`cargo test`/`cargo clippy`、`xcodebuild test`、SonarQube 扫描。覆盖率引用最近门禁产物（前端 96.91%、Rust 85.34%）；最后记录 head 为 `ff0aa8a`，当前 tip `3cf7146` 按设计存在 tip-lag。Rust/Swift 结论是代码路径核实，不是本机运行验证；`npm test` 的 17 项沙箱失败也不代表托管 CI 失败。评估未修改仓库文件；本文与门禁改动随任务分支单独提交。

> 后续变更注记（2026-10-18）：本分支同时按所有者指示引入
> `pre-push` 的 docs-only / 单实现栈范围分流（commit-creating 钩子仍为
> 完整统一门禁）。那是推送门禁策略变更，不改变本文对 `3cf7146` 代码的
> 评分；策略与边界见[推送门禁](development/quality-gate-push.md#scoped-push-routing-2026-10-18)
> 与[成本决策](development/quality-gate-cost.md#scoped-push-cost-2026-10-18-owner-direction)。
