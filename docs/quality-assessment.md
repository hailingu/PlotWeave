# PlotWeave 设计与实现质量评估

评估日期：2026-11-04（第六轮）。本文评价自上一基线以来的全部变更：AI 分集特性链、归一化形状边界、原生目录重组、推送门禁拆分、ub-mode 发布门禁与 dev→develop 集成分支重命名。沿用前轮六维结构与计分方法，不新增产品合同。

**当前结论：10.0 / 10，A+（排除评估开始前全部已知 issue 后，本轮未确认新的可扣分缺陷）。**

- **代码基线**：2026-11-04 评估时核定 `origin/develop` @ [`1913294fd0c4af81b33f77f56c8b58034b5666c2`](https://github.com/hailingu/PlotWeave/commit/1913294fd0c4af81b33f77f56c8b58034b5666c2)（2026-11-03 16:40 UTC）。下文源码链接固定此 SHA。上轮基线以来共 75 个提交：native 85 文件、src 64、docs 38、scripts 19、CI/根配置若干；**`src-tauri/**` 与 `crates/**` 两 Rust 栈零变更**，其结论由上轮同树实跑与本轮零差异事实共同覆盖。
- **tracker 基线**：2026-11-04 完成分页冻结，`state=all&per_page=100&page=1..10&sort=created&direction=asc`，共 958 项；排除 PR 后 **461 条 issue，开放 0 条**，PR 497 条，集合编号至 #959。上轮 #926–#925 之后新增的 #927–#949（AI 分集与门禁修复）及 #950–#959（依赖与重命名 PR）全部属于已知集合，关闭报告同样排除。
- **本轮新发现**：**0 项合格的新扣分发现，新增 issue 0 条**。所有候选疑问先回到生产路径、历史报告与接受契约核查；不把启发式取舍、未测范围或已修问题换措辞立项。
- **方法**：单审查者在原仓库工作树按变更清单逐域精读新代码（AI 分集六模块、归一化边界、回合生命周期、场景编号、pre-push 拆分、ub-mode 门禁、原生 AI 视图与重组差异），辅以量化指标（规模守卫、TODO/强制解包/console.log 计数、重命名残留扫描、重组相似度核对），并实跑全量前端测试、前端覆盖率与串行原生功能回归。事实、推断与限制分别记录；测试通过不替代行为与契约判断。
- **历史**：第五轮为 [10.0/A+（固定档案）](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/docs/quality-assessment.md)，发现 0 项；第四轮 9.5/A+ 发现 #915–#919 均已关闭合入。第一至第五轮 9.8/A+、9.3/A、9.6/A+、10.0/A+ 仅为历史记录，本轮没有从旧分数推算。

## 一、评分口径

### 1.1 标尺、权重与合成

沿用六维权重：架构 15%、前端 20%、原生 20%、持久化与安全 15%、测试可靠性 15%、CI/门禁/文档 15%。每维满分 10，先按根因去重扣分，再加权。综合分按普通四舍五入保留一位小数后映射评级。

连续阈值为：**A+ ≥9.5；A ≥9.0；A− ≥8.5；B+ ≥8.0；B ≥7.5；B− ≥7.0；C+ ≥6.5；C ≥6.0；C− ≥5.5；D ≥4.0；E <4.0**，每段上界为上一段下界（不含），分数限定 0–10。A–C 分 +/中/−，D/E 沿用前轮合并档。

**每维从 10 开始，只为本轮确认、起始未知且需要处理的新发现扣分。**10 表示本轮没有合格新增扣分，不能解释为零历史债务、全覆盖验收或完美软件。已知问题及未验证项不形成隐含扣分。

沿用扣分尺度：普通核心操作的可恢复 P2 扣对应维度 1.0；触发较窄、局部影响的 P2 扣 0.5；已确认且需要处理的 P3 维护缺陷扣 0.2。窄触发但可由单点故障放大、不可自愈的数据丢失类 P2 可扣 1.0，并须逐项解释。现实数据损失或核心流程不可用的 P1 按范围扣 2.0–4.0。同一根因只归一维，其测试遗漏不重复扣罚。

每项扣分须同时满足：

1. 固定版本和具体触发路径明确，有实际行为证据或闭合代码链；静态推断不得写成已复现。
2. 普通操作、合理竞态或现实脏数据可以触发，影响值得处理；不靠不现实边界凑分。
3. 与起始 461 条 issue、497 条 PR 及接受处置核对后，仍属新的共同根因。
4. 不涉及 UI 自动化方案不足，也不换名为测试成熟度、发布信心等间接扣分。

初始未知而由评估新建的 issue 仍可计入当轮，本轮未出现这种情况。没有因“必须发现新问题”另设扣分。

### 1.2 实际覆盖与限制

| 维度 | 本轮实际审查范围 | 证据性质 |
| --- | --- | --- |
| 架构与模块边界 | 归一化形状边界与 `parseProject` 单入口、AI 命令生产者与画布所有者关系、原生目录重组的编译成员、pre-push 协议/运行时拆分边界 | 生产代码精读＋重组相似度核对＋守卫实跑 |
| 前端状态与交互 | AI 分集范围词法、分集指派计划与指纹确认、批次落地重校验、回合世代/认领/持有、场景编号输入、瞬时反馈会话身份、大纲拖拽单命令 | 模块精读＋全量行为测试实跑 |
| 原生桥接与生命周期 | HostCommandRouter 重写（缓存预算、退役水位、会话失效）、NativeAiView 草稿渲染与 CJK 度量、大纲整行选择、重组后 79 文件成员与回归 | 串行真实 AppKit/WKWebView 功能回归实跑＋差异审读 |
| 持久化、安全与契约 | Rust 两栈零差异事实、归一化出口运行时校验、dev→develop 重命名的 CI/dependabot/脚本字面量核对 | git diff 集合证据＋配置阅读 |
| 测试与可靠性 | 全量前端套件、覆盖率阈值（含 nativeCanvas 每文件与 scripts floor）、原生功能回归、断言语义抽查（新测试引用稳定行为而非文案） | 实跑结果＋测试本体审读 |
| CI、门禁与文档 | pre-push 拆分后契约逐项核对、ub-mode 门禁 CLI、ci.yml develop 触发与发布边界条件、文档与设计同步（design-sync、testing/*、native-source-layout） | 契约逐项核对＋配置与文档阅读 |

未重跑持续性能、长循环内存、first-drag、库列表规模基准、付费模型、公网 TLS、签名公证、安装发行、中文输入法/VoiceOver/触控板人工验收；Rust 内核未重复实跑（零变更，上轮同树 155 通过记录仍适用）。本轮 tracker 统计为 API 分页计数，未做上轮那类逐页字节归档与 SHA-256 manifest。限制只限定结论范围，不自动扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 | 计分依据 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 10.0 | A+ | 归一化边界单入口生效；重组为纯移动＋同步组；新增合格扣分 0 |
| 前端状态与交互实现 | 20% | 10.0 | A+ | AI 分集计划/确认门与回合生命周期复核；4156 用例全过；新增合格扣分 0 |
| 原生 Swift 桥接与生命周期 | 20% | 10.0 | A+ | 重组后全量功能回归 TEST SUCCEEDED；路由器契约保持；新增合格扣分 0 |
| 持久化、安全与数据契约 | 15% | 10.0 | A+ | Rust 零差异＋归一化出口校验核对；新增合格扣分 0 |
| 测试与可靠性工程 | 15% | 10.0 | A+ | 前端覆盖率阈值与原生覆盖报告全过；新增合格扣分 0 |
| CI、门禁与文档维护 | 15% | 10.0 | A+ | pre-push 拆分契约逐项保留、重命名无残留；新增合格扣分 0 |
| **综合** | **100%** | **10.0** | **A+** | **已知问题排除后的本轮证据分** |

计算：`10×15% + 10×20% + 10×20% + 10×15% + 10×15% + 10×15% = 10.00 → 10.0`。

这不表示本轮新增的 75 个提交没有引入过缺陷——#927–#946 的 P1/P2 序列正是本期间发现并修复的。轮次的已知集合扩大，旧问题按要求排除，基线包含全部修复；本轮重新审查和验证后没有确认新的合格扣分，依既定起分法得 10.0；不能为避免满分而虚设“保留分”。

## 三、主要质量优点

### 3.1 上轮基线以来修复链及新特性边界

| 已知 issue / 特性 | 本轮复核的行为 | 边界与限制 |
| --- | --- | --- |
| #929/#939/#943 分集范围（`97a99420`、`a9e1e61b` 等） | [episodeScope.ts](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/episodeScope.ts#L219) 将范围判定与批次校验串联：非 allow 范围下只识别真实写入 `episodeNo` 的命令，整批拒绝并把编号诊断回喂模型；旧卡执行绑定其前最近用户消息（[requestForEntry](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/episodeScope.ts#L244)） | 词法启发式按设计取舍：误拦/误放两条失败路径均产生可见诊断且可重试，不构成数据写入错误 |
| #946 归一化形状（`3ff04ece`） | [finalizeNormalizedGraph](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/model/normalizedGraphShape.ts#L391) 在 [parseProject 单入口](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/model/convert.ts#L185) 交付前穷举校验节点/边 variant；schema 用映射类型强制每个域字段登记校验条目，新增字段绕不过表 | `normalizeNodes` 内部 `as unknown as` 按接受契约保留（修复管线），出口校验兜底；拒绝路径抛 `[NORMALIZED_GRAPH_SHAPE_INVALID]` 稳定诊断而非静默剥离 |
| #931 分集关联（`001f660d` 合入） | [planEpisodeAssignments](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/episodeAssignment.ts#L207) 产出确定性计划；[applyValidatedBatch](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/useAiBridge.ts#L159) 落地前按当前图重校验、指纹不一致即拒绝、冲突默认阻断待人工确认、整批单命令入栈一步撤销 | 指纹覆盖命令/展示/冲突/节点/边五族身份；未验证“确认后又改画布再确认”的人工时序，属预览确认契约的既有范围 |
| #932/#928/#744 原生 UI（`d43324e8`、`421b0565`） | [NativeOutlineView](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/native/macos/App/Editor/NativeOutlineView.swift#L45) 拖放时重读当前身份集合；[NativeAiView](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/native/macos/App/Editor/NativeAiView.swift#L40) 反馈块与正文统一 body 度量 | 原生为读投影，编辑始终回落画布单一所有者；CJK 渲染经光栅路径校准（`d171e5fe`） |
| #948 pre-push 拆分（`167a9240`） | [主钩子](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.githooks/pre-push#L40) 保留单一 trap/init 所有者与全部既有保证：`GIT_NO_REPLACE_OBJECTS`、删除 ref 跳过、唯一提交分析一次、[#805 慢路径提升](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.githooks/pre-push#L148)、[#464 缺尾随换行 fail-closed](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.githooks/pre-push#L103)、每推送提交先过 [#941 ub-mode 核验](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.githooks/pre-push#L115) | 协议/运行时两库只定义可调用助手，拆分为机械抽取；夹具测试实跑真实 Git/hooks |
| #941 ub-mode 门禁（`356f5f47`） | [ub-mode-gate.ts](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/scripts/ub-mode-gate.ts#L43) 参数数目固定、未识别调用一律失败；`pr` 入口拒绝保护分支、要求远端 tip 等于本地 HEAD 并核验证据后才建 draft | `verify` 信任本地证据文件的自述边界与 [ub-mode-gate.md](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/docs/development/ub-mode-gate.md) 记载一致 |
| #958 dev→develop 重命名（`fddc7ea1`、`437d3f4f`） | [ci.yml](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.github/workflows/ci.yml#L10) push/PR 触发与 [发布边界条件](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/.github/workflows/ci.yml#L202) 均以 develop 键定；dependabot 三处 target-branch 改为 develop；误伤的 Tauri 子命令、/dev/null 夹具路径等非分支字面量已恢复 | scripts/.githooks/.github 的 dev 分支字面量扫描零残留；GitHub blob 链接重定向不依赖 |

### 3.2 AI 回合生命周期有完整的世代与交付守卫

- [useTurnGeneration](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/panels/aiThreadTurn.ts#L38) 以世代计数+可变取消信号使旧轮迟到结果不覆盖新轮、不重复交付取消回执；[settle](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/panels/aiThreadTurn.ts#L75) 在交付、注销与认领归还三态间按“存活+世代一致”裁决。
- [pendingTurns](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/pendingTurns.ts#L33) 注册表按项目单盒：`unregister` 身份校验防旧轮清掉新轮，`returnTurn` 槽位占用时不覆盖；认领路径处理 StrictMode 双挂载、取消期间认领、提交前卸载归还三类时序（[usePendingTurnClaim](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/panels/aiThreadTurn.ts#L196)）。
- 认领条目重定 id 并[按当前画布重校验待执行卡](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/panels/aiThreadTurn.ts#L382)，拒绝旧实例闭包的校验结果成为执行预览。

### 3.3 画布上下文与读取预算有硬上界

- [graphDigest](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/graphDigest.ts#L35) 双层预算：各节计数上限超限节选并声明未列出量，最终 24,000 字符硬截断附补读指引；[find_nodes 回喂预算](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/ai/agentLoop.ts#L102) 单轮共享，超额返回诊断而非伪装完整页。
- 读工具全部经 ref 读当前态；[场景场次输入](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/src/editor/nodes/settings/SceneForm.tsx#L87) 空值清除、安全整数钳制与显式 ✕ 清除按钮并存。

### 3.4 原生路由器与资源边界保持有界

- [HostCommandRouter](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/native/macos/App/Shell/HostCommandRouter.swift#L18) 完成回复缓存受 8 MiB 总量/1 MiB 单条双界约束，单条超限交付但不保留；退役水位让旧序号无授权；会话失效先取消在途再换 sessionId。
- 目录重组 78 个文件中 74 个为 R100 纯移动，4 个内容变化文件即 #744/#928/#932 修复本体；工程经 `PBXFileSystemSynchronizedRootGroup` 自动接纳新分组，重组后全量功能回归通过。

### 3.5 工程卫生指标与文档同步

- 规模守卫 935 文件全过；生产源码 TODO/FIXME 计数 0（唯一 grep 命中为 mktemp 模板 `XXXX` 误匹配）、`console.log` 0、新增 Swift `try!`/`as!` 0。
- 文档与实现同步：[design-sync.md](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/docs/design-sync.md)、每问题 testing 记录（issue-929/931/939/941/946/948 等）、[native-source-layout.md](https://github.com/hailingu/PlotWeave/blob/1913294fd0c4af81b33f77f56c8b58034b5666c2/docs/development/native-source-layout.md) 与 workflow.md 的重命名修正均随修复落盘。

## 四、本轮扣分项与跟踪 issue

| 新 issue | 严重度 | 维度 | 证据与影响 | 扣分 |
| --- | --- | --- | --- | ---: |
| 无 | 无 | 六维 | 没有确认起始未知、需要处理且符合计分条件的新根因 | 0.0 |

**新增待处理 issue 为 0。**这不表示未来没有缺陷；后续出现新触发、合同违背或独立复现，应固定证据按标准建档。不能为补齐表格先创建推测报告。

## 五、排除项与未计分候选

### 5.1 已知集合

上轮 #925 之后新增的 #927–#949 及 PR #950–#959 全部纳入排除集合，包括其中已修复的 P1（#929 删除分集后 AI 新增节拍复活第一集）与 P2 序列（#931/#932/#933/#939/#940 等）。本轮基线包含全部对应修复（§3.1 逐项复核）。关闭不等于未知，本轮未重开旧 issue。

### 5.2 复核后不成立或由合同覆盖的疑问

| 候选疑问 | 核查后的事实与处置 |
| --- | --- |
| episodeScope 词法启发式会误判用户请求 | 误拦产生编号诊断并回喂模型可澄清；误放须经预览确认与指纹门才落地。两条路径可见、可恢复，按词表/正则取舍接受契约处理，不按泛用可能性扣分 |
| `normalizeNodes` 出口仍有 `as unknown as` | #946/#949 接受设计：内部修复管线保持断言，出口由 `finalizeNormalizedGraph` 在 `parseProject` 单入口穷举校验兜底，形状缺陷无法静默交付或回写 |
| pre-push 拆分是否丢失既有保证 | 逐项核对：`GIT_NO_REPLACE_OBJECTS` 导出、全零 sha 跳过、唯一提交分析一次、快/慢按唯一提交判定、#805 慢路径提升、#464 fail-closed、#917 共享队列解析均在主钩子保留；两库文件仅含助手函数 |
| dev→develop 重命名是否有残留破坏 | scripts/.github/.githooks 分支含义字面量扫描零残留；ci.yml 触发与 `RELEASE_BOUNDARY` 条件、dependabot target-branch 均为 develop；非分支 `dev` 字面量（Tauri 子命令、`/dev/null` 夹具）由 `437d3f4f` 恢复并有回归钉住 |
| 目录重组是否破坏编译成员或夹具路径 | 74/78 文件 R100 纯移动；4 个内容文件即当批修复本体；工程用文件系统同步组，无需逐文件登记；重组后原生全量回归 TEST SUCCEEDED |
| `validateEpisodeScope` 的 recordedScope 与重推导分歧 | 分歧时取更严方向阻断 `episodeNo` 写入并产生可见 issue 文案；`requestForEntry` 保证旧卡绑定其发起消息，范围与请求错位时宁可回喂澄清 |
| 场次输入把 "0" 静默钳为 1 | 输入 UX 取舍：清除有显式 ✕ 入口，钳制方向保守且有 SceneForm.sceneNumber 回归钉住；无数据丢失或合同违背 |
| 上轮的 tracker 字节归档本轮未做 | 本轮以 API 分页计数冻结集合（10 页终点 58<100，无截断）；未归档原始 JSON 仅限定复核证据形态，不构成产品或门禁缺陷 |

## 六、验证记录与置信度

### 6.1 本轮实际执行

工作目录为原仓库工作树（基线即 `origin/develop` tip，工作树在评估前为 clean）。Node 取 `.nvmrc` 的 **24.18.0**。

| 命令／检查 | 结果与边界 |
| --- | --- |
| issues API 分页（10 页） | 958 项 = **461 issue + 497 PR**，开放 issue 0，编号至 #959；未做字节级归档（见 1.2 限制） |
| 变更集合核对 | 上轮基线以来 75 提交；`src-tauri/**`、`crates/**` 零差异；重组 74/78 R100 纯移动 |
| `npm run check:size` | **935 文件通过**（excluded 67） |
| `npx vitest run` | **297 文件、4156 用例全部通过**（113 s）；含架构/IPC/保存链/门禁夹具/原生投影全部套件 |
| `npm run test:coverage` | 退出码 0：80% 总体行 floor、nativeCanvas 每文件 80% floor、scripts floor 全部阈值通过；lcov 汇总 **9350/9598 行 ≈ 97.42%** |
| `sh scripts/test-native.sh` | **TEST SUCCEEDED**；生产 WebCanvas 构建后串行 AppKit/WKWebView 回归；覆盖 **9830/10779 行 91.20%，79/79 文件**，report-only |
| 重命名残留扫描 | scripts/.github/.githooks 中分支含义 `dev` 字面量零命中 |
| 工程卫生计数 | TODO/FIXME 0（唯一命中为 mktemp `XXXX` 模板）、生产 `console.log` 0、新增 Swift `try!`/`as!` 0 |
| Rust 栈 | 零变更；不重跑，引用上轮同树 `cargo test -p plotweave-core` 155 通过记录与零差异事实 |

原生回归的精确用例数未从 xcresult 留存（脚本清理了中间产物），以 `** TEST SUCCEEDED **` 与覆盖率汇总行（全部套件通过后才打印）为准。AI 分集的人工验收（真实模型服务、付费 key、真实 CJK 输入法操作）未执行，与历史各轮一致，不称 UI 已人工验收。

### 6.2 提交、发布证据与剩余限制

本文为编辑性评估，无新增/实质修改可执行单元，不制造修复型 red test，也没有新的 80 代码行单元。文档经结构、链接、算术和证据交叉核查，没有专门的评估正确性自动验收器。

交付仍须正常 commit hooks 的完整静态、新前端/Rust 覆盖率、Sonar（Quality Gate OK、新代码 unresolved 0），再走既有 docs-only pre-push 与 #941 ub-mode 证据。最终 head 四项 CI 与实际完成 review 无未解决意见后，才按授权合并 develop。提交、CI、review、merge 和清理由本轮 PR 与任务记录承载，本文不预先断言成功。

功能回归和代码审查支持“所审路径没有确认新可扣分缺陷”，不支持穷尽安全/发布验收。未测范围见 1.2，UI 自动化不足不通过其他维度间接扣分。

## 七、后续处理与 issue 标准

1. 新增待修 issue 为 **0**，不创建重复、推测或已接受取舍的报告，不自动修产品。
2. 未来独立新问题按 [issue-standard](development/issue-standard.md) 的六标题、严重度标签、可验证验收及证据限制建档，说明共同根因去重。
3. pending 只由正常 hooks 产生与折并，保全原字节及前后证据，不伪造/导入历史、不调整门禁。
4. 下一轮重新冻结并独立评估，10.0 不是以后评分下限，“未发现”也不等于“没有缺陷”。
