# PlotWeave 设计与实现质量评估

评估日期：2026-10-26。本文评价软件架构、数据契约、状态与交互实现、可靠性及工程治理，不评价视觉美感，不新增产品合同。

**当前结论：9.8 / 10，A+（排除评估开始前全部已知 issue 的证据口径）。**

- **代码基线**：最新 `origin/dev` @ [`9e73056c2f696baffc63165a0ca28801de160347`](https://github.com/hailingu/PlotWeave/commit/9e73056c2f696baffc63165a0ca28801de160347)。取证和下文代码链接均固定于此版本；本次只改评估和 issue 标准，不修复产品。
- **tracker 基线**：2026-10-26 06:21 UTC 完成全量分页快照，排除 PR 后共有 **423 条 issue，开放 0 条**。已知集合包括关闭报告，状态变化不重新产生扣分。最新 issue 为 #866；#867–#878 是 PR。
- **本轮新发现**：[#879](https://github.com/hailingu/PlotWeave/issues/879)，1 项 P2；发现后于 06:27 UTC 建档。它在起始快照之外，保留本轮扣分；下一轮应视为已知项，不能因本轮刚建档而追溯取消或重复计分。
- **方法**：前端、Swift 原生、Rust/Tauri 与工程治理分域只读审查；主审复核关键代码、实际纯函数输出、相关关闭 issue 处置及精确基线 CI。没有把测试通过当作所有行为都已验证。
- **历史**：上一轮 [2026-10-24 完整评估及后续修复表](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/docs/quality-assessment.md) 保留为固定档案，8.7 / A− 描述的是 `1332debe`。#801–#809 已修复，原扣分表不再作为当前债务。

## 一、评分口径

### 1.1 标尺、权重与合成

沿用六个维度和显式权重，满分 10。评级带：A+ 9.5–10.0、A 9.0–9.4、A− 8.5–8.9、B+ 8.0–8.4、B 7.5–7.9、B− 7.0–7.4、C+ 6.5–6.9、C 6.0–6.4、C− 5.5–5.9、D 4.0–5.4、E < 4.0。各维度先按下列规则计算，再加权；综合值保留一位小数后映射评级。

**每个维度从 10 开始，只为本轮合格的新发现扣分，不另设无证据的“满分保留项”。**10 表示本轮没有确认可扣分的新缺陷，不表示领域完美、没有历史债务或已完成穷尽验证。已知问题和未验证项均不形成隐含扣分。

扣分尺度按实际影响校准：普通核心操作的可恢复 P2 缺陷扣对应维度 1.0；触发较窄、影响局部的 P2 扣 0.5；已确认且需要处理的 P3 维护缺陷扣 0.2。现实数据丢失或核心流程不可用的 P1 应按受损范围扣 2.0–4.0 并逐项解释。本轮只使用第一档。先按根因去重，同一根因只归一个维度；实现错误及解释它的测试遗漏不分开处罚。每项扣分必须满足：

1. 有固定代码、可复核命令结果或可重现行为，区分事实、推断与未验证。
2. 普通操作、合理竞态或现实脏数据可以触发，并说明实际影响，不挖极端边界凑分。
3. 不属于起始已知 issue 或其对应报告，不因关闭、更名或换入口措辞重复处罚。
4. UI 自动化方案不足完全不扣分；不把未测、所有者技术选择或已取消范围换名扣分。

### 1.2 实际覆盖与限制

| 维度 | 本轮实际审查范围 | 证据性质 |
| --- | --- | --- |
| 架构与模块边界 | 依赖图、模型纯度、shell→editor 方向、React 编辑 owner、Swift 投影 | 代码／AST 守卫阅读；模块图 28 项本地测试通过 |
| 前端状态与交互 | 首页、保存、历史、节点／连线／布局、大纲、设定、资产绑定、原生编辑意图 | 代码审查；#879 三组生产纯函数链实测；未做桌面拖放 |
| 原生桥接与生命周期 | 会话、信任、去重缓存、投影、原生命令／图库／导出退出协调、表单 | 静态核对与精确基线原生 CI；未重跑本机原生全套 |
| 持久化、安全与契约 | Rust／Swift 原子写、加载／保存、媒体验证、库事务、偏好密钥、下载 | 双栈代码及合同断言阅读；基线 Rust／native CI |
| 测试与可靠性 | 不变量、失败恢复、真实 Wry／WK 边界、覆盖率策略、历史抖动修复 | 断言审查和 CI，不把数量当完整行为验收 |
| CI、门禁与文档 | hooks、scoped push、台账保全、编译范围、四项 CI、依赖审计、文档入口 | 配置／脚本审查；#829 台账回归 34 项通过 |

未执行无关压力实验、付费 Provider、公网 TLS 或安装发行验收。第六节列出命令与未执行项；覆盖范围限制置信度，不自动扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 | 计分依据 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 10.0 | A+ | 所有权和依赖守卫清楚；本轮合格新增扣分 0 |
| 前端状态与交互实现 | 20% | 9.0 | A | #879：普通线性大纲重排产生捷径，单根因扣 1.0 |
| 原生 Swift 桥接与生命周期 | 20% | 10.0 | A+ | 会话、任务登记、最终退出复核；新增扣分 0 |
| 持久化、安全与数据契约 | 15% | 10.0 | A+ | 双栈原子写、身份与输入边界；新增扣分 0 |
| 测试与可靠性工程 | 15% | 10.0 | A+ | 多层行为／合同／真实宿主回归；#879 不重复扣测试分 |
| CI、门禁与文档维护 | 15% | 10.0 | A+ | 编译、覆盖率来源、台账已有修复；新增扣分 0 |
| **综合** | **100%** | **9.8** | **A+** | **已知问题全部排除后的本轮证据分，不是全量缺陷率或完整验收评级** |

计算：`10×15% + 9×20% + 10×20% + 10×15% + 10×15% + 10×15% = 9.8`。

历史 2026-10-13 为 9.1/A，10-18 为 8.9/A−，10-21 为 9.2/A，10-24 为 8.7/A−。不同轮次的已知集合和计分细则不同，不能把 9.8 解释为相对历史上升 1.1 分的全量质量测量。产品没有在本次文档任务中获得修复。

## 三、主要质量优点

### 3.1 架构与编辑所有权有可执行约束

- [`moduleGraph.test.ts` L97–175](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/moduleGraph.test.ts#L97-L175) 检查运行时与编译期无环、模型纯度；[L432–434](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/moduleGraph.test.ts#L432-L434) 检查 shell→editor 方向，不只靠目录命名分层。
- [`useNativeEditorShell.ts` L128–168](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/editor/nativeCanvas/useNativeEditorShell.ts#L128-L168) 绑定项目身份并在原生回执前提交共享状态；[`NativeApplicationState.swift` L94–165](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativeApplicationState.swift#L94-L165) 过滤会话和单调投影。Swift 消费投影和提交意图，React 保留唯一文档与历史。

### 3.2 原生桥与退出没有沿用历史缺口

- [`HostCommandRouter.swift` L109–160](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/HostCommandRouter.swift#L109-L160) 校验可信页面、协议、会话及请求指纹；[L204–233](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/HostCommandRouter.swift#L204-L233) 按字节限制回执缓存，退休身份不重做副作用。
- [`NativeExportView.swift` L69–91](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativeExportView.swift#L69-L91) 点击时同步登记导出；[`NativeHostServices.swift` L140–156](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativeHostServices.swift#L140-L156) 最终退出复核原生命令、图库、系统交付三类未结工作。#804 不再是当前扣分。

### 3.3 持久化和安全边界保护实际数据

- Rust [`persist.rs` L305–370](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/crates/plotweave-core/src/store/persist.rs#L305-L370) 使用排他临时文件、同步、提交前复核、rename 和父目录屏障；[`validate.rs` L312–343](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/crates/plotweave-core/src/store/validate.rs#L312-L343) 第二轮逐项释放句柄，已消除 #848 的累积。
- Swift [`NativeDirectory.swift` L78–170](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativeDirectory.swift#L78-L170) 包含 no-follow、身份、限读和耐久原子写；[`NativeProjectStore.swift` L185–233](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativeProjectStore.swift#L185-L233) 收口保存和媒体验证。
- [`provider_binding.rs` L12–44](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src-tauri/src/prefs/provider_binding.rs#L12-L44) 先绑定持久化 Provider 再用凭据；[`NativePublicDownload.swift` L56–112](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/native/macos/App/NativePublicDownload.swift#L56-L112) 逐跳检查 HTTPS、全部 DNS 答案、期限和取消。不冒充真实公网或计费验收。

### 3.4 工程约束有实际执行证据

- [基线 CI 40277917217](https://github.com/hailingu/PlotWeave/actions/runs/40277917217) 精确绑定 `9e73056c`，frontend、rust、native 成功；gate-evidence 在 dev push 按规则 skipped，不称为执行通过。
- 前端 277 个测试文件通过；原生 430 项／90 套件通过，App Swift 覆盖率 9519/10611 行（89.71%）、79/79 文件，仍为 report-only。Rust 双 workspace 的漂移、fmt、Clippy、测试和审计通过，部分测试按既定配置 ignored，不写成全平台验证。
- [`.githooks/pre-push` L372–418](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/.githooks/pre-push#L372-L418) 慢路径提升 full，不把主树 LCOV 复用到来源不明的被推树；[`gate-history.sh` L48–106](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/scripts/gate-history.sh#L48-L106) 修复链接 worktree 归因，保留索引选择与字节契约。

## 四、本轮扣分项与跟踪 issue

| Issue | 严重度 | 维度 | 实际影响 | 扣分 |
| --- | --- | --- | --- | ---: |
| [#879](https://github.com/hailingu/PlotWeave/issues/879) | P2 | 前端状态与交互 | 普通重排产生绕过新位置的直连，后续可能被分叉守卫拒绝 | 1.0 |

### 4.1 大纲插入没有替换插入位置的旧边

**代码事实**：[`planSpliceIntoSpine` L111–155](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/editor/spine.ts#L111-L155) 只移除被拖节点原关联边，插入时添加 upstream→dragged→downstream，没有移除目标原有 upstream→downstream。[`spliceEdgesWith` L44–54](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/editor/outlineDrop.ts#L44-L54) 只执行传入的身份变换，没有额外修正。

**本地实测**：Node 24.18.0 经 Vite `ssrLoadModule` 加载真实计划器和应用器。构造同集线性链 A→B→C→D，输出完整最终边集：

| 操作 | 实际最终边 | 应有线性结果 |
| --- | --- | --- |
| 游离 X 放到 B 后 | A→B、**B→C**、C→D、B→X、X→C | A→B→X→C→D |
| A 移到 C 后 | B→C、**C→D**、C→A、A→D | B→C→A→D |
| D 移到 B 前 | **A→B**、B→C、A→D、D→B | A→D→B→C |

粗体为应被替换却保留的捷径。第一组 B、C 从线性成员变为多出／多入；生产 `isForkOrMergeMember` 实测返回 true。不依赖极端规模、脏文件或供应商行为。

**入口和影响推断**：[`LeftPanel.tsx` L104–123](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/editor/panels/LeftPanel.tsx#L104-L123) 将拖放上下半映射到 before／after；[`useOutlineDrop` L101–149](https://github.com/hailingu/PlotWeave/blob/9e73056c2f696baffc63165a0ca28801de160347/src/editor/useOutlineDrop.ts#L101-L149) 直接应用计划并登记历史。因此日常排序会生成额外剧情路径，再移动新产生的分叉／汇合成员会被现有守卫拒绝。历史命令提供 undo，可手工修正连线，按可恢复 P2 计分，不声称不可恢复数据丢失。

**去重与计分边界**：已阅读 #340、#589、#75 正文及关闭评论。#340 是坐标序与拓扑序投影不一致；#589 是原本多入／多出成员拔出时删边；#75 是 AI 操作未提供可执行预览及模型指引。本项从线性图出发，由共享大纲接缝保留目标旧边，触发、对象和结果不同。既有测试只证明部分计划片段，是同一根因的解释，不另扣测试分。

**未验证**：未在桌面鼠标拖放、自动保存和重开链路复现，不能给出用户发生率。issue 验收要求完整边集、before／after、游离接入、移动、原位、undo／redo、保存消费及 #589 原有拒绝行为。本次只记录，不实施修复。

## 五、排除项与未计分候选

### 5.1 已知报告全部排除

起始全量为 423 条、开放 0；“已知”不等于“开放”。包括 #801–#809、#829、#840、#844、#848–#866 在内的历史报告及对应处置均排除，不能因仍有保留边界或换措辞再扣分。全量快照请求如下；后来新增条目须以起始时间截断，不能用现在集合代替当时集合：

```sh
gh api --paginate --slurp 'repos/hailingu/PlotWeave/issues?state=all&per_page=100&sort=created&direction=asc'
```

原始快照 SHA-256：`20c55ec74be43a3bb7d054abd8ae9385fb3dc81bd57898867d4828c07c264b25`。它标识当时取证文件，不把本地路径写成公开附件。#879 创建晚于快照，属于本轮发现记录，不构成循环扣分。

### 5.2 所有者范围和证据不足候选

- TypeScript／Rust／Swift 共存和原生体验设计、双宿主、独立数据根、原生覆盖率 report-only、macOS 范围及工具链钉版不扣分。
- **UI 自动化方案不足完全不扣分**，不通过“测试成熟度”“发布信心”等同义理由间接扣减。真实 IME、系统面板、视觉、签名公证、安装包、付费模型、公网 TLS 未测只列限制。VoiceOver 和视觉快照验收已取消，不列待补缺陷。
- 其余小载荷直接 Codable 的边界已有 #840／#863 及持久化文档记录；没有普通数据造成新故障的证据，不重报超深 JSON 风险。
- 时间格式器构造没有普通保存的可感知延迟证据；大载荷 MainActor 编解码没有现实卡顿测量，不从机制直接推导性能扣分。
- 图库提交不确定时保留媒体是现有保全协议；未发现足以另报删除／回滚缺陷的新证据。凭据或导入回收的多重故障假设不替代 #864 已有问题。
- 没有因本轮未执行某套测试、没有新 issue，或历史抖动已经修复而扣分。

## 六、验证记录与置信度

### 6.1 本轮实际执行

除只读 Git／tracker 查询外，验证从隔离 worktree 仓库根执行，Node 为 **24.18.0**；没有改主工作树源文件、索引或已有 pending。

| 命令／检查 | 实际结果与边界 |
| --- | --- |
| `git fetch origin dev` | 基线 `9e73056c`；独立分支从该 dev 创建 |
| 全量 issue 分页及相关关闭评论 | 423 条、开放 0；#340／#589／#75 的正文与处置用于去重 |
| `npm ci` | 成功，锁文件安装并保持版本化 hooks 接线 |
| `npx vitest run src/moduleGraph.test.ts` | 1 文件、28 项通过；首次命令附带不存在的另一过滤路径，实际只运行此文件，不称台账测试已执行 |
| `npx vitest run scripts/gate-history.test.ts` | 1 文件、34 项通过；含真实链接 worktree、自动暂存、人工追加、已暂存删除 |
| Vite `ssrLoadModule` → `planSpliceIntoSpine` → `spliceEdgesWith` | 三组输入均得到第四节完整边集；主审重跑一致，未改生产函数或复制算法 |
| #832 台账字节核对 | 其合并提交的 208124 字节台账仍为基线 213759 字节台账的完整前缀；主树 pending 26 行单独保留，不折并他人记录 |
| 文档结构化复核 | 核对评分、集合、锚点、历史／当前、事实／推断、验收范围；Markdown 无内容语义自动验收器 |

提交仍须由正常 hooks 完整执行静态检查、新前端／Rust 覆盖率和 Sonar；文档 push 按既有路由执行 `check-docs.sh`。提交、最终 PR head、required CI、review 和合并结果由该 PR 的实际记录提供，本文不提前写成通过。没有新增或实质修改可执行单元，80 代码行规则不适用两项 Markdown 改动；台账只允许正常钩子附加。

### 6.2 精确基线远端证据

[CI 40277917217](https://github.com/hailingu/PlotWeave/actions/runs/40277917217) 的 `headSha` 与本轮代码基线完全一致，结果见第三节。没有使用主仓库遗留 `coverage/` 作本轮新跑证据；版本化台账仍是执行器自述，不替代独立 CI、真实 Sonar 回应或实际行为验证。

### 6.3 汇总来源、分歧与限制

同一阶段 `current-quality-assessment` 的来源为 `frontend`（前端架构／状态／交互）、`native`（Swift 桥／生命周期／服务）、`rust-tooling`（Rust/Tauri／持久化／工程治理）、`primary`（主审重跑、去重、tracker 和 CI）。#879 来自 frontend，primary 独立重跑支持同一结论；native 与 rust-tooling 没有合格新增扣分。事实和覆盖见第一、三、六节；用户排除条件属于项目约束，不当作测试结果。

去重后无分歧、无评分取证阻塞；没有隐去少数高严重度发现。代码机制和 #879 纯函数结果为高置信度；桌面系统路径、真实发生率和未执行人工验收保持未验证。不以投票平均产生结论，不把缺少新问题改写为“证明没有问题”。

## 七、后续处理与 issue 标准

1. 按 [#879](https://github.com/hailingu/PlotWeave/issues/879) 验证和修复线性接缝，验收落到完整图和单步历史，不只检查 adds／removes。该 issue 保持开放供后续处理。
2. `issue-standard.md` 原先只对 feature／improvement 明列验收，缺陷 Evidence 写的是“when available”，模板为“如已有建议”，不足以强制每个新 issue 给出明确验收。本次同 PR 补成通用 **MUST**：可观察结果、触发／状态、验证方法、保留行为和范围；缺陷保留六个必需标题，验收写在 Evidence，修复建议可选。已知边界在 Disposition 区分边界验证和实现提案，不凭空改变产品合同。
3. 下一轮重新固定代码与已知集合，#879 作为已知项排除；修复后引用实际提交及验证，不直接推算分数。历史档案和本轮取证边界继续保留。
