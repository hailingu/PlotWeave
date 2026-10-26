# PlotWeave 设计与实现质量评估

评估日期：2026-10-26（同日第二轮）。本文评价软件架构、数据契约、状态与交互实现、可靠性及工程治理，不评价视觉美感，不新增产品合同。

**当前结论：9.3 / 10，A（排除评估开始前全部已知 issue 的证据口径）。**

- **代码基线**：最新 `origin/dev` @ [`f6ea7194a90425c8864954b5e30adcd6b7d12c9e`](https://github.com/hailingu/PlotWeave/commit/f6ea7194a90425c8864954b5e30adcd6b7d12c9e)。取证和下文代码链接均固定于此版本；本次只改评估文档，不修复产品。
- **tracker 基线**：2026-10-26 08:08 UTC 完成全量分页快照，排除 PR 后共有 **424 条 issue，开放 0 条**（较第一轮快照新增 #880/#881 两个 PR 与 #879 的关闭处置）。已知集合包括关闭报告，状态变化不重新产生扣分。最新 issue 为 #879。
- **本轮新发现**：[#882](https://github.com/hailingu/PlotWeave/issues/882)–[#892](https://github.com/hailingu/PlotWeave/issues/892)，共 **11 项：2 项 P2、9 项 P3**；全部在起始快照之外建档，保留本轮扣分。
- **方法**：前端、Swift 原生、Rust/Tauri、工程治理四域只读审查，主审对全部 11 项发现逐一复核关键代码、独立重跑纯函数探针并做 tracker 去重。没有把测试通过当作所有行为都已验证。
- **历史**：上一轮（同日第一轮，[固定档案](https://github.com/hailingu/PlotWeave/blob/171e43d73cd0e56a4257e8965c01c8ec359576c4/docs/quality-assessment.md)）为 9.8/A+，唯一扣分项 #879 已由 PR #881（`0a931755`）修复并合入本基线；本轮探针与聚焦测试（36 项通过）确认插入接缝替换与原位重放行为正确，[NativeProductionLifecycleTests](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/Tests/NativeProductionLifecycleTests.swift) 钉住落盘拓扑往返。该修复的拔出侧残余缺口是本轮 [#882](https://github.com/hailingu/PlotWeave/issues/882)。

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
| 前端状态与交互 | 接缝计划器（含 #879 修复逐行复核）、撤销/重做、连线规则、加载归一化、大纲拖放映射、资产导入撤销 | 主审独立探针（生产模块实测）＋代码追踪；未做桌面拖放 |
| 原生桥接与生命周期 | 回执缓存双界、会话切换、退出屏障、时间戳缓存、深度边界入口清点、凭据事务、模型响应解析 | 代码追踪；基线原生 CI；未重跑本机原生全套 |
| 持久化、安全与契约 | #848/#850/#851/#864 修复完备性复核、原子写与清扫白名单、操作锁序、谓词一致性、复制过滤、Swift 库索引校验 | 双栈代码追踪；基线 Rust CI；未做 fd/IO 运行时注入 |
| 测试与可靠性 | 新增拓扑/生命周期断言审查、修复回归覆盖、覆盖率策略、契约测试钉住范围 | 断言审查与聚焦测试实跑，不把数量当行为验收 |
| CI、门禁与文档 | hooks、scoped push 提升链、台账边界、ci.yml、脚本/文档交叉引用与计数、基线四 job | 配置／脚本审查＋git 取证；远程保护状态仅文档可证 |

未执行无关压力实验、付费 Provider、公网 TLS、运行时 EMFILE/EIO 注入或安装发行验收。第六节列出命令与未执行项；覆盖范围限制置信度，不自动扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 | 计分依据 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 10.0 | A+ | 所有权和依赖守卫清楚；本轮合格新增扣分 0 |
| 前端状态与交互实现 | 20% | 8.4 | B+ | #882 P2 −1.0；#884/#885/#886 P3 各 −0.2 |
| 原生 Swift 桥接与生命周期 | 20% | 9.6 | A+ | #889/#890 P3 各 −0.2；回执缓存与退出屏障复核无新缺陷 |
| 持久化、安全与数据契约 | 15% | 8.6 | A− | #883 P2 −1.0；#887/#888 P3 各 −0.2 |
| 测试与可靠性工程 | 15% | 10.0 | A+ | 多层行为／合同／真实宿主回归；各缺口是根因解释，不重复扣测试分 |
| CI、门禁与文档维护 | 15% | 9.6 | A+ | #891/#892 P3 各 −0.2 |
| **综合** | **100%** | **9.3** | **A** | **已知问题全部排除后的本轮证据分，不是全量缺陷率或完整验收评级** |

计算：`10×15% + 8.4×20% + 9.6×20% + 8.6×15% + 10×15% + 9.6×15% = 9.33 → 9.3`。

历史 2026-10-13 为 9.1/A，10-18 为 8.9/A−，10-21 为 9.2/A，10-24 为 8.7/A−，10-26 第一轮为 9.8/A+。不同轮次的已知集合、审查深度与计分细则不同，不能把 9.3 解释为相对第一轮下降 0.5 的全量质量测量：第一轮对当时合入前夜的修复链路覆盖更深，本轮对拔出侧、库索引错误分流、导入事务与隔离区生命周期等第一轮未展开的角落覆盖更深。产品没有在本次文档任务中获得修复。

## 三、主要质量优点

### 3.1 架构与编辑所有权有可执行约束

- [`moduleGraph.test.ts`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/moduleGraph.test.ts) 检查运行时与编译期无环、模型纯度、shell→editor 方向，不只靠目录命名分层。
- [`useNativeEditorShell.ts`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/nativeCanvas/useNativeEditorShell.ts) 绑定项目身份并在原生回执前提交共享状态；[`NativeApplicationState.swift`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeApplicationState.swift) 过滤会话和单调投影。Swift 消费投影和提交意图，React 保留唯一文档与历史；原生大纲与 web 大纲委托同一计划器，无双实现漂移。

### 3.2 #879 修复本体正确，原生桥与退出无沿用缺口

- 插入接缝按端点对移除（`spliceEdgesWith` 全部同端点对）、环检测基于真正保留的边集、原位重放零变更——本轮主审探针逐项复核通过（第六节）。
- [`HostCommandRouter.swift`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/HostCommandRouter.swift) 回执缓存在身份（≤4096）与字节（≤8 MiB）双界均有容量淘汰，退役水位与项目身份校验阻断旧回执跨会话/跨项目复用；三类退出任务在 MainActor 同步块内登记与复核，未发现已入飞行但未登记的任务类型。
- [`NativeTimestampParsing.swift`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeTimestampParsing.swift) 缓存格式器经互斥锁保护，1583–9999 纪元护栏避免 ICU 历法分歧，#858/#824 修复正确。

### 3.3 持久化和安全边界保护实际数据

- Rust [`persist.rs`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/crates/plotweave-core/src/store/persist.rs) 排他临时文件、同步、提交前复核、rename 与父目录屏障；#848 的句柄释放修复经复核在两轮复验全部路径（含错误路径）完备，`asset_fd_tests` 以真实 RLIMIT_NOFILE 子进程钉住。
- #850（凭据回执竞态）、#851（Tauri 库列表隔离）、#864（导入隔离事务）修复经复核完整覆盖其声称范围；操作锁库→项目单向嵌套无反序；加载契约无字段静默丢弃（六键全量、`raw_description` 保真、未来版本拒绝而非重写）。
- Swift [`NativeDirectory.swift`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeDirectory.swift) no-follow 归类、身份绑定、耐久原子写；[`NativePublicDownload.swift`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativePublicDownload.swift) 逐跳 HTTPS/DNS/期限校验。`metadata` 把缺失与 I/O 失败设计为不同状态（该意图未被 #883 指出的调用方使用）。

### 3.4 工程约束有实际执行证据

- [基线 CI 40286297528](https://github.com/hailingu/PlotWeave/actions/runs/40286297528) 精确绑定 `f6ea7194`，frontend、rust、native 成功；gate-evidence 在 dev push 按规则 skipped，不称为执行通过。
- `#829/#805/#855–#857` 的门禁修复经复核完备：宿主路径传递、慢路径提升 full（`PRE_PUSH_SCOPE_ESCALATED`，先于范围分派）、脚本 TS 编译与 lint 覆盖均有契约测试钉住；台账在 amend、路径受限提交、push 后折叠等现实序列上无丢失或重复。
- 文档交叉引用机检全部锚点可解析；原生命令计数 27+2 在四处文档一致；scripts 覆盖率地板注册表与磁盘清点守卫闭环，新文件未分类即失败。

## 四、本轮扣分项与跟踪 issue

| Issue | 严重度 | 维度 | 实际影响 | 扣分 |
| --- | --- | --- | --- | ---: |
| [#882](https://github.com/hailingu/PlotWeave/issues/882) | P2 | 前端状态与交互 | 大纲重排产生重复平行边，下次加载被隔离、邻居被拒拖 | 1.0 |
| [#883](https://github.com/hailingu/PlotWeave/issues/883) | P2 | 持久化、安全与数据契约 | 瞬时 I/O 错误被并入缺失，库索引元数据被读取路径永久删除 | 1.0 |
| [#884](https://github.com/hailingu/PlotWeave/issues/884) | P3 | 前端状态与交互 | 非剧情流锚点显示插入指示但静默无效果 | 0.2 |
| [#885](https://github.com/hailingu/PlotWeave/issues/885) | P3 | 前端状态与交互 | 分叉锚点接缝按边数组序选取，与大纲显示邻接不一致 | 0.2 |
| [#886](https://github.com/hailingu/PlotWeave/issues/886) | P3 | 前端状态与交互 | 导入撤销后隔离授权未行使，副本永久孤儿 | 0.2 |
| [#887](https://github.com/hailingu/PlotWeave/issues/887) | P3 | 持久化、安全与数据契约 | 导入源 relPath 谓词与全体消费者不一致（纵深防御） | 0.2 |
| [#888](https://github.com/hailingu/PlotWeave/issues/888) | P3 | 持久化、安全与数据契约 | 项目复制携带 `.trash` 隔离区内容 | 0.2 |
| [#889](https://github.com/hailingu/PlotWeave/issues/889) | P3 | 原生 Swift 桥接与生命周期 | 模型服务响应解析缺深度预扫（网络信任边界） | 0.2 |
| [#890](https://github.com/hailingu/PlotWeave/issues/890) | P3 | 原生 Swift 桥接与生命周期 | 导入凭据登记与媒体提交不原子，失败窗留不可隔离副本 | 0.2 |
| [#891](https://github.com/hailingu/PlotWeave/issues/891) | P3 | CI、门禁与文档维护 | 门禁成本文档未同步 #805 慢路径自动提升 | 0.2 |
| [#892](https://github.com/hailingu/PlotWeave/issues/892) | P3 | CI、门禁与文档维护 | 门禁脚本注释引用已删除的覆盖率基线数字 | 0.2 |

### 4.1 #882：拔出缝合未查既有直连边

**代码事实**：[`spine.ts` L128–134](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/spine.ts#L128-L134) 拔出 X 时无条件 `adds.push({source: prev, target: next})`，不检查 `remaining` 是否已含同端点对；插入侧接缝移除（L146–151）是按端点对 `.filter` 全删，两侧不对称。[`useOutlineDrop` L126–131](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/useOutlineDrop.ts#L126-L131) 逐条应用 adds，无重复检查；[`useConnectionRules` L37–70](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/useConnectionRules.ts#L37-L70) 允许手绘"捷径"直连边（仅拒自环/精确重复/成环）；[`normalizeEdges` `isolateDuplicateEdges`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/model/normalizeEdges.ts#L309-L325) 在加载时隔离逻辑重复边。

**主审独立实测**（Node 24.18.0，`npx tsx` 直接加载生产 `src/editor/spine.ts`）：

| 输入 | 操作 | 实际最终边 |
| --- | --- | --- |
| 干净图 `P→X、X→N、P→N(手绘)、Q→M` | X 拖到 M 后 | `M→X、P→N、`**`P→N`**`、Q→M` |
| #879 存量形状 `A→B、B→C(旧捷径)、C→D、B→X、X→C` | X 拖到 C 后 | `A→B、B→C、`**`B→C`**`、C→X、X→D` |

**影响**：会话内平行重复边（重叠渲染、重复计数）；保存重开后被 `isolateDuplicateEdges` 静默隔离并警告——会话内编辑被加载管线撤销；邻居变为多入/多出成员，再次拖拽命中 #589 拒绝。两种进入方式均为普通操作：手绘捷径边是合法画布编辑；#879 缺陷窗口（2026-08-27 至 2026-10-26）内保存的存量项目重拖即触发。一步 undo 可恢复，按可恢复 P2 扣 1.0。

**去重与边界**：#879 是插入侧保留旧直连（干净线性链产生捷径），本项是拔出侧缝合新增重复（既有直连时产生平行重复），代码位置、触发与结果均不同；#589 是被拖成员侧拒绝。基线 36 项聚焦测试通过——修复自身用例为绿，缺口是未覆盖场景，按口径不另扣测试分。**未验证**：桌面拖放与磁盘重开链路。

### 4.2 #883：库索引把瞬时 I/O 错误并入缺失

**代码事实**：[`NativeLibraryOperation.swift` L89–100](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeLibraryOperation.swift#L89-L100) `filterMedia` 在每次库操作（含只读列表）的锁内全量校验，单一 `catch` 不区分错误类别即 `removeValue` + 警告 + `index.changed = true`；L31–34 随即把删除持久化写回 `library.json`。而 [`NativeDirectory.swift` L26–27](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeDirectory.swift#L26-L27) 的 `metadata` 已把 ENOENT（缺失）与其余 errno（EMFILE/EIO/EACCES，L82–86 `openFile` 同理）设计为不同状态——区分能力存在但未被使用。

**影响与计分**：库索引条目（名称/类型/标签/分组，别处无副本）被永久删除并落盘，媒体字节成为无引用孤儿且无恢复入口；EMFILE 突发（#848 已在兄弟保存流证实同类 fd 压力可现实达到）下一次列表可清空全部条目，属威胁模型明列的"单点故障放大为列表全局受损"。触发需环境性故障（窄），但影响非局部且不可恢复（元数据丢失），按 1.0 计。**未验证**：运行时 EMFILE/EIO 注入。

### 4.3 P3 项摘要

- **#884/#885（大纲拖放锚点语义）**：`rowDragOver` 对所有 `level<3` 行显示可落指示（[`LeftPanel.tsx` L104–112](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/panels/LeftPanel.tsx#L104-L112)），但非剧情流锚点计划返回 null 后 [`useOutlineDrop` L118](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/useOutlineDrop.ts#L118) 静默返回——与 #589 确立的"拒绝须可见提示"原则不一致；分叉锚点的 downstream 由 [`insertionNeighbors`](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/spine.ts#L70-L91) 按边数组序 `.find` 选取，主审探针证实删除的接缝与大纲显示邻接无关联（`[A→B,B→C,B→Q,C→D]` 拖 X 到 B 后恒删数组首条 `B→C`），#879 修复使其具有删除既有边的持久影响。
- **#886（导入撤销孤儿）**：[`useLibraryAssetDrop.ts` L108–117](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src/editor/useLibraryAssetDrop.ts#L108-L117) 的 undo 只恢复引用，`discardImport` 三个调用点全为拖放拒绝路径；redoGuard 依赖文件存在，处置需权衡 undo→redo 窗口——需要所有者定夺，故立 P3 而非直接修复。
- **#887/#888（隔离区谓词与复制）**：[`assets.rs` L74](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/src-tauri/src/assets.rs#L74) 是全体 relPath 消费者中唯一用非活跃谓词（保留 `.trash`）的位置，当前不可触发、按纵深防御 P3 记录；[`copy.rs` L144–181](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/crates/plotweave-core/src/store/copy.rs#L144-L181) 递归复制含 `.trash` 在内的全部子目录到副本（Rust 与 Swift 原生 `copyAssets` 行为一致），惰性但空间随复制链放大。
- **#889/#890（原生信任边界与事务）**：[`NativeModels.swift` L167–174](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeModels.swift#L167-L174) 提供者网络响应直接递归 `Codable` 解包，#840/#863 建立的深度预扫未覆盖该入口（触发需异常端点，崩溃为全应用）；[`NativeProjectMedia.swift` L18–26](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/native/macos/App/NativeProjectMedia.swift#L18-L26) 媒体提交与凭据登记不原子，极窄失败窗留下 #864 路径无法隔离的副本（`NativeDirectory.directory(create:)` 已有同文件回滚先例）。
- **#891/#892（文档与注释漂移）**：[`quality-gate-cost.md` L150–166](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/docs/development/quality-gate-cost.md#L150-L166) 的 scoped push 章节停留在 #805 之前口径（`git show d6464241 --stat` 证实该修复只改 push.md 与钩子），人工边界指令已被 `PRE_PUSH_SCOPE_ESCALATED` 自动化取代；[`sonar-quality-gate.sh` L104–105](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/scripts/sonar-quality-gate.sh#L104-L105) 注释引用的前端 98.13% 在 `typescript-standard.md` 中已不存在（PR #670/`71e400e2` 移除数字时未触脚本，`--stat` 证实）。两者均不影响行为。

## 五、排除项与未计分候选

### 5.1 已知报告全部排除

起始全量为 424 条、开放 0；“已知”不等于“开放”。包括 #801–#809、#829、#840、#844、#848–#866、#879 及其处置在内的历史报告均排除，不能因仍有保留边界或换措辞再扣分。全量快照请求与第一轮相同：

```sh
gh api --paginate --slurp 'repos/hailingu/PlotWeave/issues?state=all&per_page=100&sort=created&direction=asc'
```

原始快照 SHA-256：`64cf9be299f85b1729a9d91f4f69885575e05ed45738af04f14b20736678044f`。它标识当时取证文件，不把本地路径写成公开附件。#882–#892 创建晚于快照，属于本轮发现记录，不构成循环扣分。

### 5.2 有文档化处置、所有者范围与证据不足候选

- `projects/{id}/assets/` 媒体临时文件不在清扫白名单：[persistence.md §10.2](https://github.com/hailingu/PlotWeave/blob/f6ea7194a90425c8864954b5e30adcd6b7d12c9e/docs/data-model/persistence.md) 已记录"积累速率低、暂不清扫"的处置；与 #722/#818（会话临时文件已修复）的不对称仅作记录提示，不立缺陷。若所有者想对齐处理，可在 #888 处置时一并考虑。
- 本地小载荷直解 `Codable`（Preferences/Salvage）、`NativeProjectEnvelope.now()` 每次保存重建 DateFormatter、`copyContents` 整文件进内存（≤256 MiB 瞬时）、`removeTree` 逐条 fsync：均无普通操作下的用户可感知机制或现实失败证据，按口径不从机制推导性能扣分。
- `gate-scope` 前端根配置集合在 push 文档中未逐一枚举：行为有契约测试钉住（`package.json`/`vite.native-canvas.config.ts` 归 full）且方向保守（多检不少检），属文档欠规格而非误导性声明，不计分。
- TypeScript／Rust／Swift 共存、双宿主、原生覆盖率 report-only、统一提交门禁成本、文档化 hook 覆盖边界、工具链钉版：所有者决策，不扣分。
- **UI 自动化方案不足完全不扣分**，不通过"测试成熟度""发布信心"等同义理由间接扣减。真实 IME、系统面板、视觉、签名公证、安装包、付费模型、公网 TLS 未测只列限制。
- 没有因本轮未执行某套测试、没有新 issue，或历史抖动已经修复而扣分。

## 六、验证记录与置信度

### 6.1 本轮实际执行

除只读 Git／tracker 查询外，验证均在主工作树只读执行（未改源文件、索引与 pending），Node 为 **24.18.0**：

| 命令／检查 | 实际结果与边界 |
| --- | --- |
| `gh api --paginate --slurp`（issue 全量快照） | 424 条非 PR、开放 0、最大 #879；SHA-256 见 5.1；11 项发现的去重检索基于该快照全文 |
| `npx tsx` 加载生产 `src/editor/spine.ts` 探针 | 五组输入（干净图手绘捷径、#879 存量形状、分叉锚点、游离锚点、原位重放）输出完整最终边集与 `isForkOrMergeMember` 判定，支撑 #882/#884/#885；未复制算法、未改生产函数 |
| `npx vitest run src/editor/spine.test.ts src/editor/outlineDrop.topology.test.ts src/editor/useOutlineDrop.test.tsx` | 3 文件、36 项全部通过——#879 修复自身用例为绿，扣分项均为未覆盖场景 |
| 固定版本代码阅读 | spine.ts、useConnectionRules、useOutlineDrop、LeftPanel（拖放段）、normalizeEdges、NativeLibraryOperation、NativeDirectory、NativeModels、NativeProjectMedia、NativeProjectImportDiscard、useLibraryAssetDrop、assets.rs、copy.rs、journal_io.rs（谓词）、quality-gate-cost/push、sonar-quality-gate.sh、issue-standard.md；11 项发现的关键代码均由主审本人复核 |
| `git show d6464241 --stat` / `git show 71e400e2 --stat` | 证实 #805 修复未触 cost.md、PR #670 未触门禁脚本——#891/#892 的"新漂移而非重复处罚"依据 |
| [CI 40286297528](https://github.com/hailingu/PlotWeave/actions/runs/40286297528) | headSha 与代码基线完全一致，frontend/rust/native 成功；gate-evidence 在 dev push 按规则 skipped |

未执行：桌面拖放与磁盘重开链路（#882/#884/#885 的 UI 接线为静态确认）、EMFILE/EIO 运行时注入（#883/#890 代码链已闭合）、本机原生全套与 Sonar 重跑（沿用基线 CI 与提交门禁）。四域只读审查覆盖面广，但 11 项发现的可信度分级以各 issue 的“验证情况”为准。

提交仍须由正常 hooks 完整执行静态检查、新前端／Rust 覆盖率和 Sonar；文档 push 按既有路由执行 `check-docs.sh`。提交、最终 PR head、required CI、review 和合并结果由该 PR 的实际记录提供，本文不提前写成通过。没有新增或实质修改可执行单元，80 代码行规则不适用于本文档改动；台账只允许正常钩子附加。

### 6.2 汇总来源、分歧与限制

四域审查来源为 `frontend`（前端状态与交互）、`native`（Swift 桥／生命周期／服务）、`rust-tooling`（Rust/Tauri／持久化／工程治理），主审（primary）对 11 项发现全部独立复核代码并重跑探针，无仅凭分域报告采信的扣分。#882 与 #883 为高置信度（探针实测／代码链闭合＋设计意图注释佐证）；#886/#890 的处置方向含设计权衡（redo 依赖、回滚顺序），立 P3 交所有者定夺而非直接认定修复方案。事实与覆盖见第一、三、六节；用户排除条件属于项目约束，不当作测试结果。不以投票平均产生结论，不把缺少新问题改写为“证明没有问题”。

## 七、后续处理与 issue 标准

1. 建议处置顺序：[#882](https://github.com/hailingu/PlotWeave/issues/882)、[#883](https://github.com/hailingu/PlotWeave/issues/883)（P2，含存量数据进入路径）优先；P3 项按所有者排期，其中 #886/#890 含设计权衡（redo 依赖、事务顺序），处置时先定规则再动代码。
2. `issue-standard.md` 的通用验收标准要求（"Every new issue MUST include explicit, testable acceptance criteria"，PR #880 引入）经本轮核实已在位：缺陷六标题下 Evidence 内必填验收标准、known-boundary 在 Disposition 区分边界验证与实现提案。本轮 11 个 issue 均按该标准建档，无需再改该文档。
3. 下一轮重新固定代码与已知集合，#882–#892 全部作为已知项排除；修复后引用实际提交及验证，不直接推算分数。历史档案和本轮取证边界继续保留。
