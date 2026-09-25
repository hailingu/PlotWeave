# 数据模型：持久化

[返回数据模型索引](README.md) · 相关主题：[Provider 设置](provider-settings.md)、[加载与归一化](normalization.md)

## 十、本地存储体系

命令产出的文档变更，经防抖持久化回调落到以下布局。
### 10.1 目录布局

```
应用数据目录/                           # Tauri app_data_dir，禁止硬编码路径
├── projects/
│   └── {projectId}/
│       ├── project.json               # ProjectDocument
│       ├── ai-session.json             # AI 创作历史（独立 schemaVersion）
│       └── assets/                    # 项目资产（自包含）
│           ├── {assetId}.png
│           └── {assetId}.mp4
├── library/                           # 个人资产库（跨项目复用）
│   ├── library.json                   # 库索引：assets.byId（分类/视角/标签）+ groups.byId（编组）
│   ├── asset-delete-journal.json      # 库资产删除恢复日志（仅存在未完成事务时）
│   └── assets/
│       ├── {assetId}.png
│       └── .trash/                    # 随机名私有隔离区；禁止进入任何 AssetRef
├── index.json                         # 项目索引：首页列表元数据（id/名称/缩略图/updatedAt）
└── settings.json                      # AppSettings：provider 配置与模型选择（不含 API key）
```

**存储布局迁移（独立于文档 schema 迁移的轴）**：文档 `schemaVersion` 迁移（§11.1）只转换文档内容，不涉及文件位置。当前实现（v0 与 v1 文档）均以扁平 `projects/{id}.json` 存储——上文目录布局中的每项目子目录、`assets/` 与 `index.json` 随 §7.1 项目资产落地。届时**必须**三选一，防止既有项目在首页消失：

- **布局迁移**：启动时发现旧扁平文件 → 建目录搬移为 `{id}/project.json` → 写入 `index.json`，迁移原子完成（失败回滚到扁平布局）；
- **路径回退**：目录化后 `list_projects`/`load_project` 仍兼容发现扁平旧文件（只读兼容，首次保存时搬移）；
- 或两者结合（推荐：启动迁移 + 兜底回退）。

布局迁移未实现前，§10.1 的 `index.json`/每项目目录不应成为 `list_projects` 的唯一数据源。

**AI 会话存储（[issue #47](https://github.com/hailingu/PlotWeave/issues/47)、[PR #57](https://github.com/hailingu/PlotWeave/pull/57)，已实现）**：会话独立保存在 `projects/{id}/ai-session.json`，`schemaVersion: 1` 保存消息 id、角色、顺序、正文及预览卡/执行回执。落盘总条数最多 200 条（[issue #64](https://github.com/hailingu/PlotWeave/issues/64)、[PR #85](https://github.com/hailingu/PlotWeave/pull/85)，已实现）：可执行待执行卡（`pending` 且校验通过，含自未确认执行卡降级来的）优先占用容量，其余额度保留最新历史，最终按原时间线输出。待执行卡自身超过 200 张时也从最旧提案起裁剪，不再额外追加无上限的钉住卡；最多 200 张时，继续普通聊天不会挤掉待执行卡。校验拒绝卡、已执行及已忽略卡按普通历史处理。此规则限制条目数量，不承诺文件字节上限；待执行卡占满容量时普通历史可能全部不落盘，超额旧提案重开后不再恢复（状态矩阵及边界见 [UI 设计 §6.2](../ui-design.md#62-会话落盘总量回归矩阵issue-64)）。裁剪只发生在写入主文件的落盘边界（前端 `aiSessionStore` 的 `diskSessionOf`，浏览器内存回退同语义）：面板保存通道与进程内快照（设置页重挂载种子、保存失败保留、退出冲刷待写重试）持全量落盘形态，设置页往返与失败后重开不丢进程内历史；内存线程与加载归一化都不裁剪（旧文件全量展示，下次实际变更保存才收敛）。缺文件返回空历史；前端逐条归一化并隔离坏条目。JSON 或信封损坏返回 `{ session: null, corrupt: true }`，界面显示损坏诊断；真实 I/O 读取失败仍返回错误。两者都不阻断画布打开。真实 I/O 读取失败时，AI 操作区只显示诊断并停用发送与执行，重开项目成功读取后才恢复；缺文件仍可正常开始聊天。损坏诊断不触发自动写回，后续实际编辑保存成功才更新主文件。

**范围决定（2026-09-10，仓库所有者确认）**：本项目按单应用实例使用，不考虑多实例或跨进程并发。AI 会话不维护跨进程文件锁、写入序号、冲突检测或历史分叉合并，也不新增单实例插件。只有主文件一个持久化来源；保存失败上浮给面板并保留进程内历史，不创建、读取、提升或清扫恢复副本，不进行定时自动重试。这一决定取代 PR #57 早期双副本恢复协议。旧开发版本主文件里的 `writeSeq` 不再参与保存判定；旧开发版本恢复目录不作为数据源，也不自动迁移或删除。

同一项目的会话写入复用保存/删除串行链，主文件使用同目录临时文件、flush、原子 rename 与父目录同步。失败的最新快照保留至成功保存或删除项目；后续消息变更、重开保留会话、再次尝试退出均可重试主文件。正常关闭窗口、macOS ⌘Q 与 Dock「退出」共用应用级退出屏障（[issue #119](https://github.com/hailingu/PlotWeave/issues/119)）：屏障覆盖画布防抖脏文档、项目保存链的失败重试登记与 AI 会话三类未落盘数据（画布与项目链部分见 §10.2），先等在途写入落定，每项目最多尝试一次失败快照；期间新加入的保存也需等待，仍失败则保留窗口并显示错误。启动间隙（原生退出屏障已安装、前端退出监听未注册）内到达的 ⌘Q/Dock 退出请求由 Rust 侧门闸缓冲；前端监听注册完成后经 `acknowledge_quit_listener` 确认就绪，确认消费暂存并重放一次同一 `app-quit-requested` 事件，使其进入同一冲刷屏障。暂存与直发互斥：被暂存的请求不再同时直发，同一退出请求至多投递一次，不形成并发双派发重复冲刷（[PR #82](https://github.com/hailingu/PlotWeave/pull/82)）；确认晚于注册保证重放必有接收者，就绪后到达的请求由已注册监听直接接收、不再缓冲（[issue #65](https://github.com/hailingu/PlotWeave/issues/65)）；前端持续未加载时退出请求仍会被取消，属记录在案的保留边界。没有后台自动重试；强制终止后未保存内容可能丢失，不承诺跨进程恢复。

删除项目等待已有写入并清除项目目录中的会话，成功后清除内存快照；删除墓碑期排队的会话写入被吸收——不执行但按 id 留存最新写入，删除失败（项目仍在磁盘）时重排回吐（与画布保存同口径，[issue #59](https://github.com/hailingu/PlotWeave/issues/59)），补写自身失败时保留快照经失败事件交给 App 级恢复通道（重开项目时内存副本胜出并提示可重试，退出屏障仍兜底），删除成功则随项目一并丢弃，绝不重建已删目录；不再有恢复副本清理回执或首页孤儿副本扫描。复制项目仅复制画布和项目资产，不复制对话；现有剧本导出也不包含会话。
### 10.2 写入安全

单写者场景**不需要**文件锁、版本号等并发机制；但需要防崩溃截断——写到一半进程被杀、断电、磁盘满，会留下截断的 JSON，导致整个项目无法打开。因此：

- **控制文件信任链是所有 I/O 的前置条件**：Rust 先 canonicalize `app_data_dir` 为受信根；`projectId` 等路径分量先通过对应的文件名安全字符集校验，再参与拼接。对 `projects/`、`library/` 及目录化布局的 `projects/{projectId}/`，现存目录必须是实际目录且 canonical 路径逐级仍位于父级受信根内，任一级为符号链接（无论指向根内或根外）、非目录或无法验证都拒绝**整个对应操作**，不能只禁用其 `assets/`。缺失目录只能在已验证父目录下创建，创建后立即 canonicalize 复核。读取、创建、替换、删除或扫描 `project.json`、旧布局 `{projectId}.json`、`index.json`、`library/library.json`、`library/asset-delete-journal.json`、`settings.json` 及其临时文件前，使用 `symlink_metadata` 拒绝最终路径为符号链接，现存文件还须是普通文件且 canonical 后仍是已验证父目录的直接后代；目录扫描跳过并报告符号链接/越界项，绝不跟随。验证后保持父目录句柄打开，所有实际 open/create/rename/delete 均以平台等价的 no-follow、相对目录句柄语义执行，不得 canonicalize 后退回未经绑定的原字符串路径，避免检查与使用之间被替换。新临时文件以该目录句柄下的随机同目录名称排他创建，避免预置 `.tmp` 符号链接截获写入；最终 rename 前再次验证现存目标。该解析器由项目 list/create/load/save/delete/复制流程、布局迁移、索引校正及库/设置命令共用，验证失败时不得读取、写入、删除外部树中的文件，也不得先更新另一控制文件。
- **资产文件能力边界**：控制文件与资产文件共用“受信根句柄绑定、逐组件 no-follow、实际 I/O 不退回字符串路径”的底层解析器；控制文件按本节校验，项目/库资产的读、写、媒体响应与删除还必须执行 §7.1 的专用资产根规则。canonical 路径和已校验内存条目只能用于诊断或选择逻辑对象，不能代替实际文件句柄授权。
- 在目标文件的受信父目录句柄下排他创建随机同目录临时文件（如 `project.json.<随机值>.tmp`），写入并 flush 后以目录句柄相对 rename 覆盖 `project.json`（rename 原子，读者只见旧版或新版，不见半个文件）。`index.json` / `library.json` / `settings.json` 同样处理；不得使用可被提前布置的固定 `.tmp` 路径。
- **崩溃遗留临时文件的顺带清扫**（[issue #148](https://github.com/hailingu/PlotWeave/issues/148)，已实现）：进程在排他创建临时文件与 rename 之间被终止时，进程内的失败清理不会执行，留下无引用的随机 `.tmp`。`list_projects` 与 `list_library_assets` 顺带清扫各自目录（项目侧 `projects/`；库侧 `library/` 根与 `library/assets/`，`assets/` 缺失或为符号链接时跳过且不在读路径创建）。条目须**同时**满足三条件才被移除：① 归属可辨——名字匹配本协议命名 `.{目标名}.{id}.tmp`（隐藏点前缀、`.tmp` 后缀），目标名落在本目录原子写目标白名单内（`projects/` 仅 `{项目 id}.json`；`library/` 根仅 `library.json`/`asset-delete-journal.json`/`library-corrupt-<64 位摘要>.bak`；`library/assets/` 为 `{资产 id}.{1~8 位小写扩展名}`，资产 id 域含旧 `la-{ms}-{size}` 方案存量），且 id 段匹配防碰撞生成器的唯一产出形状 `p-<小写十六进制>-<小写十六进制>`（长度 ≤64；PR #217 两轮评审收紧——宽字符集与非空目标会把 `.notes.backup.tmp`/`.notes.p-18f-0.tmp` 之类外来文件误收误删；id 段长度不按 epoch 收窄，十六进制结构是稳定契约，长度随时间戳/计数/哈希漂移）；② 超龄且不活动——mtime 超过 24h 宽限期（临时文件正常生命周期为毫秒~分钟级，未来时刻的脏时间戳按未超龄保留），且清扫与本目录的原子写经进程内操作锁串行（`projects/` 锁由 list/create/save 内核持有，`library/` 由 §7.2 库操作锁覆盖；PR #217 第三轮评审——挂起恢复或时钟前跳使进行中写入的临时文件显得超龄时，清扫也无法插入排他创建与 rename 之间）；③ no-follow 归类为普通文件——符号链接与目录等异型条目只跳过、绝不跟随，移除只删目录项自身。清扫尽力而为、fail-soft：扫描/元数据/删除失败只留结构化诊断，不阻断列表/启动，也不因单条坏数据中断其余回收；只删除、不读取内容，遗留临时文件不充当恢复副本（不扩大为新的恢复副本协议）。剩余记录边界：跨进程并发实例写同一 `projects/` 树不在操作锁范围（§10.2 单写者模型，由前端保存链承担；库侧跨进程另有 §7.2 文件锁）；`projects/{id}/` 会话目录（AI 会话临时文件）、`projects/{id}/assets/`（项目媒体临时文件）与应用数据根（`settings.json` 临时文件）暂不清扫，积累速率低，如需回收按同一内核扩展。
- `project.json` 是项目内容及合法 name/updatedAt 的权威真源，`index.json` 只是可丢弃、可重建的首页缓存；两个文件的独立 rename **不构成跨文件事务**。`create_project`/`save_project` 先原子提交项目文档，再以同一 name/updatedAt 更新索引。Rust 启动时、且最迟在每次 `list_projects()` 返回前，扫描项目文档（布局迁移期同时覆盖 §10.1 的旧路径回退），以受信路径 id 与文档中的合法 name/updatedAt 重建或校正索引：补缺失项、覆盖不一致项、移除已确认没有项目真源的陈旧项；缩略图等仅存于索引的展示字段只在对应项目仍存在时保留。文档元数据异型时不得把非法值写进索引：保留可用的合法索引回退，否则返回明确的损坏占位与诊断，留待 §11.1 加载归一化修复。校正后的列表直接从这份内存投影返回，并尝试以 tmp + flush + rename 回写索引；即使回写再次失败也不得返回已知陈旧的 name/updatedAt，须报告可恢复警告。由此在两次 rename 之间崩溃、索引写失败或索引损坏只会造成可恢复的缓存陈旧，不会让首页长期显示与项目文档不一致的名称或更新时间。
- 前端防抖 500ms 提交一次；失败回队重试；`flushPersist()` 在关闭窗口/切换项目前调用。退出屏障同样等待防抖落盘（[issue #119](https://github.com/hailingu/PlotWeave/issues/119)）：编辑器挂载期间向应用级注册表（`canvasSaveRegistry`）登记「有脏或在途」探针与立即冲刷闸，退出冲刷先补交画布最新编辑，再处理保存链；失败重试登记（含未落定链上动作）在退出时立即重存，每登记至多尝试一次，代次已前进的陈旧登记不重放（新保存拥有终态，陈旧稿不得后完成覆盖新内容），仍失败则阻断退出、保留登记与 5s 后台重试节律并显示诊断。重试可以复用同一份序列化载荷，但其中的 `project.updatedAt` 不具有权威性：每次 `save_project` 尝试都由 Rust 在保存边界重新生成时间，调用方不得通过预先盖戳或重放旧值决定本次保存时刻。序列化时节点 `ui` 会话态（`selected`/`expanded`）按 §3 不落盘——`serializeProject` 输出统一重置为加载初值（`selected: false`、`expanded: true`），内存中的选中态不进入载荷；`update_node_ui` 不置脏（§9.4），纯选择/折叠操作不触发防抖保存，也不会因此刷新 `updatedAt` 改变首页最近项目排序。置脏判定的实现口径：前端以持久化签名（剔除 React Flow 会话态与样式类后的语义序列化）变化置脏；签名逐项按节点/连线对象身份缓存并按持久字段引用记忆（[issue #272](https://github.com/hailingu/PlotWeave/issues/272)，已实现）——拖拽过程帧只重新序列化被拖节点，无关重渲染零序列化；签名字面与整体序列化一致，置脏/防抖/失败重试/卸载与退出冲刷/aiRevision 提交对账契约不变。
- 项目文档保存成功（含失败登记后的链上后台重试成功）即向前端发出落定通知（issue #101）：编辑器卸载冲刷/在途保存可以晚于返回首页的列表读取，首页摘要（名称、派生统计、更新时间/排序）靠该通知在导航读取之后再刷新一次，恢复到与磁盘一致；保存失败不发出通知，且失败按磁盘状态分两类（§10.5 保存边界同款分类）——**提交前失败**（信封/资产预验、临时文件创建/写入/同步或 rename 失败）磁盘保持旧内容，首页不得虚报新摘要；**提交后失败**（`atomic_write` 的 rename 已成功但目录 fsync 持久性屏障失败，或写后资产复验拒绝）时 `projects/{id}.json` 已被新内容替换并带新盖戳，但不发通知，首页可能继续显示旧摘要，直至下一次挂载/回到首页/后续保存成功触发的列表重读。首页并发发起的多次列表读取按发起序收敛，较旧的响应不得覆盖较新的结果。
- 首页列表的维护写与普通保存共用同一项目保存链（[issue #134](https://github.com/hailingu/PlotWeave/issues/134)，已实现）：空库播种先等该 id 在途保存落定再探测（在途链落定不改链身份、身份守卫看不见；等落定后探测，保存所建文件经「项目已存在」自然跳过），仅在 `load_project` 确证「项目不存在」后经链写入（no-replace 语义不变——文件存在含不可读一律跳过），探测窗口内目标示例的删除在途时种子写被删除墓碑吸收、不为删除中项目落盘，目标存在保存失败的重试登记（最新未落盘内容比磁盘/空目录新）或探测窗口内排入新写入（链身份变化，探测结果已过时）时同样跳过种子写——成功的种子写会清除登记或以硬编码内容覆盖窗口内写入，留待链重试交付；已知示例的旧格式迁移/修复回写先等该示例保存链静止再读盘，读盘/资产复验的 await 窗口内该示例排入新保存或删除（链身份变化）即跳过本次回写——迟到修复不得覆盖较新内容或复活已删对象，留待下次列表/打开重查；链上存在保存失败的重试登记（最新未落盘内容比磁盘新）同样跳过回写——成功保存会清除登记、永久丢弃该内容，留待链重试交付；回写失败由链登记重试并经落定通知刷新首页。

#### 设置保存状态与不变量（issue #121）

[issue #121](https://github.com/hailingu/PlotWeave/issues/121) 已实现：`save_prefs` 的设置层负责序列化、1 MiB 上限与应用数据根句柄，复用 `store::atomic_write` 完成控制文件替换及持久性屏障。数据目录的创建（设置读取与保存入口共用 `ensure_data_dir` 内核）经 `store::create_dir_all_durable` 持久化完成（[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 三轮评审修订，Unix）：创建时刻探测最深已存在祖先，新建目录条目所在的各级宿主（自锚点至直接父目录）在写入任何内容前逐级 fsync——首启读取（`load_prefs`）与首次保存创建的条目均与内容同为持久。创建或同步失败时，内核尽力自深至浅拆除本次新建的层级（仅空目录可拆）后返回原错误，重试得以重新探测锚点、再做全链同步，而非退化为「目录已存在」的单级兜底。目录已存在时保存仍兜底同步其直接父目录一次（单级防御）。剩余边界：清理前来不及执行的崩溃／断电、清理不完整（并发写入占据层级）与并发调用方在创建与同步之间进入，均残留多级未同步状态并由下次调用的单级兜底承接——需要「多级新建 + 精确崩溃窗口 + 其后断电」三重叠加，按 P2 记录在案；store／library 侧创建入口尚未接入该助手，属已记录的后续事项。所有设置保存入口均经同一内核；不改变整份保存的 IPC 协议、设置读取失败策略或前端保存排序。旧 `settings.json.tmp` 占位无需删除，也不会被本次保存改写。

| 前置状态 | 动作／时序 | 预期可观察结果 | 跨转换不变量及所有者 | 验证结果（`prefs::save_tests`） |
| --- | --- | --- | --- | --- |
| 首次保存或已有设置 | 保存合法 JSON，再读取 | 完整新设置可读，正常结束无临时文件 | 设置层：读写采用相同 1 MiB 字节上限；原子写层：目标不会成为半份 JSON | `save_creates_then_replaces_complete_settings`、`save_enforces_serialized_byte_limit_before_touching_files` 通过 |
| 旧 `settings.json.tmp` 被文件、目录或符号链接占据 | 保存新设置 | 保存成功，占位条目及其指向的内容保持原状 | 原子写层：临时文件必须同目录随机排他创建，不借用或清理其他条目 | `save_ignores_legacy_temp_directory_and_file`、`save_does_not_follow_legacy_temp_symlink` 先红后绿 |
| `settings.json` 是目录或符号链接 | 发起保存 | 拒绝并返回诊断，原条目及外部内容不变 | 原子写层：目标归类与改名前复核共用信任链 | `save_rejects_directory_target_without_leaving_temp_files`、`save_rejects_symlink_target_without_replacing_it` 先红后绿 |
| 已有旧设置 | 创建、写入、文件同步或改名阶段失败，然后重试 | 失败上抛；改名前旧文件不变；本次临时文件尽力清理；重试可完成 | 原子写层：只有成功排他创建的临时文件归本次操作所有；未提交不得损坏旧设置 | `save_precommit_io_failures_preserve_old_settings_and_allow_retry`、`atomic_save_collision_does_not_remove_another_writers_temp_file` 先红后绿 |
| 新文件已改名，父目录尚未同步 | 目录同步失败，然后重试 | 返回失败；完整新版可能已可见；重试成功 | 原子写层：耐久性未确认不得报告成功；改名后失败不承诺恢复旧版 | `save_directory_sync_failure_reports_error_with_complete_new_file`、`save_obeys_durability_protocol_order` 先红后绿 |
| 数据根缺失，首启读取或首次保存新建一或多级目录 | `load_prefs`／`save_prefs` 创建数据目录；创建或条目同步失败后重试 | 创建时刻同步新条目的各级宿主（Unix）；失败时自深至浅尽力拆除本次新建层级后上抛，重试重新探测锚点做全链同步；数据根已存在时保存仍兜底同步直接父目录一次（单级） | 原子写层：返回成功 ⇒ 目录条目与文件内容同为持久；条目屏障缺失不得报告成功；失败残留仅剩「清理前来不及执行的崩溃／清理不完整／并发进入」记录边界 | `save_syncs_entry_host_when_data_dir_newly_created`、`save_syncs_every_host_of_newly_created_levels`、`ensure_data_dir_persists_every_host_of_new_levels`、`ensure_data_dir_removes_created_levels_on_sync_failure_for_full_retry`、`ensure_data_dir_rejects_file_blocked_path_without_side_effects`、`save_entry_sync_failure_preserves_old_settings_and_allows_retry` 先红后绿（[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 评审）；宿主链与回滚范围计算另有 `persist::tests::entry_sync_plan_covers_hosts_and_rollback_scope_of_new_levels` |
| 多次保存重叠 | 并发写入不同完整快照 | 每次使用独立临时文件，最终为某一完整快照 | 原子写层：不互相截断或清理临时文件；业务先后由既有调用方负责 | `overlapping_saves_leave_one_complete_snapshot` 先红后绿；不承诺跨进程业务排序 |

验证边界：在隔离临时目录运行真实文件 I/O；同步故障以测试专用注入覆盖错误传播与文件可恢复状态，不等同真实断电实验。非 Unix 沿用共享内核不执行父目录／条目宿主 fsync 的平台边界，本仓库未验证 Windows；不新增同用户恶意换树防御。

验证记录（2026-09-18）：在 `src-tauri` 执行 `cargo test --lib prefs::save_tests`，11 项通过；`cargo fmt --check && cargo clippy -- -D warnings && cargo test` 的各项检查通过，Rust 单元测试 312 项、原生退出集成夹具通过。首次全量测试因沙箱禁止绑定环回端口，9 个既有 HTTP 测试失败；允许本地端口后全量重跑通过。测试编译仍有 `library_index/fixup_tests.rs` 的未使用 `Value` 导入和 `library_index/normalize_tests.rs` 的未使用 `warnings` 变量两条既有警告，本次未改动。构建产物使用独立临时目录并在完成前清理；未触碰真实设置或调用真实供应商。两个设计文档无配置的自动检查，按保存入口、状态矩阵、失败语义、平台边界与交叉引用作结构化复核。圈复杂度 `N/A — no configured complexity tool`；人工检查本次新增／修改函数均未超过 80 代码行，受影响源文件均少于 800 行。

验证记录（2026-09-18，[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 评审修复）：新增目录条目宿主屏障后，`cargo test --lib prefs::save_tests` 14 项通过（含 3 项先红后绿的评审回归）；`persist::tests::entry_sync_chain_covers_each_host_of_new_levels` 覆盖宿主链计算（两级新建、一级新建、目标已存在、根目录无宿主）。条目屏障对 `projects/`、`library/` 根的同型首次创建窗口不在本次范围（见 PR 回复的后续事项）。

验证记录（2026-09-18，[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 第二轮评审修复）：读取路径创建内核 `ensure_data_dir` 接入持久化创建（多级缺失在创建时刻同步全部宿主），`cargo test --lib prefs::save_tests` 15 项通过（新增 `ensure_data_dir_persists_every_host_of_new_levels` 先红后绿）。剩余多级未同步窗口仅存在于 store／library 创建入口，属后续事项，不在设置契约内。

验证记录（2026-09-18，[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 第三轮评审修复）：`create_dir_all_durable` 的创建／同步失败路径新增回滚——自深至浅尽力拆除本次新建层级（仅空目录可拆），重试重新探测锚点做全链同步而非退化为单级兜底。`cargo test --lib prefs::save_tests` 17 项通过（新增 `ensure_data_dir_removes_created_levels_on_sync_failure_for_full_retry` 先红后绿、`ensure_data_dir_rejects_file_blocked_path_without_side_effects` 守卫）；`persist::tests::entry_sync_plan_covers_hosts_and_rollback_scope_of_new_levels` 同时断言宿主链与回滚范围。残留边界（清理前来不及执行的崩溃／断电、清理不完整、并发进入）按 P2 记录于上文，未覆盖 store／library 入口。

验证记录（2026-09-18，[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 第四轮评审修复）：锚点探测 `existing_anchor` 改为 `NotFound` 视为缺失、其余 I/O 失败按 fail-closed 上抛（探测失败优先于任何回滚计划），消除「瞬态元数据错误使现存目录被误判为本次新建、进而被失败清理拆除」的窗口。`cargo test --lib prefs::save_tests` 17 项通过；320 项单元测试全绿。

验证记录（2026-09-18，[PR #201](https://github.com/hailingu/PlotWeave/pull/201) 第五轮评审修复）：第四轮的 fail-closed 回归测试此前只走正常路径（`leaf` 缺失、`tmp` 父目录正常，旧 `is_ok` 吞错实现同样通过），未真正覆盖所声称分支。现经 `faults::fail_at(Stage::AnchorProbe)`（仅判定注入、不进入协议序记录）在探测站点注入非 NotFound 失败，`persist::tests::entry_sync_plan_fail_closed_on_transient_metadata_error` 在接入注入前红、接入后绿，断言错误上抛且无任何创建／清理副作用。
### 10.5 Rust 持久化命令（Tauri commands）

**执行线程（[issue #138](https://github.com/hailingu/PlotWeave/issues/138)，已实现）**：
项目／AI 会话、设置与密钥封装、资产库／编组、项目资产导入／预检、媒体 URL
校验以及生图产物落盘与校验（[issue #310](https://github.com/hailingu/PlotWeave/issues/310)）
的同步工作，由异步命令通过 `blocking::run` 整体交给 `spawn_blocking`。
目录准备、锁等待、序列化、文件操作和持久性屏障均在闭包内完成；IPC 成功仅在
完整内核结束后返回，领域错误保持原样，线程任务异常显式失败。事务锁与恢复
诊断序号仍由同步内核拥有，不跨 await 持有。相关操作的先后关系继续由前端
项目／会话共享保存链、设置保存链及库变更队列保证；独立并发请求不承诺 FIFO。
`pwmedia` 协议继续使用已有阻塞线程池，退出确认／取消登记等短时内存操作保留
原入口。生图落盘的锁内取消复验经托管作业注册表在阻塞线程查询，作业登记
守卫生命周期保留在命令侧（详见上文验证矩阵文档的 #310 记录）。
[验证矩阵与延迟测量](../development/invoke-responsiveness.md) 记录实际范围和缺口。

下表按领域职责描述参数；实际 IPC 注册与参数名以 `src-tauri/src/lib.rs` 和相应函数签名为准。库的 `list_library_assets` / `import_library_asset` / `update_library_asset` / `delete_library_asset` 与两个组命令已在 #29 对齐。尚未对齐的目标接口显式标注如下，不能直接作为当前 invoke 名称。

| 命令 | 职责 |
| --- | --- |
| `list_projects()` | 按 §10.2 先验证应用根、项目目录与每个候选控制文件，再扫描项目文档真源并与 `index.json` 缓存校正后返回内存投影（该缓存交互属规划中的 §10.2 索引机制——当前扁平存储实现由 `list_project_metas` 每次直接扫描并解析 `projects/*.json` 文档构造列表，无索引缓存，issue #280 评审勘误）；索引缺失、损坏或与文档的 id/name/updatedAt 不一致时重建并原子回写，不直接返回陈旧缓存。单个项目文档 JSON 损坏、信封不可判型或底层 I/O 读取失败（非并发删除、非信任链拒绝）时，以**损坏占位摘要**返回（受信路径 id + 诊断文案，名称/统计/时间缺省——缺省时间排序稳定居末），不再静默跳过（[issue #123](https://github.com/hailingu/PlotWeave/issues/123)，已实现）：首页渲染损坏占位卡供定位，点击打开仍由 `load_project` 的失败诊断（issue #98 横幅）承接；信任链拒绝的符号链接/异型条目与读取时已并发删除（NotFound）的条目仍跳过，目录级读取失败整次报错、由首页错误态（issue #133）承接 |
| `create_project(name)` | 按 §10.2 验证/创建项目目录及控制文件目标后，原子写初始 `project.json`；name 按 §9.3 项目名校验口径校验（与 rename_project 同规则）。（随后的可重建索引更新与跨文件中断的 §10.2 校正恢复属**规划中的索引机制**——当前实现 `create_project_file` 仅 `atomic_write` 落盘后由同一文档经 `read_meta` 构造回执，不写 index.json，issue #280 评审勘误。） |
| `load_project(projectId)` | 按 §10.2 验证完整目录/文件信任链后才读 `project.json`；项目基准目录或文件逃逸即拒绝整个加载。随后按 §11.1 第 0 步只做信封判型：旧扁平形状包装为 v0，缺失/异型版本号的 v1 形状标记为待修复 v1，混合/无法判定的信封或显式版本与形状冲突时拒绝且不改写；并随原始文档返回受信 `projectId`（随附可用索引元数据属**规划中的 §10.2 索引机制**——当前实现 `load_project_file` 直接返回 `ProjectFile`，不经索引，issue #280 评审勘误）。v1 的 `project` 父容器或成员异型不得在 Rust 层整份拒绝，交由前端归一化修复；节点级 schemaVersion 迁移与归一化同样在前端模型层（见十一），Rust 不参与。错误出口（issue #229）：NotFound 根因的拒绝文案携带稳定机器码前缀 `[project_not_found] `——前端空库播种等程序判定按码分支，不经中文文案；其余类别不带码，无码错误按「存在但不可读」保守处理；码不上屏，展示层剥离前缀 |
| `load_ai_session(projectId)` / `save_ai_session(projectId, session)` | 已实现：经受信项目目录句柄读取/原子写入唯一主文件 `ai-session.json`。缺失或损坏由 `{ session, corrupt }` 区分，真实 I/O 失败返回 Err。保存校验会话 v1 信封及数组 entries、要求项目记录存在，失败直接上浮。逐条归一化由前端加载完成；落盘形态映射（运行时标注剥离、未确认执行卡降级）在前端保存通道保持全量，总量最多 200 条（待执行卡优先占容量，其自身超额则保留最新 200 张）的容量裁剪由前端会话存储 `aiSessionStore` 在写入边界统一施加——进程内快照（设置页重挂载/失败保留/退出冲刷）持全量形态（[issue #64](https://github.com/hailingu/PlotWeave/issues/64)、[PR #85](https://github.com/hailingu/PlotWeave/pull/85)），后端保存校验不含条数上限；没有恢复副本命令或跨进程定序协议（§10.1）。 |
| `save_project(projectId, doc)` | 按 §10.2 验证完整目录、目标与临时文件信任链后，先校验完整项目信封：确认 `doc.project` 是普通对象；`project.id` **无条件以受信路径参数 `projectId` 覆盖**——调用方自报的 id 不构成授权，不得把与路径参数不一致的 id 落盘（否则内存会话、项目真源与首页索引出现分裂身份）；`project.name` 按 §9.3 项目名校验口径校验（与 rename_project/create_project 同规则）——先验 typeof string，去首尾空白后非空且按字符数 ≤ 64，非法值整次拒绝（保存边界不替调用方修复，普通命令无法产生的名称不得经原始 IPC 持久化），合法时采用规范化后的值。信封其余必需顶层成员同款前置校验：`schemaVersion` 必须严格等于当前支持版本（1）——缺失、异型或未来版本号整次拒绝（缺失/异型版本落盘后下次加载按 §11.1 第 0 步标记待修复，未来版本则直接拒绝，均不得由保存产生）；`graph` 是普通对象且其 `nodes`/`edges` 均为数组，`settings` 是普通对象且其 `characters`/`locations`/`props`/`documents` 各桶均为普通对象——任一异型即整次拒绝，不得把 `graph: null`、异型 `settings` 之类的载荷落盘后靠 §11.1 归一化重置为空容器，把无法判型的损坏静默变成内容丢失。`episodeTitles` 必须是普通对象（非数组、非 `null`）且键值满足 §11.1 第 3 步的键值域（规范十进制正整数安全整数键、字符串值）——数组型标题表等异型落盘后下次加载会被重置为 `{}`，载荷中的标题静默丢失，保存边界同样直接拒绝。`project` 其余元数据同域校验：`createdAt` 与 `updatedAt` 均须为可解析的 ISO 8601 字符串（`updatedAt` 虽被本命令无条件覆盖，异型值仍整次拒绝——保存边界不接受形状不完整的信封）；可选 `description` 存在时须为字符串；`graph.viewport` 存在时须为普通对象且 `x`/`y` 为有限数值、`zoom` 为正有限数（§3 缺省语义只允许字段缺省，不允许异型值落盘）；`graph.aiRevision` 存在时须为非负安全整数（§12.2 提交身份——异型/负数/超安全整数落盘后加载归一化会清零，已应用批次计数丢失、执行卡恢复对账误判）。再确认 `doc.assets`/`doc.assets.byId` 均为普通对象，再把每个键和值当作不可信输入执行 §7.1 完整形状、Record 键/id 一致性及 MIME/时间戳规范形式校验（保存边界不替调用方修复，非规范值直接拒绝，避免内存与落盘分叉），并逐项以受信项目资产根句柄 no-follow 打开当前 relPath、确认普通文件和真实路径包含关系；任一校验失败即在创建临时文件、生成保存时间或更新索引前拒绝整次保存，返回具体字段或 assetId 诊断，不得静默剥离。全部通过后，Rust 为本次尝试只取一次系统时间，**无条件覆盖**调用方携带的 `doc.project.updatedAt`（不信任旧值、未来值或前端时钟），再以排他创建的同目录临时文件 + flush + rename 原子替换 `project.json`。（随后的 `index.json` 缓存更新与 §10.2 的启动/列表校正是**规划中的索引机制**——当前扁平存储实现尚未落地 index.json，保存只写 `projects/{id}.json` 这一份权威文档。）成功回执类型上携带权威 updatedAt（`ProjectMeta.updated_at`，由本次已原子写入的同一文档经 `read_meta` 构造——回执与落盘真值同源），但**当前前端未消费该回执**：`tauriSave`（`src/projectStore/saveChain.ts`）仅 await 后丢弃、返回 `Promise<void>`，会话模型 `ProjectContent`（`src/model/content.ts`）亦无 updatedAt 字段——内存中没有由保存链刷新的元数据；首页元数据与最近排序的现行刷新来源是 `list_projects` 重新读取，触发有三：挂载、回到首页，以及**保存落定通知**——`useProjectSummaries` 订阅 `projectStore.onProjectSaved`，首页可见时任一次保存成功即重读列表（issue #101：编辑器卸载冲刷/在途保存可以晚于返回首页的首次读取，保存失败登记后的后台重试成功也发生在卸载之后，首页摘要只能靠这条通知恢复与磁盘一致；保存失败不通知，且失败须按磁盘状态分两类——**提交前失败**（信封/资产预验、临时文件创建/写入/同步或 rename 失败）磁盘保持旧内容，首页不得虚报新摘要；**提交后失败**（`atomic_write` 的 rename 已成功但目录 fsync 持久性屏障失败，或写后资产复验拒绝——文档虽已提交，篡改不得静默）时 `projects/{id}.json` 已被新内容替换并带新盖戳，但回执为失败、不发 `onProjectSaved`，首页可能继续显示旧摘要，直至下一次挂载/回到首页/后续保存成功触发的列表重读；这是现行刷新边界，回执或通知机制的演进不得依赖「失败即磁盘未变」这一不成立的不变量）。当前实现由 `list_project_metas` 每次直接扫描并解析 `projects/*.json` 文档，读到的即是盖戳后的文档真值，不经索引缓存；保存链不依赖回执。「消费回执以刷新内存元数据、省去一次列表重读且不触发新一轮脏写」是演进目标而非已实现行为（issue #268），接入时须为会话模型补字段、防止盖戳误触新一轮脏写，且**不得移除保存落定通知触发的列表重读**——回执只能覆盖发起保存的挂载实例自身的内存刷新，卸载后的冲刷落定与后台重试成功仍须经 `onProjectSaved` 通知路径刷新首页（issue #101 契约）；失败重试重新执行信封与资产复验并取新时间，`serializeProject` 只负责结构序列化、不负责保存时刻盖戳 |
| `delete_project(projectId)` | 按 §10.2 验证完整目录/文件信任链后只删除受信项目控制文件/目录；目标缺失为幂等成功，符号链接或越界目标拒绝且不跟随 |
| `validate_project_asset(projectId, asset)` | `set_asset` 的只读 Rust 前置命令：projectId 只接受 dispatcher 当前受信活动会话值，不接受命令负载自报；先按 §7.1 校验完整 AssetRef 与词法 relPath，再从受信项目目录/资产根句柄逐组件 no-follow 打开目标，确认它是资产根内普通文件；返回本次规范化后的完整 AssetRef。不得缓存结果或把它视为保存授权；公开 dispatcher 只把本次返回值立即交给模块私有 reducer，失败时活动文档、历史栈与脏标记零变更 |
| `import_asset(projectId, file)`（目标接口） | 当前已注册的是 `import_project_asset_from_library(id, libraryAssetId)`，用于库 → 项目；通用文件导入接口尚未注册。按 §7.1 从受信项目目录句柄打开 `assets/` 根，在其下排他创建临时文件并以句柄相对 rename 落位，返回 `AssetRef`；不得按拼接后的绝对目标路径写入 |
| `get_asset_media_url(scope, assetId)` | scope 只允许 `{ kind: 'project'; projectId: string }` 或 `{ kind: 'library' }`，不得接受目录/路径字符串；命令只返回含逻辑 scope + assetId 的 opaque URL，不返回本机路径。Rust 协议处理器在每次媒体请求时按 §7.1 验证 projectId、从当前规范化索引解析 relPath，并以受信资产根句柄逐组件 no-follow 打开、确认普通文件后按 §7.1 的有界缓冲策略响应 |
| `register_project_asset_alias(id, blankKey, freshId)` | 当前已实现：登记加载归一化的空白键重发别名，供修复落盘前解析媒体；不接受 relPath，规则见 §7.1 |
| `copy_project_assets(fromId, toId)` / `verify_project_assets(id, assets)` | 当前已实现：前者经受信句柄复制项目媒体，后者提供加载侧资产实路径复验，供 §7.3 复制与 §11 归一化调用 |
| `list_library_assets()` | 先按 §7.2 通过受信控制文件与资产目录句柄恢复 `asset-delete-journal.json` 中的未完成事务；存在无法安全自动恢复的身份冲突时保留现场并返回警告。随后读 `library.json`，迁移并完整归一化 LibraryAsset/AssetGroup 后返回资产库列表（含编组、`cleanupPending` 与其他警告） |
| `import_library_asset(file, meta)` | 按 §7.2 校验 meta 与完整构造结果后，按 §7.1 通过受信库资产根句柄安全拷贝，完成文件 flush/fsync、原子落位与资产父目录 fsync 后确认可读，再耐久提交新增索引；索引失败时只留下可诊断孤儿文件。meta 含 name/kind/view/groupId/tags |
| `update_library_asset(assetId, patch)` | 按 §7.2 校验白名单 patch 并复验完整合并结果后修改索引项：改名、改标签、改视角、换编组（只动索引不动文件） |
| `upsert_library_group(group)` | 按 §7.2 校验完整 AssetGroup 后新增/更新编组；kind 变更不得与成员资产冲突 |
| `delete_library_group(groupId)` | 要求组存在；原子删除组并剥离成员资产的 groupId，不留下悬空编组引用 |
| `delete_library_asset(assetId)` | 按 §7.2 从本次受信规范化索引解析 id：若新索引仍有其他条目引用同一已打开文件身份，仅耐久提交去项索引；否则先耐久写 `asset-delete-journal.json`，再把身份核验后的原目录项通过受信句柄原子移入 `assets/.trash/` 随机名并复核移动后身份，隔离与目录 fsync 成功后才提交去项索引。提交后只用绑定已打开身份的平台原语清理隔离项；普通按名称 unlink 禁止。身份冲突、平台能力不足、清理或 fsync 失败均按阶段回迁或返回 `cleanupPending`，由启动/列表/后续写入按日志恢复；不得回滚已提交索引，也不得覆盖原名处后来出现的文件 |
| `collect_library_asset(projectId, projectAssetId, meta)`（待实现） | #29 明确保留项目 → 库收藏链路；以下为目标职责。按 §7.1 分别以受信项目/库资产根句柄 no-follow 读取与写入，把项目资产完成文件 flush/fsync、原子落位与资产父目录 fsync 后才耐久提交新增库索引（「收藏」）；索引失败只留下可诊断孤儿文件 |
| `get_settings()` / `update_settings(patch)`（目标名称） | 当前 IPC 为 `load_prefs()` / `save_prefs(prefs)`，读取/保存整份设置；不可把目标 patch 接口当作现有协议。`load_prefs` 仅在设置文件缺失（首次启动）返回空对象；损坏、超限或其余读取失败返回 Err 上抛，前端设置页展示可重试错误并阻止以默认值全量覆盖原配置（[issue #120](https://github.com/hailingu/PlotWeave/issues/120)）。`save_prefs` 在 1 MiB 序列化上限校验后，经受信应用根句柄执行 §10.2 原子写及持久性屏障；保存各阶段错误均上抛（[issue #121](https://github.com/hailingu/PlotWeave/issues/121)） |
| `set_provider_key(provider, key)` | 加密并返回 envelope 密文（由前端随 settings 落盘；解密走 `seal::open`，无独立读命令） |
| `llm_chat(messages, tools)` | LLM 请求代理：key 由 settings 密文在 Rust 内存解密，绕开 webview CORS（见 12.2）；#15 已补 120 秒请求超时、16 MiB 响应体流式限读，与图像代理共用 `http_util`，发送/读取超时有明确诊断 |
| `llm_image_generate(request)` | 文生图代理（§13 首版）：单对象载荷（projectId/jobId/provider 配置/model/prompt/size），key 解密同 `llm_chat`；请求 OpenAI 兼容 `/images/generations`（b64_json 优先，url 成员回退下载），响应体流式限读（主响应 64 MiB 文本 / url 回退 32 MiB 字节，超限即中止）；**作业总预算 600s 自命令进入起算**（[issue #141](https://github.com/hailingu/PlotWeave/issues/141)，已实现）：provider 凭据读取（同步阻塞访问挪入阻塞线程池）、生成 POST（含响应体读取）与 url 回退下载链的逐跳 DNS 解析、请求、响应体读取的等待上界**均为作业剩余预算**，预算耗尽按阶段（读取凭据/生成请求/解析图像主机/下载图像/读取图像）给出诊断并放弃——不发出可能计费的请求、产物不写回；逐跳 120s 与 POST 300s 客户端超时保留为单阶段兜底；阻塞任务（凭据读取、DNS 解析）不可取消，预算耗尽只是放弃等待、任务运行至系统返回后其结果被丢弃、不持有应用锁；其中 DNS 解析被隔离在严格并发上限（2）的专用线程边界内——挂起的解析线程不占用 Tokio 阻塞池、不蔓延到凭据读取等其他阻塞工作，泄漏上限为常量个线程，在途到顶即按「解析繁忙」fail-fast，额度随解析线程返回归还，等待侧经异步通道由 `timeout_at(绝对截止时间)` 约束（阻塞池排队不会把等待拖过 deadline）；资源生命周期已文档化，PR #220 评审修订；产物按字节魔数定型 MIME（PNG/JPEG/WebP/GIF，provider 声称的 content-type 不作为依据）、过 32 MiB 上限后经原子写内核落盘进项目 `assets/`，§9.3 预检（形状 + 实路径复验）在命令内、返回前完成，前端单次 IPC 直收已校验的 `source=generated` AssetRef 并入索引。请求返回后与落盘前各查一次取消标志：协作式取消即放弃结果 |
| `llm_image_cancel(jobId)` | 协作式取消（[issue #143](https://github.com/hailingu/PlotWeave/issues/143)，已实现）：活动作业在 `llm_image_generate` 入口登记于应用托管的取消注册表（Tauri managed state，RAII 守卫）——成功/失败/取消/卸载全部出口随 Drop 清理，错误路径不再遗留标记；命中活动作业即标记取消，进行中的生成在检查点放弃结果（HTTP 请求本身不中断，由超时约束兜底）；命中未知/已结束 id 进有界墓碑（去重 + 64 容量 FIFO 淘汰——未知与迟到取消不无界增长），同 id 登记时消费墓碑使「先取消后登记」的预取消语义生效（复用墓碑窗口内的 id 按此语义继承取消） |
