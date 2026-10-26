# PlotWeave 设计与实现质量评估

评估日期：2026-10-27（第四轮）。本文评价软件架构、数据契约、状态与交互实现、可靠性及工程治理，不评价视觉美感，不新增产品合同。

**当前结论：9.5 / 10，A+（排除评估开始前全部已知 issue 的证据口径）。**

- **代码基线**：最新 `origin/dev` @ [`098602b7bf48b34cffb17cc94e7a4532a4234730`](https://github.com/hailingu/PlotWeave/commit/098602b7bf48b34cffb17cc94e7a4532a4234730)。取证和下文代码链接均固定于此版本；本次只改评估文档，不修复产品。
- **tracker 基线**：2026-10-27 本轮开始时完成全量分页快照，排除 PR 后共有 **441 条 issue，开放 0 条**（较第三轮快照新增 #903–#908 共 6 条——第三轮发现已全部处置关闭：#903/#904 经 PR #910（`c998e1d3`）修复，#905 经 PR #911（`0a7498ca`）修复，#906 经 PR #912（`8f324994`）以文档栈限定登记为 known-boundary，#907 经 PR #913（`2a03946c`）修复，#908 经 PR #914（`2918cb77`）以四处文档同步加测试钉住处置）。已知集合包括关闭报告，状态变化不重新产生扣分。快照时最新 issue 为 #908。
- **本轮新发现**：[#915](https://github.com/hailingu/PlotWeave/issues/915)–[#919](https://github.com/hailingu/PlotWeave/issues/919)，共 **5 项：3 项 P2、2 项 P3**；全部在起始快照之外建档，保留本轮扣分。
- **方法**：前端、Swift 原生、Rust/Tauri、工程治理四域只读审查（分域报告产出候选，全部候选须经主审复核方可计分）；主审先逐一复核第三轮 6 项发现的 5 个修复提交本体与配套测试/文档（修复完备性），再对全部候选发现独立复核关键代码、独立重跑纯函数探针、夹具与台账匹配，并做 tracker 去重（441 条全量快照）。没有把测试通过当作所有行为都已验证。
- **历史**：上一轮（2026-10-26 第三轮，[固定档案](https://github.com/hailingu/PlotWeave/blob/28b66dda2102f49a3765d0de37cbec88f28c6744/docs/quality-assessment.md)）为 9.6/A+，6 项发现 #903–#908 已全部处置并合入本基线；本轮逐项复核修复链完备后，在同一六维权重下评估当前基线的新缺口。

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
| 架构与模块边界 | 模块图守卫沿用、shell→feature 方向、原生动作复用生产控制器（零第二文档存储）、会话/缓存边界 | CI 架构守卫 + 双栈代码阅读 |
| 前端状态与交互 | 命令栈代次、大纲接缝计划器（含 #910 修复逐行复核与探针实测）、连线三层契约、加载归一化、保存管线水位、原生桥回执、面板/首页/设置/资产库/导出投影 | 分域探针（spine/outlineDrop 六场景、16 项聚焦测试）＋主审代码追踪；未做桌面拖放 |
| 原生桥接与生命周期 | #905 修复邻接入口（discardImport/deleteProject/saveProject/registerAlias/validateAsset/copyAssets）、退出屏障登记/退休、路由器缓存双界、媒体投递粒度、下载栈逐跳复验、信封判型跨栈对照 | 静态代码追踪；基线原生 CI；未重跑本机原生全套与运行时注入 |
| 持久化、安全与契约 | #906/#907 处置复核（含 #907 source() 链专项核查）、加载侧复验双栈、原子写/清扫/备份、列表抗脏、错误分类学、锁序、导入凭据生命周期 | 双栈代码追踪＋定向 cargo test（envelope 9 项、media_filter 6 项）＋serde_json 探针 |
| 测试与可靠性 | 修复回归覆盖审查、探针实测、覆盖率策略与 scripts 登记表闭环 | 断言审查与聚焦测试实跑，不把数量当行为验收 |
| CI、门禁与文档 | hooks/台账/证据链（台账匹配与核验器只读实测、worktree 夹具）、gate-scope 分类实测、ci.yml 供应链姿态、check:size、全仓链接检查、命令计数 | 配置／脚本审查＋git/GitHub 取证＋只读实测；远程保护状态仅文档可证 |

未执行无关压力实验、付费 Provider、公网 TLS、运行时 EMFILE/EIO 注入、深嵌套崩溃复现或安装发行验收。第六节列出命令与未执行项；覆盖范围限制置信度，不自动扣分。

## 二、综合结果

| 维度 | 权重 | 评分 | 评级 | 计分依据 |
| --- | ---: | ---: | --- | --- |
| 架构与模块边界 | 15% | 10.0 | A+ | 所有权和依赖守卫清楚；本轮合格新增扣分 0 |
| 前端状态与交互实现 | 20% | 10.0 | A+ | 命令栈/保存/归一化/原生桥复核无新缺陷；本轮合格新增扣分 0 |
| 原生 Swift 桥接与生命周期 | 20% | 9.5 | A+ | #916 P2 −0.5；#905 修复链与邻接入口复核无新缺陷 |
| 持久化、安全与数据契约 | 15% | 8.8 | A− | #915 P2 −1.0；#918 P3 −0.2 |
| 测试与可靠性工程 | 15% | 10.0 | A+ | 多层行为／合同／真实宿主回归；各缺口是根因解释，不重复扣测试分 |
| CI、门禁与文档维护 | 15% | 8.8 | A− | #917 P2 −1.0；#919 P3 −0.2 |
| **综合** | **100%** | **9.5** | **A+** | **已知问题全部排除后的本轮证据分，不是全量缺陷率或完整验收评级** |

计算：`10×15% + 10×20% + 9.5×20% + 8.8×15% + 10×15% + 8.8×15% = 9.54 → 9.5`。

历史 2026-10-13 为 9.1/A，10-18 为 8.9/A−，10-21 为 9.2/A，10-24 为 8.7/A−，10-26 第一轮为 9.8/A+，第二轮为 9.3/A，第三轮为 9.6/A+。不同轮次的已知集合、审查深度与计分细则不同，不能把 9.5 解释为相对第三轮下降 0.1 的全量质量测量：本轮把加载侧资产复验的错误分类（第三轮只审了 `openMedia`/库列表两个入口）、控制文件深度边界的剩余裸 Codable 入口（#840/#863/#889 之后的收尾面）与门禁台账的跨环境生命周期纳入了审查面。产品没有在本次文档任务中获得修复。

## 三、主要质量优点

### 3.1 第三轮 6 项发现的修复链完整、行为正确

- [#903/#904](https://github.com/hailingu/PlotWeave/pull/910)（`c998e1d3`）：[`planAt`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src/editor/outlineDrop.ts#L24-L36) 对整份计划的**每条新增边**复用 `connectionEndpointIssue` 端点契约；同组无其他 sequence 成员的组尾落点返回空计划，[`useOutlineDrop.ts` L171–176](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src/editor/useOutlineDrop.ts#L171-L176) 对空计划早退——不推历史、不改集、无横幅；原生 `editor.outlineMove` 与 web 拖放共用同一计划器，无旁路。分域以 `npx tsx` 加载生产 `spine.ts`/`outlineDrop.ts` 实测六场景（原位重放、分支锚点拒绝、同组空计划、跨组全游离组拒绝）逐项正确；`npx vitest run src/editor/outlineDrop.test.ts src/editor/spine.test.ts` 16 项全过。
- [#905](https://github.com/hailingu/PlotWeave/pull/911)（`0a7498ca`）：[`openMedia`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/NativeProjectMedia.swift#L72-L85) 仅在确证 `project_not_found` 时同时退役 pendingMedia/mediaAliases/importReceipts 三表，瞬时错误原样上抛；`NativeProjectMediaReadFailureTests` 以 `PW_STORAGE_ERROR`/`PW_STORAGE_LIMIT`/`PW_PROJECT_CORRUPT` 参数化钉住。主审复核同文件及邻接入口（`discardImport`、`verifySaveAssets`、`copyAssets`、`deleteProject`）均无同类吞没。
- [#906](https://github.com/hailingu/PlotWeave/pull/912)（`8f324994`）：按验收方案 b 在 [assets.md](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/docs/data-model/assets.md#L193-L195) 显式登记 Tauri 历史路径「不回滚、保留字节优先」的栈限定边界，与 #890 的 Swift 回滚契约分栈记载——known-boundary 处置完整。
- [#907](https://github.com/hailingu/PlotWeave/pull/913)（`2a03946c`）：[`transient_media_failure`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src-tauri/src/library.rs#L137-L146) 沿 `std::error::Error::source()` 链取 `io::ErrorKind`，仅 `NotFound` 归缺失，其余以 `[PW_LIBRARY_MEDIA_TEMPORARILY_UNAVAILABLE]` 保留条目。主审专项核查 `LibraryError`/`StoreError`/`AssetsError` 全部变体的 `source()` 实现：均返回底层 `io::Error`/`serde_json::Error`，无构造器把 io 错误拍平成 String，分流链完整；`cargo test --lib media_filter` 6 项实测通过。
- [#908](https://github.com/hailingu/PlotWeave/pull/914)（`2918cb77`）：AGENTS.md、cost.md、push.md、workflow.md 四处同步 `public/**` 归 frontend 的口径，[`gate-scope.test.ts` L21–22](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/scripts/gate-scope.test.ts#L21-L22) 以 `public/favicon.png` 钉住。
- PR #910/#911/#913 正文含不变量矩阵与验证命令；#912/#914 为文档/测试钉住变更（无生产代码），按规则不要求矩阵。五个 PR 均在同一提交内同步对应设计文档，无漂移残留。

### 3.2 多层契约对等与状态机防护（前端复核无新缺陷）

- 边契约三层对等：`graphRules.connectionEndpointIssue`（交互+AI）↔ `normalizeEdges` 孤儿隔离（加载）↔ 保存边界校验对同一批不变量逐条对齐，#903 后大纲接缝计划的新增边也纳入同一判定。
- 命令栈代次防护：`CommandStack.revision` 使在途重做被任何穿插操作（含 ABA 往返）失效；拒绝路径不传播迟到的旧失败（`history.ts`）。
- 「读到即最新」加载契约：`tauriLoad` 链静止/失败登记复验/读盘+链身份守卫三段循环，读盘后排队的新保存触发重启而非交付旧内容（`projectStore/tauri.ts`）。
- 保存管线固定点协调：防抖→在途串行→编辑序号水位→外部重存覆盖水位→四源退出屏障失败归属逐一复核（#849 探针口径沿用）。
- 原生意图传输防重放：SHA-256 指纹去重 + 序号退役水位 + 会话身份 + 处理器登记先于执行；原生编辑命令复用生产控制器的校验与历史，零第二文档存储，回执经 `flushSync` 确保下一条命令读到已提交状态。

### 3.3 双栈持久化内核与信任链

- 锚定句柄纪律彻底：`NativeDirectory` 全部子孙操作 descriptor 相对（`openat`/`fstatat`/`renameatx_np`），no-follow 归类 + `(dev,ino)` 身份绑定贯穿打开/删除/复制/导入复核；Rust 侧 `store/persist.rs` 同构。
- 原子写阶段序完整且可注入：`O_EXCL` 临时文件→写+fsync→重归类→`beforeCommit`→rename→目录 fsync（`NativeDirectory` + `NativeAtomicWriteFaults`；`persist.rs` + `faults.rs` 逐阶段故障注入支撑回归）。
- 损坏备份内核绝不覆盖证据：SHA-256 内容寻址、复用前身份+全字节比对、新建目标必须不存在（`damaged_backup.rs`，库/设置两域共用）。
- 库身份日志先行：导入在最终 rename 前把 `(dev,ino)` 连同 `importPending` 耐久写入 journal，恢复对含糊形态一律保留证据并暂停写入而非删除；删除日志可恢复提交协议（日志先于移动耐久落盘、隔离目录先于原目录 fsync、回迁用 `hard_link` 表达 no-replace）。
- 退出定点严密：库批次与导出交付均「accept 先于任务启动 + defer 无条件退休」，`finishQuit` 终批前复查三注册表；路由器回执缓存双界淘汰 + `retiredThrough` 单调防重放。
- 下载栈纵深（两栈对等）：逐跳 DNS 固定/策略复验（含重定向）、仅数值 IP 连接、定界 HTTP 解析器拒绝歧义 framing；Rust 图像下载并发上界与作业总预算，诊断输出先脱敏后截断。
- 信封判型对版本 0/未来值/规范整数串/异型值的接受集两栈逐例一致（#918 的浮点拼写是本轮发现的唯一分歧载体）。

### 3.4 工程约束有实际执行证据

- [基线 CI 40355863367](https://github.com/hailingu/PlotWeave/actions/runs/40355863367) 精确绑定 `098602b7`，frontend、rust、native 成功；gate-evidence 在 dev push 按规则 skipped，不称为执行通过。近 10 次 dev 运行无 job 失败（3 次 cancelled 均为并发取代）。
- `gate-tree-marker` 精确实现 #404/#429 合同（PID+lstart 绑定、双向年龄界定、命中即删）；`pre-push` 的规范性句子逐条落地（`GIT_NO_REPLACE_OBJECTS=1`、按唯一提交去重、删除 ref 跳过、慢路径 `PRE_PUSH_SCOPE_ESCALATED` 自动提升 full）；复用 LCOV fail-closed（对复用报告也要求非空且含覆盖记录）；临时索引检测按 PR #581 评审口径实现。
- CI 供应链姿态：全部 action 按 SHA 钉版、`permissions: contents: read`、gate-evidence 检出事件 base SHA 且不执行 PR-head 代码、`RELEASE_BOUNDARY` 仅在 base=main ∧ head=dev ∧ 同仓库时置位；`ci-npm-audit.sh` 与文档合同逐项一致。
- 机械可验口径一致：Node `24.18.0`、Rust `1.95.0`、Xcode/SDK `27.0`、版本 `0.3.0` 各处吻合；原生命令数 27+2 与五个 `enum Command`（9/7/5/3/3）加两条退出命令精确吻合；`npm run check:size` 通过（895 检查/66 排除/祖父条目 0）；scripts 覆盖率登记表无悬空（4/4 用例实跑通过）；全仓 50 个 Markdown、617 条相对链接仅 1 条断链（见 #919）。
- #903–#908 修复涉及的函数与文件均在 80 代码行/800 行/1800 行上限内（`outlineSplicePlan` 50 行、`list_assets_with_media` 55 行，主审清点）。

## 四、本轮扣分项与跟踪 issue

| Issue | 严重度 | 维度 | 实际影响 | 扣分 |
| --- | --- | --- | --- | ---: |
| [#915](https://github.com/hailingu/PlotWeave/issues/915) | P2 | 持久化、安全与数据契约 | 加载侧资产复验把瞬时 I/O 失败并入坏资产键，前端隔离后条目随下次保存从 `project.json` 持久消失，引用悬空、媒体成孤儿 | 1.0 |
| [#916](https://github.com/hailingu/PlotWeave/issues/916) | P2 | 原生 Swift 桥接与生命周期 | `library.json` 抢救解析与 `settings.json` 读取绕过 #840 深度预扫，400–512 层嵌套的脏文件在协作线程栈上令整个应用崩溃 | 0.5 |
| [#917](https://github.com/hailingu/PlotWeave/issues/917) | P2 | CI、门禁与文档维护 | 门禁待物化记录绑定运行环境 gitdir，一次性工作环境使版本化台账对连续 7 个任务提交停更且无任何诊断 | 1.0 |
| [#918](https://github.com/hailingu/PlotWeave/issues/918) | P3 | 持久化、安全与数据契约 | `schemaVersion` 浮点拼写（如 `1.0`）Rust 按表示拒绝、Swift 按值接受，同一文件两宿主行为相反 | 0.2 |
| [#919](https://github.com/hailingu/PlotWeave/issues/919) | P3 | CI、门禁与文档维护 | `assets.md` 引用 `media_protocol.rs` 的相对链接多一级 `..`，GitHub 上 404（全仓唯一断链） | 0.2 |

### 4.1 #915：加载侧资产复验吞瞬时 I/O 失败（本轮唯一数据丢失级 P2）

**代码事实**：Swift [`verifyAssets`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/NativeProjectStore.swift#L252-L260) 第 258 行以 `(try? projectDirectory(id: id).media(...)) == nil` 判坏键——`try?` 把 `media()` 抛出的一切错误（含 `NativeDirectory.ioError` 映射的 `PW_STORAGE_ERROR`：EMFILE/EIO/EACCES）与确证缺失同列；Rust [`unverifiable_asset_keys`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/crates/plotweave-core/src/store/validate.rs#L349-L364) 第 361 行以 `verify_asset_real_path(...).is_err()` 同构折叠，**两栈一致地错**。前端 [`tauri.ts`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src/projectStore/tauri.ts#L334-L350) 每次加载（含示例升级回写）调用 `verify_project_assets` 并交 `parseProject`；[`normalizeAssetRecords`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src/model/normalizeAssets.ts#L134-L146) 对返回键执行 `delete byId[key]`，警告文案写「缺失/符号链接/逃逸/保留隔离区」——假定的正是确证缺失语义。归一化文档成为会话真源，下一次防抖保存把不含该条目的 `assets.byId` 写回 `project.json`。

**对照与去重**：#883（库 `filterMedia`）、#905（`openMedia`）、#907（Tauri 库列表）已在三个入口确立并落地「瞬时失败不得并入缺失处置」，唯独加载侧复验双栈均未对齐——同一原则的第四个入口，按第三轮 #907 对 #883 的先例属新事实而非重复处罚。tracker 全量检索「verify_project_assets/复验/瞬时/invalidAssetKeys」无已知条目。

**影响与计分**：资产条目（id/relPath/mime/时间戳）从文档持久消失，分镜引用位悬空，媒体文件成无索引孤儿（#886 边界：无孤儿扫描，手动重导入是唯一恢复）。fd 压力态（#848 已证实现实可达）一次复验可把整项目全部资产一并上报，属单点环境故障放大。按「触发较窄但数据丢失类、可被单点环境故障放大且不可自愈」口径扣 1.0。**未验证**：运行时 EMFILE/EIO 注入（Swift→前端→保存三段代码链已闭合）。

### 4.2 #916：库索引抢救与设置读取绕过 #840 深度预扫

**代码事实**：[`NativeLibrarySalvage.parse`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/NativeLibrarySalvage.swift#L5-L23) 第 7 行与 `bucket` 第 14/16/20 行、[`NativePreferences.load`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/NativePreferences.swift#L74-L84) 第 79 行及 `backupDamaged` 第 110 行直接调用 `JSONDecoder().decode(HostJSON.self, …)`——不经 [`HostJSON.decode`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/HostJSON.swift#L38-L42)（回退 Codable 前先迭代式 `rejectNestingBeyondLimit`），也不走自带 `maxDepth=32` 的 `HostJSONParser`。`HostJSON.init(from:)` 逐层递归，Foundation 扫描只拒绝 513 层以上，400–512 层进入递归解包并在 512 KiB 协作栈上 SIGBUS（#840 探针实测：Release ≈400 层）。调用链每次图库操作必经（`NativeLibraryOperation.init` → `NativeLibraryIndex.init` L20 → `Salvage.parse`），偏好读取在启动即触发；`NativeLibrary`/`NativePreferences` 均为 actor（协作线程池）。Rust 侧 `serde_json` 自带 128 层上限返回错误不崩溃——Swift 独有缺口。

**归属与去重**：#840 修复 `a5ccb9bc` 把边界落在 `HostJSON.decode` 并宣称「512 KiB 协作线程栈上递归解包的栈溢出窗口由此关闭」，[persistence.md L83](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/docs/data-model/persistence.md#L83) 又明文列出「库索引、偏好…仍走 Codable 路径」；#863（桥信封）、#889（模型响应）是同族不同入口且均已单独立项处置——这两处用户控制文件是剩余未覆盖入口，且无任何文档把它们登记为保留边界。按 #889 先例属新入口事实。

**影响与计分**：单个脏文件令整个应用进程崩溃；`settings.json` 变体每次启动必崩直至手动删除。触发与 #840 同类（约 400+ 层嵌套的脏文件，所有者已接受该类为 P2）。窄触发 P2 扣 0.5。**未验证**：本轮运行时复现（崩溃阈值与栈环境引用 #840 的实测记录）。

### 4.3 #917：门禁台账待物化记录随一次性工作环境搁浅

**代码事实**：[`gate-history.sh` L43](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/scripts/gate-history.sh#L43) 与 [`sonar-quality-gate.sh` L42](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/scripts/sonar-quality-gate.sh#L42) 的待物化路径按 `git rev-parse --git-path` 解析——链接 worktree 下落在该 worktree 私有 gitdir；[`.githooks/pre-push` L53–L63](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/.githooks/pre-push#L53-L63) 已显式按 `$main_root` 补全并经 `PLOTWEAVE_GATE_PENDING_PATH` 把推送记录导回主队列（#405，证明「记录必须进主队列」是设计意图），提交侧没有同款对齐。`1a20f0f5`（PR #581）使推送不再物化，折并完全依赖同一 gitdir 的后继普通提交——单提交任务分支合并后即无后继，环境被丢弃时记录永久搁浅。

**主审实测**：台账匹配——最近 8 个本地任务提交（`98eeb2ea`→`2918cb77`）中仅 `4a33e65c` 有记录，其余 7 个 tree/head 零命中、台账行数恒 867；本克隆待物化文件仅 1 条推送记录（14:39:52Z，`head=4e6a7dd8`），7 个提交的记录从未进入本克隆。夹具实测——链接 worktree 中 `--git-path` 解析到 `.git/worktrees/<name>/`，`worktree remove` 后记录随 gitdir 删除。`node scripts/verify-gate-evidence.ts --base 343c3ab8 --head 2918cb77` 输出「范围 1 个提交，0 个有台账证据，tip 状态 lagging」并以 0 退出。

**影响与计分**：文档承诺「版本化台账滞后一个普通提交」、记录「仍在开发者机器上物化」（[quality-gate-evidence.md L46/L193/L546](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/docs/development/quality-gate-evidence.md#L46)），实测为无界滞后且无诊断。单提交 PR 的服务端核验空转是 L583–584 已记录边界，不重复计分，但也意味着没有任何机制能察觉停更。影响限于证据工件，产品代码与 CI 回归不受影响，可经原环境手工物化恢复。按普通路径 P2 扣 1.0（与 10-24 轮 #805 同量级）。**未验证**：7 个提交的实际来源环境（推测为另一克隆或已移除的 worktree）。

### 4.4 P3 项摘要

- **#918（schemaVersion 浮点拼写跨栈分歧）**：Rust [`parse_explicit_envelope`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/crates/plotweave-core/src/store/list.rs#L230-L241) 以 `n.as_u64()` 按表示判型——serde_json 把 `1.0`/`100.0`/`1e2` 解析为 f64 载荷，`as_u64()` 返回 `None` 即拒绝（仓库外探针以同版 serde_json 1.0.154 实测）；Swift [`NativeProjectEnvelope.parse`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/native/macos/App/NativeProjectEnvelope.swift#L25-L31) 以 `rounded() == version` 按值接受；前端 `JSON.parse` 亦按值。normalization.md 第 0 步「非安全整数」措辞按值读法与 Swift 一致，而 #650 又裁定 Rust 为磁盘合同基线——具体分歧实例未被 #338（异型非数值）或 #650（元问题）记录。同一文件 Tauri 显示损坏占位卡、Swift 正常打开，无数据丢失，P3 扣 0.2。
- **#919（唯一断链）**：[assets.md L187](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/docs/data-model/assets.md#L187) 的 `[media_protocol](../../../src-tauri/src/media_protocol.rs)` 多一级 `..`，GitHub 404（`9833adf1` 引入）；全仓 617 条相对链接中唯一断链，主审 `test -f` 两种路径对照确认，P3 扣 0.2。

## 五、排除项与未计分候选

### 5.1 已知报告全部排除

起始全量为 441 条、开放 0；“已知”不等于“开放”。包括 #801–#809、#829、#840、#844、#848–#866、#879、#882–#892 及 #903–#908 及其处置在内的历史报告均排除，不能因仍有保留边界或换措辞再扣分。全量快照请求与前三轮相同：

```sh
gh api --paginate --slurp 'repos/hailingu/PlotWeave/issues?state=all&per_page=100&sort=created&direction=asc'
```

原始快照 SHA-256：`81d00d902b2be76f155628bafb0329b68f34019553efdfd5a8a3d2b481dea3e6`。它标识当时取证文件，不把本地路径写成公开附件。#915–#919 创建晚于快照，属于本轮发现记录，不构成循环扣分。

### 5.2 有文档化处置、所有者范围与证据不足候选

- **同一库资产重复拖上同一分镜卡逐次全量拷贝**：[`bindAssetRefPatch`](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/src/editor/assetDrop.ts#L25-L32) 的去重域是项目资产 id（graph-model §4.2「引用位的唯一真相是 assetId」），而 ui-design.md §7.3 明文「拖上画布 = 拷贝进项目（新 id）」——每次 drop 铸新 id 后绑定，去重分支仅在命令重放时命中，与文档语义一致；姊妹路径 `entityDrop` 按 label 去重是因设定实体没有资产 id，两域不同不构成不一致。是否按库源去重属产品决策，不计分、不立项。
- **项目复制原样复制 `projects/{id}/assets/` 内崩溃遗留的媒体原子写临时文件**：[persistence.md L84](https://github.com/hailingu/PlotWeave/blob/098602b7bf48b34cffb17cc94e7a4532a4234730/docs/data-model/persistence.md#L84) 已把「媒体临时文件暂不清扫，积累速率低」登记为记录边界；复制传播是该边界的下游后果，不再立新项。
- **Rust 导入凭据（每凭据 2 个 fd）在保存持续失败的会话中随导入累积**：与第三轮 5.2 对 #886「凭据 fd 常驻」的排除同口径——需要多批次未保存导入叠加保存持续失败，无普通操作下的现实路径，不从机制推导扣分。
- **#917 的「单提交 PR 服务端核验空转」部分**：quality-gate-evidence.md L583–L584 已明文「A single-commit bypass PR that preserves its parent ledger surfaces only the tip warning」，属已记录边界；本项只对未记录的「记录搁浅 + 台账停更 + 无诊断」计分。
- **`NativeLibrary.execute` 只读列表也无条件确保 `library/assets/` 存在**：与 Rust 侧「读不创建」存在跨栈差异，但 assets.md L135 明文两栈不统一索引持久化策略，且该创建是 journal 恢复的前置条件、无数据危害——已文档化跨栈差异，不立发现。
- 其余经完整读函数复核排除的分域候选：`atomicWrite` 非替换竞态错误码分类（仅外部并发可达，出威胁模型）、媒体方案瞬时打开失败显示 404（展示级可重试，弱于 #907 已计分口径）、`NativeSeal.probeMachineMaterial` 失败不缓存重复 spawn（性能债无现实痛点）、`read_index_capped` 读路径回写归一化结果（PR #33 评审确立的刻意设计）、清扫误删在途临时文件（三条件 + 操作锁串行）、`damaged_backup` 覆盖旧备份（目标必须不存在）、库锁/项目锁死锁（全仓单向获取）、生产路径 `unwrap/expect`（均在构建期配置或定形响应）、provider 响应 Rust 深度（serde_json 自带 128 层上限）、`aiRevision` 浮点拼写（经 webview JSON 往返自愈）、连线确定性 id 复用（undo/redo 序列推演一致）、`useNodePatch` 级联 undo 整组恢复（LIFO 前态恰等于快照）、`EpisodeField` 输入 `0` 瞬时钳位（中间值合并同一撤销步）。
- TypeScript／Rust／Swift 共存、双宿主、原生覆盖率 report-only、统一提交门禁成本、文档化 hook 覆盖边界、工具链钉版、80 代码行评审制：所有者决策，不扣分。
- **UI 自动化方案不足完全不扣分**，不通过“测试成熟度”“发布信心”等同义理由间接扣减。真实 IME、系统面板、视觉、签名公证、安装包、付费模型、公网 TLS 未测只列限制。
- 没有因本轮未执行某套测试、没有新 issue，或历史抖动已经修复而扣分。

## 六、验证记录与置信度

### 6.1 本轮实际执行

除只读 Git／tracker／GitHub 查询外，验证均在主工作树只读执行（未改源文件、索引与 pending；唯一写入为仓库外 `/tmp` 探针与夹具），Node 为 **24.18.0**：

| 命令／检查 | 实际结果与边界 |
| --- | --- |
| `gh api --paginate --slurp`（issue 全量快照） | 441 条非 PR、开放 0、最大 #908；SHA-256 见 5.1；5 项发现的去重检索基于该快照全文 |
| `git show`（5 个处置提交逐项复核） | `c998e1d3`/`0a7498ca`/`8f324994`/`2a03946c`/`2918cb77` 的代码与配套测试/文档变更全部主审阅读；修复本体完备，#906 为文档栈限定处置 |
| `gh pr view` #910–#914 | PR 正文验证命令齐全；#910/#911/#913 含不变量矩阵；#912/#914 无生产代码变更不要求矩阵 |
| `npx tsx` 加载生产 `spine.ts`/`outlineDrop.ts`/`assetDrop.ts` 探针 | 六组拓扑场景（原位重放、分支锚点 #903 校验拒绝、#904 同组空计划、跨组全游离组拒绝、`bindAssetRefPatch` 新副本/同 id）输出逐项符合预期 |
| `npx vitest run src/editor/outlineDrop.test.ts src/editor/spine.test.ts` | 2 文件、16 项全部通过——#910 修复回归为绿 |
| `cargo test -p plotweave-core envelope`／`cargo test --lib media_filter` | 9 项与 6 项全部通过（信封判型现向量、#907 分流回归） |
| serde_json 行为探针（`/tmp` 临时工程，1.0.154 同版） | `1.0`/`100.0`/`1e2` 的 `as_u64()` 均为 `None`——#918 实测依据 |
| 台账匹配（node 探针 + `git rev-parse <c>^{tree}`） | 最近 12 个非合并提交逐个比对 tree/head；7 个任务提交零命中、台账行数恒 867——#917 实测依据 |
| worktree 夹具（`/tmp` 新建仓库） | 链接 worktree 中 `--git-path` 解析到 `.git/worktrees/<name>/`，`worktree remove` 后记录消失——#917 机制实测 |
| `node scripts/verify-gate-evidence.ts`（只读） | PR #914 范围「0 个有台账证据，tip 状态 lagging」退出码 0；多提交历史范围同形 |
| node 只读调用 `scripts/gate-scope-core.ts` 分类函数 | `src/**`/`public/**`/前端根配置 → frontend；`docs/**`/README/AGENTS/LICENSE/台账 → docs；`native/**` → native；Rust 双仓 → rust；混合/未知/根配置 → full——与 AGENTS.md 逐条一致，`public/` 钉住用例在位 |
| [CI 40355863367](https://github.com/hailingu/PlotWeave/actions/runs/40355863367) | headSha 与代码基线完全一致，frontend/rust/native 成功；gate-evidence 在 dev push 按规则 skipped；近 10 次 dev 运行无 job 失败 |
| `npm run check:size`、`npx vitest run scripts/scripts-coverage-scope.test.ts` | 895 检查/66 排除/0 祖父通过；登记表 4/4 无悬空 |
| 全仓链接检查（node，50 文件/617 链接） | 唯一断链即 #919；锚点按 GitHub slug 规则核验 |
| Sonar 服务可达性 | `http://localhost:9000` 状态 UP（26.8.0）——后续提交门禁前提 |

未执行：桌面拖放与磁盘重开链路（#915/#916 的 UI 接线为静态确认，计划层/解码层已探针或代码闭合）、运行时 EMFILE/EIO 注入（#915 代码链闭合）、深嵌套崩溃运行时复现（#916 引用 #840 实测）、本机原生全套与全量 `npm test`/`cargo test`（沿用基线 CI 与提交门禁）。四域审查覆盖面广，但 5 项发现的可信度分级以各 issue 的「验证情况」为准。

提交仍须由正常 hooks 完整执行静态检查、新前端／Rust 覆盖率和 Sonar；文档 push 按既有路由执行 `check-docs.sh`。提交、最终 PR head、required CI、review 和合并结果由该 PR 的实际记录提供，本文不提前写成通过。没有新增或实质修改可执行单元，80 代码行规则不适用于本文档改动；台账只允许正常钩子附加。

### 6.2 汇总来源、分歧与限制

四域审查来源为 `frontend`（前端状态与交互）、`native`（Swift 桥／生命周期／服务）、`rust`（Rust/Tauri／持久化）、`tooling`（CI／门禁／文档），主审对 5 项计分发现全部独立复核代码并重跑探针/夹具/台账匹配，无仅凭分域报告采信的扣分；分域另报的 11 项候选经主审复核排除（见 5.2，其中「重复拖入逐次拷贝」「复制传播临时文件」「凭据 fd 累积」三项为文档化语义/边界或机制推导）。#915/#916/#917 机制均代码链闭合（#915 双栈折叠点与前端删除点、#916 四处裸解码与调用链、#917 路径解析与台账/夹具实测）；#915/#916 的触发概率为低但现实可达（#848/#840 分别背书 fd 压力与深嵌套脏数据的可触达性）。#917 的成因环境属推测，可证事实（台账停更、pending 单条、夹具机制）不受影响。事实与覆盖见第一、三、六节；用户排除条件属于项目约束，不当作测试结果。不以投票平均产生结论，不把缺少新问题改写为“证明没有问题”。

## 七、后续处理与 issue 标准

1. 建议处置顺序：[#915](https://github.com/hailingu/PlotWeave/issues/915)（P2，持久化丢失、双栈对齐）优先，[#917](https://github.com/hailingu/PlotWeave/issues/917)（P2，需先定记录队列对齐或替代诊断的设计，属所有者决策）次之，[#916](https://github.com/hailingu/PlotWeave/issues/916)（P2，崩溃类窄触发，改走 `HostJSON.decode` 即可收口）随后；P3 项按所有者排期，其中 #918 需先定「按值」还是「按表示」口径再动代码，#919 为最小文档修复。
2. `issue-standard.md` 的通用验收标准要求经本轮继续核实有效：5 个新 issue 均按缺陷六标题建档并附可验证验收标准与去重说明，标签与标题严重度一致。
3. 下一轮重新固定代码与已知集合，#915–#919 全部作为已知项排除；修复后引用实际提交及验证，不直接推算分数。历史档案和本轮取证边界继续保留。
