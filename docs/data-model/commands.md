# 数据模型：命令与撤销

[返回数据模型索引](README.md) · 相关主题：[项目文档](project-document.md)、[AI 交互](ai-integration.md)

## 九、命令与撤销

数据与引用规则定义完毕，本节定义它们的唯一变更入口（原则 3）。

> **就地实施状态（2026-09-21 核对，issue #237）**：本节的命令信封（`GraphCommand`/`inverse`）与统一入口（`applyCommand`/`dispatchCommand`）为**目标设计**——`src` 中无同名可导入符号（§2 的全局声明同样适用）。当前实现以等价语义交付，各小节就地标注：§9.1 信封对照 `HistoryCommand`（`src/editor/history.ts`），§9.2 清单附「当前实现入口」列，§9.3 撤销捕获与资产预检附实际落点，§9.4 已注明栈容量与合并差异。除入口形态外，本节的不变量（边界校验、整批原子、撤销完整恢复）目标与实现共同遵守，已标注的例外除外（如 §9.2 `rename_project` 尚未接入撤销栈）；历史或未来的目标接口不可直接 invoke/import。

### 9.1 命令结构

单写者场景无需并发基线与路径级补丁。命令信封固定为六个字段：`id` / `type` / `actor`（变更来源：用户操作或 AI Agent，用于审计与 UI 标记，见十二节）/ `patch`（正向补丁）/ `inverse`（逆向补丁，执行时自动捕获）/ `timestamp`；另有可选的 `transient` 标记（瞬时 UI 命令，仅供拖拽/缩放等手势的过程帧使用：不进撤销栈、不置脏不落盘）。「不进撤销栈」与「不持久化」是两个独立维度——前者由 §9.4 按命令类型裁定，后者仅 transient 过程帧成立；需要持久化但不进栈的变更（如视口终帧）以非 transient 命令提交、按 §9.4 排除出栈，见 §9.4。

`patch` 的具体形状由 `type` 决定，完整定义见 9.3。

> **实施对照**：目标信封未落地。当前命令形状为 `HistoryCommand`（`src/editor/history.ts`）：`undo`/`redo` 闭包、可选 `coalesceKey`（800ms 内同键合并为一步撤销）、`redoGuard`（资产恢复类命令重做前的异步复验，issue #10）与 `timestamp`；无 `actor`/`id`/`patch`/`inverse` 字段——命令来源（actor）审计未实现，`aiRevision` 仅承载 AI 批次的持久提交身份（§12.2：单调计数、撤销不回退，不记录逐命令来源）；不入栈与不落盘两类变更按 §9.4 由非命令路径处理（如视口）。

### 9.2 命令清单

| 类别 | 命令 | 说明 | 当前实现入口（等价语义，§9 就地实施状态） |
| --- | --- | --- | --- |
| 节点 | `create_node` / `delete_node` / `move_node` / `resize_node` | delete 连带删除关联边，inverse 一并恢复 | `useNodeCreation`；`useNodeDeletion`（节点+连线+产物回收同一撤销单元）；`move_node` = `useNodeDragHistory`（拖拽整段一步，过程帧不入栈）与 `useAutoLayout.onAutoLayout`（整图位置 before/after 快照为一步撤销，issue #94）；`resize_node` 为目标设计，画布未交付 |
| 节点数据 | `update_node_spec` / `update_node_meta` / `update_node_ui` | | `useNodePatch.patchNode`（编辑即命令、同键合并撤销；分支选项级联内置同一撤销单元）；`ui` 态为运行态不经命令通道 |
| 连接 | `connect_edge` / `disconnect_edge` | | `useConnectionRules`（实时校验 + 落线入栈，与 AI 校验共用 `graphRules`）；`useEdgeDeletion` |
| 设定 | `upsert_character` / `delete_character`（地点、道具同构） | | `useSettingsActions`（角色/地点整桶 before/after 可撤销）；道具（props）CRUD 为目标设计，当前仅透传保真（§6 契约桶） |
| 设定文档 | `upsert_document` / `delete_document` | | `useSettingsActions`（documents 桶，issue 56） |
| 集标题 | `set_episode_title` | title 为空串 = 删除该集的标题键 | `useEpisodeEditing`（连续输入同键合并） |
| 项目 | `rename_project` | 改 `project.name`；name 在命令边界按 §9.3 项目名校验口径校验并保存规范化结果，索引同步由持久化层负责 | `App` 改名链经 `projectStore.save`（name 校验与索引同步由 §10.5 `save_project` 边界完成）；**尚未接入撤销栈**——改名不可撤销，首页/编辑器两条链均只写状态并保存（`HistoryCommand` 不涉及） |
| 资产 | `set_asset` / `remove_asset` | set 为 upsert 语义（id 已存在 = 覆盖），但必须经公开 dispatcher 的 Rust 实路径预检后才交给内部 reducer；inverse 视新增/覆盖而定（见 9.3） | `useAssetIndex`（索引增删写通道，由各命令包进撤销单元）；预检实际落点见 §9.3 实施对照 |
| 视口 | `update_viewport` | 不进撤销栈；过程帧 transient 不落盘，交互结束帧置脏随防抖持久化（§9.4） | `useEditorPersistence.onMoveEnd`（更新视口 ref + 显式标脏，衔接 `useDebouncedSave` 防抖落盘；不经命令） |
| 批量 | `batch` | 一等命令，整批作为单个撤销单元；整批原子——预校验任一子命令失败即整批拒绝、零变更（见 9.3） | 通用 `batch` dispatcher 未落地；已交付的手工复合命令**列举主要入口、并非穷举**（逐项映射见各命令行的「当前实现入口」列）：AI 批量经 `ai/commands.ts` 契约层与 `ai/batchFold.ts` 的 `validateAiBatch` 校验后由 `ai/batchSim.ts` 在虚拟终态折叠为一条复合命令（§12）；`useOutlineDrop`（sequence 边手术 + episodeNo 补丁，§3.5）；`useLibraryAssetDrop`（图库资产拖入分镜：资产入索引 + 引用位绑定一条命令，含 redoGuard）；`imagegen/state.ts`（生成产物落位：新旧资产切换 + outputs 补丁同栈撤销/重做） |

### 9.3 命令数据模型

命令创建时只携带**变更意图**（目标值）；`inverse` 不由创建者填写，而是 `applyCommand` 执行时从变更前文档（docBefore）自动捕获。这保证 undo 数据永远与文档真实旧值一致，创建者不可能填错。

> **实施对照**：自动捕获未以集中 reducer 落地，「创建者不可能填错」的结构性保证**尚未成立**——各生产点自行编写回退闭包（`useNodePatch.patchNode` 手工枚举补丁键构造 before、`useSettingsActions.patchSettings` 的 before 快照由调用方提供、`useNodeDeletion`/`useEdgeDeletion`/`ai/batchSim.ts` 各自构造撤销闭包），遗漏旧值或快照错误的窗口由各入口的单测守护，而非结构排除。

**文件系统依赖命令的入口约束**：Store 对 UI、Agent、MCP 与导入器只公开异步 `dispatchCommand`；纯 TS 的 `applyCommand` reducer 是模块私有实现，外部不得直接调用。dispatcher 遇到任意正向、撤销、重做或 batch 内的 `set_asset` 时，必须先把活动会话由 `load_project` 返回的受信 `projectId`（不得取自命令/Agent 负载）与完整 `AssetRef` 交给 Rust `validate_project_asset`，只将 Rust 原样返回的规范化 AssetRef 送入 reducer；真实路径预检失败时文档、undo/redo 栈与脏标记均保持不变。batch 在建立虚拟演进文档前完成全部 `set_asset` 预检，任一失败整批零变更；预检结果不得缓存或被另一条命令复用。`save_project` 仍按 §10.5 在每次落盘前复验完整 `assets.byId`，用于封住预检后文件被替换或删除的窗口；预检不是保存授权。

> **实施对照**：统一 `dispatchCommand` 未落地，预检语义部分交付——画布拖入导入经 `src/editor/projectAssets.ts` 调 Rust `validate_project_asset`（`useCanvasDrop` 消费）；图库拖入（`useLibraryAssetDrop`）与生成产物（`imagegen/state.ts`）以 `HistoryCommand.redoGuard` 在重做前复验落盘状态（issue #10）；`save_project` 落盘前复验完整 `assets.byId`（§10.5 已实现）。**已知差异：撤销恢复资产尚未预检**——目标要求覆盖「任意正向、撤销、重做」，而 `HistoryCommand` 只有 `redoGuard` 无 undo 守卫：`useNodeDeletion` 的 undo 直接 `addAsset` 恢复被回收产物、`imagegen` 替换产物的 undo 直接恢复旧产物；撤销窗口内文件被外部删改时失效条目会回到索引，由 `save_project` 全量复验在落盘边界拒绝（known boundary，design-sync #10 已记录）。

```ts
type Point = { x: number; y: number }
type Size = { width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type NodeUi = StoryNode['ui']

/** 命令类型与负载形状的映射。 */
interface CommandPayloads {
  // ── 节点 ──
  // create_node 的负载来自 Agent/MCP/导入等 JSON 边界，先校验 node 为普通
  // 对象，并在读取 type/spec/meta 前校验 StoryNodeBase 完整外壳：data、
  // data.spec、data.meta、layout、layout.position、ui 均须为普通对象；
  // position.x/y 须为有限数；可选 size 存在时须为普通对象，且
  // width/height 须为正有限数；
  // 可选 zIndex 存在时须为有限数；ui.selected/ui.expanded 均须为 boolean。
  // 任一必需容器缺失、null、数组或字段异型都直接拒绝，不得让脏节点先进入
  // 活动图、等重载时才由 §11.1 隔离。外壳通过后再按 nodeType 做同款校验
  // （§4.1 判别联合）：
  // spec 须属于该类型；meta.label 仅名称型节点；shot 不得携带 episodeNo；
  // 非 shot 节点的 episodeNo 须为正整数且为安全整数（Number.isSafeInteger
  // 且 > 0，与 set_episode_title 同域——零/负/小数/非有限值产生的大纲分组
  // 没有合法的集标题命令可对应，非有限值经 JSON 序列化不稳定，超出安全
  // 整数范围的集号作为 episodeTitles 对象键会与相邻集号折叠）。
  // branch 节点的 spec.options 内选项 id 不得重复——重复 id 映射到同一
  // option-<id> 句柄，label 解析歧义，且删除其一不被识别为移除，级联会把
  // 既有连线静默改接到剩余同 id 选项上。其余键控列表同域校验：
  // dialogue.lines 的 DialogueLine.id、shot.refs 的 ShotRef.id 均须非空且
  // 数组内唯一（列表 key 用 id，重复或空 id 会让删除/重排 reconcile 到
  // 错误项；空选项 id 还会生成无标识的 option- 句柄）。
  // ShotRef 每项还须是普通对象且形成 §4.2 的完整判别联合：kind 只允许
  // character/location/audio，assetId 与 label 必须恰有一个；assetId 须为
  // 非空字符串并解析到当前项目活动 assets.byId，character/location 目标
  // MIME 必须为 image/*，audio 目标必须为 audio/*；label 分支只校验为
  // 字符串，不查资产。未知 kind、混写/漏写目标或 MIME 用途不符均拒绝。
  // 另校验 node.id 为 trim 后非空字符串且全局唯一：空白 id 会生成无标识
  // 的边端点与空 React key；id 已存在于活动图时拒绝执行——否则追加会产生
  // 同 id 的歧义节点，且生成的 delete_node inverse 会把既有节点一并抹掉。
  // 导入器/Agent 须自行保证 id 新鲜；必要时由命令边界分配新 id 后再应用。
  // spec 数值域：sceneNo/shotNo 须为正整数且为安全整数（Number.isSafeInteger
  // 且 > 0——场号/镜号进卡片标题与导出排序，非有限值经 JSON 序列化变 null，
  // 超出安全整数范围的编号会与相邻编号折叠，导致重复编号与排序错误）。
  create_node: { node: StoryNode }              // 完整节点，含初始 layout/spec/meta
  delete_node: { nodeId: string }               // inverse 捕获被删节点 + 连带边
  move_node: { nodeId: string; to: Point }
  resize_node: { nodeId: string; to: Size }
  // ── 节点数据（set 为部分对象，只写变更字段）──
  // applyCommand 按解析出的节点类型校验 set：spec 字段须属于该类型的 Spec；
  // meta 字段同样按类型相关——label 仅名称型节点（scene/beat/dialogue）可写
  // （branch/shot 写 label 即镜像字段）；episodeNo 不可用于 shot（随宿主场景
  // 分集，§3.5），可用于其余类型但须为正整数（与 create_node 同域）。
  // 异型 set 拒绝执行。branch 的 options 补丁同样校验选项 id
  // 非空且数组内唯一；dialogue.lines / shot.refs 补丁同款（与 create_node
  // 同域，理由见其注释）。sceneNo/shotNo 补丁同样校验正整数域
  // （与 create_node 同域）。
  // update_node_meta 的 set 是联合而非交集：改名走 LabeledMeta 分支，
  // branch/shot 的 meta 编辑走 DerivedMeta 分支——交集会因 never 可选属性
  // 让改名补丁（{ label: '新名称' }）在类型上不可能成立。
  // 清除语义：unset 列出要删除的可选字段（如 episodeNo 回退未分集、
  // scene 的 locationId 解除引用）——JSON 无法传输 undefined，省略属性
  // 只表示「不修改」，清除必须走 unset。unset 与 set 同名字段、字段为必选
  // 或不存在（类型上无此键）一律拒绝；unset 空数组与省略等价。
  update_node_spec: { nodeId: string; set: Partial<NodeSpec>; unset?: string[] }
  update_node_meta: { nodeId: string; set: Partial<LabeledMeta> | Partial<DerivedMeta>; unset?: string[] }
  update_node_ui: { nodeId: string; set: Partial<NodeUi> }
  // ── 连接 ──
  // connect_edge 在命令边界先按 §5 校验安全外壳与判别字段：edge/data 须为
  // 普通对象，id/source/target 须为合法字符串 id，kind 仅允许
  // sequence/branch/attach，order 存在时须为有限数；未知 kind 或不属于任一
  // 变体的形状在端点解析、句柄、环、重复边与 inverse 处理前即拒绝。
  // 外壳合法后再把 edge.source 与 edge.target 解析为活动节点；任一端点不存在
  // 时，不分变体一律拒绝，且必须先于后续类型、句柄、环与重复边校验
  // （不可解出的连线留到加载才隔离会长期滞留活动图，并污染渲染、遍历与
  // 持久化）。两端点均存在后，branch 边的
  // source 须为分支节点、sourceHandle 中的选项 id 须存在于该节点 options；
  // attach 端点类型校验同理（§5），且目标
  // shot 已有入向 attach 边时拒绝（宿主唯一，§5）——更换宿主走
  // disconnect_edge + connect_edge 进同一 batch 的原子操作。
  // 另校验 edge.id 为 trim 后非空字符串且全局唯一（与 create_node 的
  // node.id 同款）：空白 id 会让 React Flow 以空 key 渲染、
  // disconnect_edge 与 inverse 无法按 id
  // 定位；id 已存在于活动图即拒绝——否则产生同 id 的歧义边，且生成的
  // disconnect_edge inverse 会把既有同 id 边一并误删。剧情流边（sequence/branch）另须保持 DAG：
  // 自环与成环（BFS 传递闭包）在命令层同样拒绝——Agent/导入绕过交互层
  // isValidConnection 直达本边界（§4.3 两层校验）。
  // 端口归属反向校验：source 为 branch 节点的边必须是 branch 变体并携带
  // 合法 option-<id> 句柄——branch 节点没有匿名 output 端口（§4.3），
  // sequence/attach 从 branch 发出即绕过选项语义；targetHandle 必须省略，
  // sequence 边的 sourceHandle 同样必须省略（剧情流出口为匿名 output
  // 端口，Handle 无 id）——匿名端口句柄携带任意值即拒绝。
  // 另拒绝逻辑重复边：同（source, target, sourceHandle）的边已存在于活动图
  // 即拒绝——新 edge.id 不改变重复本质，重叠连线会令遍历与统计重复计数
  // （交互层与 AI 路径已有同款检查，本边界为兜底）。
  connect_edge: { edge: StoryEdge }             // 完整边，含 data.kind；branch 边不落 label（胶囊文案按 sourceHandle 派生，§5）
  disconnect_edge: { edgeId: string }           // inverse 捕获被删边
  // ── 设定（地点、道具同构，略）──
  // 命令边界校验实体形状（TS 类型在 JSON 边界已擦除）：id/name 为非空
  // 字符串（去首尾空白后非空）；Character.id 还须满足 §6 的
  // [A-Za-z0-9_-]{1,64} 文本 token 子值域；gradient 为字符串；可选字段
  // （bio/note/description/avatarAssetId）存在时须为字符串——异型即拒绝，
  // 否则 name: null 之类的值会持久化并使消费方（trim/渲染）在运行期崩溃。
  upsert_character: { character: Character }    // id 已存在 = 更新，否则 = 新增
  delete_character: { characterId: string }     // inverse 捕获被删实体
  // ── 设定文档（SettingsDocument，§6）──
  // 命令边界校验完整文档形状（TS 类型在 JSON 边界已擦除，Agent/MCP/导入
  // 均可提交异型负载）：id 非空；title/body 为字符串；relatedIds 每项须为
  // { kind: 'character' | 'location'; id: string }——旧式字符串项、未知
  // kind、缺失或空 id 即拒绝（跨桶同名使裸 id 无法解析归属，§6）；
  // 数组内 (kind, id) 重复即拒绝（重复关联会持久化并让反向索引/导航
  // 重复列出同一文档）。
  upsert_document: { document: SettingsDocument }  // id 已存在 = 更新，否则 = 新增
  delete_document: { documentId: string }          // inverse 捕获被删文档
  // ── 集标题 ──
  // episodeNo 必须为正整数且为安全整数（Number.isSafeInteger 且 > 0，与
  // §11.1 归一化口径一致——零/负/小数/非有限/超出安全整数范围的值在命令
  // 边界拒绝，防止写入后重载即被归一化删除）；title 先校验 typeof 为
  // string（TS 类型在 JSON 边界已擦除，非字符串值直接 trim 会抛异常、
  // 原样写入则重载即被归一化删除），再去首尾空白，空串 = 删除该键
  set_episode_title: { episodeNo: number; title: string }
  // ── 项目 ──
  // 项目名校验口径（rename_project 命令边界、create_project、持久化层的
  // 项目名/id 校验三处共用，与 src-tauri store.rs sanitize_name 一致）：
  // 先校验 typeof 为 string（TS 类型在 JSON 边界已擦除），去首尾空白后
  // 非空且按字符数 ≤ 64 字符。命令边界拒绝非法值并保存去空白后的规范化
  // 结果——否则无效名称先写入活动文档与撤销栈、随后持续保存失败，非
  // 字符串值还会破坏按字符串消费名称的 UI。
  // inverse 捕获 docBefore 中的旧名原值（不经规范化——§11.1 已保证
  // 活动文档中的名称合法可保存，inverse 才可经本边界回放）。
  rename_project: { name: string }
  // ── 资产 ──
  // set_asset 语义同 upsert：id 不存在 = 新增，已存在 = 覆盖；inverse 视
  // 新增/覆盖分别捕获（见下方 inverse 捕获规则），覆盖时恢复旧 AssetRef
  // 而非删除条目，避免 undo 让既有引用悬空。命令边界按 §7.1 校验完整
  // AssetRef：asset 须为普通对象，id/relPath/mime/source/createdAt 均满足
  // 各自类型和值域并写入规范化结果；任一非法即拒绝，不能只校验 relPath。
  // 公开 dispatcher 在 reducer 读取 docBefore、捕获 inverse 或修改活动文档前，
  // 必须先经 Rust validate_project_asset 校验真实路径并采用其规范化返回值；
  // 原始 JSON 调用方不得直接触达内部 reducer，前端词法检查不能替代预检。
  set_asset: { asset: AssetRef }
  remove_asset: { assetId: string }             // 只移除索引，不删文件（见 7.3）；assetId 不存在时按「目标缺失」通则拒绝（inverse 无从捕获，见下方 inverse 捕获规则）
  // ── 视口 ──
  // to 的 x/y 须为有限数值、zoom 为正且有限——非法变换在边界拒绝（与
  // §11.1 第 3 步 viewport 归一化同域），避免 Agent/导入写入无效视口。
  update_viewport: { to: Viewport }
  // ── 批量 ──
  // 原子性契约：applyCommand 对 batch 先按子命令顺序在「虚拟演进文档」上
  // 逐一预校验（每条子命令的边界校验都针对前序子命令应用后的文档形态）；
  // 任一子命令失败即整批拒绝、零变更——不允许顺序执行后中途失败留下半批
  // 结果（如换宿主 batch 的 connect 子命令因 edge.id 冲突被拒而 shot 成孤儿）。
  // batch 含 set_asset 时，dispatcher 还须在本轮虚拟预校验前完成全部 Rust
  // 实路径预检；全部外部预检与纯模型预校验通过后才顺序执行并逐子捕获 inverse。
  batch: { commands: GraphCommand[] }           // 正向：完整命令信封（id/actor/timestamp 齐备，§9.1 审计契约）
}

type CommandType = keyof CommandPayloads

/** inverse 的类型安全形状：自带类型标签，patch 形状随标签走。
 * 多命令复合的 undo（如 delete_node 的连带边恢复）统一用 batch 承载。
 * batch 的 inverse 负载是 **InverseBatch**（子命令 inverse 的逆序数组），
 * 不是正向的 ForwardBatch——undo 操作由 applyCommand 内部构造，
 * 不经命令通道，无 id/actor/timestamp（§9.1 元数据契约只约束正向命令）。 */
type InversePatchOf<K extends CommandType> = K extends 'batch'
  ? { commands: InverseCommand[] }
  : CommandPayloads[K]

type InverseCommand = {
  [K in CommandType]: { type: K; patch: InversePatchOf<K> }
}[CommandType]

/** 类型化的命令信封：type 与 patch 必须同源于同一个 K（判别相关）。
 * inverse 是「另一条命令」（类型常与正向不同：upsert_character 新增的
 * inverse 是 delete_character），故为 InverseCommand 而非 CommandPayloads[T]。 */
interface GraphCommandBase {
  id: string
  actor: 'user' | 'agent'
  /** 执行时自动捕获的逆向命令；命令创建者不传。 */
  inverse?: InverseCommand
  transient?: boolean
  timestamp: number
}

/** 命令信封（数组/存储/传输/Agent 产出的默认形状）：type 与 patch 判别相关——
 * 裸 `type: K` 与异型 patch 的组合（如 delete_node 配 remove_asset 负载）
 * 在类型层即不可表示。 */
type GraphCommand = GraphCommandBase & {
  [K in CommandType]: { type: K; patch: CommandPayloads[K] }
}[CommandType]

/** 已知具体类型时的提取（applyCommand 逐类型分发）。 */
type GraphCommandOf<K extends CommandType> = Extract<GraphCommand, { type: K }>
```

**inverse 捕获规则**（applyCommand 内置，逐类型固定；inverse 的 type 按「捕获到的实际逆操作」取值）：

依赖既有实体的命令（`delete_node` / `disconnect_edge` / `delete_character` / `delete_document` / `remove_asset` / `update_node_*` 等删除与更新类）在命令边界**要求目标存在**：目标缺失时拒绝执行并返回错误——inverse 依赖从 docBefore 捕获旧实体，目标缺失时 inverse 无法生成，实施者只剩报错、制造不可撤销的历史项或伪造数据三条歧路，故统一取第一条。若某调用方（如 Agent 持过期快照重放）需要吞掉此类失败，语义为**不入栈的 no-op**：不产生 undo 历史项、不触发持久化变更标记，且必须显式选择该语义而非默认行为。

| 命令 | inverse 内容 | inverse.type |
| --- | --- | --- |
| `create_node` | 等效 `delete_node { nodeId }` | `delete_node` |
| `delete_node` | 等效 `create_node { node }` + 每条连带边的 `connect_edge`，进同一 `batch` | `batch` |
| `move_node` / `resize_node` / `update_viewport` | 同结构，`to` 换为 docBefore 中的旧值；**手势例外**：拖拽/缩放手势结束提交的正式 `move_node`/`resize_node`，inverse 的 `to` 取 dispatcher 在手势开始时捕获的原坐标，而非松手时的 docBefore（§9.4——transient 过程帧已把 docBefore 推进到最后一帧） | 同正向 |
| `update_node_*` | 同结构，`set` 只含被覆盖与被清除字段的旧值；被 `set` 新增（原先不存在）的字段进 inverse 的 `unset` | 同正向；**唯一例外**：触发选项级联的 `update_node_spec`（§8.2.2）→ inverse 为 `batch`——旧 spec 补丁 + 每条被级联删除边的 `connect_edge`，整体恢复 |
| `connect_edge` / `disconnect_edge` | 互逆，边数据取自 docBefore | 对偶命令 |
| `upsert_character` | 新增 → `delete_character`；更新 → 旧实体整体 | 视新增/更新而定 |
| `delete_character` | 等效 `upsert_character { character: 旧实体 }` | `upsert_character` |
| `upsert_document` | 新增 → `delete_document`；更新 → 旧文档整体 | 视新增/更新而定 |
| `delete_document` | 等效 `upsert_document { document: 旧文档 }` | `upsert_document` |
| `set_episode_title` | 同结构，title 换为旧值；原来无该键 → inverse 为空串（即删除） | `set_episode_title` |
| `rename_project` | 同结构，name 换为 docBefore 中的旧名 | `rename_project` |
| `set_asset` | 新增 → `remove_asset { assetId }`；覆盖已有 id → `set_asset { asset: docBefore 中的旧 AssetRef }`（恢复旧值，而非删除条目） | 视新增/覆盖而定 |
| `remove_asset` | 等效 `set_asset { asset: docBefore 中的旧 AssetRef }` | `set_asset` |
| `batch` | 子命令 inverse 的**逆序**数组，进同一 `batch` | `batch` |

### 9.4 撤销规则

- 撤销/重做栈仅存于会话，不持久化；目标 `GraphStore` 规格的 50 条与当前 `CommandStack` 默认 200 条存在差异，当前实现还在 800ms 内合并同键补丁。本次仅记录实现差异，不调整容量。
- **资产重做前复验（#10，已实现）**：库导入与生成产物命令通过可选 `redoGuard` 调用 `projectAssets.revalidate`，在资产重新进入索引前异步复验；失败时画布不变、命令保留在重做栈并显示错误，文件恢复后可重试。校验期间新编辑、撤销（含空栈意向）或再次重做都会推进栈版本，使旧校验的成功或迟到失败失效；普通无 guard 命令保持同步重做。删除撤销恢复资产的同构路径仍未增加复验，是 #10 明确保留的边界。
- 拖拽中发 `move_node { transient: true }`（过程帧只更新内存文档，不置脏不落盘、不进栈），松手时补发一条正式命令进撤销栈。**正式命令的 inverse 不得按默认规则从 docBefore 捕获**——transient 帧已把文档推进到最后一帧拖拽位置，从 docBefore 捕获会让 undo 只回到最后一个拖拽帧（常与终点相同）而非拖拽起点；dispatcher 必须在手势开始时捕获并持有各被拖节点的原坐标，松手提交正式 `move_node`/`resize_node` 时以该原坐标显式填充 inverse，或把整个手势（transient 帧 + 正式命令）作为同一手势事务合并捕获一次 inverse。缩放（resize）手势同款。
- `update_node_ui`（选中、展开折叠）与 `update_viewport` 不进撤销栈，但二者语义不同：`update_node_ui` 只改 §4.1 的 `ui` 会话态（`selected`/`expanded`，§3 明确不持久化、加载时重置），**不置脏、不落盘**——纯选择操作不得触发防抖保存，否则会让 Rust 重新生成 `updatedAt`、错误改变首页最近项目排序；若未来出现真正需要持久化的 UI 字段，须为其定义独立命令，不得搭 update_node_ui 的便车。`update_viewport` 则必须最终落盘——`graph.viewport` 随项目持久化（§3），平移/缩放的过程帧发 `update_viewport { transient: true }`（只更新内存、不置脏不落盘），交互结束时补发一条非 transient 的 `update_viewport` 终帧：置脏并随 §10.5 防抖保存落盘，但按本条仍不进撤销栈。若全部视口变更都停留在 transient 帧，关闭项目时视口修改不会产生可保存的脏状态，重开只能得到旧视口或 fitView。
