# PlotWeave 设计与实现质量评估

评估日期：2026-10-26（同日第三轮）。本文评价软件架构、数据契约、状态与交互实现、可靠性及工程治理，不评价视觉美感，不新增产品合同。

**当前结论：9.6 / 10，A+（排除评估开始前全部已知 issue 的证据口径）。**

- **代码基线**：最新 `origin/dev` @ [`4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b`](https://github.com/hailingu/PlotWeave/commit/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b)。取证和下文代码链接均固定于此版本；本次只改评估文档，不修复产品。
- **tracker 基线**：2026-10-26 本轮开始时完成全量分页快照，排除 PR 后共有 **435 条 issue，开放 0 条**（较第二轮快照新增 #882–#892 共 11 条——第二轮发现已全部处置关闭：9 项经 PR #894/#895/#896/#897/#898/#899 修复，#886 以 known-boundary 登记保留边界）。已知集合包括关闭报告，状态变化不重新产生扣分。快照时最新 issue 为 #892。
- **本轮新发现**：[#903](https://github.com/hailingu/PlotWeave/issues/903)–[#908](https://github.com/hailingu/PlotWeave/issues/908)，共 **6 项：2 项 P2、4 项 P3**；全部在起始快照之外建档，保留本轮扣分。
- **方法**：前端、Swift 原生、Rust/Tauri、工程治理四域只读审查；主审先逐一复核第二轮 11 项发现的 7 个修复提交本体与周边（修复完备性），再对四域报告的全部候选发现独立复核关键代码、独立重跑纯函数探针并做 tracker 去重。没有把测试通过当作所有行为都已验证。
- **历史**：上一轮（同日第二轮，[固定档案](https://github.com/hailingu/PlotWeave/blob/f87fa234a70de63db3557045747124225c74dfb3/docs/quality-assessment.md)）为 9.3/A，11 项发现 #882–#892 已全部处置并合入本基线；本轮逐项复核修复链完备后，在同一六维权重下评估当前基线的新缺口。

## 一、评分口径

### 1.1 标尺、权重与合成

沿用六个维度和显式权重，满分 10。评级带：A+ 9.5–10.0、A 9.0–9.4、A− 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B− 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C− 5.5–5.9、D 4.0–5.4、E < 4.0。各维度先按下列规则计算，再加权；综合值保留一位小数后映射评级。

**每个维度从 10 开始，只为本轮合格的新发现扣分，不另设无证据的“满分保留项”。**10 表示本轮没有确认可扣分的新缺陷，不表示领域完美、没有历史债务或已完成穷尽验证。已知问题和未验证项均不形成隐含扣分。

扣分尺度按实际影响校准：普通核心操作的可恢复 P2 缺陷扣对应维度 1.0；触发较窄、影响局部的 P2 扣 0.5；已确认且需要处理的 P3 维护缺陷扣 0.2。触发较窄但影响非局部且不可恢复的 P2（数据丢失类、且可被单点环境故障放大）按 1.0 计并逐项解释。现实数据丢失或核心流程不可用的 P1 应按受损范围扣 2.0–4.0；本轮没有 P1。先按根因去重，同一根因只归一个维度；实现错误及解释它的测试遗漏不分开处罚。每项扣分必须满足：

1. 有固定代码、可复核命令结果或可重现行为，区分事实、推断与未验证。
2. 普通操作、合理竞态或现实脏数据可以触发，并说明实际影响，不挖极端边界凑分。
3. 不属于起始已知 issue 或其对应报告，不因关闭、更名或换入口措辞重复处罚。
4. UI 自动化方案不足完全不扣分；不把未测、所有者技术选择或已取消范围换名扣分。

### 1.2 实际覆盖与限制

| 维度 | 本轮实际审查范围 | 证据性质 |
| --- | --- | --- |
| 架构与模块边界 | 依赖图、模型纯度、shell→editor 方向、React 编辑 owner、Swift 投影、会话/缓存边界 | 代码／AST 守卫与路由器／状态机阅读；沿用基线 CI 的架构守卫 |
| 前端状态与交互 | 大纲接缝计划器（含 #894 修复逐行复核与探针实测）、连线规则、加载归一化、历史栈、库资产导入撤销、面板状态机 | 主审独立探针（生产模块实测）＋代码追踪；未做桌面拖放 |
| 原生桥接与生命周期 | 修复链复核（瞬时错误分流、导入回滚、深度预扫）、回执缓存双界、退出屏障、pending 态生命周期、库恢复窗口、网络信任边界 | 代码追踪；基线原生 CI；未重跑本机原生全套与运行时注入 |
| 持久化、安全与契约 | #882–#892 修复完备性复核、原子写与清扫白名单、隔离区排除、操作锁序、谓词一致性、双栈导入凭据、库列表投影 | 双栈代码追踪；基线 Rust CI；未做 fd/IO 运行时注入 |
| 测试与可靠性 | 修复回归覆盖审查、探针实测、覆盖率策略、契约测试钉住范围 | 断言审查与聚焦测试实跑，不把数量当行为验收 |
| CI、门禁与文档 | hooks、scoped push 分类边界（实测分类函数）、台账与证据链、ci.yml、脚本/文档交叉引用与计数、基线四 job | 配置／脚本审查＋git 取证＋只读实测；远程保护状态仅文档可证 |

未执行无关压力实验、付费 Provider、公网 TLS、运行时 EMFILE/EIO 注入或安装发行验收。第六节列出命令与未执行项；覆盖范围限制置信度，不自动扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 | 计分依据 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 10.0 | A+ | 所有权和依赖守卫清楚；本轮合格新增扣分 0 |
| 前端状态与交互实现 | 20% | 8.8 | A− | #903 P2 −1.0；#904 P3 −0.2 |
| 原生 Swift 桥接与生命周期 | 20% | 9.5 | A+ | #905 P2 −0.5；修复链复核无新缺陷 |
| 持久化、安全与数据契约 | 15% | 9.6 | A+ | #906/#907 P3 各 −0.2；#888 修复复核完备 |
| 测试与可靠性工程 | 15% | 10.0 | A+ | 多层行为／合同／真实宿主回归；各缺口是根因解释，不重复扣测试分 |
| CI、门禁与文档维护 | 15% | 9.8 | A+ | #908 P3 −0.2 |
| **综合** | **100%** | **9.6** | **A+** | **已知问题全部排除后的本轮证据分，不是全量缺陷率或完整验收评级** |

计算：`10×15% + 8.8×20% + 9.5×20% + 9.6×15% + 10×15% + 9.8×15% = 9.57 → 9.6`。

历史 2026-10-13 为 9.1/A，10-18 为 8.9/A−，10-21 为 9.2/A，10-24 为 8.7/A−，10-26 第一轮为 9.8/A+，第二轮为 9.3/A。不同轮次的已知集合、审查深度与计分细则不同，不能把 9.6 解释为相对第二轮上升 0.3 的全量质量测量：第二轮对拔出侧、库索引错误分流、导入事务等角落覆盖更深，本轮在其修复链复核之上把锚点类型契约、pending 态生命周期与跨栈一致性缺口纳入了审查面。产品没有在本次文档任务中获得修复。

## 三、主要质量优点

### 3.1 第二轮 11 项发现的修复链完整、行为正确

- [#882/#884/#885](https://github.com/hailingu/PlotWeave/pull/894)（`10c59da9`/`42e32621`）：主审以 `npx tsx` 直接加载生产 `src/editor/spine.ts` 实测十组场景——干净图手绘捷径、#879 存量形状、多出边/多入边锚点、原位重放（前后两侧）、反向原位、游离插入、下游成环缝合——缝合查重、多接缝拒绝（不按数组序选边）、原位短路（不改选旁支接缝）逐项正确；`useOutlineDrop` 对 null 计划给出可见提示、接缝与集归属仍为单命令 undo/redo（`spliceEdgesWith` 两向保留完整边对象）。
- [#883](https://github.com/hailingu/PlotWeave/pull/895)（`5d9b1834`）：`filterMedia` 按 `PW_STORAGE_ERROR` 分流保留条目、不设 changed、不重写 `library.json`；新增真实 chmod 注入与 ENOENT 仍隔离的回归。#883 的分流原则成为本轮 [#907](https://github.com/hailingu/PlotWeave/issues/907) 衡量 Rust 侧一致性的基准。
- [#890](https://github.com/hailingu/PlotWeave/pull/897)（`a2c36f23`）：凭据登记失败在同一 actor 内回滚 `removeTree`，回滚失败返回 `PW_IMPORT_ROLLBACK_FAILED` 且不谎称已删除；`pendingMedia` 只在凭据成功后发布。#886 撤销保留边界在 [assets.md](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/docs/data-model/assets.md#L187) 显式记录保留理由与人工清理入口。
- [#887/#888](https://github.com/hailingu/PlotWeave/pull/899)（`98eeb2ea`）：Rust `copy_dir_handles` 与 Swift `copyContents` 每层排除精确 `.trash`、不触碰源数据、`.trashcan` 等近似名保留，双栈同批并各有回归；`find_library_entry` 改用全体消费者一致的活跃谓词。
- [#889](https://github.com/hailingu/PlotWeave/pull/898)（`4a33e65c`）：提供者网络响应改走 `HostJSON.decode` 共享深度预扫，恰在下限深度仍有效的边界有独立回归。
- [#891/#892](https://github.com/hailingu/PlotWeave/pull/896)（`26573717`）：cost.md 表格补齐快/慢路径与 `PRE_PUSH_SCOPE_ESCALATED` 口径，门禁脚本注释不再引用已删除的覆盖率数字。

### 3.2 端点契约多层一致（本轮扣分项即其唯一漏网入口）

- sequence 边「不得以分支为 source」在交互层（[`connectionEndpointIssue`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/graphRules.ts#L70-L72)）、AI 批量层（`connectPlacementIssue`）、加载归一化（`normalizeEdges` 孤儿隔离）三处共用同一判定；大纲计划器是唯一未接线的入口（[#903](https://github.com/hailingu/PlotWeave/issues/903)）。
- 撤销/重做跨边手术与集归属补丁保持原子；`edgeKindOf`/环检测/归一化对运行态与加载态对等（分域复核无分叉形态）。

### 3.3 原生桥、退出与网络信任边界复核无新缺陷

- [`HostCommandRouter.swift`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/native/macos/App/HostCommandRouter.swift) 回执缓存双界淘汰不变量逐路径复核成立（`settle` 先退役再计预算、`makeRoom` 不驱逐结算中条目）；三类退出任务登记均在 `defer` 退休，取消路径不悬挂 quit。
- 库删除/导入事务的每个崩溃窗口表推演收敛或保守挂起自愈；`NativeModels`/DNS/公网 IP/HTTP 帧上限逐项复核；#889 后两条解码路径均封顶。

### 3.4 工程约束有实际执行证据

- [基线 CI 40334299512](https://github.com/hailingu/PlotWeave/actions/runs/40334299512) 精确绑定 `4e6a7dd8`，frontend、rust、native 成功；gate-evidence 在 dev push 按规则 skipped，不称为执行通过。
- 原生命令计数 27+2 经本轮重新清点在四处文档一致；scripts 覆盖率地板注册表与磁盘清点守卫闭环；`verify-gate-evidence` 对真实历史范围只读实测（release-boundary 与 task-PR 两种形态）退出码符合文档矩阵。
- #894–#899 六个修复 PR 均在同一提交内同步 graph-model.md/ui-design.md/assets.md/cost.md，修复与文档无漂移残留。

## 四、本轮扣分项与跟踪 issue

| Issue | 严重度 | 维度 | 实际影响 | 扣分 |
| --- | --- | --- | --- | ---: |
| [#903](https://github.com/hailingu/PlotWeave/issues/903) | P2 | 前端状态与交互 | 分支行作锚点产出 source=分支的非法 sequence 边：会话内不可见、重开被隔离，被拖节点脱落剧情流 | 1.0 |
| [#904](https://github.com/hailingu/PlotWeave/issues/904) | P3 | 前端状态与交互 | 组尾落点无可行锚点时对无操作弹出与事实不符的错误横幅 | 0.2 |
| [#905](https://github.com/hailingu/PlotWeave/issues/905) | P2 | 原生 Swift 桥接与生命周期 | 控制文件瞬时读失败被并入项目消失，整项目待保存导入与别名的内存态被清空，预览批量 404 至下次保存 | 0.5 |
| [#906](https://github.com/hailingu/PlotWeave/issues/906) | P3 | 持久化、安全与数据契约 | Rust 导入凭据登记失败不回滚已落位媒体，与 #890 文档契约的栈范围未界定 | 0.2 |
| [#907](https://github.com/hailingu/PlotWeave/issues/907) | P3 | 持久化、安全与数据契约 | Tauri 库列表把瞬时打开失败并入缺失从投影剔除，与原生路径瞬时分流不一致 | 0.2 |
| [#908](https://github.com/hailingu/PlotWeave/issues/908) | P3 | CI、门禁与文档维护 | 推送门禁把 `public/` 划入 frontend 单栈，三处治理文档未记载且无用例钉住 | 0.2 |

### 4.1 #903：分支锚点产出非法剧情流边（本轮唯一普通操作级 P2）

**代码事实**：锚点资格唯一检查是 [`isSpineMember`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/spine.ts#L132-L134)（是否 sequence 边端点），不查节点类型；分支持有 sequence 入边（[示例项目](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/sampleGraph.ts#L280-L283)自带 `dialogue-1 → branch-1`，手绘也允许）即为合法锚点。[`insertionNeighbors`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/spine.ts#L90-L96) 只数 sequence 出边——分支的出边全是 branch 类型 → `adjacent` 为空 → `{upstream: 分支, downstream: null}` → [L166](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/spine.ts#L166) 无条件加 `upstream→dragged`。计划器签名只收 edges，结构上无法查端点类型；`useOutlineDrop` 物化时无端点复核。该边形态被交互层、AI 批量层、加载归一化三方禁止，唯独计划器可产出；分支节点只有匿名 target 句柄与选项 source 句柄（[BranchNode.tsx](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/nodes/BranchNode.tsx#L44-L47)），边会话内不可渲染。

**主审独立实测**（Node 24.18.0，`npx tsx` 直接加载生产 `src/editor/spine.ts`）：`拖 X 到 BR(分支) 之后 → 删[P→X, X→N] 加[P→N, BR→X]`——缝合与非法边同计划产出；`before` 位置（多入边拒绝之外）产出合法替换。

**影响与计分**：大纲会话内把 X 排到分支后（inFlow 按端点计数驱动），画布无新连线；保存重开后 `BR→X` 被孤儿边规则隔离，而原位边已删并缝合——X 脱落剧情流成为游离节点，与 #879/#882 同类「会话内编辑被加载管线静默撤销」。保存前一步 undo 可恢复、重开后可手动重连，节点本体与文本不丢，按普通核心操作的可恢复 P2 扣 1.0。

**去重与边界**：#884 是非剧情流锚点的静默无操作（分支持有 sequence 入边时恰是剧情流成员，判定相反）；#589/#885 是被拖成员侧与接缝选取；#340/#361 是导出投影。均不同根因。**未验证**：桌面拖放、磁盘重开与原生大纲实测（静态确认共用计划器）。

### 4.2 #905：openMedia 把瞬时控制文件失败并入项目消失

**代码事实**：[`NativeProjectMedia.swift L75–81`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/native/macos/App/NativeProjectMedia.swift#L75-L81) 的 catch 不区分错误码，任何 `loadProject` 抛错都清空整项目 `pendingMedia`/`mediaAliases`；而 [`loadProject`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/native/macos/App/NativeProjectStore.swift#L180-L187) 除 `project_not_found` 外还因 `PW_STORAGE_ERROR`（[`NativeDirectory`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/native/macos/App/NativeDirectory.swift#L26-L27) 的 errno 路径统一映射）抛错——区分能力存在但未用。同文件 `discardImport`/`validateAsset`/`registerAlias` 失败时不清状态、`importReceipts` 却被保留，三处不一致可证非整体设计；现有测试仅覆盖项目删除路径。

**影响与计分**：导入成功至防抖保存的窗口内，一次瞬时 I/O 失败清空整项目 pending 态——之后所有待保存资产的 pwmedia 加载返回 `PW_ASSET_NOT_FOUND`（预览批量 404），直至下一次成功保存从 `byId` 恢复。触发较窄（fd 压力窗口，#848 已证实同类压力现实可达）、影响局部且可自愈、无数据丢失，按 0.5 扣。**未验证**：运行时 EMFILE 注入。

### 4.3 P3 项摘要

- **#904（组尾落点横幅）**：[outlineDrop.ts L30–41](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/outlineDrop.ts#L30-L41) 组尾回退耗尽返回 null，[useOutlineDrop L162–167](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src/editor/useOutlineDrop.ts#L162-L167) 把 null 一律按拒绝上浮（`10c59da9` 引入）——行落点有「拖回自身」豁免、组尾落点没有；全游离组或单行组的组尾落点实为无操作，却弹出不成立的「接缝不唯一/形成环/请调整连线」持续性横幅。零状态写入，仅诊断与事实不符，P3 扣 0.2。
- **#906/#907（跨栈导入与列表一致性）**：Rust [`import_asset_from_library`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src-tauri/src/assets.rs#L183-L191) 在 `register` 失败（`try_clone`/重开刚写入文件的瞬时错误）时不回滚已落位媒体，凭据未入表使 discard 亦不可达，最终名孤儿无清扫方——同日 #890 修复只改了 Swift 与文档，[assets.md L193](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/docs/data-model/assets.md#L193) 契约段未界定栈范围（同文件其他栈分歧处均有显式标注）；Rust [`list_assets_with`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/src-tauri/src/library.rs#L97-L115) 把任意打开错误（含瞬时）从列表投影剔除（#851 修复 `282c7aa5` 引入的 retain 不分流错误类别），磁盘索引无损、可自愈，但与 #883 为原生确立的瞬时分流原则不一致。均按 P3 纵深/一致性记录，处置方向（补齐或显式栈限定）交所有者定夺。
- **#908（门禁分类边界）**：[`gate-scope-core.ts L31–37`](https://github.com/hailingu/PlotWeave/blob/4e6a7dd8d975cfe94011b4102fe3f1d14c2f011b/scripts/gate-scope-core.ts#L31-L37) 把 `public/` 前缀划入 frontend（`0d408fea` 引入），三处治理文档（AGENTS.md、push.md L19/L22、cost.md L150）均写 frontend = `src/**` 与前端专属根配置且未知路径归 full，无一处记载 `public/**`，`gate-scope.test.ts` 亦无用例钉住；主审 node 实测分类函数 `public/favicon.png → frontend`。语义上分类合理、现实风险极低，属规格/行为分叉与欠测试，P3 扣 0.2。

## 五、排除项与未计分候选

### 5.1 已知报告全部排除

起始全量为 435 条、开放 0；“已知”不等于“开放”。包括 #801–#809、#829、#840、#844、#848–#866、#879 及 #882–#892 及其处置在内的历史报告均排除，不能因仍有保留边界或换措辞再扣分。全量快照请求与前两轮相同：

```sh
gh api --paginate --slurp 'repos/hailingu/PlotWeave/issues?state=all&per_page=100&sort=created&direction=asc'
```

原始快照 SHA-256：`5987d0a568643d5389a198e55d07374a4209b5b2a82ffc6e7de2f89b3bd3117a`。它标识当时取证文件，不把本地路径写成公开附件。#903–#908 创建晚于快照，属于本轮发现记录，不构成循环扣分。

### 5.2 有文档化处置、所有者范围与证据不足候选

- **导入凭据持有文件描述符直至保存/丢弃**：#886 报告正文已明言「会话内每个此类凭据还持有 1 个打开的文件描述符直至下次保存」，属已知集合内的既记录事实；本轮对「无上限累计触发 EMFILE」的机制推演因需要千次级未保存导入、无普通操作下的现实路径，按口径不从机制推导扣分，不再立新项。
- **中间提交 `137e3506` 的 native job 失败**（run [40308144750](https://github.com/hailingu/PlotWeave/actions/runs/40308144750)）：失败步骤为「Upload native Swift coverage」artifact 上传，该次运行 438 项测试全部通过，后续基线运行全绿；原生覆盖率 report-only 是所有者决策，一次性 runner 上传故障不构成缺陷。
- 第二轮已排除的候选（`projects/{id}/assets/` 媒体临时文件不清扫的文档化处置、本地小载荷直解 `Codable`、`NativeProjectEnvelope.now()` 格式器重建、`copyContents` 整文件进内存、`removeTree` 逐条 fsync、gate-scope 根配置集合未逐一枚举）本轮维持排除；其中根配置枚举排除不覆盖 [#908](https://github.com/hailingu/PlotWeave/issues/908)——那是目录前缀级的实现/文档分叉且无测试钉住，属不同事实。
- TypeScript／Rust／Swift 共存、双宿主、原生覆盖率 report-only、统一提交门禁成本、文档化 hook 覆盖边界、工具链钉版：所有者决策，不扣分。
- **UI 自动化方案不足完全不扣分**，不通过“测试成熟度”“发布信心”等同义理由间接扣减。真实 IME、系统面板、视觉、签名公证、安装包、付费模型、公网 TLS 未测只列限制。
- 没有因本轮未执行某套测试、没有新 issue，或历史抖动已经修复而扣分。

## 六、验证记录与置信度

### 6.1 本轮实际执行

除只读 Git／tracker 查询外，验证均在主工作树只读执行（未改源文件、索引与 pending），Node 为 **24.18.0**：

| 命令／检查 | 实际结果与边界 |
| --- | --- |
| `gh api --paginate --slurp`（issue 全量快照） | 435 条非 PR、开放 0、最大 #892；SHA-256 见 5.1；6 项发现的去重检索基于该快照全文 |
| `git show`（7 个修复提交逐项复核） | `10c59da9`/`42e32621`/`5d9b1834`/`98eeb2ea`/`a2c36f23`/`4a33e65c`/`26573717` 的代码与配套测试/文档变更全部主审阅读；修复本体完备，#904 是其中 #884 修复的上浮分支缺口 |
| `npx tsx` 加载生产 `src/editor/spine.ts` 探针 | 两组共十场景（八组拓扑 + 分支锚点 after/before）：缝合查重、多接缝拒绝、原位重放、游离插入、成环缝合逐项输出完整最终边集；#903 的 `BR→X` 非法加边由探针直接产出 |
| `npx vitest run src/editor/spine.test.ts src/editor/outlineDrop.topology.test.ts src/editor/useOutlineDrop.test.tsx` | 3 文件、53 项全部通过（较第二轮 36 项增加 #894 修复回归）——修复自身用例为绿，扣分项均为未覆盖场景 |
| node 只读调用 `scripts/gate-scope-core.ts` 分类函数 | `public/favicon.png → frontend`、`vite.native-canvas.config.ts`/`tsconfig.scripts.json` → full——#908 实测依据 |
| `git log -S` 定位回归来源 | `282c7aa5`（#851 retain 引入）、`0d408fea`（public/ 前缀引入）、`10c59da9`（null 上浮引入）；`#903`/`#905` 的引入提交未定位 |
| [CI 40334299512](https://github.com/hailingu/PlotWeave/actions/runs/40334299512) | headSha 与代码基线完全一致，frontend/rust/native 成功；gate-evidence 在 dev push 按规则 skipped |
| 原生命令清点 | Swift 各服务 `enum Command` 手工清点 27+2，与 overview.md/ui-design.md/feature-parity/上一轮评估四处一致 |

未执行：桌面拖放与磁盘重开链路（#903/#904 的 UI 接线为静态确认，计划层已探针实测）、运行时 EMFILE/EIO 注入（#905/#906/#907 代码链已闭合）、本机原生全套与 Sonar 重跑（沿用基线 CI 与提交门禁）。四域审查覆盖面广，但 6 项发现的可信度分级以各 issue 的「验证情况」为准。

提交仍须由正常 hooks 完整执行静态检查、新前端／Rust 覆盖率和 Sonar；文档 push 按既有路由执行 `check-docs.sh`。提交、最终 PR head、required CI、review 和合并结果由该 PR 的实际记录提供，本文不提前写成通过。没有新增或实质修改可执行单元，80 代码行规则不适用于本文档改动；台账只允许正常钩子附加。

### 6.2 汇总来源、分歧与限制

四域审查来源为 `frontend`（前端状态与交互）、`native`（Swift 桥／生命周期／服务）、`rust`（Rust/Tauri／持久化）、`tooling`（CI／门禁／文档），主审对 6 项计分发现全部独立复核代码并重跑探针/实测分类函数，无仅凭分域报告采信的扣分；分域另报的「导入凭据 fd 常驻」经查为 #886 已记录事实而排除。#903 为高置信度（探针实测＋三方契约引文）；#905 机制确定、触发概率中低；#906/#907 的处置方向含所有者裁量（补齐或栈限定），立 P3 而非直接认定修复方案。事实与覆盖见第一、三、六节；用户排除条件属于项目约束，不当作测试结果。不以投票平均产生结论，不把缺少新问题改写为“证明没有问题”。

## 七、后续处理与 issue 标准

1. 建议处置顺序：[#903](https://github.com/hailingu/PlotWeave/issues/903)（P2，普通操作触发、拓扑脱落）优先，[#905](https://github.com/hailingu/PlotWeave/issues/905)（P2，瞬时失败放大）次之；P3 项按所有者排期，其中 #906/#907 需先定「补齐对齐」还是「显式栈限定」再动代码，#908 建议走文档三处同步的最小处置。
2. `issue-standard.md` 的通用验收标准要求经本轮继续核实有效：6 个新 issue 均按缺陷六标题建档并附可验证验收标准与去重说明。
3. 下一轮重新固定代码与已知集合，#903–#908 全部作为已知项排除；修复后引用实际提交及验证，不直接推算分数。历史档案和本轮取证边界继续保留。
