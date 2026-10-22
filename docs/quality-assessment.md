# PlotWeave 设计与实现质量评估

本文是对 PlotWeave 设计与实现质量的评估记录：给出分维度评分、综合评级与每条结论的证据。它不是工程门禁，不新增规范或契约。缺陷结论供排期参考；已有所有者决策的事项不因本记录而重新成为扣分项。

**当前基线追加评估（2026-10-21）**：`dev` @ `05c9df40` 的当前复核见第七节，当前综合为 **9.2 / A**；第三节至第六节保留 `3cf7146` 历史记录，不随第七节重写或回填。

- **评估基线**：`dev` @ `3cf7146`（2026-10-18）。上一份记录基线为 `96fb373`（2026-10-13，9.1 / A），两者维度划分与口径不同，不作为本轮跟踪对比；其记录的 [#545](https://github.com/hailingu/PlotWeave/issues/545)–[#549](https://github.com/hailingu/PlotWeave/issues/549)、[#552](https://github.com/hailingu/PlotWeave/issues/552)、[#553](https://github.com/hailingu/PlotWeave/issues/553) 等扣分点已在本基线核实关闭。
- **评估性质**：只读审阅加 issue 建档。按前端/React、Rust/Tauri、Swift 原生、测试体系、工程门禁、文档治理、产品交互、安全八个方向并行审查，并直接复核关键扣分证据（剧情流接缝纯函数复现、Rust 删除/读取路径、原生失败生命周期、CI 门禁核验器、设置/模态/焦点路径、GitHub 分支保护 API）。本轮新建 issue [#589](https://github.com/hailingu/PlotWeave/issues/589)–[#603](https://github.com/hailingu/PlotWeave/issues/603) 共 15 个；关闭截图/UI 自动化类 [#550](https://github.com/hailingu/PlotWeave/issues/550)、[#571](https://github.com/hailingu/PlotWeave/issues/571)。
- **证据强度**：文件行数、测试数量、依赖与 `gh` 状态由本次直接核对；覆盖率数值取自最近一次门禁产物（前端 96.91%、Rust 85.34%）。本轮运行了 `npm run check:size`、`npm run typecheck:strict`、`npm run lint -- --max-warnings=0` 与完整 `npm test`；**没有**重跑 `cargo test`、`xcodebuild` 或 SonarQube，Rust/Swift 结论是代码路径核实，不是本机运行验证（详见第六节）。

**后续状态更新（2026-10-19，#593）**：[PR #624](https://github.com/hailingu/PlotWeave/pull/624)
已在实现中将 gate-evidence 的核验器与 Node 版本固定到事件 base SHA，head 只作为 Git 对象读取，
修复本评估记录的“仅替换 PR 核验器即可中和检查”路径；issue 在 PR 合并并验证后关闭。
工作流定义本身仍由 PR merge 提供，台账仍为无签名自述，未实施独立执行器或 required review；
详见[证据边界](development/quality-gate-evidence.md#server-side-evidence-verification-issue-548)。
下列数值和八项 P2 计数保留为 `3cf7146` 的历史评估，不作为修复后当前评分；该次只更新 #593 状态，未重算综合评级。

**后续状态更新（2026-10-19，#596）**：节点已有独立键盘焦点虚线外环，设定集/资产删除按钮在键盘聚焦及行内焦点时显现；对应条目、issue 表和待办状态随本修复同步，历史评分未重算。焦点样式验证与物理键盘/系统窗口验收的区别见 [UI 设计](ui-design.md#26-无障碍变体)。

**后续状态更新（2026-10-19，#597）**：完成响应已与在途 Task 分离，并加入 8 MiB 总计／1 MiB 单条编码字节预算；淘汰保留身份指纹和防重放，详情及测量边界见[桥合同](swiftui-react-flow-feature-parity.md#桥合同)。本次同步 #597 状态，历史评分未重算。

**后续状态更新（2026-10-19，#603）**：Web 首页项目菜单的键盘激活改为按钮边界锚点并聚焦首项，Escape 归还触发器；指针定位及项目动作保留。DOM 行为测试覆盖定位、切换项目、取消与重命名焦点，未验收物理键盘／系统窗口；历史评分未重算。

**后续状态更新（2026-10-19，#614）**：历史 `pw_request_submit` 的 completion 入口用 `Option<PwCompletion>` 表达可空 C 函数指针，NULL 在 ID 分配／登记／入队前返回 0；队列仍只保存有效回调。Rust ABI 回归覆盖 NULL completion、core/request 和非法 UTF-8，排空后验证唯一有效回执与无创建副作用。当前 Swift 原生工程仍不链接该 ABI；未做真实 C 宿主链接验收，历史评分未重算。

**后续状态更新（2026-10-19，#600）**：目标保存／删除与列表维护测试统一 typed IPC 夹具、使用受控时钟／命令到达和链静止边界；快捷键测试逐例 cleanup 并核验监听卸载。Rust 项目锁、凭据及真实 invoke 回归改为明确释放门闸，150–200 ms 不再作为通过阈值，长超时仅兜底死锁。故障注入验证仍能检测播种越过保存链和同步阻塞回归；对应条目同步，历史评分未重算。

**后续状态更新（2026-10-20，#632）**：[PR #670](https://github.com/hailingu/PlotWeave/pull/670) 已移除覆盖率配置注释与 TypeScript 标准中会过期的实测基线，改为引用所评估运行的 LCOV 报告和自报台账摘要，并保留台账的证据边界。对应扣分条目同步标记为已修复；本次不改变 80% 下限，也不重算历史评分。

**后续状态更新（2026-10-21，#683）**：以 `dev` @ `f613f9f` 核对 tracker 与修复提交，#589–#603 的 15 个原始条目均已关闭（completed）。原 8 项 P2（#589–#596）已修复 8 项，尚未关闭 0 项；此计数只覆盖本评估原始清单。下文补齐遗漏的 #589、#590、#591、#592、#594，并同步 #595 与同表 #598、#599、#602 的关闭状态、修复依据和建议。`3cf7146` 的评分、测试数及“8 个 P2”保留为历史事实，本次不重新评分；当前项目风险以 tracker 为准。

## 一、评分口径

9 个维度、10 分制、等权。评级带：A+ 9.5–10.0、A 9.0–9.4、A- 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B- 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C- 5.5–5.9、D 4.0–5.4、E < 4.0。

扣分只计有真实证据、且在正常使用或已记录脏数据下可达的问题。下列事项不计扣分：

- 三栈并存与 Tauri/Swift 双份实现（[#518](https://github.com/hailingu/PlotWeave/issues/518) 已关闭的所有者决策）。
- 同用户替换 `projects/` 树、非 Unix 身份缺口、同用户恶意软件场景（仓库威胁模型已排除；[#520](https://github.com/hailingu/PlotWeave/issues/520) 为已登记边界）。
- 不支持 Windows 的平台选择本身；库/项目媒体等明确记录的平台能力缺失。
- 门禁不做快速通道、CI 不跑本机 Sonar 的既有执行约束（托管 runner 不可达本机服务）；但本轮新发现的门禁证据核验器信任边界单独计。
- [#468](https://github.com/hailingu/PlotWeave/issues/468) 的 80 行函数上限执行方式、[#522](https://github.com/hailingu/PlotWeave/issues/522) 的归一化层已登记断言、[#519](https://github.com/hailingu/PlotWeave/issues/519) 的 v0 时间排序边界。
- 已关闭或已登记的 issue（含 #544–#549、#552、#553、#568、#572–#575 等）；截图/UI 自动化类缺口（#550、#571 本轮已按所有者决定关闭）。

## 二、综合结果（历史基线）

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

历史结论（`3cf7146`）：当时在正常交互、预期失败路径和门禁证据链上发现 **8 个 P2**，其中包括可复现的大纲丢边与原生画布失败死路，因此当时综合为 8.9 / A-，无 P1。2026-10-21 状态核对时，这 8 项已全部修复并关闭，原清单尚未关闭 P2 为 **0**；历史评分保留，当前综合评级未重算。

## 三、分维度结论（历史评分与后续状态）

### 3.1 架构与模块设计 — 9.4 / A

强项：模块边界由可执行测试强制。`src/moduleGraph.ts` 用 TypeScript AST 构建真实依赖图，`src/moduleGraph.test.ts` 断言无环、model 层对 React/xyflow 无运行时依赖、shell 不反向依赖 editor 运行时；`useEditorController` 只做接线，文档/面板/持久化/历史/视图/图动作/AI 各自 hook 化；Rust `plotweave-core` 零 Tauri 依赖；native 侧 `NativeHostServices` 通过命令白名单分发，React 保留唯一可写编辑会话。

基线发现及后续状态：

- **已修复（原 P2）** [#590](https://github.com/hailingu/PlotWeave/issues/590)：基线中画布失败后重试、关闭与退出不可达；现保留失败恢复入口并提供无 listener 时可见的退出降级。修复起点 [`a5afdf0a`](https://github.com/hailingu/PlotWeave/commit/a5afdf0a2604427c25107eb72830ca94f2cfd7cd)，后续评审修复已随该任务合入，issue 已关闭。
- **P3** `NativeExportView` 绕过 `HostCommandRouter` 直接调用 `services.perform`，系统命令不受会话校验/指纹去重/退役语义约束（基线中未单独建档的观察，与已修复的导出默认值问题范围不同）。

### 3.2 代码质量与类型安全 — 9.3 / A

强项：生产代码未发现 `any`/`@ts-ignore`；13 处 `@ts-expect-error` 均在负向类型测试。`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` 进门禁；AI 命令为显式判别联合 + 穷尽 switch + `never` 守卫，宽化收口在 `nodes/patch.ts` 的受控出口。Swift 无 `try!`/`as!`/`fatalError`；Rust `clippy --all-targets -- -D warnings` 覆盖测试 target。

基线发现及后续状态：

- **已修复（原 P2）** [#594](https://github.com/hailingu/PlotWeave/issues/594)：设置防抖保存失败已有用户可见诊断与重试反馈；修复 [PR #622](https://github.com/hailingu/PlotWeave/pull/622) 已合入（[`acd27eb7`](https://github.com/hailingu/PlotWeave/commit/acd27eb75fe76a3079caeaf35248a0853c1a08b9)），issue 已关闭。
- **已修复（原 P3）** [#615](https://github.com/hailingu/PlotWeave/issues/615)：删除无生产消费者的 `ShellStage` 及两个自证常量测试；显式演示夹具改用当前用途说明，实际业务能力继续由现有状态/服务与行为测试体现。
- **P3** 约 18 处非空断言、203 处 `as` 仍属存量债务；多个 600–775 行文件超过评审阈值但在 800 行硬上限内。

### 3.3 数据持久化与健壮性 — 8.5 / A-

强项：原子写四件套完整（`O_EXCL` 随机临时名、write+fsync、rename 前复核、父目录 fsync）；`library_journal` 有删除事务、隔离区身份复核、崩溃恢复与故障注入；cap-std 受信句柄 + no-follow + `(dev, ino)` 身份绑定贯穿读取；前端保存链有单飞、代次重试、删除墓碑、卸载补交与退出冲刷。

基线发现及后续状态：

- **已修复（原 P2）** [#589](https://github.com/hailingu/PlotWeave/issues/589)：基线的分叉／汇合重排会丢失关联 sequence 边；现明确拒绝这些危险重排并保留原图，已有对应大纲重排回归。修复 [`d60b747d`](https://github.com/hailingu/PlotWeave/commit/d60b747dec15ac087bf664100df8d84ad10572ac)，issue 已关闭。
- **已修复（原 P2）** [#591](https://github.com/hailingu/PlotWeave/issues/591)：项目删除已补 `projects/` 目录持久性屏障，修复 [`1f35363b`](https://github.com/hailingu/PlotWeave/commit/1f35363b67d1e469d340afa0426b3436767769ba)，issue 已关闭。
- **已修复（原 P2）** [#592](https://github.com/hailingu/PlotWeave/issues/592)：项目控制文件已有字节上限及对应读写回归，列表读取路径已有有界处理；修复 [`24b979db`](https://github.com/hailingu/PlotWeave/commit/24b979db7109e83af5148de2c0e49f9119c4f818)，issue 已关闭。
- **已修复（原 P3）** [#597](https://github.com/hailingu/PlotWeave/issues/597)：完成 Task 不再驻留，回执有默认 8 MiB 总预算／1 MiB 单条上限，超限及淘汰后仅保留身份摘要，重复不重执行。在途响应及临时编码内存不计入该预算，未以此声明进程 RSS 上限。

### 3.4 测试与验证 — 8.8 / A-

强项：233 个 Vitest 文件 / 3,250 用例、539 个 Rust `#[test]`、287 个 Swift `@Test`；前端 96.91%、Rust 85.34% 行覆盖；0 skip、0 snapshot、0 `.only`、0 `#[ignore]`。Rust 用真实文件系统/Wry 子进程，Swift 用真实 WKWebView/AppKit 宿主，IPC 命令表与 `generate_handler!` 双向一致，CSS/TSX 守卫用 PostCSS/TS AST。

基线发现及后续状态：

- **已修复（原 P3）** [#601](https://github.com/hailingu/PlotWeave/issues/601)：日常原生入口显式启用覆盖率，导出 App 逐文件计数、缺报清单及 CI 摘要/产物；默认先报告，显式下限按未舍入计数且要求完整清单。2026-10-19 基线为 7372/9427 行（78.20%）、69/70 文件，`ShellStage.swift` 缺报（该死类型及自证测试随后由 #615 移除，该次报告清单为 69/69）；不把缺报伪装为 0/0，不以测试 target 提高数值。前端/Rust 80% 下限不变；[口径与边界](development/native-coverage.md)。
- **已修复（原 P3）** [#600](https://github.com/hailingu/PlotWeave/issues/600)：目标保存／删除测试以受控 Promise、时钟和链静止边界替代真实 sleep；Tauri 测试共用 `ipc/invoke` 夹具，快捷键测试逐例 cleanup 并核验监听归零。Rust 三类响应性回归以门闸持有期间的兄弟任务／心跳推进判定，时间仅观察；不声称全仓库已消除真实延迟。
- **已修复（原 P3）** [#616](https://github.com/hailingu/PlotWeave/issues/616)：前端 nativeCanvas 每个生产 TS/TSX 文件独立要求 80% 行覆盖，全局 80% 保留；新文件自动纳入，无新增低覆盖豁免或产品排除。真实 V8 已复现全局 96.95% 时四个低覆盖文件分别失败，并补生产入口、命令/错误和撤销行为测试。其他目录仍只有全局下限；CI 普通测试核验策略配置，实际覆盖率由本地必需门禁执行。

### 3.5 工程基建与质量门禁 — 8.7 / A-

强项：四个版本化钩子 fail-closed；`pre-push` 按 stdin ref 逐唯一提交分派，非 HEAD/脏树进入临时 worktree 并按被推树锁文件 `npm ci`；`GIT_NO_REPLACE_OBJECTS=1`；gate-history 记录 tree/head/QualityGate/覆盖率；GitHub API 实测四项 required checks、`enforce_admins=true`、force push/删除禁用；Node/Rust/Xcode 钉版，`cargo audit` 阻断漏洞级 advisory，Dependabot 周粒度分组到 dev。

基线发现及后续状态：

- **已修复（原 P2）** [#593](https://github.com/hailingu/PlotWeave/issues/593)：[PR #624](https://github.com/hailingu/PlotWeave/pull/624) 固定检出事件 base SHA，从 base 读取 `.nvmrc` 与 `scripts/verify-gate-evidence.ts`，只获取 head 对象并按精确 SHA 核验 head 台账；替换 PR 中的核验器不再改变判定。原 tip-lag 语义未变。**保留边界**：工作流定义仍由 PR merge 提供，作者若同时改写 workflow 仍能改变检查；没有新增 approving review 要求、保护规则或独立执行器，台账仍不是本地门禁真实执行的独立证明。
- **已修复（原 P3）** [#618](https://github.com/hailingu/PlotWeave/issues/618)：npm high/critical 与执行错误现在阻断 frontend；cargo-audit 固定版本，CI Actions 固定已验证的完整上游 SHA。隔离 high lockfile 实际退出 1，当前真实 npm 与双 Cargo 审计均无漏洞；informational 仍沿用既有策略，未新增 ignore 或改项目锁文件。Runner/advisory 数据仍动态更新，不声称整套 CI 位元级复现。原「CI 重复执行 scripts 套件」由 [#617](https://github.com/hailingu/PlotWeave/issues/617) 修复。

### 3.6 文档与治理 — 8.8 / A-

强项：`docs/` 约 11k 行，数据模型按主题拆分；UI 规格含状态矩阵、令牌契约、无障碍与验收边界；AGENTS.md 对分支/提交/门禁/审查轮次有可执行规则；门禁证据文档诚实记录 tip-lag 与“自述证据不是独立证明”；CSS 令牌契约明确支持/拒绝/保留边界。

基线发现及后续状态：

- **已修复（原 P3）** [#602](https://github.com/hailingu/PlotWeave/issues/602)：workflow 的分支保护描述已对齐已启用策略；README、workflow、file-size-guard 的当前原生实现入口指向 dev，旧分支按历史记录标注。修复 [`a7a2abe0`](https://github.com/hailingu/PlotWeave/commit/a7a2abe05ad05b7d3f7647f3c7b10605d883de66)，issue 已关闭。
- **已修复（原 P3）** [#632](https://github.com/hailingu/PlotWeave/issues/632)：`vite.config.ts` 注释与 TypeScript 标准不再写死实测基线，改为引用对应运行的 LCOV 报告、台账摘要及核验边界；80% 下限保持，历史评分未重算（[PR #670](https://github.com/hailingu/PlotWeave/pull/670)）。

### 3.7 可维护性与一致性 — 9.0 / A-

强项：命名一致；800/1800 行上限由 `check:size` 强制执行，当前 744 个维护文件、64 个排除项、无祖父豁免；运行时依赖仅 4 个；重复度政策与共享夹具实际收敛；`check:workspace-drift` 防双 Cargo workspace 漂移，`plotweave-core::lock` 成为单一来源。

基线发现及后续状态：

- **P3** `sheetTokensEngine.ts` 775 行 + 约 4k 行守卫代码，维护成本高但确实抓到了真实令牌/对比度问题，记为取舍；最大测试文件 1,775/1,800 行，后续拆分压力大。

### 3.8 安全性 — 9.4 / A

强项：API key 封装 PBKDF2 600k + AES-256-GCM + provider AAD、迭代数上界、机器标识不可用硬失败；桥接有版本化信封、主框架+精确入口 URL 双重信任、规范化指纹去重、4096 容量窗口与退役防重放；图像下载逐跳 DNS + 公网 IPv4/IPv6 分类 + 重定向复验；HTTP 错误脱敏、Bearer 跨源剥离；cap-std + no-follow + 身份绑定。无现实可利用漏洞。

基线发现及后续状态：

- **已修复（原 P3）** [#614](https://github.com/hailingu/PlotWeave/issues/614)：`pw_request_submit` 用可空入口类型并在入队前拒绝 NULL completion，返回 0 且不消耗 ID、不派发或产生回调；core/request NULL 行为保留。该 ABI 仍不在当前原生工程链接。
- **P3** `WebCanvasHostView.pushAppearance` 用字符串插值拼 JS（内容来自 JSONEncoder，实际安全），与同文件 `dispatchEvent` 的 `arguments:` 严格度不一致；防御纵深一致性口子，非现实漏洞。

### 3.9 产品与交互设计 — 8.6 / A-

强项：三层设计令牌 + 8 个偏好环境；选中卡“1pt 边框 + 1pt 外轮廓”保持尺寸；对齐/吸附/键盘移动/整段拖拽一步撤销/导出焦点陷阱/分隔条键盘调宽有真实状态矩阵；错误、加载、空态大多分开；原生首页有 `ProgressView`、空态与恢复按钮；导出弹窗是真正的键盘模态。

基线发现及后续状态：

- **已修复（原 P2）** [#596](https://github.com/hailingu/PlotWeave/issues/596)：节点包装层的 focus-visible 虚线外环与卡片选中框并存；设定集/资产行 focus-within 显示删除按钮，按钮 focus-visible 立即可见并有轮廓。原键盘命令与保存入口未变，测试边界见文首更新。
- **已修复（原 P2）** [#595](https://github.com/hailingu/PlotWeave/issues/595)：文档弹窗标注 `aria-modal` 并复用焦点进入／圈定／归还，设置快捷键在模态会话挂起，避免卸载未保存草稿；[PR #621](https://github.com/hailingu/PlotWeave/pull/621) 已合入（[`4753be8d`](https://github.com/hailingu/PlotWeave/commit/4753be8d1b81c8f309b5c0900ba59043f7eb4d9c)），issue 已关闭。真实 IME 保留已接受的未验证边界。
- **已修复（原 P3）** [#599](https://github.com/hailingu/PlotWeave/issues/599)：Web/Tauri 输入行已有显式发送按钮，与 Enter 共用回合路径，busy 态保留取消；修复 [`113d4adf`](https://github.com/hailingu/PlotWeave/commit/113d4adf76a068a25cac5a41322f778d08ab9a82)，issue 已关闭。
- **P3** 首页首次加载空列表显示“没有匹配「」”，与“加载完前不显示空状态”的注释相反。**已修复（原 P3）** [#603](https://github.com/hailingu/PlotWeave/issues/603)：键盘项目菜单以触发按钮定位并聚焦首项，Escape 返回；指针路径保留。
- **已修复（原 P3）** [#598](https://github.com/hailingu/PlotWeave/issues/598)：原生创作大纲导出默认关闭，与 Web 对齐；修复 [`76c53706`](https://github.com/hailingu/PlotWeave/commit/76c53706b447e9e7dabfc58b34d254d96936a90d)，issue 已关闭。基线另有未单独建档的“编辑器缺少保存中／已保存正向状态”观察，此处不将其归入该修复。

## 四、原评估 issue 与关闭状态

| Issue | 维度 | 严重度 | 摘要 |
| --- | --- | --- | --- |
| [#589](https://github.com/hailingu/PlotWeave/issues/589) | 3.3 | 已修复（原 P2），已关闭 | 拒绝分叉／汇合成员危险重排；[`d60b747d`](https://github.com/hailingu/PlotWeave/commit/d60b747dec15ac087bf664100df8d84ad10572ac) |
| [#590](https://github.com/hailingu/PlotWeave/issues/590) | 3.1 | 已修复（原 P2），已关闭 | 失败可恢复，退出提供可见降级；[`a5afdf0a`](https://github.com/hailingu/PlotWeave/commit/a5afdf0a2604427c25107eb72830ca94f2cfd7cd) |
| [#591](https://github.com/hailingu/PlotWeave/issues/591) | 3.3 | 已修复（原 P2），已关闭 | 删除后同步 projects 目录；[`1f35363b`](https://github.com/hailingu/PlotWeave/commit/1f35363b67d1e469d340afa0426b3436767769ba) |
| [#592](https://github.com/hailingu/PlotWeave/issues/592) | 3.3 | 已修复（原 P2），已关闭 | 项目控制文件读写有界；[`24b979db`](https://github.com/hailingu/PlotWeave/commit/24b979db7109e83af5148de2c0e49f9119c4f818) |
| [#593](https://github.com/hailingu/PlotWeave/issues/593) | 3.5 | 原 P2，已修复 | PR #624 固定 base 核验器；workflow-definition 与自述证据边界保留，已关闭 |
| [#594](https://github.com/hailingu/PlotWeave/issues/594) | 3.2 | 已修复（原 P2），已关闭 | 设置防抖保存失败诊断与重试反馈；[`acd27eb7`](https://github.com/hailingu/PlotWeave/commit/acd27eb75fe76a3079caeaf35248a0853c1a08b9) |
| [#595](https://github.com/hailingu/PlotWeave/issues/595) | 3.9 | 已修复（原 P2），已关闭 | 文档模态会话保留草稿与焦点；[`4753be8d`](https://github.com/hailingu/PlotWeave/commit/4753be8d1b81c8f309b5c0900ba59043f7eb4d9c) |
| [#596](https://github.com/hailingu/PlotWeave/issues/596) | 3.9 | 原 P2，已修复 | 节点独立焦点环与侧栏删除按钮焦点显现，已关闭 |
| [#597](https://github.com/hailingu/PlotWeave/issues/597) | 3.3 | 原 P3，已修复 | 完成响应字节预算与摘要退役；已关闭 |
| [#598](https://github.com/hailingu/PlotWeave/issues/598) | 3.9 | 已修复（原 P3），已关闭 | 原生创作大纲默认关闭；[`76c53706`](https://github.com/hailingu/PlotWeave/commit/76c53706b447e9e7dabfc58b34d254d96936a90d) |
| [#599](https://github.com/hailingu/PlotWeave/issues/599) | 3.9 | 已修复（原 P3），已关闭 | Web/Tauri 显式发送入口；[`113d4adf`](https://github.com/hailingu/PlotWeave/commit/113d4adf76a068a25cac5a41322f778d08ab9a82) |
| [#600](https://github.com/hailingu/PlotWeave/issues/600) | 3.4 | 已修复（原 P3） | 受控交错、共享 IPC 夹具与监听清理 |
| [#601](https://github.com/hailingu/PlotWeave/issues/601) | 3.4 | 已修复（原 P3） | Swift App 覆盖率报告、缺报清单及显式可选下限 |
| [#602](https://github.com/hailingu/PlotWeave/issues/602) | 3.6 | 已修复（原 P3），已关闭 | 保护声明与当前原生实现分支引用同步；[`a7a2abe0`](https://github.com/hailingu/PlotWeave/commit/a7a2abe05ad05b7d3f7647f3c7b10605d883de66) |
| [#603](https://github.com/hailingu/PlotWeave/issues/603) | 3.9 | 已修复（原 P3） | 键盘菜单按钮锚点、首项聚焦与 Escape 归还 |

原评估当时按所有者决定将 [#550](https://github.com/hailingu/PlotWeave/issues/550)（SwiftUI 视图层截图/UI 自动化回归）、[#571](https://github.com/hailingu/PlotWeave/issues/571)（视觉目验/截图录屏）标记 `known-boundary` + not planned，并保留 [#570](https://github.com/hailingu/PlotWeave/issues/570)（人工 IME 验证）与 [#551](https://github.com/hailingu/PlotWeave/issues/551)（Tauri 全链路 E2E）。此处记录当时范围划分；当前验收边界见[当前能力矩阵](swiftui-react-flow-current-state.md)，真实 IME 未验证为接受边界，VoiceOver 与视觉快照验收已取消。

## 五、结论与修复优先级

**历史基线综合 8.9 / 10，A-**（`3cf7146`，未重新评分）。原评估因当时的 8 项 P2 未进入 A。状态更新时原 8 项已修复并关闭，当前原清单尚未关闭 P2 为 0；这不生成当前项目评级，后续新增问题以 tracker 为准。

原修复优先级与完成状态（2026-10-21 核对）：

1. **已完成 #589**：拒绝分叉／汇合危险重排并保留边；修复依据见 3.3。
2. **已完成 #590**：失败恢复与可见退出降级；修复依据见 3.1。
3. **已完成 #591、#592**：删除目录持久性屏障及项目控制文件有界读写；修复依据见 3.3。
4. **已完成 #593 实现修复（PR #624）**：核验器与 Node 版本取事件 base SHA，PR head 仅为 Git 数据；不再作为待修复项。工作流定义的外部强制保护/required review 尚未实施，需单独的所有者治理决定，不包含在本次已修复承诺中。
5. **已完成 #594、#595、#596**：设置保存错误反馈、文档模态与画布／侧栏焦点样式；修复依据见 3.2、3.9。
6. **已完成 #598、#599、#602** 的导出默认、AI 发送和文档一致性；**#597、#603、#600、#601、#616** 的完成情况见各维度条目。

原评估曾预估修复上述 P2 后可达 **9.2–9.3 / A**；该预估未经过修复后重新评分，不作当前评级或待办承诺。

## 六、历史基线验证记录

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

## 七、当前基线追加评估（2026-10-21，HEAD 05c9df40）

本节是对 `3cf7146` 历史记录的独立追加复核，不重写第三节至第六节的历史证据。评估性质为只读审阅加定向复现；基线为 `dev` @ `05c9df4030b09ec316fbb6822b46077a39dfd624`（2026-10-21 20:40）。工作区评估开始时无 open issue；上一轮记录中的 #681、#682、#684、#685、#686、#687、#688 均已关闭，本节不重复扣分。

### 7.1 当前评分

| 维度 | 评分 | 评级 |
| --- | ---: | --- |
| 架构与模块设计 | 9.4 | A |
| 代码质量与类型安全 | 9.3 | A |
| 数据持久化与健壮性 | 9.4 | A |
| 测试与验证 | 9.1 | A |
| 工程基建与质量门禁 | 9.2 | A |
| 文档与治理 | 9.2 | A |
| 安全性 | 9.3 | A |
| 产品与交互设计 | 8.9 | A- |
| 可维护性与一致性 | 9.1 | A |
| **综合** | **9.2** | **A** |

等权计算：`(9.4 + 9.3 + 9.4 + 9.1 + 9.2 + 9.2 + 9.3 + 8.9 + 9.1) / 9 = 82.9 / 9 = 9.211`，按一位小数记为 **9.2 / A**。历史基线 `3cf7146` 的 8.9 / A- 保留，不因本节回填或改写。

### 7.2 本轮扣分点（均为 P3）

1. **原生画布投影逐帧重算**（[#698](https://github.com/hailingu/PlotWeave/issues/698)）。`snapshot()` 在每次渲染调用 `buildOutlineGroups`，并在 Swift 宿主每次渲染执行完整 `JSON.stringify`；`sources` 比较只更新 `contentRevision`，不跳过快照计算。临时 Swift 宿主测试中，一次只改变 `position` 的拖动帧触发两次完整 `snapshot()`，两条调用栈均为 `snapshot → useNativeEditorShell → EditorWindow`。18 节点下 #688 实测首拖最大 19–29ms，未出现 >33ms 间隔，因此当前不是用户可见卡顿；问题是随图规模线性增长的质量债。证据：[`useNativeEditorShell.ts:185`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/nativeCanvas/useNativeEditorShell.ts#L185)、[`:230`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/nativeCanvas/useNativeEditorShell.ts#L230)。
2. **防抖“卸载冲刷”受 `onSave` 身份变化影响**（[#699](https://github.com/hailingu/PlotWeave/issues/699)）。[`App.tsx:86`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/App.tsx#L86) 每次渲染新建内联 `onSave`；[`useDebouncedSave.ts:250`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/useDebouncedSave.ts#L250) 的 effect 依赖 `onUnmount`，而 `flushOnUnmount` 依赖 `onSave`（[`:442`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/useDebouncedSave.ts#L442)）。临时 hook 测试在 600ms 内仅替换 `onSave` 身份，保存被提前调用 1 次（期望 0）；影响是额外写入、削弱防抖和混淆失败/卸载分支，未观察到编辑丢失。
3. **资产面板失败后本地列表不回填**（[#700](https://github.com/hailingu/PlotWeave/issues/700)）。[`AssetsPanel.tsx:119`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/panels/AssetsPanel.tsx#L119) 在 `libraryStore.remove` 前移除本地行，失败分支只 `setError`；[`:168`](https://github.com/hailingu/PlotWeave/blob/05c9df4030b09ec316fbb6822b46077a39dfd624/src/editor/panels/AssetsPanel.tsx#L168) 的批量导入在全部成功后 `setAssets`，部分失败时已成功项不进入列表。触发需只读目录/删除日志冲突/多选中单个不可读文件；重新挂载可恢复，不丢数据。

上述三项在评分时均为未登记的新发现，因此计入 9.2 的轻微折减；现已建档为 #698–#700，按仓库“已知 issue 不重复扣分”的规则，后续复评不再把它们作为新的扣分点，仅保留为质量债与验收线索。

### 7.3 未扣分边界

- **已有 issue**：评估开始时 open issue 为 0；#681–#688 已关闭；#698–#700 由本次复核创建，均为 P3。
- **UI 自动化**：按所有者决定不因缺少 UI 自动化扣分。
- **所有者决策**：三栈并存、Tauri/Swift 双实现、80 行函数上限的人工执行、VoiceOver 不支持、Windows 不支持、原生覆盖率 report-only，均不重新当作缺陷。
- **保留边界**：托管 CI 不跑本机 Sonar；`gate-evidence` 工作流定义仍由 PR 提供且台账为自述；`git am` 等路径不触发钩子；同用户替换 `projects/` 树不在威胁模型内。
- **交付边界**：`README.md` 明确当前 Release 仅提供源码归档，尚无签名、公证和安装验收的 macOS 安装包；这是产品交付成熟度限制，不是代码缺陷。
- **真实设备边界**：#688 的原生首拖修复使用 Debug 合成输入；真实触控板、120Hz、Release 呈现仍未验收，不据此宣称所有性能问题已闭环。

### 7.4 当前验证记录

已运行（仓库根，Node 24.18.0；除非另注）：

| 检查 | 结果 |
| --- | --- |
| `npm run format:check` | 通过 |
| `npm run lint -- --max-warnings=0` | 通过，零警告 |
| `npm run typecheck:strict` | 通过 |
| `npm run check:size` | 通过：`{"code":"SIZE_CHECK_COMPLETE","checked":834,"excluded":66,"passed":true}` |
| `npm run build` | 通过：418 模块；EditorView chunk 451.91 kB |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm test` | 3,489 用例：3,472 通过，17 失败；失败集中在 `scripts/gate-tree-marker.test.ts`、`scripts/pre-push-refs.test.ts`、`scripts/sonar-quality-gate.test.ts`，根因是本沙箱 `ps`/临时目录权限，不是产品失败 |
| `npx vitest run --coverage`（排除上述 3 个受沙箱阻断的 scripts 套件） | 257 文件 / 3,334 用例通过；行 97.54%、语句 96.32%、分支 91.54% |
| `cargo test`（`src-tauri`） | 408 通过，0 失败 |
| `cargo test`（`crates`） | 142 + 4 + 8 = 154 通过，0 失败 |
| `cargo fmt --check && cargo clippy --all-targets -- -D warnings`（两个 workspace） | 通过 |
| GitHub Actions `ci` @ `05c9df40` | success；workflow 含 frontend / rust / native / gate-evidence，dev push 的 gate-evidence 按规则跳过 |

未运行：原生 `xcodebuild`（本机 Xcode 27.1，仓库钉版 27.0；以 HEAD 的 CI success 作为原生证据）、SonarQube 服务端、真实安装包与真机体验。Rust/Swift 的本地结论以源码核实、CI 记录和上述可执行检查为限；`npm test` 的 17 项沙箱失败与托管 CI 的 success 不矛盾，托管 runner 具备测试所需的进程身份能力。

**当前结论**：仓库工程骨架、类型纪律、持久化协议和安全边界仍处于 A 档上限水平；本轮未发现 P1/P2，未发现需要推翻既有设计决策的缺陷。当前 9.2 / A 与历史 8.9 / A- 是两个不同基线的独立记录：历史分数不因修复或当前复核回填，当前分数也不改写历史证据。
