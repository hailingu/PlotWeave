# PlotWeave 数据模型设计

> 状态：v1（2026-08-28 定稿）
> 实施状态（2026-09-09 核对）：`ProjectDocument` v1、加载归一化与序列化管线已落地；磁盘保存使用 `schemaVersion: 1`，旧 v0 文档经迁移后进入会话。本文同时保留目标架构与后续演进，不能据此认定每个示意接口均已实现；当前模块与命令映射见 §2、§10.5。已关闭 issue 的逐项结论和合并依据见[设计同步记录](design-sync.md)。历轮评审修订已归档至[修订历史](data-model-revisions.md)，当前状态以正文的落地说明为准。
> 适用范围：画布文档模型、设定与资产模型、命令与撤销、本地存储体系、AI Agent 交互。
> 明确不在范围内：用户体系、租户、余额/计费。PlotWeave 是单用户 BYOK 桌面工具；若未来出现此类需求，另起《服务端领域模型》文档。

## 一、设计背景与原则

PlotWeave 是 Tauri + React Flow + Rust 的单用户桌面工具：创作者在画布上把剧本、场景、角色与剧情分支组织为节点图。模型配置走 BYOK——用户自己在客户端里配置 provider（base URL + API key），无服务端、无计费。

全部模型设计从五条原则推出，后文每个决策都能回溯到其中之一：

1. **单一文档真源**：一个项目的画布数据收敛为一份带 `schemaVersion` 的 JSON 文档。备份、导出、版本兼容都只围绕这一份文件。
2. **数据按职责分区**：渲染布局、会话状态、用户意图、元信息分开存放，互不污染。
3. **一切变更走命令**：状态修改有唯一入口，撤销/重做、持久化、AI 操作画布都建立在这条通道上。
4. **资产文件化**：媒体内容落盘为文件，文档内只存引用。
5. **不为不存在的问题付费**：单写者桌面场景不引入并发仲裁、协同合并、任务编排等机制。

## 二、总体分层

下图是目标架构的职责划分，`GraphStore` / `useGraphStore` 为设计名称，不是当前可导入的实现符号。

```
React 组件层（节点组件、设定面板、资产库面板）
   ↓ 交互意图
Store 桥接层（useGraphStore hook）
   ↓ 命令（GraphCommand）
模型层（纯 TypeScript，无框架依赖）
   ProjectDocument ← GraphStore（applyCommand / undo / redo / 防抖持久化回调）
   ↓ invoke
Rust 持久化层（Tauri commands：文件读写、资产导入、设置与密钥、LLM 代理）
```

两条约束贯穿所有层：

- 模型层是纯 TS：不可变更新，对外暴露只读快照。便于单测，也便于未来需要时平移到 Rust。
- 画布状态的唯一真源是 GraphStore；React Flow 只作渲染与交互层，不持有业务状态。

**当前实现映射（#6、#14、#16、#35、#39）**：`EditorView` 负责装配，`useEditorDocument` 持有会话文档，`useEditorController` 汇集按域 hooks，`EditorLayout`/`EditorCanvasRegion`/`EditorOverlays` 承载布局；撤销重做由 `history.ts` 的 `CommandStack` 承载。会话 `ProjectContent` 与磁盘 `ProjectDocument` 通过 `model/convert.ts` 门面转换，归一化阶段位于 `normalize*.ts`，序列化位于 `serialize.ts`。UI 补丁经 `nodes/patch.ts` 的 `NodeDataPatch` 按节点类型判别，`PatchShape` 去掉索引签名，序列化按节点联合穷尽分派；JSON 输入仍须运行时校验。`projectStore.ts` 是持久化门面，内部按 `memory`/`tauri`/`saveChain`/`seeds` 分域；Rust 项目存储位于 `store/`，库索引与删除恢复分别位于 `library_index/`、`library_journal/`。这些拆分不改变文档格式或产品行为。

下文顺序：先定义数据本身（三~七）与引用规则（八），再定义变更机制（九：命令与撤销），然后是落地（十：存储；十一：加载归一化），最后是建立在命令通道之上的 AI 能力（十二）与演进方向（十三）。

## 三、ProjectDocument

一个项目一份文档，序列化为 `project.json`：

```ts
/** 项目文档：画布数据的序列化真源。 */
interface ProjectDocument {
  schemaVersion: 1
  project: {
    id: string            // 目录名，创建时生成的 UUID
    name: string
    description?: string
    createdAt: string     // ISO 8601
    updatedAt: string
  }
  graph: {
    nodes: StoryNode[]    // 见第四节
    edges: StoryEdge[]    // 见第五节
    viewport?: { x: number; y: number; zoom: number }  // 单用户场景直接随文档持久化；缺省 = 从未保存过视口（打开时 fitView）
    aiRevision?: number   // 已应用 AI 批次的单调计数（§12.2 提交身份）；缺省 = 0，只增不减
  }
  settings: {             // 设定集：节点通过 id 引用，见第六节
    characters: Record<string, Character>
    locations: Record<string, Location>
    props: Record<string, PropItem>
    documents: Record<string, SettingsDocument>  // 长篇自由文本条目（小传/世界观/术语表）
  }
  episodeTitles: Record<number, string>  // 集标题表：键 = 集号（见 4.1，不建「集」实体表）
  assets: {
    byId: Record<string, AssetRef>  // 项目资产索引；文件本体在项目 assets/ 目录，见第七节
  }
}
```

文档**不**持久化画布会话态：撤销/重做栈、选中态（`ui.selected` 加载时重置）、拖拽中的临时位置。这些留在内存，随会话结束消失。创作型 AI 对话是例外：它不进入 `ProjectDocument`，而是按 §10.1 的独立 `ai-session.json` 保存，以免频繁消息写入重序列化整份画布。

`graph`/`settings`/`assets` 三个容器可携带上表契约键之外的**同版本扩展字段**（未知键，[issue #100](https://github.com/hailingu/PlotWeave/issues/100)）：Rust 原样透传、前端归一化按扩展字段保留（不修复、不回写），保存原样落盘——数值须为 IEEE 754 双精度可往返形态才受保留保证：整数越出 JS 安全整数域可诊断（归一化记警告、保存固化当前加载值）；小数精度超出 f64 的值在 Rust 解析侧即舍入、webview 不可检测，同样不受保证（§11 分层策略与传输边界）。顶层与 `project` 层是类型化封闭契约，未知键不保留；会被旧客户端丢弃的字段增补必须升级 `schemaVersion`。

## 四、节点模型

### 4.1 通用结构

```ts
/** 画布节点：叙事单元，四分区（layout/ui/spec/meta）。
 * type 与 data.spec/meta 判别相关：scene/beat/dialogue 显示并编辑名称
 * → meta.label 必填；branch/shot/image 标题由 spec.prompt / spec.shotNo
 * 派生或无标题（图片节点）→ 不落 label（§8.1.1 禁止镜像字段）。 */
interface StoryNodeBase {
  id: string
  layout: {                          // 渲染布局
    position: { x: number; y: number }
    size?: { width: number; height: number }
    zIndex?: number
  }
  ui: {                              // 会话态，加载时重置
    selected: boolean
    expanded: boolean                // 首版节点无折叠形态，恒 true；保留字段为演进占位
  }
}

/** 名称型节点 meta：label 必填（卡片头部/大纲/Agent 摘要的显示与编辑目标）。 */
interface LabeledMeta {
  label: string
  episodeNo?: number             // 集归属（大纲分组的唯一依据）；正整数且为安全整数（Number.isSafeInteger 且 > 0——超出安全整数范围的集号作为对象键会与相邻集号折叠，命令写入后重载即被 §11.1 删除；与 set_episode_title/§11.1 归一化同域）
  createdAt?: string             // 首版运行态不维护时间戳，落盘可省略；保留字段为演进占位
  updatedAt?: string
}

/** 派生标题节点 meta：无 label（branch 专属；label?: never 禁写，
 * 结构上杜绝可变对象/spread 携带镜像标题，§8.1.1）。 */
interface DerivedMeta {
  label?: never
  episodeNo?: number             // 同 LabeledMeta：正整数域
  createdAt?: string
  updatedAt?: string
}

/** 分镜卡 meta：无 episodeNo（分镜卡随宿主场景分集，§4.1/§3.5）、
 * 无 label（镜号由 shotNo 派生）——两者均 never 禁写。 */
interface ShotMeta {
  label?: never
  episodeNo?: never
  createdAt?: string
  updatedAt?: string
}

/** 图片节点 meta（§13）：生成产物非叙事单元，无 label、无 episodeNo
 * （不进大纲分组）——两者均 never 禁写。 */
interface ImageMeta {
  label?: never
  episodeNo?: never
  createdAt?: string
  updatedAt?: string
}

interface SceneDocNode extends StoryNodeBase {
  type: 'scene'
  data: { spec: SceneSpec; meta: LabeledMeta }
}
interface BeatDocNode extends StoryNodeBase {
  type: 'beat'
  data: { spec: BeatSpec; meta: LabeledMeta }
}
interface DialogueDocNode extends StoryNodeBase {
  type: 'dialogue'
  data: { spec: DialogueSpec; meta: LabeledMeta }
}
interface BranchDocNode extends StoryNodeBase {
  type: 'branch'
  data: { spec: BranchSpec; meta: DerivedMeta }
}
interface ShotDocNode extends StoryNodeBase {
  type: 'shot'
  data: { spec: ShotSpec; meta: ShotMeta }
}
interface ImageDocNode extends StoryNodeBase {
  type: 'image'
  data: { spec: ImageSpec; meta: ImageMeta }
}

type StoryNode =
  | SceneDocNode
  | BeatDocNode
  | DialogueDocNode
  | BranchDocNode
  | ShotDocNode
  | ImageDocNode
```

节点数据只保留四个分区：渲染布局（`layout`）、会话状态（`ui`）、用户意图（`data.spec`）、元信息（`data.meta`）。画布没有执行引擎，因此不设输入缓存、产物、运行状态等分区——没有写者的字段不进模型（原则 5）。

「集」是逻辑分类而非实体：首版集 = 编号 + 大纲行内标题，标题存文档级 `episodeTitles: Record<number, string>`（键 = 集号），不建「集」实体表。

### 4.2 各类型 spec

节点里写的一切内容——梗概、台词、以及将来 AI 生成的 prompt——都是 `spec` 的字段，随 `project.json` 持久化，无需额外存储。

```ts
type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec | ImageSpec

/** 场景：一个时空单元的叙事容器（UI 形态 = 索引卡，字段对齐 ui-design §4.2）。 */
interface SceneSpec {
  sceneNo: number            // 剧本场景头编号，展示为 SCENE 03；正整数且为安全整数（Number.isSafeInteger 且 > 0，命令边界与归一化均校验，§9.3/§11）
  interior: boolean          // 内景/外景徽标
  locationId?: string        // 引用 settings.locations
  time?: string              // 自由文本，如「夜·雨」
  weather?: string           // 天气，自由文本
  synopsis: string           // 场景梗概
  characterIds: string[]     // 出场角色，引用 settings.characters
}

/** 桥段：场景内的情节拍点（转折、反转、高潮）。承载节奏而非内容，不设正文。 */
interface BeatSpec {
  tone: string               // 情绪基调（UI 设计文中的 emotionalTone），如「压抑」「爆发」
}

/** 对白：一段角色对话。 */
interface DialogueSpec {
  lines: DialogueLine[]
}

/** 对白的一行：角色台词或居中动作行；id 为稳定标识（列表 key 不用数组下标）
 * 且非空、数组内唯一（命令边界与归一化均校验，§9.3/§11）——重复或空 id 作
 * React key 会让删除/重排 reconcile 到错误行。 */
interface DialogueLine {
  id: string
  kind: 'line' | 'action'
  text: string
  speaker?: string           // kind='line' 时的说话人，引用 settings.characters
  side?: 'left' | 'right'    // 气泡左右侧
  vo?: boolean               // 画外音（VO 徽标）
}

/** 分支：剧情分岔点。选项存在 spec 里（端口/胶囊渲染的唯一真相）；
 * 出口连线经 sourceHandle（option-<选项 id>）指向选项，label 由选项派生，边上不落拷贝（见第五节）。 */
interface BranchSpec {
  prompt: string             // 分岔事由，如「女主是否发现真相」
  options: Array<{ id: string; label: string }>  // id 为稳定标识，非空且数组内唯一（命令边界与归一化均校验，§9.3/§11）；sourceHandle 按 id 定位（option-<id>），删选项不位移其他连线
}

/** 分镜卡（生成侧）：一张卡 = 一个镜头及其 AI 燃料。
 * 画布一等节点类型，经 attach 边垂直下挂在索引卡正下方（见 4.3），
 * 不参与横向剧情流；首版为结构占位，拖拽引用与渲染联动随演进评审。 */
interface ShotSpec {
  shotNo: number             // 镜号；正整数且为安全整数（同 sceneNo 域——参与导出排序，非有限值经 JSON 序列化变 null，超出安全整数范围的编号在传入命令前即可能与相邻编号折叠为同一 IEEE-754 数值）
  size: string               // 景别（特写 / 中景 / 全景…）
  picture: string            // 画面描述
  prompt: string             // 镜头 Prompt（AI 视频模型的直接输入）
  refs: ShotRef[]            // 引用位：角色垫图 / 场景底图 / 音频
}

/** 分镜卡引用位：引用位与自由位互斥（assetId / label 不共存——
 * 对侧成员以 never 禁写，混写形状在类型层不可表示）。
 * kind 只表示生成用途，不是目标命名空间；引用位一律指向本项目 assets.byId。
 * 引用位的唯一真相是 assetId（§8.1）——缩略图/媒体内容按项目资产实时解析，索引元数据变化不影响引用，
 * 被删按 §8.2.3 失效展示；落 label 即镜像字段（禁止，§8.1.1）。
 * id 非空且在 refs 数组内唯一（同 DialogueLine，§9.3/§11 校验）。
 * character/location 只接受 image/* 项目资产，audio 只接受 audio/* 项目资产。 */
type ShotRef =
  | { id: string; kind: 'character' | 'location' | 'audio'; assetId: string; label?: never }  // 项目资产引用位
  | { id: string; kind: 'character' | 'location' | 'audio'; label: string; assetId?: never }  // 自由位：手填文案
```

**分镜引用读取防护（[issue #130](https://github.com/hailingu/PlotWeave/issues/130)，已实现）**：`ShotNode` 仅将 `assets.byId` 的自有条目视为引用目标，不把对象原型的继承成员当成资产；特殊属性名不是禁用 id，同名自有合法条目仍可解析。渲染前检查 MIME 为字符串，目标缺失、条目为空或 MIME 缺失/异型时仅对该引用显示带资产 ID 的失效提示，不清除 `ShotRef`、不修改资产索引，合法条目恢复后重新展示。这是 §8.2.3 的局部展示兜底，不替代 §7.1/§11 的完整资产校验，不改变持久化格式或写入契约。

**图片节点（§13 文生图首版，生成侧媒体节点）**：自由摆放在画布上，不参与任何连线（sequence/branch/attach 端点均不得为 image——§5 端口归属与 §11.3 孤儿边规则同域拒绝）；生成操作由 `spec` 携带，产物落 `outputs` 槽位：

```ts
/** 图片节点 spec：文生图输入 + 产物槽位。
 * model 为 "providerId:modelId"（与 AppSettings 默认模型同构，空串 = 未选择，
 * 生成入口回退默认图像模型）；operation 不落字段——首版无引用输入、恒为
 * 文生图，图生图随 §13 引用边演进再评审。 */
interface ImageSpec {
  prompt: string               // 画面描述（生成输入）
  model: string
  size: string                 // 如 '1024x1536'（竖版贴短剧画幅）
  outputs: {
    primary?: GeneratedOutput  // 产物槽位：缺失 = 尚未生成
  }
}

/** 生成产物引用：只存项目资产 id（assets.byId 是唯一真相，§8.1 禁止镜像
 * 媒体字段）；宽高为演进占位（存在时须为正有限数，归一化剥离非法值）。 */
interface GeneratedOutput {
  assetId: string
  width?: number
  height?: number
}
```

产物媒体经 Rust `llm_image_generate` 原子落盘进项目 `assets/`（`source: 'generated'`），§9.3 预检（形状 + 实路径复验）在命令内、返回前完成——前端单次 IPC 直收已校验条目并入会话索引，再以 `update_node_spec` 写回 `outputs.primary`（走命令栈，可撤销）。生成完成写回前比对**输入签名**（prompt/model/size 规范化元组）：输入已前进即丢弃结果并横幅提示，媒体文件留存待延迟回收（§7.3）——旧输入的产物不得覆盖新编辑。落盘之后到命令返回之间不存在取消检查点（文件已写、放弃只会制造孤儿）：该窗口内编辑器卸载的结果丢失登记为已知边界，跨卸载保留随 job 落盘与启动恢复演进一并解决。

### 4.3 端口与连接

直接使用 React Flow 多 handle：

- `scene` / `beat` / `dialogue`：`input`（target）+ `output`（source）各一个。
- `branch`：一个 `input`（target）+ 多个出口 source handle（`option-<选项 id>`，动态增删；用稳定 id 而非数组下标，删除任一选项不影响其余出口的连线归属）。
- `scene`：额外带底部 source handle（`shots`），经 attach 边垂直下挂分镜卡——**横向 = 剧情顺序，垂直 = 派生从属**（一对多合法，attach 不参与剧情流环检测）。
- 连接校验做两层：前端交互层（`isValidConnection`）即时反馈；命令层（`connect_edge` 边界，§9.3）对同一不变量复核——禁止自环、禁止剧情流成环（sequence/branch 的 BFS 传递闭包检查；attach 垂直从属不参与）——Agent/导入绕过交互层直达命令通道，剧情流 DAG 不变量不能在命令层失守；漏网成环边由归一化隔离（§11.1 第 3 步）。

## 五、边模型

```ts
/** 剧情连线：按 data.kind 判别的三种变体。
 * branch 变体必须携带 sourceHandle（option-<选项 id>）——边上无镜像 label 后
 * 胶囊文案的唯一解析依据，缺句柄的 branch 边非法（归一化按孤儿边隔离）。 */
interface EdgeBase {
  id: string
  source: string
  target: string
  targetHandle?: never                    // 禁写（never，同 §4.1 DerivedMeta.label——必须省略的形状在类型层不可表示，静态类型与 connect_edge 边界契约一致）：各节点仅一个匿名 target 端口（Handle 无 id），JSON 边界漏入的值即非法（§5 端口归属反向约束）
}

interface SequenceEdge extends EdgeBase {
  sourceHandle?: never                        // 禁写（never）：剧情流出口为匿名 output 端口（Handle 无 id），JSON 边界漏入的值即非法（§5 端口归属反向约束）
  data: { kind: 'sequence'; order?: number }  // order = 同一 source 多出口的排列顺序
}

interface BranchEdge extends EdgeBase {
  sourceHandle: string                        // 必填：option-<选项 id>
  data: { kind: 'branch'; order?: number }
}

interface AttachEdge extends EdgeBase {
  sourceHandle: 'shots'                       // 必填字面量：索引卡底部端口（§4.3，attach 仅从该端口发起，防误绑横向出口）
  data: { kind: 'attach'; order?: number }
}

type StoryEdge = SequenceEdge | BranchEdge | AttachEdge
```

**JSON 边界的完整边判别校验**：TypeScript 联合在导入、Agent/MCP 与磁盘 JSON 边界均已擦除。`connect_edge` 必须先确认边及 `data` 为普通对象，`id`/`source`/`target` 满足 §8.1 的字符串 id 值域，`data.kind` 严格等于 `sequence`/`branch`/`attach` 之一，可选 `data.order` 存在时为有限数，再解析活动端点并按 kind 校验对应句柄形状（sequence 禁写 `sourceHandle`、branch 必须是可解析的 `option-<id>`、attach 必须是字面量 `shots`，三者均禁写 `targetHandle`）。加载时先完成 §11.1 的节点/列表/边 id 重发及可确定引用改写（包括空白节点 id 对边端点的改写），再要求 `source`/`target` 是合法字符串 id，并在解析端点前校验 `data.kind` 与 `order`；未知或非字符串 kind 立即连同警告隔离。已知 kind 的漏网边只允许执行不会改变连接语义的确定性修复——剥离匿名端口上的 `targetHandle`，以及 sequence 的 `sourceHandle`（均记录警告）——修复后仍无法形成对应变体（如 branch 缺少可解析的选项句柄、attach 句柄不是字面量 `shots`）则隔离，不得进入活动图。除加载专有的 id 重发、引用改写与上述确定性句柄剥离外，该安全外壳与判别校验必须先于端点解析、句柄语义、端点类型、成环、重复边和 inverse 处理，否则未知变体可能被渲染后又无法经 `connect_edge` inverse 恢复。

- `sequence`：剧情顺序流，无 label。
- `branch`：从 branch 节点出口引出；**边上不存 label 拷贝**——胶囊文案按 `sourceHandle`（`option-<选项 id>`）解析分支节点 `spec.options` 中同 id 选项的 label 派生（§8.1.1 禁止镜像字段）；多结局用多条 branch 边指向不同子图表达。
- `attach`：索引卡底部端口 → 分镜卡顶部端口的派生从属边（垂直下挂），无 label，不参与剧情流环检测。**宿主唯一**：一个 shot 至多一条入向 attach 边——宿主场景是分镜卡分集归属（§3.5）与下挂布局的唯一依据，多宿主会让归属随边序漂移；更换宿主为原子操作（`disconnect_edge` 旧边 + `connect_edge` 新边进同一 `batch`），而非直接加第二条边。

**句柄保留字面量**：`shots` 为 attach 变体专属（§4.3 attach 仅从索引卡底部端口发起）；`option-<id>` 句柄为 branch 变体专属（§8.1.1 无镜像 label 后的文案解析依据）。`sequence`/`branch` 边携带 `shots` 句柄、`sequence` 边携带 `option-<id>` 句柄、`attach` 边携带非 `shots` 句柄，均属 kind/句柄矛盾——命令层校验拒绝，漏网者由归一化按孤儿边隔离（§11.3）。attach 边另受**端点类型约束**：必须 `scene → shot`（非 scene 源或非 shot 目标同样命令层拒绝、归一化隔离），否则分镜计数与下挂布局会被脏数据污染；并受**宿主唯一约束**：目标 shot 已有入向 attach 边时命令层拒绝第二条（更换宿主走「断开 + 重连」同 `batch` 的原子操作），漏网者归一化保留文档序首条、其余按孤儿边隔离（§11.1 第 3 步）。

**端口归属反向约束**：branch 节点没有匿名 output 端口（§4.3 出口只有 `option-<id>`）——source 为 branch 节点的边必须是 branch 变体且携带合法选项句柄，`sequence`/`attach` 边从 branch 发出即绕过选项语义，命令层拒绝、归一化按孤儿边隔离。匿名端口句柄必须省略：各节点仅一个匿名 target 端口，scene/beat/dialogue 的剧情流出口同为匿名 output 端口（实现中 Handle 均无 id）——`targetHandle` 与 sequence 边的 `sourceHandle` 携带任意值都无法绑定到真实端口，命令层拒绝；归一化剥离该字段并记录警告（端口匿名唯一，剥离不改变连接语义，无需隔离）。此前句柄保留字面量规则中 sequence 携带 `shots`/`option-<id>` 的两条矛盾形态被本条吸收（更严：任何值均非法）。**逻辑重复边**：同（source, target, sourceHandle）的边全局唯一——重复边产生重叠连线并令遍历/统计重复计数，命令层拒绝，漏网者归一化保留文档序首条、其余按孤儿边隔离（§11.1 第 3 步）。

**剧情流端点约束**：分镜卡不参与横向剧情流（§4.2，只经 attach 垂直下挂）——`sequence`/`branch` 边的任一端点为 shot 节点即非法：命令层校验拒绝，漏网者由归一化按孤儿边隔离。

## 六、设定集（settings）

角色/地点/道具是项目级实体，节点只存 id 引用——改一处人设，所有引用它的节点同时生效：

```ts
interface Character {
  id: string
  name: string
  gradient: string            // 头像配色渐变（设定集头像与节点头像串共用）
  bio?: string                // 一句小传；长篇人设/世界观走 SettingsDocument
  avatarAssetId?: string      // 引用 assets.byId（项目资产落地后启用）
}
interface Location { id: string; name: string; note?: string }
interface PropItem { id: string; name: string; description?: string }

/** 文档条目（写作原料）：人物小传 / 世界观 / 术语表等自由文本，持久化于
 * ProjectDocument.settings.documents；与结构化条目双向关联（如小传挂在角色名下）；
 * 全文进入 AI 上下文快照的按需读取范围。 */
interface SettingsDocument {
  id: string
  title: string
  body: string
  relatedIds: Array<{ kind: 'character' | 'location'; id: string }>  // 关联的设定条目：kind + id 显式成对——character 与 location 是两个独立 id 空间，字符串可能跨桶同名，裸 id 无法解析归属；数组内按 (kind, id) 唯一——重复项使命令边界拒绝、归一化去重（§9.3/§11.1），否则反向索引/导航会把同一文档重复列出
}
```

**角色 id 的文本语法子值域**：`Character.id` 除满足 §8.1 的共同值域外，还必须匹配 ASCII 正则 `^[A-Za-z0-9_-]{1,64}$`。这是持久化 @ 提及 token 的语法约束，不扩散到无需嵌入文本 token 的其他 id 域；角色创建、导入与 `upsert_character` 在命令边界拒绝不满足该子值域的 id。由此 `@[character:<id>]` 的 `<id>` 不含 `]`、换行、空白或其他分隔字符，可直接按下述固定语法无歧义扫描，无需依赖实现各异的转义器。

**悬空引用规则**：设定被删除时不级联改节点（避免静默丢数据），节点侧按「引用失效」样式展示（如灰色角标），由用户决定替换或清除。只做检测与展示，不引入级联状态机（原则 5）。

## 七、资产模型

### 7.1 两个作用域

- **项目资产**：归属于某个项目，文件存于项目目录内，`project.json` 的 `assets.byId` 只索引本项目资产。项目是**自包含**的——导出、备份、移动项目目录不会丢失任何引用。
- **个人资产库**：跨项目复用的素材（角色立绘、参考图、常用模板），存于应用级 `library/` 目录，由独立的 `library.json` 索引，不进任何 ProjectDocument。

两个作用域共享同一个引用结构：

```ts
/** 资产引用：媒体本体是文件，文档只存引用。 */
interface AssetRef {
  id: string
  relPath: string            // 项目资产相对项目目录；库资产相对 library/ 目录（维持既有磁盘格式：库条目写作 assets/<文件>——变更基准会让既有资产全部解析失效）。解析目标必须落在专用资产子目录内，安全约束见下
  mime: string
  source: 'upload' | 'generated'
  createdAt: string
}
```

**后端媒体能力归属（[issue #146](https://github.com/hailingu/PlotWeave/issues/146)，已实现）**：按项目资产管线、图库命令、协议适配器、纯策略和文件系统能力区分依赖；错误类型所在的 `library::error` 是独立契约，引用它不等同于调用图库命令。`media_protocol` 独立持有跨作用域的 `pwmedia` 请求处理与 `get_asset_media_url`，单向调用 `assets::project_media`、库索引和恢复能力；图库命令不再包含协议适配器。`media_format` 是无 IO 的扩展名叶子策略，供 `assets` 与 `library` 直接消费：导入仍优先使用合法的短文件扩展名，其余按 MIME 回退；生成产物仍仅按原有 PNG/JPEG/WebP/GIF 映射扩展名，其他类型回退 `bin`。`library_fs::open_library_asset` 统一持有库文件的句柄链打开、普通文件与 Unix 身份复核，供项目导入和协议读取共用。没有兼容性反向 re-export；IPC 名称、URL、磁盘格式、锁与读取许可生命周期不变。`src-tauri/tests/media_format_leaf.rs` 在不声明其他应用模块的测试 crate 中直接编译生产叶子，并验证两种扩展名策略；其余能力的方向按生产引用核对，本单未引入全仓 Rust 模块图检查。

**AssetRef 的 JSON 边界完整校验**：导入、Agent/MCP、磁盘项目文档与 `library.json` 中的 TypeScript 形状均已擦除。进入活动索引前必须确认条目是普通对象；`id` 满足 §8.1 的字符串 id 值域，`relPath` 是非空字符串并满足下述路径安全约束，`mime` 是去首尾空白后由两个非 `*` RFC 9110 token 组成的具体 `type/subtype` ASCII 媒体类型（索引不保存参数，统一小写），`source` 严格等于 `upload` 或 `generated`，`createdAt` 是带显式 `Z` 或 UTC offset、可解析且表示有效时刻的 ISO 8601 字符串并统一落为 UTC `toISOString()`。`set_asset` 的纯模型校验对完整形状执行该规则；此外公开 dispatcher 必须在调用内部 reducer 前，经 Rust `validate_project_asset(projectId, asset)` 以受信项目/资产根句柄逐组件 no-follow 打开 `relPath`、确认目标是资产根内普通文件，并只采用 Rust 返回的规范化 AssetRef。形状或真实路径任一失败时不得进入活动文档、undo/redo 栈或脏标记；导入/生成、Agent/MCP、撤销/重做与 batch 同样不得绕过。`save_project` 在任何临时文件或时间戳写入前对 `assets.byId` 全量执行同一 Rust 实路径复验，防止预检后目录项被替换；失败整份拒绝且不更新索引。加载项目时，`assets.byId` 的 Record 键/id 先按 §11.1 的共同规则修复；加载资产库时，旧数组格式先按 §7.2 的兼容迁移转换为目标 Record，再执行同款键/id 修复。随后，合法但未规范化的 MIME 大小写/空白与带显式时区的时间戳表示可确定性规范化并警告，其余无法无歧义修复的条目隔离并警告，引用按 §8.2.3 标记悬空。库侧即使另有分类字段归一化，也必须执行这些共享字段规则，不能因 `relPath` 合法就跳过基础形状。

**relPath 安全约束**：relPath 必须是纯相对路径（禁止绝对路径），其**基准**为项目目录（项目资产）或 `library/` 目录（库资产）——维持既有磁盘格式（库条目写作 `assets/<文件>`），基准变更会让既有资产解析成 `library/assets/assets/<文件>` 而全部失效。解析目标必须位于**专用资产子目录**内（项目 `assets/`、库 `library/assets/`，§10.1），且不得进入保留的库隔离目录 `library/assets/.trash/`（该目录及其随机名称永不进入 AssetRef、媒体 URL 或孤儿候选）：控制文件（`project.json`/`library.json`/`index.json`）位于子目录之外——`"library.json"` 这类条目词法合法、解析后也在库目录内，但目标不在 `library/assets/` 内即非法，`delete_library_asset`/`remove_file` 之类的按路径操作由此永远触达不到索引自身；含 `..` 上跳段使解析目标越出子目录同样非法。词法规范化不足以兜底：资产目录内若存在指向根外的符号链接，`assets/link` 词法合法、不含 `..`，真实路径却已越界——因此校验以**真实路径包含关系**为准：对资产子目录与目标路径做 canonicalize（解析符号链接）后判定目标仍位于子目录之内，越界即非法；新增资产（目标文件尚不存在、无法 canonicalize）时拒绝路径各级中的符号链接，或对最近已存在祖先做 canonicalize 后拼接校验。**信任链必须从应用数据根逐级建立，不能把待校验的基准目录自身当作最外层锚**：先 canonicalize Tauri `app_data_dir` 作为受信根并确认 `projects/` 与 `library/` 的 canonical 路径仍位于该根内，再确认 `{projectId}/` 的 canonical 路径仍位于 canonical `projects/` 内，最后才确认项目 `assets/` 位于该项目目录内、`library/assets/` 位于 canonical `library/` 内；任一现存中间目录是指向其父级受信根外的符号链接，均拒绝整个对应资产区并记录警告。目录尚不存在时只能通过已验证且无符号链接的父目录创建，创建后重新 canonicalize 并复核逐级包含关系。由此即使项目目录与其 `assets/`、或 `library/` 与 `library/assets/` 一起指向同一外部树，也不能以“根与目标彼此包含”为由通过校验。**分层执行**：词法校验（纯相对、解析目标在子目录内）前端模型层可执行；上述逐级真实路径包含判定只能在可访问文件系统的 Rust 层执行——webview 模型层无法自行解析本机符号链接。Rust 在 `load_project` 与资产命令内对每个 relPath 做 canonical 校验并把非法条目清单随加载结果返回，前端归一化消费该清单隔离条目；库侧 `list_library_assets`/`delete_library_asset` 在 Rust 内同款校验。这是 §7.1「项目自包含」与备份/移动完整性的前提，也是信任边界校验（防解析或复制时逃逸资产根）：`set_asset` 命令边界拒绝非法值，归一化对脏数据隔离该索引项并记录警告（引用该资产的字段按 §8.2.3 悬空展示）。**库索引入口同款约束**：`library.json` 不走 §11.1 项目文档归一化（它不是 ProjectDocument），且可被手工修改或损坏——读取库索引（`list_library_assets`，§7.2 启动时全量载入）时对每个条目应用同款校验（含真实路径包含判定），非法条目不进内存索引并记录警告。仅在列表入口过滤不足以兜底：`delete_library_asset` 等操作会重读或消费索引中的 relPath，而目录项可能在列表校验之后、实际读删之前被替换（TOCTOU）。**canonicalize 只用于加载筛查、包含关系诊断与无句柄平台上的拒绝性兜底，绝不是后续文件 I/O 的授权凭据；缓存“本会话已验证”的 relPath 同样不构成授权，本文不再允许二者作为实际操作的替代方案。**凡按 relPath 触达项目或库资产文件的入口（导入、创建、读取、媒体响应、复制、移动、删除与清理）均由 Rust 在该次操作内从已验证的应用/项目/库父目录句柄出发，以 no-follow 语义打开并持有专用 `assets/` 根目录句柄；把词法校验后的 `assets/<子路径>` 去掉固定首段后，逐组件以相对目录句柄继续打开，拒绝空段、`.`/`..`、符号链接、非目录中间项及越界，整个句柄链保持到操作结束，不得在校验后退回原始绝对路径或字符串拼接路径。读取以最终父目录句柄相对 no-follow open，并在已打开句柄上确认普通文件后流式读取；删除不得只凭最终组件名称调用 `unlinkat`：no-follow 只能阻止跟随符号链接，不能证明该名称仍绑定此前打开的普通文件。库资产删除必须先按 §7.2 把经身份核验的目录项原子移入保留的私有隔离区，再提交索引；提交后只允许以仍绑定该已打开文件身份的平台原语清理隔离项，平台不能提供等价保证时保留隔离项并返回 `cleanupPending`，不得退化为按名称删除。创建/导入在句柄下排他创建随机临时文件并以句柄相对 rename 落位。Rust 文件系统适配层必须在各平台为路径解析、读取、创建与原子移动提供与 POSIX `openat`、Linux `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` 同等的“根句柄绑定 + 逐组件不跟随”保证；普通 `unlinkat` 只约束删除发生在受信目录内，**不满足**库媒体的文件身份绑定清理，后者必须使用 §7.2 的更强平台原语或保留 `cleanupPending`。相应能力缺失时拒绝该阶段，不得降级为 check-then-use。媒体展示也不得把本机绝对路径或 relPath 交给前端 `mediaUrl` 拼接/通用文件协议：前端只获得含 scope + assetId 的 opaque asset URL，Rust 自定义协议处理器在**每次请求**重新从当前规范化索引解析 id，并通过上述句柄链读取后返回字节；索引内存快照可以减少 JSON 重读，但永远不能跳过这一步文件系统能力校验。由此目录项在列表后被替换也无法让任何项目或库入口触达资产根外文件。

控制文件不适用“只拒绝对应资产区”的降级：项目目录或库目录的任一级信任链失败时，必须按 §10.2 在任何控制文件 I/O 前拒绝整个项目或库操作；不能先读取 `project.json`/`library.json`，再仅把资产标为不可用。

**媒体访问落地（#9、#26、#31）**：项目与库媒体均已接入 `pwmedia`，`get_asset_media_url` 只接收逻辑 scope 与 assetId；`library_dir_path`、`project_asset_path` 已移除，通用 `assetProtocol` 已停用且 scope 为空。#9 曾采用的资产子目录白名单是历史过渡方案。项目资产 id 在 URL 段中以 UTF-8 字节的十六进制编码保留完整值域；这只是编码，不是加密。

项目媒体以磁盘 `assets.byId` 为权威；导入/生成后尚未防抖保存的资产由 Rust 在落盘管线登记到应用持有的 `PendingProjectAssets`，在索引空窗期供解析。加载时空白键重发通过 `register_project_asset_alias` 登记“新 id → 原磁盘键”别名，别名不携带路径，不复活已删除条目；项目控制文件缺失时拒绝服务并清理该项目登记。每次媒体请求仍重新打开并复验文件。当前 Tauri 响应采用有界缓冲交付，而非流式 body：库媒体上限 20 MiB、项目媒体上限 256 MiB，并发闸门为 4，许可持有至响应交付。超过 256 MiB 的项目文件可能可保存但无法预览，这是已登记的读取边界；不能把生成结果的 32 MiB 上限套在所有历史项目媒体上。

### 7.2 库资产的分类与编组

**落地状态（#17、#25、#29）**：锚定句柄访问、1 MiB 库索引限读、脏条目隔离、日志驱动删除与恢复、Record 迁移、完整归一化、组命令及库命令重命名均已合入 `dev`。库操作由进程内互斥锁与跨进程文件锁串行化；列表及写入前先恢复未完成事务，返回 `warnings`/`cleanupPending`，只读告警态暂停写入。平台缺少身份绑定清理能力时仍保留隔离文件，不把“事务已实现”解释为“必定立即物理删除”。库操作锁的中毒后行为为可验证恢复（[issue #145](https://github.com/hailingu/PlotWeave/issues/145)）：锁不守卫内存状态，磁盘一致性由本节日志可恢复提交协议独立保证。

资产库要回答"我有哪些人物/场景/道具的哪些视图"，扁平标签不足以表达（"三视图"是结构而非标签），因此采用结构化分类 + 编组 + 自由标签三层：

```ts
/** 资产视角：三视图/多角度/表情/定妆等结构化分类。 */
type AssetView = 'front' | 'side' | 'back' | 'three_quarter' | 'top' | 'expression' | 'turnout' | 'other'

/** 个人资产库索引项：在 AssetRef 之上带分类与组织信息。 */
interface LibraryAsset extends AssetRef {
  name: string
  kind: 'character' | 'location' | 'wardrobe' | 'colorlight' | 'reference' | 'other'  // 角色设定/场景设定/服化道/色彩光影/风格参考/其他
  view?: AssetView           // 视角；三视图即同一 group 下 front/side/back 各一张
  groupId?: string           // 同一主体的多视图编组，引用 library.json 的 groups
  tags: string[]             // 自由标签，补充 kind/view 表达不了的维度
}

/** 资产组：同一主体（如某角色）的多张视图/变体的集合。 */
interface AssetGroup {
  id: string
  name: string               // 如「女主·林晚」
  kind: LibraryAsset['kind']
}
```

- **完整库形状与加载归一化**：`library.json` 根值及目标格式的 `assets.byId`/`groups.byId` 必须是普通对象，桶成员也必须是普通对象；异型根按下述损坏索引恢复规则处理，异型桶或成员隔离并警告，均不得在字段检查前解引用。键/id 按上文兼容迁移及 §8.1 共同规则一致化后，资产先执行 §7.1 的完整 `AssetRef` 校验，再校验 `name` 是去首尾空白后 1–128 字符的字符串、`kind` 严格属于声明联合、`tags` 是至多 16 项的数组且每项是去空白后 1–64 字符并在规范化后唯一；`view` 存在时必须是 `AssetView`，`groupId` 存在时必须是 §8.1 合法字符串 id。组同款校验 `name` 与 `kind`；合法 name 保存去空白后的值，必填 `name`/`kind` 或 AssetRef 字段异型时整个条目隔离。可选组织信息允许安全降级：加载时 `tags` 非数组重置为 `[]`；数组成员先去空白，异型/空白/超长/重复项删除，超过 16 个规范成员时只保留文档序前 16 项；非法 `view`/`groupId` 剥离，均警告。组条目隔离完成后再解析资产 `groupId`：目标组不存在或组与资产的 `kind` 不同即剥离该引用并警告，活动库内始终保持同组同类。
- **损坏索引的局部恢复（[issue #137](https://github.com/hailingu/PlotWeave/issues/137)，已实现）**：`library.json` JSON 语法、UTF-8 编码或根形状损坏时，按已知的 `assets`/`groups` 桶提取边界可确认且能完整解析的成员，再执行既有字段和引用校验；正常条目继续支持列表、媒体访问、导入项目、编辑与删除，脏条目隔离并返回 `warnings`。按栈核对 `{}`/`[]` 的匹配类型，遇到错配立即停止扫描其后内容，仅提取此前已确认的完整成员；同样不猜测截断字符串或嵌套结构之后不能确认归属的内容。无法识别任何条目时返回带损坏提示的空视图；媒体文件不能重建名称、标签、组等索引权威元数据。损坏视图采用确定性的只读归一化，不生成未落定的新 id，读取不覆盖损坏原件。用户后续导入、编辑或编组等写操作，以当前可用视图为基线保存；替换前必须将原始字节耐久保存为同目录 `library-corrupt-<原始字节的 SHA-256 摘要>.bak`。同一原件失败重试时复用该备份：核对普通文件、实际字节一致并重新同步文件和目录（Unix）后才继续，避免相同副本随重试累积；原件变化则保留独立备份。备份创建、读取或同步失败，或同名备份类型/内容不符时拒绝继续，不覆盖异常备份。既有随机名备份保留，不自动迁移或删除。导入入口先完成候选索引校验与原件备份，再物化新媒体，最后提交索引，因此备份失败及其重试不会新增媒体；媒体物化失败不提交索引，已完成的备份保留。媒体成功后最终索引提交失败仍沿用下述孤儿保留协议，不因错误而盲目删除可能已提交的媒体。该备份用于保留恢复证据，不自动合并回库；损坏条目不因恢复而触发媒体清理。既有索引大小上限、文件类型和 IO 错误仍明确失败，不把这些错误当成空库。
- **损坏索引与未完成删除（#137，已实现）**：删除恢复不能把局部索引缺失的 assetId 当作已提交删除。索引损坏且事务目标缺失时，先在日志耐久写入 `indexUncertain: true`，随后保留该事务的原媒体、隔离文件和日志，报告冲突及 `cleanupPending`；即使后续操作已修复索引也不自动解除。其他正常条目仍可使用和写入，这些待核对事务需保留现场供人工核对。标记写入失败或使日志超过原有 1 MiB 上限时，本次恢复在媒体操作前失败；所有日志写入都检查序列化后的大小。日志自身异型仍沿用全库只读告警规则。
- **库写边界**：`import_library_asset`/`collect_library_asset` 对 meta 及构造出的完整 `LibraryAsset` 执行上述规则后才写索引。`update_library_asset` 要求 patch 是普通对象且仅含 `name`/`kind`/`view`/`groupId`/`tags`：字段一旦出现就先做运行时类型和值域校验，`view: null`/`groupId: null` 是唯一清除标记且落盘时删除对应可选字段，其他异型值拒绝；字符串保存规范化值，tags 须在输入时满足数组、成员和值域规则。补丁应用到当前条目后必须复验**完整合并结果**（含不可编辑的 AssetRef 字段及 groupId 存在性/kind 一致性），失败则整次命令不写盘，不能让本次未触及的旧脏字段继续落盘。组写入由 `upsert_library_group` 执行同款完整形状校验；修改组 kind 若会与任一成员资产冲突则拒绝。`delete_library_group` 要求组存在，并在同一次原子索引写入中删除该组、剥离成员资产的 `groupId`；因此不会留下悬空编组引用。每个库写命令在操作开始时必须通过 §10.2 的受信控制文件句柄读取当前索引并按本节完成归一化，再以该次读取结果作为唯一逻辑基线；会话内存快照只用于 UI 展示/缓存，不得作为写命令的权威输入，也不得把补丁直接套在重新读出的原始 JSON 上。最终索引经同目录 tmp 写入、文件内容 flush/fsync、原子 rename 与父目录 fsync 全部成功后才视为耐久提交并替换会话快照。这份由命令在操作开始时通过受信句柄读取并归一化的索引快照只代表本次操作的逻辑基线，不携带文件系统权限；任何由条目 relPath 引发的文件读写仍必须逐次执行 §7.1 的根目录句柄绑定与 no-follow 操作。
- **清理指引的证据完整性（[PR #222](https://github.com/hailingu/PlotWeave/pull/222)，已实现）**：`cleanupPending` 不是完整的冲突清单。索引仍引用的事务遇到原路径占用、媒体缺失或隔离项身份不符时，恢复可能只设置 `conflicted` 并返回 `warnings`，仍须保留媒体与日志。前端只在当前待清理快照无证据项、且本会话未收到任何有效图库警告时显示目录级清理指引；所有有效警告均保守暂停（不从非结构化文案推断安全）。关闭提示和后续空/缺失/失败/迟到响应均不能解除会话保护；先备份、人工核对并完全退出重启，由新一轮恢复诊断重新判定。一次性修复警告也会暂缓本会话指引，正常图库编辑不受影响；不新增自动删除或更改后端恢复协议。详见 [UI 设计 §8.1](ui-design.md#81-资产库面板按影视美术部门分类)。

- **重隔离诊断（[审查 5255085559](https://github.com/hailingu/PlotWeave/pull/222#discussion_r4052637973)，已实现）**：索引已提交、旧隔离项缺失而原路径仍绑定预期媒体时，恢复重新隔离并由 `try_bound_cleanup` 报告该隔离项的唯一诊断。身份绑定清理不可用仅产生常规待清理项，保留媒体与日志；不再叠加泛化的重隔离条目，避免重复计数和被误归为证据。再次恢复应返回同一快照；身份不符仍属于保留现场的证据项，未知诊断的前端保守分类不变。状态矩阵与验证见 [UI 设计 §8.1](ui-design.md#81-资产库面板按影视美术部门分类)。
- **诊断快照顺序（[PR #222 审查修订](https://github.com/hailingu/PlotWeave/pull/222#discussion_r4052533501)，已实现）**：六个图库命令（列表、导入、元数据更新、删除、组写入、组删除）的成功响应均增加 `diagnosticsRevision`，为规范十进制正整数 `u64` 字符串（无前导零，上限 `18446744073709551615`），避免 JavaScript 数字精度影响顺序。`library::diagnostics::with_snapshot` 在既有进程内库锁和库文件锁均持有期间、执行操作前分配序号，并在同一临界区构造诊断响应；序号按实际后端执行顺序递增，不以请求发起或响应到达顺序判断新旧。这六个命令失败时原样返回错误；若已完成恢复，则经下述事件发布观察，否则仅留空号、不伪造快照。耗尽时在操作前拒绝，不回绕。该序号仅属于当前原生进程，不写入索引、资产或删除日志；多个原生进程各自发号，不构成跨进程版本。前端随原生进程重启建立新诊断会话。
  - 前端七个消费入口（列表命令分别供资产列表和组列表使用）统一传递信封。`libraryDiagnostics` 只接受比本会话已接受最大序号更大的 `cleanupPending` 快照：旧/重复响应忽略，新空数组可以清除旧状态；同内容也推进序号，但保留数组引用与关闭状态。关闭提示不重置序号；失败或完全不携带快照/序号的命令响应不改变状态，独立恢复事件仍可刷新。显式快照缺失/非法序号或非数组载荷保留旧状态、不推进序号，并记录 `LIBRARY_DIAGNOSTICS_SNAPSHOT_INVALID`。条目为结构化 `{ kind, message }`（issue #229）：`kind` 取 `routine`/`evidence`，由后端生产点给出，前端按 kind 分区呈现、不经文案推导；未知/缺失 kind 与裸字符串 fail-safe 归证据类，缺/空 `message` 的条目丢弃。
  - `warnings` 仍独立累积并建立会话清理保护，包括迟到快照中的警告；拒绝旧待清理快照不能丢掉冲突信号。该扩展不改变磁盘恢复协议，也不把跨资产前端操作改为全局串行。失败操作可能已留下需下次恢复发现的现场，仍由后续成功诊断刷新。状态矩阵与验证边界见 [UI 设计 §8.1](ui-design.md#81-资产库面板按影视美术部门分类)。
  - **命令失败后的恢复观察（[审查 5255110778](https://github.com/hailingu/PlotWeave/pull/222#discussion_r4052662271)，已实现）**：六个命令内核在 `recover` 成功返回后立即显式报告，早于只读拒绝、目标定位、编组冲突和后续 I/O。`with_snapshot` 与替代入口复用 `with_observations` 的锁和发号源；业务失败时释放锁后以 `library-diagnostics` 事件发布已完成恢复，原错误不变。成功仅返回包含操作最终诊断的响应，不另发同序号的前置恢复事件，避免删除新增的待清理项被旧恢复状态抢先占位。校验在恢复前拒绝、或恢复自身未完成时不发布；不为取得诊断而二次执行恢复。观察只描述已完成的恢复，后续操作部分失败的新现场仍由下一次成功恢复刷新。
  - **替代恢复入口（[审查 5255029989](https://github.com/hailingu/PlotWeave/pull/222#discussion_r4052588914)，已实现）**：库 scope 的 `get_asset_media_url`、实际 `pwmedia` 打开，以及 `import_project_asset_from_library` 使用 `with_recovery_snapshot` 共享上述库锁、文件锁和发号源。内核显式报告已完成的恢复，锁内收集 `warnings` 与 `cleanupPending`，释放锁后发送 `library-diagnostics` 事件；载荷同为 `{ diagnosticsRevision, warnings, cleanupPending }`。恢复发现冲突、或恢复成功后目标定位/打开/拷贝失败时，仍发送已收集诊断，操作原始错误照常返回。同操作多个观察保留全部去重警告和最后的待清理快照；恢复自身未完成则不伪造空快照。项目导入复用冲突检查产生的恢复结果，不再次恢复而吞掉一次性诊断。媒体字节读取仍在库锁之外。
  - 前端入口在事件监听注册完成后才渲染应用，覆盖组件发起媒体/导入请求的启动窗口；监听贯穿前端会话，事件与七个命令消费入口共用同一发布边界，乱序事件/响应统一按序号判断，旧事件的警告仍建立保护。监听失败记录 `LIBRARY_DIAGNOSTICS_LISTENER_FAILED` 并发布警告、暂停本会话清理指引，应用仍可编辑，重启后重试监听；非法事件保留当前快照并记录诊断。后端事件发送失败记录 `LIBRARY_DIAGNOSTICS_EMIT_FAILED`，不把已落定操作伪报成失败；当前没有事件持久化或自动重传。纯项目 scope 媒体与浏览器预览不触发图库恢复事件。

- **库文件/索引的可恢复提交协议**：`library/assets/` 文件与 `library.json` 的两个独立操作不构成事务，失败只能留下可诊断、不可被活动索引引用的隔离项/孤儿文件，不能留下“索引仍引用但媒体本体已不可恢复”的状态；下述 fsync 均包含目标平台的等价耐久屏障，无法提供时不得进入下一阶段。导入/收藏仍先通过 §7.1 完成临时文件写入、文件 flush/fsync、原子落位与资产父目录 fsync，确认可读后才耐久提交新增索引；索引失败只留下孤儿文件。删除若新索引中仍有其他条目引用同一已打开文件身份，则只提交去项索引，不移动或删除物理文件。否则采用身份绑定的隔离事务：① 通过受信句柄读取并归一化当前索引，逐组件 no-follow 打开待删普通文件、捕获平台稳定文件身份并保持文件/原父目录句柄；`.trash/` 缺失时只能在已验证资产根句柄下创建为应用私有目录并 fsync，且须确认与源文件同一文件系统（否则原子 rename 无法成立并在写日志前失败）；在 `library/asset-delete-journal.json` 以随机 transaction id 耐久记录 assetId、原 relPath、预期身份和未公开的 `assets/.trash/<随机名>`，日志原子提交与父目录 fsync 成功前不得移动文件。② 通过已持有的资产根、原父目录与 `.trash/` 目录句柄，把原目录项原子 rename 到隔离名并 fsync 两侧目录；随后 no-follow 打开隔离项并与步骤①身份比较。若 rename 窗口中目录项已被替换、身份不一致，则不得提交索引或删除隔离项；仅在原名仍空缺时用 no-replace rename 恢复，原名已被占用则保留隔离项与日志并报冲突，绝不覆盖后来文件。**身份冲突未解决期间的条目隔离**：凡因身份不符、路径占用或平台能力不足而保留日志的未完成事务，其对应 assetId 不得继续作为可用资产暴露——恢复/列表流程在规范化索引与内存投影中把该条目标为冲突不可用并随列表返回警告；标记期间媒体协议处理器与任何按 relPath 的打开拒绝为该 assetId 服务（原 relPath 可能已绑定后来文件，解析它会把占用者的替换文件当作原资产展示），也不得以该条目为源复制入项目或收藏；标记只随日志事务解决而解除——原名重新 no-replace 绑定预期身份、索引耐久提交去项或日志按恢复规则清除，不得靠重新列表静默消失。③ 隔离身份一致且耐久后才原子提交不含该条目的 `library.json` 并 fsync `library/`；提交失败时索引仍含该资产，恢复流程按日志把同一身份 no-replace 移回原位。④ 索引提交成功后，只能用绑定步骤①已打开身份的操作系统删除原语清理隔离项并 fsync `.trash/`；普通 `unlinkat(隔离名)`、再次 stat 后按名称 unlink 或任何 check-then-use 退化均禁止。平台没有身份绑定删除能力、删除/fsync 失败或进程中断时，保留隔离项并返回/记录 `cleanupPending`，索引不得回滚。启动及每次库列表/写入前先恢复日志：每条事务先重读规范化索引并按已打开身份复核其他活动条目；若其他条目已引用预期身份，不得移动或删除其当前目录项，隔离项存在时只按身份绑定能力清理该额外目录项、能力不足则保留 `cleanupPending`，隔离项不存在时可清除日志。没有其他活动引用且索引仍含 assetId 时：若隔离项尚未生成且原路径仍绑定预期身份，清除这条未开始事务；若隔离项身份一致，则只在原目标名空缺时 no-replace 回迁；其余缺失、身份不符或路径占用均保留日志、按上述冲突期隔离规则将条目标为冲突不可用并警告。索引已无 assetId 时，隔离项存在则只尝试身份绑定清理；隔离项已不存在且原路径不再绑定预期身份，视为清理已完成并清除日志；原路径仍绑定预期身份则重新执行身份核验隔离，不得按原名删除；能力不足均保留现场与 `cleanupPending`。日志根/条目异型、重复 transaction id、路径越出固定原资产位置或 `.trash/` 随机名单项时整份恢复进入只读告警态，所有库写入/删除暂停，不猜测路径、不移动或删除任何文件。事务完成且相关目录已 fsync 后才原子移除日志项；`.trash/` 永不参与 AssetRef 解析、媒体服务或普通孤儿扫描，显式清理也必须消费日志并遵守同一身份绑定规则。
- **分工**：`kind` 回答"是什么"，`view` 回答"哪个角度"，`groupId` 把同一主体的三视图绑成一组；`tags` 只用于前两者覆盖不了的自由维度（如「赛博朋克」「雨夜」）。能用结构化字段表达的不写成标签，避免同义标签发散。
- **迁移规则（`prop` → `wardrobe`）**：现实剧组服化道同属一个部门，旧 `prop`（道具）条目并入 `wardrobe`（服装/妆发/道具）；新增 `colorlight` 承载色彩脚本（color script）与光影氛围参考。
- **旧库索引兼容迁移（已实现）**：当前 `library.json` 使用 `assets.byId`/`groups.byId` Record；旧格式使用 `assets: LibraryAsset[]`/`groups: AssetGroup[]`，条目 `createdAt` 是 epoch 毫秒、`source` 缺失，且可选 `view`/`groupId` 用 `null` 表示。读取旧格式时先安全预检两个数组及普通对象成员，再复用 §11.1 的 v0 数组键化规则校验 id：重复 id 保留文档序首项、后续项重发本域未占用 id，缺失/非字符串/空白 id 同样重发，最后才键化为 `assets.byId`/`groups.byId`。组 id 重复时既有 `groupId` 引用本就解析到首项，不随后续项重发而改接；仅一个空白原 id 组时建立映射并同步改写精确匹配的 `groupId`，多个同值空白组则映射歧义，删除相关 `groupId` 并警告。当前库资产均由本地导入产生，缺失 `source` 确定性补为 `upload`，非负安全整数且能表示有效日期的毫秒时间戳转为 UTC ISO 8601，`null` 可选字段删除，旧 `prop` kind 按上条改写。完成这些兼容改写及 Record 键/id 引用同步后才按上一条顺序执行完整 `AssetGroup`、`LibraryAsset` 与跨条目 groupId/kind 校验；缺失/异型时间戳或显式未知 source 不得猜测，隔离条目并警告。不得把目标校验直接套在旧数组成员上，否则所有缺 source、数字时间戳的现有库资产都会被误删。
- **迁移身份稳定性**：检测到迁移/修复即耐久回写，保证重发 id 跨读取稳定。只读告警态、迁移挂起态或损坏索引的局部视图不暴露未落定的新身份；不能在每次列表时再次产生漂移 id。
- **绑定方式**：分类信息写在 `library.json` 索引项里、以资产 id 为键；改标签、换组、改视角只更新索引，不动媒体文件。
- **快速读取**：`library.json` 启动时全量载入内存（桌面量级，数千条索引项仅数百 KB），列表页筛选/搜索全走内存过滤，媒体文件懒加载。规模失控时再迁 SQLite（见十三）。

### 7.3 流转规则

- **库资产进入项目 = 拷贝**：把库素材放上画布或设为角色头像时，文件拷入项目 `assets/` 并生成项目级 AssetRef（新 id）。项目不持有对库文件的引用，因此库侧可随时清理而不产生项目内的悬空引用。
- **AI 生成结果必须落盘后再引用（文生图已实现）**：厂商临时 URL 不得出现在文档里——临时链接会过期，直接引用会导致画布内容日后无法打开。生成结果默认落项目资产；「收藏到资产库」及 `collect_library_asset` 仍待实现，#29 关闭不包含该链路。
- **浏览器预览拷贝语义（#8）**：导入时基于源 blob 创建独立 object URL，绑定项目资产 id；删除源库条目不影响已导入缩略图。此映射仅在会话内有效，浏览器重载后丢失；预览回退不提供桌面端的文件持久化。
- **延迟回收**：删除引用资产的节点/设定时不立即删文件，由后续「清理未引用资产」命令统一回收（首版可只做手动触发）。
- **项目复制 = 文档级复制**：复制件的 `project.id` 必须替换为目标项目的新 id（持久化层强制 id = 目标路径 id，禁止沿用源 id），创建时间取复制时刻；资产索引随文档原样带走（与 `avatarAssetId` 等
  引用字段保持一致解析，§8.1）。当前桌面实现先创建副本，再经 Rust `copy_project_assets` 将媒体拷入副本 `assets/`，最后保存文档；失败时清理副本并报告错误，清理也失败则报告残留副本。整个流程是分步操作，不宣称跨文件原子事务。**复制命名策略保证不超上限**：新名 = `{源名} 副本`（已存在
  则 ` 副本 2`、` 副本 3`…），拼接结果按字符数超过 64（§9.3 项目名校验口径）时先
  截断源名至可容纳后缀再拼接——直接追加后缀会让接近上限的合法源名复制即被
  持久化层拒绝，复制操作必须总能成功。

## 八、引用模型与联动规则

节点、设定、资产之间的引用是画布最容易出错的区域。本节定义引用的分类、唯一真相归属与联动规则。核心只有一条：**每个引用事实只存一处，其余全部是派生视图**。

### 8.1 引用类型与真相归属

| 引用类型 | 例子 | 唯一真相 | 派生物（不持久化） |
| --- | --- | --- | --- |
| 剧情流向 | 场景 → 对白 | `graph.edges` | 无 |
| 节点 → 设定 | 场景的 `characterIds` | spec 字段（id 数组） | 反向索引（「谁引用了这个角色」） |
| 文本内 @ 提及 | 对白文本里的 @角色 | 文本 token（只存 id） | 提及列表、高亮、反向索引——**不落边** |
| 节点/设定 → 资产 | 角色头像 `avatarAssetId`、分镜 `refs[].assetId` | 明确命名空间的 assetId 字段（均指项目 `assets.byId`） | 引用计数（清理未引用资产时现算） |
| 节点 → 节点输入（未来媒体节点） | 视频节点的立绘输入 | `graph.edges` | 执行输入在解析时现算，不物化镜像 |

**持久化 id 的共同值域**：本文所有“id 非空”均指运行时值满足 `typeof id === 'string' && id.trim().length > 0`；只由空白字符组成的字符串与空串同属非法 id。命令边界须按此口径拒绝，加载归一化须在任何查表、去重或引用解析前按 §11.1 的确定性规则修复。该规则只判定有效性，不擅自 `trim()` 非空 id——id 是不透明标识，改变已有非空 id 必须同步改写其全部引用。嵌入文本语法的 `Character.id` 另受 §6 的安全字符集子值域约束。

细则：

1. **禁止镜像字段**：不设任何「引用的第二份拷贝」（如 inputs 镜像、边上冗余的引用标签副本）。派生信息需要时现算或重建，不持久化。
2. **文本 token 只存 id**：唯一合法语法为 `@[character:<id>]`，其中 `<id>` 必须完整匹配 §6 的 `[A-Za-z0-9_-]{1,64}`；解析器只把完整匹配 `@\[character:([A-Za-z0-9_-]{1,64})\]` 的片段识别为 token，前后相邻普通文本不属于 token。缺右括号、超长 payload、额外冒号或包含其他字符的近似片段一律保留为普通文本并记录加载警告，不做截断或猜测解码。token 不存名称快照；显示名永远按捕获 id 实时解析——改名不断引用，也无需回写任何文本。
3. **反向索引由模型层维护**：GraphStore 在每次 `applyCommand` 后增量重建「被引用方 → 引用方列表」索引，供「查看引用」「删除前确认」使用。索引是内存派生物，不进文档，不依赖任何组件的挂载状态。

### 8.2 生命周期联动规则

引用的建立、断开、悬空处理全部收敛到命令层（第九节），UI 只是发起者：

1. **建立**：连线 = `connect_edge`；@ 提及 = 编辑 spec 文本（`update_node_spec`）。引用关系随文本天然一致，不存在单独的「同步」步骤。
2. **断开 ≠ 删除**：断开连线只移除该边，不触碰对方的 spec/文本。删除节点连带删边，且节点与连带边进同一 `batch`——inverse 完整恢复两者（见 9.3），撤销后引用关系原样回来。删除分支选项同理：其引出的 branch 边由 **applyCommand 内置级联**一并删除——`update_node_spec` 收窄 `branch.options` 时，命令层自动检测被移除的选项 id 并在同一撤销单元内断开其出口边，**不依赖调用方自行拼装 batch**（Agent 走通用 `update_node_spec` 工具同样受保护）；inverse 同时恢复选项与被断开的边。
3. **删除被引用方**：不级联清理引用方（避免静默丢数据）。引用按「失效」展示（灰色角标/删除线），由用户决定替换或清除。
4. **加载修复而非拒绝**：归一化管线（第十一节）对悬空引用统一标记；孤儿边隔离并记录警告——单条坏数据不得导致整个项目加载失败。

### 8.3 为什么这样设计（失效模式对照）

引用系统的典型故障全部来自「同一事实多份拷贝 + 操作只更新部分副本」：

- 文本存一份、边存一份、镜像字段再存一份，编辑路径只更新其中一两个 → 各副本互相矛盾；
- 副本间的同步逻辑挂在组件生命周期上，组件卸载（节点收起/切换项目）同步即停止 → 引用残留或丢失；
- 删除节点清了边却忘了文本里的提及，或撤销删除只恢复节点不恢复连带边 → 引用关系永久错乱。

本节三条规则分别消灭这三类故障：没有副本就没有不一致（8.1）；派生重建在模型层，不依赖组件生死（8.1.3）；删除/撤销的级联在命令层一次完成（8.2.2）。

## 九、命令与撤销

数据与引用规则定义完毕，本节定义它们的唯一变更入口（原则 3）。

> **就地实施状态（2026-09-21 核对，issue #237）**：本节的命令信封（`GraphCommand`/`inverse`）与统一入口（`applyCommand`/`dispatchCommand`）为**目标设计**——`src` 中无同名可导入符号（§2 的全局声明同样适用）。当前实现以等价语义交付，各小节就地标注：§9.1 信封对照 `HistoryCommand`（`src/editor/history.ts`），§9.2 清单附「当前实现入口」列，§9.3 撤销捕获与资产预检附实际落点，§9.4 已注明栈容量与合并差异。除入口形态外，本节的不变量（边界校验、整批原子、撤销完整恢复）目标与实现共同遵守；历史或未来的目标接口不可直接 invoke/import。

### 9.1 命令结构

单写者场景无需并发基线与路径级补丁。命令信封固定为六个字段：`id` / `type` / `actor`（变更来源：用户操作或 AI Agent，用于审计与 UI 标记，见十二节）/ `patch`（正向补丁）/ `inverse`（逆向补丁，执行时自动捕获）/ `timestamp`；另有可选的 `transient` 标记（瞬时 UI 命令，仅供拖拽/缩放等手势的过程帧使用：不进撤销栈、不置脏不落盘）。「不进撤销栈」与「不持久化」是两个独立维度——前者由 §9.4 按命令类型裁定，后者仅 transient 过程帧成立；需要持久化但不进栈的变更（如视口终帧）以非 transient 命令提交、按 §9.4 排除出栈，见 §9.4。

`patch` 的具体形状由 `type` 决定，完整定义见 9.3。

> **实施对照**：目标信封未落地。当前命令形状为 `HistoryCommand`（`src/editor/history.ts`）：`undo`/`redo` 闭包、可选 `coalesceKey`（800ms 内同键合并为一步撤销）、`redoGuard`（资产恢复类命令重做前的异步复验，issue #10）与 `timestamp`；无 `actor`/`id`/`patch`/`inverse` 字段——AI 批次的来源与提交身份由 `aiRevision` 承载（§12.2），不入栈与不落盘两类变更按 §9.4 由非命令路径处理（如视口）。

### 9.2 命令清单

| 类别 | 命令 | 说明 | 当前实现入口（等价语义，§9 就地实施状态） |
| --- | --- | --- | --- |
| 节点 | `create_node` / `delete_node` / `move_node` / `resize_node` | delete 连带删除关联边，inverse 一并恢复 | `useNodeCreation`；`useNodeDeletion`（节点+连线+产物回收同一撤销单元）；`move_node` = `useNodeDragHistory`（拖拽整段一步，过程帧不入栈）；`resize_node` 为目标设计，画布未交付 |
| 节点数据 | `update_node_spec` / `update_node_meta` / `update_node_ui` | | `useNodePatch.patchNode`（编辑即命令、同键合并撤销；分支选项级联内置同一撤销单元）；`ui` 态为运行态不经命令通道 |
| 连接 | `connect_edge` / `disconnect_edge` | | `useConnectionRules`（实时校验 + 落线入栈，与 AI 校验共用 `graphRules`）；`useEdgeDeletion` |
| 设定 | `upsert_character` / `delete_character`（地点、道具同构） | | `useSettingsActions`（整桶 before/after 可撤销） |
| 设定文档 | `upsert_document` / `delete_document` | | `useSettingsActions`（documents 桶，issue 56） |
| 集标题 | `set_episode_title` | title 为空串 = 删除该集的标题键 | `useEpisodeEditing`（连续输入同键合并） |
| 项目 | `rename_project` | 改 `project.name`；name 在命令边界按 §9.3 项目名校验口径校验并保存规范化结果，索引同步由持久化层负责 | `App` 改名链经 `projectStore.save`（name 校验与索引同步由 §10.5 `save_project` 边界完成） |
| 资产 | `set_asset` / `remove_asset` | set 为 upsert 语义（id 已存在 = 覆盖），但必须经公开 dispatcher 的 Rust 实路径预检后才交给内部 reducer；inverse 视新增/覆盖而定（见 9.3） | `useAssetIndex`（索引增删写通道，由各命令包进撤销单元）；预检实际落点见 §9.3 实施对照 |
| 视口 | `update_viewport` | 不进撤销栈；过程帧 transient 不落盘，交互结束帧置脏随防抖持久化（§9.4） | 画布视口 ref + 显式标脏防抖落盘（`useCanvasView`/`useDebouncedSave`，不经命令） |
| 批量 | `batch` | 一等命令，整批作为单个撤销单元；整批原子——预校验任一子命令失败即整批拒绝、零变更（见 9.3） | AI 批量经 `ai/batchSim.ts` 在虚拟终态折叠，forward/backward 闭包整体入栈为一条复合命令（§12） |

### 9.3 命令数据模型

命令创建时只携带**变更意图**（目标值）；`inverse` 不由创建者填写，而是 `applyCommand` 执行时从变更前文档（docBefore）自动捕获。这保证 undo 数据永远与文档真实旧值一致，创建者不可能填错。

> **实施对照**：自动捕获未以集中 reducer 落地；等价保证在各命令生产点以「写入前捕获旧值构成 undo 闭包」成立——如 `useNodePatch.patchNode` 的 before 快照、`ai/batchSim.ts` 在模拟期一次性捕获 backward 闭包、`useSettingsActions` 的整桶 before。创建者不手填逆补丁的目标性质不变。

**文件系统依赖命令的入口约束**：Store 对 UI、Agent、MCP 与导入器只公开异步 `dispatchCommand`；纯 TS 的 `applyCommand` reducer 是模块私有实现，外部不得直接调用。dispatcher 遇到任意正向、撤销、重做或 batch 内的 `set_asset` 时，必须先把活动会话由 `load_project` 返回的受信 `projectId`（不得取自命令/Agent 负载）与完整 `AssetRef` 交给 Rust `validate_project_asset`，只将 Rust 原样返回的规范化 AssetRef 送入 reducer；真实路径预检失败时文档、undo/redo 栈与脏标记均保持不变。batch 在建立虚拟演进文档前完成全部 `set_asset` 预检，任一失败整批零变更；预检结果不得缓存或被另一条命令复用。`save_project` 仍按 §10.5 在每次落盘前复验完整 `assets.byId`，用于封住预检后文件被替换或删除的窗口；预检不是保存授权。

> **实施对照**：统一 `dispatchCommand` 未落地，预检语义以既有入口交付——画布拖入导入经 `src/editor/projectAssets.ts` 调 Rust `validate_project_asset`（`useCanvasDrop` 消费）；图库拖入（`useLibraryAssetDrop`）与生成产物（`imagegen/state.ts`）以 `HistoryCommand.redoGuard` 在重做前复验落盘状态（issue #10）；`save_project` 落盘前复验完整 `assets.byId`（§10.5 已实现）。「预检失败零变更」由各入口自身的拒绝/回滚路径保证，非集中 dispatcher。

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

**AI 会话存储（[issue #47](https://github.com/hailingu/PlotWeave/issues/47)、[PR #57](https://github.com/hailingu/PlotWeave/pull/57)，已实现）**：会话独立保存在 `projects/{id}/ai-session.json`，`schemaVersion: 1` 保存消息 id、角色、顺序、正文及预览卡/执行回执。落盘总条数最多 200 条（[issue #64](https://github.com/hailingu/PlotWeave/issues/64)、[PR #85](https://github.com/hailingu/PlotWeave/pull/85)，已实现）：可执行待执行卡（`pending` 且校验通过，含自未确认执行卡降级来的）优先占用容量，其余额度保留最新历史，最终按原时间线输出。待执行卡自身超过 200 张时也从最旧提案起裁剪，不再额外追加无上限的钉住卡；最多 200 张时，继续普通聊天不会挤掉待执行卡。校验拒绝卡、已执行及已忽略卡按普通历史处理。此规则限制条目数量，不承诺文件字节上限；待执行卡占满容量时普通历史可能全部不落盘，超额旧提案重开后不再恢复（状态矩阵及边界见 [UI 设计 §6.2](ui-design.md#62-会话落盘总量回归矩阵issue-64)）。裁剪只发生在写入主文件的落盘边界（前端 `aiSessionStore` 的 `diskSessionOf`，浏览器内存回退同语义）：面板保存通道与进程内快照（设置页重挂载种子、保存失败保留、退出冲刷待写重试）持全量落盘形态，设置页往返与失败后重开不丢进程内历史；内存线程与加载归一化都不裁剪（旧文件全量展示，下次实际变更保存才收敛）。缺文件返回空历史；前端逐条归一化并隔离坏条目。JSON 或信封损坏返回 `{ session: null, corrupt: true }`，界面显示损坏诊断；真实 I/O 读取失败仍返回错误。两者都不阻断画布打开。真实 I/O 读取失败时，AI 操作区只显示诊断并停用发送与执行，重开项目成功读取后才恢复；缺文件仍可正常开始聊天。损坏诊断不触发自动写回，后续实际编辑保存成功才更新主文件。

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
- 前端防抖 500ms 提交一次；失败回队重试；`flushPersist()` 在关闭窗口/切换项目前调用。退出屏障同样等待防抖落盘（[issue #119](https://github.com/hailingu/PlotWeave/issues/119)）：编辑器挂载期间向应用级注册表（`canvasSaveRegistry`）登记「有脏或在途」探针与立即冲刷闸，退出冲刷先补交画布最新编辑，再处理保存链；失败重试登记（含未落定链上动作）在退出时立即重存，每登记至多尝试一次，代次已前进的陈旧登记不重放（新保存拥有终态，陈旧稿不得后完成覆盖新内容），仍失败则阻断退出、保留登记与 5s 后台重试节律并显示诊断。重试可以复用同一份序列化载荷，但其中的 `project.updatedAt` 不具有权威性：每次 `save_project` 尝试都由 Rust 在保存边界重新生成时间，调用方不得通过预先盖戳或重放旧值决定本次保存时刻。序列化时节点 `ui` 会话态（`selected`/`expanded`）按 §3 不落盘——`serializeProject` 输出统一重置为加载初值（`selected: false`、`expanded: true`），内存中的选中态不进入载荷；`update_node_ui` 不置脏（§9.4），纯选择/折叠操作不触发防抖保存，也不会因此刷新 `updatedAt` 改变首页最近项目排序。
- 项目文档保存成功（含失败登记后的链上后台重试成功）即向前端发出落定通知（issue #101）：编辑器卸载冲刷/在途保存可以晚于返回首页的列表读取，首页摘要（名称、派生统计、更新时间/排序）靠该通知在导航读取之后再刷新一次，恢复到与磁盘一致；保存失败不发出通知，首页保持磁盘现状，不虚报新摘要。首页并发发起的多次列表读取按发起序收敛，较旧的响应不得覆盖较新的结果。
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

### 10.3 Provider 与模型配置

BYOK 下 provider 分两层：**内置适配器在代码里，用户配置（含加密后的 API key）在 `settings.json`**。

代码层（不进配置文件的静态定义）：

```ts
/** 内置 provider：请求适配器，非纯数据。 */
interface ProviderDef {
  key: string                // 'openai' | 'ark' | ...
  label: string
  defaultBaseUrl: string
  endpoints: { chat?: string; image?: string; video?: string }
  /** 统一参数 ↔ 厂商格式的双向适配；OpenAI 兼容 provider 用默认透传实现。 */
  requestAdapter: (op: string, params: unknown) => unknown
  responseAdapter: (op: string, raw: unknown) => unknown
}

/** 内置模型目录：能力与可选参数清单。 */
interface ModelDef {
  key: string
  label: string
  type: 'text' | 'image' | 'video'
  providers: string[]        // 支持哪些 provider
  capabilities: string[]     // 如 'text-to-image' / 'first-frame' / 'tool-calling'
  options?: Record<string, string[]>   // 可选参数清单：sizes / ratios / durations...
  defaultParams?: Record<string, unknown>
}
```

`settings.json` 中用户可改的部分（按 provider key 分桶）：

```ts
/** 应用级设置：provider 配置与模型选择，不含密钥。
 * 无外观字段：跟随系统外观（HIG——应用内不设主题开关）。 */
interface AppSettings {
  providers: Record<string, ProviderSettings>
  selectedModels: { text?: string; image?: string; video?: string }
}

interface ProviderSettings {
  baseUrl?: string                                    // 覆盖默认值
  customModels?: Array<{ key: string; label: string }> // 用户自建模型条目
  disabledModelKeys?: string[]                        // 用户隐藏的内置模型
}
```

**模型可见性 = 三层过滤**：在内置目录或自定义条目里 → 所属 provider 已配置（key + baseUrl 齐备）→ 未被用户禁用。过滤结果是计算属性，不持久化。

> 落地状态（2026-09-04）：已发布的实现收敛为扁平 `AppSettings { providers: ProviderConfig[]; defaultChat: string | null; defaultImage: string | null }`（"providerId:modelId"，§13 图像生成首版随 `defaultImage` 落地）；`ProviderDef`/`ModelDef` 的能力目录与 `selectedModels` 三段结构为目录化演进预留，引入时按下表 §10.5 命令边界对齐。

### 10.4 密钥管理

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密（密钥 = 应用常数 + IOPlatformUUID + 随机盐，封装于 envelope），明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。

**带凭据请求的传输策略**（[issue #136](https://github.com/hailingu/PlotWeave/issues/136)，已实现）：聊天与生图的 provider POST 共用 Rust `provider_transport`，发送前校验最终端点。远程服务（含局域网）必须使用 HTTPS；HTTP 仅允许 URL 解析后明确为 `localhost`、IPv4 `127.0.0.0/8` 或 IPv6 `::1` 的回环目标，不通过 DNS 为其他域名授予例外。自定义 HTTPS 域名不绑定 provider id，沿用客户端的证书校验。每跳重定向重新执行相同检查，且任何 HTTPS → HTTP 降级均拒绝（包括回环目标）；保留 reqwest 的默认 10 跳限制及跨 host/port 敏感头剥离，不恢复已移除的 Bearer。拒绝通过既有请求错误展示，策略诊断不含原始 URL 或凭据。存量 HTTP 配置保留，用户可在设置页改为 HTTPS 或回环网关后重试；不改变 `settings.json` 格式，也不在加载/保存时替换地址。模型返回的图片下载 URL 仍执行 §13 的独立公网目标策略，不采用回环例外。

**失败诊断的脱敏边界**（[issue #149](https://github.com/hailingu/PlotWeave/issues/149)，已实现）：reqwest 错误的 `Display` 会内嵌完整请求 URL（含 query），用户配置的敏感 query 或签名 URL 的签名参数会随之进入前端诊断；provider 错误正文（摘录 200 字符）也可能回显请求 URL 或 API key。统一脱敏策略：① 凡经 `Display` 到达前端的 reqwest 错误（发送/超时/客户端构造/响应体读取，含 §13 下载路径），把本次请求 URL 的每次出现替换为脱敏形态 `scheme://host[:port]/path`——userinfo、query 与 fragment 一律剥离，路径与错误类别/底层原因文本保留（可行动信息不丢）；② 状态错误摘录先把本次 API key 替换为 `***`、本次请求 URL 替换为脱敏形态，再截断 200 字符（脱敏先于截断，跨边界的 key 不留半截）。脱敏为精确子串替换：URL 的其它拼写形态（百分号编码差异等）与 key 的局部片段不在覆盖范围，属记录边界；主 key 经 Bearer header 发送、代码不直接格式化 header 的既有防线不变。

### 10.5 Rust 持久化命令（Tauri commands）

**执行线程（[issue #138](https://github.com/hailingu/PlotWeave/issues/138)，已实现）**：
项目／AI 会话、设置与密钥封装、资产库／编组、项目资产导入／预检以及媒体 URL
校验的同步工作，由异步命令通过 `blocking::run` 整体交给 `spawn_blocking`。
目录准备、锁等待、序列化、文件操作和持久性屏障均在闭包内完成；IPC 成功仅在
完整内核结束后返回，领域错误保持原样，线程任务异常显式失败。事务锁与恢复
诊断序号仍由同步内核拥有，不跨 await 持有。相关操作的先后关系继续由前端
项目／会话共享保存链、设置保存链及库变更队列保证；独立并发请求不承诺 FIFO。
`pwmedia` 协议继续使用已有阻塞线程池，退出确认／取消登记等短时内存操作保留
原入口。[验证矩阵与延迟测量](development/invoke-responsiveness.md) 记录实际范围和缺口。

下表按领域职责描述参数；实际 IPC 注册与参数名以 `src-tauri/src/lib.rs` 和相应函数签名为准。库的 `list_library_assets` / `import_library_asset` / `update_library_asset` / `delete_library_asset` 与两个组命令已在 #29 对齐。尚未对齐的目标接口显式标注如下，不能直接作为当前 invoke 名称。

| 命令 | 职责 |
| --- | --- |
| `list_projects()` | 按 §10.2 先验证应用根、项目目录与每个候选控制文件，再扫描项目文档真源并与 `index.json` 缓存校正后返回内存投影；索引缺失、损坏或与文档的 id/name/updatedAt 不一致时重建并原子回写，不直接返回陈旧缓存。单个项目文档 JSON 损坏、信封不可判型或底层 I/O 读取失败（非并发删除、非信任链拒绝）时，以**损坏占位摘要**返回（受信路径 id + 诊断文案，名称/统计/时间缺省——缺省时间排序稳定居末），不再静默跳过（[issue #123](https://github.com/hailingu/PlotWeave/issues/123)，已实现）：首页渲染损坏占位卡供定位，点击打开仍由 `load_project` 的失败诊断（issue #98 横幅）承接；信任链拒绝的符号链接/异型条目与读取时已并发删除（NotFound）的条目仍跳过，目录级读取失败整次报错、由首页错误态（issue #133）承接 |
| `create_project(name)` | 按 §10.2 验证/创建项目目录及控制文件目标后，先原子写初始 `project.json`，再更新可重建索引；name 按 §9.3 项目名校验口径校验（与 rename_project 同规则），跨文件中断由 §10.2 校正恢复 |
| `load_project(projectId)` | 按 §10.2 验证完整目录/文件信任链后才读 `project.json`；项目基准目录或文件逃逸即拒绝整个加载。随后按 §11.1 第 0 步只做信封判型：旧扁平形状包装为 v0，缺失/异型版本号的 v1 形状标记为待修复 v1，混合/无法判定的信封或显式版本与形状冲突时拒绝且不改写；并随原始文档返回受信 `projectId` 与可用的索引元数据。v1 的 `project` 父容器或成员异型不得在 Rust 层整份拒绝，交由前端归一化修复；节点级 schemaVersion 迁移与归一化同样在前端模型层（见十一），Rust 不参与。错误出口（issue #229）：NotFound 根因的拒绝文案携带稳定机器码前缀 `[project_not_found] `——前端空库播种等程序判定按码分支，不经中文文案；其余类别不带码，无码错误按「存在但不可读」保守处理；码不上屏，展示层剥离前缀 |
| `load_ai_session(projectId)` / `save_ai_session(projectId, session)` | 已实现：经受信项目目录句柄读取/原子写入唯一主文件 `ai-session.json`。缺失或损坏由 `{ session, corrupt }` 区分，真实 I/O 失败返回 Err。保存校验会话 v1 信封及数组 entries、要求项目记录存在，失败直接上浮。逐条归一化由前端加载完成；落盘形态映射（运行时标注剥离、未确认执行卡降级）在前端保存通道保持全量，总量最多 200 条（待执行卡优先占容量，其自身超额则保留最新 200 张）的容量裁剪由前端会话存储 `aiSessionStore` 在写入边界统一施加——进程内快照（设置页重挂载/失败保留/退出冲刷）持全量形态（[issue #64](https://github.com/hailingu/PlotWeave/issues/64)、[PR #85](https://github.com/hailingu/PlotWeave/pull/85)），后端保存校验不含条数上限；没有恢复副本命令或跨进程定序协议（§10.1）。 |
| `save_project(projectId, doc)` | 按 §10.2 验证完整目录、目标与临时文件信任链后，先校验完整项目信封：确认 `doc.project` 是普通对象；`project.id` **无条件以受信路径参数 `projectId` 覆盖**——调用方自报的 id 不构成授权，不得把与路径参数不一致的 id 落盘（否则内存会话、项目真源与首页索引出现分裂身份）；`project.name` 按 §9.3 项目名校验口径校验（与 rename_project/create_project 同规则）——先验 typeof string，去首尾空白后非空且按字符数 ≤ 64，非法值整次拒绝（保存边界不替调用方修复，普通命令无法产生的名称不得经原始 IPC 持久化），合法时采用规范化后的值。信封其余必需顶层成员同款前置校验：`schemaVersion` 必须严格等于当前支持版本（1）——缺失、异型或未来版本号整次拒绝（缺失/异型版本落盘后下次加载按 §11.1 第 0 步标记待修复，未来版本则直接拒绝，均不得由保存产生）；`graph` 是普通对象且其 `nodes`/`edges` 均为数组，`settings` 是普通对象且其 `characters`/`locations`/`props`/`documents` 各桶均为普通对象——任一异型即整次拒绝，不得把 `graph: null`、异型 `settings` 之类的载荷落盘后靠 §11.1 归一化重置为空容器，把无法判型的损坏静默变成内容丢失。`episodeTitles` 必须是普通对象（非数组、非 `null`）且键值满足 §11.1 第 3 步的键值域（规范十进制正整数安全整数键、字符串值）——数组型标题表等异型落盘后下次加载会被重置为 `{}`，载荷中的标题静默丢失，保存边界同样直接拒绝。`project` 其余元数据同域校验：`createdAt` 与 `updatedAt` 均须为可解析的 ISO 8601 字符串（`updatedAt` 虽被本命令无条件覆盖，异型值仍整次拒绝——保存边界不接受形状不完整的信封）；可选 `description` 存在时须为字符串；`graph.viewport` 存在时须为普通对象且 `x`/`y` 为有限数值、`zoom` 为正有限数（§3 缺省语义只允许字段缺省，不允许异型值落盘）；`graph.aiRevision` 存在时须为非负安全整数（§12.2 提交身份——异型/负数/超安全整数落盘后加载归一化会清零，已应用批次计数丢失、执行卡恢复对账误判）。再确认 `doc.assets`/`doc.assets.byId` 均为普通对象，再把每个键和值当作不可信输入执行 §7.1 完整形状、Record 键/id 一致性及 MIME/时间戳规范形式校验（保存边界不替调用方修复，非规范值直接拒绝，避免内存与落盘分叉），并逐项以受信项目资产根句柄 no-follow 打开当前 relPath、确认普通文件和真实路径包含关系；任一校验失败即在创建临时文件、生成保存时间或更新索引前拒绝整次保存，返回具体字段或 assetId 诊断，不得静默剥离。全部通过后，Rust 为本次尝试只取一次系统时间，**无条件覆盖**调用方携带的 `doc.project.updatedAt`（不信任旧值、未来值或前端时钟），再以排他创建的同目录临时文件 + flush + rename 原子替换 `project.json`；随后以规范化后的 name 与同一 updatedAt 更新可重建的 `index.json` 缓存，跨文件中断由 §10.2 的启动/列表校正恢复。成功回执返回权威 updatedAt，供前端刷新内存元数据而不触发新一轮脏写；失败重试重新执行信封与资产复验并取新时间，`serializeProject` 只负责结构序列化、不负责保存时刻盖戳 |
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

## 十一、加载与归一化

**实现入口（#6、#39）**：`model/convert.ts` 的 `parseProject` 负责信封判型与阶段编排；容器、节点、键控列表、边、资产、设定、引用分别由 `normalizeContainers`、`normalizeNodes`、`normalizeKeyedLists`、`normalizeEdges`、`normalizeAssets`、`normalizeSettings`、`normalizeRefs` 等模块处理，输出由 `serialize.ts` 统一序列化。原 `convert.ts`/`convert.test.ts` 与 `normalizeContainers` 的历史规模豁免已随拆分失效；阶段顺序和修复语义保持不变。

**入口输入所有权（[issue #102](https://github.com/hailingu/PlotWeave/issues/102)）**：`parseProject` 保留可变输入设计——归一化与 v0 迁移前预归一化**就地改写**传入对象及其嵌套成员（键控桶内嵌 id 以记录键改写、字段剥离/补默认、数组重置等）。调用后不得假设输入保持原样，也不得把调用后的输入再当原始档使用；需保留原始文档或嵌套引用的调用方须先自行克隆（`structuredClone`）再传入。`repaired` 判定基于入口内部的未改动快照，不受就地改写影响；`raw: unknown` 不承诺比该契约更深的所有权约束。错误路径（信封拒绝）不承诺任何改写语义；纯解析入口（克隆后归一化）属独立行为变更，不在该 issue 范围。

**v0 内嵌设定引用兼容子步骤（逻辑上属于第 0 步预检与第 1 步迁移 ④，优先于下文通用列表补缺）**：当前已发布的旧项目不只使用 `data.characterIds`/`locationId`/字符串 speaker；还可能把场景出场角色写成 `data.characters: Array<{ label, gradient? }>`、地点写成 `data.location: string`，把对白行 speaker 写成 `{ label, gradient? }`。迁移器必须在把缺失的 `characterIds` 补成空数组、校验新形态 speaker 或拆分节点四分区之前识别并保留这些字段：

- 预检确认 `data.characters` 为数组后只保留普通对象成员；每项 `label` 须为 trim 后非空字符串、可选 `gradient` 须为字符串，异型项删除并逐项警告，不得让成员字段读取先抛错。合法头像先在 v0 `settings.characters[]` 中确定性复用实体：优先同名同 gradient，再同名；仅当单字旧标签在兼容 gradient 的既有名称中唯一匹配前缀时才复用，零个或多个候选时新建本域唯一 id 的 Character（名称取 label，gradient 缺省取默认值）。把所得 id 与已有合法 `data.characterIds` 按原顺序合并去重后写入 `characterIds`，成功转换后才删除 `characters`；只有两种来源都不存在时才补 `[]`。
- `data.location` 为 trim 后非空字符串且没有合法 `locationId` 时，按完整名称复用 `settings.locations[]` 中的唯一实体，找不到则补建新 id 的 Location，再写入 `locationId`；已有合法 `locationId` 时以其为准并删除旧镜像，名称冲突记录警告。`location` 存在但非字符串或规范化后为空时删除并警告，不得覆盖合法 id。
- 对白 `data.lines[]` 的普通对象成员若 `kind === 'line'` 且 speaker 是普通对象，按头像同一 label/gradient 校验与复用/补建规则改写为角色 id；异型 speaker 删除并警告。非 line 成员携带 speaker 时按判别形状剥离并警告。对象型 speaker 在本转换完成前不得被当成“非字符串引用”清除。
- 本子步骤补建的角色/地点实体先进入 v0 设定数组，再由第 1 步 ⑤ 与原有实体一起做 id 校验、键化和引用一致性处理。由此实体与节点引用使用同一最终 id；通用预检中“缺失/非数组列表置空”的规则仅适用于上述旧字段也不存在或已确定无法恢复的情形，不能先清空再迁移。

上述确定性匹配只允许形状合法、名称经同一 `trim()` 规范化且 id 可安全读取的既有设定实体进入候选集；异型既有实体留给后续通用归一化隔离并警告，不得因兼容匹配读取其字段而中断迁移。新建实体的 id 必须避开本域已有键与已分配 id，规范化后的旧 label/location 同时作为比较值与新实体名称，避免空白差异制造重复实体。

`load_project` 返回后、交付画布前执行归一化管线，保证任何历史版本的文档都以当前形态进入会话。管线位于**前端模型层**（纯 TS，无框架依赖，与 §2 分层一致）——Rust 持久化层对节点/边结构不透明，只做第 0 步的信封判型与旧格式包装，并提供路径给定的受信 `projectId` 与索引元数据；不得仅因缺失 `schemaVersion` 就无条件按 v0 包装，也不得因 v1 的 `project` 父容器或成员异型而整份拒绝。文件系统信任边界仍由 Rust 层负责：任何项目控制文件 I/O 前先执行 §10.2 的目录/文件信任链校验；资产 relPath 的真实路径包含判定（canonicalize/符号链接解析）也只能由可访问文件系统的 Rust 层在 `load_project` 内执行，非法条目清单随加载结果返回，供第 3 步消费（§7.1 分层执行）。这两类检查不参与节点级模型迁移。

**同版本文档的字段演进与扩展字段保留（[issue #100](https://github.com/hailingu/PlotWeave/issues/100)）**：`schemaVersion` 不变的文档可能出现当前实现不认识的键，按所在层级分层处置——不得把未知数据当作可修复缺陷静默销毁，也不削弱既有坏数据修复与未来版本拒绝：

- **顶层与 `project` 层（封闭契约）**：顶层键与 `project` 字段由 Rust 信封（第 0 步的 `ProjectFile`/`ProjectInfo`）与保存边界（§10.5）按类型化结构解析，未知键在 IPC 前即被剥离，不进入前端 `repaired` 比较（仅打开不产生回写）；下一次前端保存按类型化契约重建信封，未知键随之丢失。该层的字段增补属破坏性演进，写入方必须升级 `schemaVersion`——旧客户端以未来版本拒绝保护代替静默丢弃。无版本文件按形状判型后的 `versionless` 修复标记（§10.5）依赖「顶层额外键使规范化比较必然不等、触发回写补盖版本号」的既有收敛语义，不受保留策略影响。
- **`graph`/`settings`/`assets` 容器层（扩展字段保留）**：三个容器以 untyped 值经 Rust 透传（第 0 步），契约键（graph 的 `nodes`/`edges`/`viewport`/`aiRevision`，settings 的四桶，assets 的 `byId`）之外的未知键由前端归一化按扩展字段原样保留：解析不修复、不纳入 `repaired` 判定（仅打开不回写），经会话透传字段随下一次保存原样落盘；保存边界（§10.5）只校验契约字段，扩展键照常通过。**传输边界（数值须为 IEEE 754 双精度可往返形态才受保留保证）**：整数越出 JS 安全整数域（±2^53−1）在 webview 解析时舍入——先于前端一切代码，归一化记域约束诊断警告（打开仍零回写），下一次保存固化当前加载值；小数精度超出 f64 的值更早在 Rust `serde_json` 解析侧舍入，webview 收到的值与真实小精度数值不可区分，该子类不可检测、无诊断可施，保存同样固化舍入值。需要位精确数值的字段演进必须升级 `schemaVersion` 走类型化契约，或以字符串承载。实现在 `normalizeContainers`（捕获 + 值域诊断 + 装配回填）与 `serialize.ts`（会话 ⇄ 落盘双向携带），契约键清单共享于 `jsonGuards.ts`。
- **成员级（节点/边/键控桶条目的内部字段）**：归一化对成员就地校验修复，未知字段随成员原样保留（不触发 `repaired`）；会话模型按 §4.1/§4.2 的字段域搬运——设定实体与资产条目整对象透传、未知字段往返保留，节点 `spec` 字段随展开透传，而节点顶层、边、`layout`/`ui`/`meta` 的未知键不进会话字段域，在下次保存时丢失。该层的语义性增补同样应升级 `schemaVersion`。

任何层级的扩展字段保留都不豁免既有修复：契约键的形状/值域修复、容器异型重置、孤儿边隔离等照常执行并记警告；扩展键与修复正交，`repaired` 只由契约字段的改写驱动，携带扩展键的净本零回写。

0. **信封判型与迁移前安全预检（先于任何迁移或逐项字段读取）**。根值不是普通对象时直接拒绝且不改写。v0 特征定义为：不存在 v1 专属顶层键 `project`/`graph`/`assets`，同时至少出现两个旧扁平特征键 `name`/`updated_at`/`nodes`/`edges`，且其中至少一个是 `nodes` 或 `edges`；v1 特征定义为：至少出现一个 v1 专属顶层键，且不存在旧扁平专属的顶层 `name`/`updated_at`/`nodes`/`edges`。v0 与 v1 专属键同时出现即为混合信封，拒绝加载并保留原文件。`schemaVersion` 为非负安全整数时由显式版本定族：0 只要未出现 v1 专属键即可进入 v0 预检（旧容器即使缺失或异型也由下段修复），1 只要未出现旧扁平专属键即可进入 v1 通用归一化（`project`/`graph`/`assets` 即使全部缺失也由第 2 步补齐），高于当前版本拒绝并提示升级；显式版本与相反家族专属键冲突时拒绝。版本字段存在且为 number、但负数、非安全整数或非有限值时直接拒绝，不得按形状降级；字符串值若是规范十进制整数且表示高于当前的版本也直接拒绝。仅当版本字段缺失，或其余无法表达受支持/未来版本的异型值出现时，才要求上述形状特征足以单独判型：唯一匹配 v0 时赋予迁移用的有效版本 0，唯一匹配 v1 时赋予待修复的有效版本 1，两组都不满足时拒绝，均记录警告。由此，丢失版本号但保持 v1 信封特征的文档会直接进入第 2 步，绝不读取顶层 `nodes`/`edges` 重新装配画布；显式 v1 的缺容器文档仍可按既有修复契约打开。

   判为 v0 后，迁移器在执行第 1 步前先按**旧路径**做安全预检：顶层 `nodes`/`edges` 非数组时重置为空数组，`settings` 非普通对象时重置为空对象，`settings.characters`/`settings.locations` 缺失或非数组时重置为空数组，`episodeTitles` 缺失或非普通 Record 时重置为空 Record，均记录无法机械恢复内容的警告；随后先过滤 `nodes`/`edges` 与设定数组中的非普通对象成员。仅对已确认是普通对象的 v0 节点读取 `type`/`data`：`data` 非普通对象时隔离该节点及其关联边；按节点类型检查旧扁平列表路径 `data.characterIds`/`data.lines`/`data.options`/`data.refs`。检查 scene 时必须先识别并保留可恢复的 `data.characters`/`data.location`，检查 dialogue 的 `data.lines` 普通对象成员时必须保留对象型 `speaker`，再执行本节开头的兼容子步骤；`characterIds` 缺失或非数组时，仅在没有可恢复 `characters` 来源时重置为空数组，否则延迟到兼容转换中合并/补齐。其余必填列表缺失或非数组时重置为空数组；`characterIds` 只保留字符串成员，`lines`/`refs` 只保留普通对象成员。`options` 在预检中必须保留原数组长度与成员位置，只按原始下标把成员分类为旧格式字符串、普通对象或非法项并记录警告；不得在第 1 步 ① 建立下标映射前过滤、压缩或重排，非法项到该步完成无映射标记后才删除。v0 边的 `data` 非普通对象时先重置为空对象，供第 1 步写入判别字段；迁移会读取或执行字符串操作的标量（如 `id`、`sourceHandle`、`type`、`className`）必须先做运行时类型检查，异型值只能按后续契约重发、隔离或保留警告，不得直接调用 `trim()`、前缀判断或正则方法。除此之外不得在本预检完成前解引用任何节点、边、设定实体或嵌套列表成员。预检只建立可安全遍历的迁移输入，不写回磁盘；完整迁移与 v1 通用归一化全部成功后才允许持久化。

1. 第 0 步完成后，`schemaVersion` 低于当前版本时按迁移链逐级升级；高于当前版本已在第 0 步拒绝。**迁移链首环**：schemaVersion 0（首版扁平存储格式：顶层 `name`/`updated_at`/`nodes`/`edges`/`settings`/`episodeTitles`，节点数据未分区、设定集为数组）→ 1（本文档结构）。首环包含四次改写与一次信封装配，改写全部发生在孤儿边隔离之前：① 逐个 branch 以转换前的 `data.options` 原始数组下标遍历并建立「原始下标 → 最终选项 id」映射：字符串成员先保留原文案转换为 `{ id: 新 id, label: 原字符串 }`；普通对象成员只有 `label` 为字符串时才保留，随后按本节共同 id 规则补发缺失/非法 id，并在同一数组内去重——v0 已存在的重复选项 id 保留首见项、后续项重发新 id；所有新 id 均须避开该节点全部原有合法 id 与本轮已分配 id。其余异型或 label 非字符串的成员删除并逐项警告，其原始下标不建立映射；**不得先压缩数组再用新下标建映射**，否则被删项后的旧 `option-N` 连线会静默改接到后一选项。`dialogue.lines`/`shot.refs` 等其余键控列表同阶段补稳定 id。上述选项对象化、id 补发与去重必须全部在 ② 之前完成：旧下标句柄按「原始下标 → 最终选项 id」定位；若字符串仍是标量，或重复 id 留到 ② 之后才去重，连线会被删除或静默改接；② 对每条以该 branch 为 source、且按第③项旧字段归类规则可确定归为 branch 的边，把规范的旧式 0 基下标句柄（`option-0`、`option-1`…）按该节点的映射改写为稳定 id 句柄（`option-<id>`）。下标越界、对应旧项已删除或句柄无法规范解析时不得改写，而须立即把该边加入迁移隔离集合并记录警告；第 3 步直接隔离，不得再把原字面量解释成稳定 `option-<id>`（否则它可能碰巧解析到 id 为同一数字串的其他选项），更不得猜测为压缩后下标；③ 把边的旧式运行态判别字段（`type: 'branch'`、`className: 'pw-edge-attach'/'pw-edge-sequence'`）按归类规则（§4.3 连线语义）改写为显式 `data.kind`，**并删除镜像的 `data.optionLabel`**（§5 禁止边上落 label，胶囊文案按改写后的稳定句柄重新派生）；④ 节点结构转换：先按本节开头的 v0 兼容子步骤把 `data.characters`/`data.location`/对象型 `speaker` 复用或补建为设定实体并改写成 id，成功后才删除旧字段；再把旧 React Flow 形状（顶层 `position`/`selected`、类型字段平铺于 `data`）拆入四分区（`layout`/`ui`/`data.spec`/`data.meta`），**名称型节点（scene/beat/dialogue）的旧 `data.name` 上移为 `meta.label`（必填）**，`ui.selected` 重置、`ui.expanded` 初始化为 `true`（旧节点无该字段）——v0 节点未经引用转换与四分区转换不得 stamped 为 v1。⑤ **信封装配**（文档级映射与缺省回退，经 Rust `wrap_legacy` + 前端 `serializeProject` 协作完成）：顶层 `name` → `project.name`；顶层 `updated_at`（epoch 毫秒）→ ISO 8601 → `project.updatedAt`，`createdAt` 缺省与 `updatedAt` 同刻；`project.id` 由项目文件名回填（信任边界校验）；`nodes`/`edges` 上移 `graph`，`viewport` 缺省不伪造（打开时 fitView）；`settings` 的嵌套数组键化：`settings.characters[]` / `settings.locations[]` → `Record<id, 实体>`（v0 的 `settings` 本身是对象，数组在成员上——勿把整个 settings 当数组转换），**键化前按 §8.1 的共同值域校验实体 id：重复 id 保留首见项、后续重发新 id（节点引用本就按 id 解析到首见项）；缺失、非字符串或 `trim()` 后为空的 id 均重发新 id 并记录警告**，避免直接键化时同键覆盖、设定内容静默丢失；对字符串型空白 id，以修复前原值为映射键建立「原 id → 新 id」映射并同步改写指向该桶的全部结构化引用（`characterIds` 成员、`speaker`、`locationId`、`relatedIds` 对应 kind 项的 `id` 等，与第 3 步空白键处理同款）——数组内某一原值仅对应一个实体时映射明确、引用随重发保留；同一原值对应多个实体时映射歧义，相关引用保持悬空并记录警告（键化完成后记录键均满足共同值域，第 3 步不会再补到这一步）；`props`/`documents` 补空桶；`episodeTitles` 归一化（字符串键 → 数字键的格式转换、去空标题——仅规范十进制正整数字符串键参与转换，非规范数字串如 `"01"`/`"1e0"` 不转换、连同非法键一并由第 3 步删除；键/值域校验由第 3 步对所有版本统一执行，见下），缺省 `{}`（v0 早于集标题功能的文件没有该字段）；`assets` 补 `{ byId: {} }`。⑤ 完成前文档不得 stamped 为 v1。
   **v0 角色 id 补充**：本步 ⑤ 对 `settings.characters[]` 键化前，除共同 id 规则外还必须立即执行下文“角色 id/token 专项修复”；先生成安全 id 并同步结构化引用与旧 token，再以最终 id 建 Record 键。不得先把含 `]`/换行等 id 的角色盖成 v1、留到后续扫描才处理。

2. 对第 0 步判定的 v1 文档与第 1 步迁移产物，先做当前信封的容器级形状校验（先于一切 v1 逐项规则；**父容器先于子容器**——父容器异型未补齐就访问子容器会直接解引用失败）：`project`/`graph`/`settings`/`assets` 缺失或为非普通对象（`null`/数组等）时，`project` 先补为可供逐字段归一化的空普通对象，其余分别补 `{ nodes: [], edges: [] }`/默认空桶/`{ byId: {} }`；父容器就位后再校验子容器——`graph.nodes`/`graph.edges` 非数组时重置为空数组，`settings.characters`/`locations`/`props`/`documents` 与 `assets.byId` 非普通键值对象（`null`、数组或其他异型——JavaScript 中数组同为对象，「非对象」检查不足以排除；数组形态会让下标 `"0"`/`"1"` 被当作权威实体 id 改写内嵌 id，原有引用静默悬空）时重置为对应空 Record，`episodeTitles` 缺失或非 Record（`null`/数组等）时重置为 `{}`——标题表容器不合法时第 3 步的键值遍历无从执行。异型容器的内容无法机械恢复，重置均记录警告，但管线必须可遍历、单个脏字段不能让整个项目打不开（§8.2.4）。容器就位后再过滤**成员级异型**——节点/边数组中的非普通对象成员（`null`/数组/标量）隔离并记录警告，Record 桶中的非普通对象值同款移除：任何字段读取与改写只针对普通对象成员，否则 `graph.nodes: [null]` 会在下一步重置 `ui.selected` 时解引用 `null`、`characters.c1 = null` 会在内嵌 id 修复时崩坏。成员过滤后接着校验**嵌套容器及其成员**（必须先于第 3 步一切逐项修复与遍历——第 3 步首条规则即读取 `data.kind`、迭代列表、按列表 id 去重，判别式、列表容器或成员异型时会在形状校验执行之前先解引用崩坏）：节点 `data`/`data.spec`/`data.meta`/`layout` 或边 `data` 缺失或为非普通对象时判别依据缺失、无法机械修复——隔离该节点（连同其关联边）/该边并记录警告；与节点类型对应的必填列表 `scene.spec.characterIds`、`dialogue.spec.lines`、`branch.spec.options`、`shot.spec.refs`，以及每个 `SettingsDocument.relatedIds` 缺失或非数组时重置为空数组并记录警告——列表可确定性置空、所属节点/实体保留，指向被清空选项的连线由第 3 步按孤儿边处理。列表容器就位后再过滤成员：`lines`/`options`/`refs`/`relatedIds` 中的非普通对象成员移除并警告，`characterIds` 中的非字符串成员移除并警告；普通对象成员的字段形状与字符串成员的值域仍由第 3 步按各自契约校验。所有父容器和嵌套列表安全后、读取 `project.name` 等成员前补齐项目必填元数据：`project.id` 缺失、非字符串、`trim()` 后为空或与 `load_project(projectId)` 的受信项目 id 不一致时，以受信 id 覆盖并记录警告；`project.name` 先校验为字符串，再去首尾空白，非字符串、规范化后为空或按字符数超过 64 时回退索引中的合法名称，再回退固定占位「未命名项目」并警告；`createdAt`/`updatedAt` 须为可解析的 ISO 8601 字符串，`updatedAt` 非法时优先采用索引中的合法时间、否则取本次加载时刻，`createdAt` 非法时采用修复后的 `updatedAt`，均记录警告；可选 `description` 存在但非字符串时剥离并警告。由此即使原始 `project` 为 `null`/数组/缺失也会在逐项规则前成为完整、可保存的信封。最后补齐节点 `ui` 默认值——`ui` 缺失/非对象或 `selected`/`expanded` 类型错误时重置为 `selected: false`、`expanded: true`（与迁移 ④ 初始化口径一致）并记录警告——再重置所有节点 `ui.selected = false`（顺序不能颠倒：普通对象节点的异型 `ui` 会在重置时直接解引用失败）。
3. 先执行下文“非法 id 与 Record 键的统一解释”中的全部 id 修复：节点/列表 id 重发及可确定引用改写先于边隔离，边 id 同步重发；**完成这些 id 修复后，先执行本段后列的全部节点判别联合、基础结构与可修复字段归一化规则；隔离无法机械修复的节点及其全部关联边，得到最终活动节点集。任何边的端点/kind/句柄解析、逻辑重复、attach 宿主唯一或剧情流成环判定都不得早于该阶段，也不得让已隔离节点或其关联边进入候选边集合**；随后在解析 `source`/`target`、读取节点类型或执行任何边语义前，按 §5 校验边的端点字符串值域及完整 `data.kind` 判别联合：未知/非字符串 kind、非法端点值或确定性句柄剥离后仍无法形成任一变体的边立即隔离并警告。随后才隔离孤儿边（source/target 节点已不存在；branch 边的 `sourceHandle` 指向的选项已不存在、kind/句柄矛盾（§5 保留字面量）、sequence/attach 边 source 为 branch 节点（§5 端口归属反向约束）、attach 边端点类型不合法——必须 scene → shot——、sequence/branch 边端点为 shot（§4.2 分镜卡不参与剧情流）同论）并记录警告——修复而非拒绝，单条坏数据不阻断加载（见 8.2.4）。已知 kind 的边携带 `targetHandle` 或 sequence 边携带 `sourceHandle` 时不隔离而剥离——匿名端口唯一（§5），剥离不改变连接语义，记录警告；该确定性剥离发生在完整变体判定内，绝不为未知 kind 猜测变体。剧情流边的自环与成环同款隔离：仅以最终活动节点之间、且已通过前述边形状/端点筛选的候选边按文档序逐边重建剧情流图，source 等于 target 的自环边、加入即闭合回路的 sequence/branch 边均按孤儿边隔离并警告（attach 垂直从属不参与环检测，§4.3）。节点 id 重复时保留文档序首个节点、后续同 id 节点重发新 id 并记录警告——按 id 的引用（边端点等）本就解析到首个节点，重发节点成为无连线孤儿节点（内容保留，由用户处置）。branch 节点 `options` 内出现重复 id 时同样修复：保留首见项，后续重复项重发新 id 并记录警告——v1 文档的连线按 id 解析，本就归属首见项，重发不产生改接（v0 迁移路径的重复 id 已在首环 ① 去重，不经此条）；其余键控列表（`dialogue.lines`、`shot.refs`）的重复 id 同款修复——它们不被边引用，重发纯为列表 key 去歧。边 id 重复时保留文档序首条、后续重复边重发新 id 并记录警告。同一 shot 存在多条入向 attach 边时保留文档序首条、其余按孤儿边隔离并警告（宿主场景唯一，见 §5 attach 宿主约束）。节点 `meta.episodeNo` 非法（非正整数、非有限值或超出安全整数范围，§9.3 命令边界同域）时删除该字段并记录警告——回退为未分集，不阻断加载。逻辑重复边（同 source/target/sourceHandle，§5）保留文档序首条、其余按孤儿边隔离并警告。**节点校验细则（逻辑上已按本步前置顺序执行，以下位置只展开规则，不表示晚于边图重建）**：按 §4.1 判别联合校验节点 `type` 与 `spec`/`meta` 的对应：never 禁写字段被携带（branch/shot 的 `label`、shot 的 `episodeNo`）时剥离该字段并警告；type 与 spec 形态错位（如 scene 携带 BranchSpec）、名称型节点缺必填 `meta.label` 等无法机械修复的异型节点，隔离该节点及其关联边并记录警告，不交付画布——JSON 边界已擦除 TypeScript 类型，此校验是 §9.3 create_node 边界校验在加载路径的对等兜底。节点基础结构（§4.1 StoryNodeBase 四分区的外壳）同款校验：节点 `id` 缺失或为空时重发新 id 并记录警告——缺失（undefined/null）的 id 无引用可指向，重发无副作用；**空字符串 id 可被脏写的边端点（`source: ''`/`target: ''`）指向**，重发时建立「空 id → 新 id」映射并同步改写边端点——仅一个空 id 节点时映射明确、连线保留；存在多个空 id 节点时映射歧义，指向空串的边按孤儿边隔离并警告——**歧义判定以修复前的空 id 数量为准、先于上文的通用重复 id 去重执行**：空串本身即「重复 id」，若先去重再判定，两个空 id 节点会被折叠为一个、指向空串的边被错误改接到首见节点而非隔离（与空选项 id 的歧义处理同款；更正四十四轮「无引用可指向缺失 id」对空串不成立的表述）；`ui` 的缺失/异型已在第 2 步重置 `selected` 前补齐默认值，本条不再重复；`layout.size` 等可选布局数值非法时剥离该字段并记录警告；`layout.position` 坐标非有限数值等无法机械修复的基础结构异型，隔离该节点及其关联边并记录警告、不交付画布——单个异型节点不阻断项目打开（§8.2.4），缺坐标/缺 ui 的节点会让依赖 StoryNodeBase 的画布渲染直接崩溃。非法 sceneNo/shotNo（非正整数、非有限值或超出安全整数范围，§9.3 同域）按文档序顺位重发为正整数并记录警告（场号/镜号可在场景面板修正）。键控列表（`branch.options`/`dialogue.lines`/`shot.refs`）中的空 id 重发新 id 并记录警告。重发空选项 id 时建立「空 id → 新 id」映射并同步改写该 branch 节点引出边的 `option-` 句柄——branch 内仅一个空 id 选项时映射明确、连线保留；同 branch 存在多个空 id 选项时映射歧义，无法归属的连线按孤儿边隔离——**歧义判定同样以修复前的空选项 id 数量为准、先于上文的 `options` 重复 id 去重执行**：空串同为「重复 id」，先去重会把多个空选项折叠为一个、误判映射明确，连线被错接到首见项而非隔离。本步内节点/列表修复先于边隔离判定，句柄解析针对修复后的 id。完成本步键/id 修复后，对 `assets.byId` 每个普通对象值执行 §7.1 的完整 AssetRef 形状校验：`relPath`/`mime`/`source`/`createdAt` 任一必填字段缺失、类型错误或值域非法即从活动索引隔离并警告；仅 MIME 的合法大小写/首尾空白与可解析时间戳的时区表示允许规范化后保留。relPath 词法层（绝对路径、解析目标越出资产子目录）由本步判定；真实路径包含判定（canonicalize/符号链接解析）消费 Rust `load_project` 随加载结果返回的非法条目清单——形状、词法或真实路径任一校验失败均移除该条目，其引用字段按 §8.2.3 悬空展示，项目自包含不因脏数据破坏。`episodeTitles` 键值校验对**所有版本**文档执行（迁移链 ⑤ 只做 v0 的字符串键 → 数字键格式转换，v1 文档不经迁移链，脏写/导入仍可携带非法键值）：键须为规范十进制正整数字符串且在安全整数范围（`Number.isSafeInteger`）内——零/负/小数/NaN/非数字串删除该键并记录警告（无法由 `set_episode_title` 产生也无大纲语义）；`"01"`、`"1e0"`、`" 1"` 等可折算为正整数但非规范书写的键同样删除并记录警告——它们与规范键（如 `"1"`）折叠到同一集号，转换时会按属性遍历序静默覆盖其中一个标题；超出安全整数范围的键删除并警告（`Record<number, string>` 索引精度不保）。值非字符串时删除该键并记录警告（大纲 UI 只消费字符串标题）；字符串值去首尾空白，空白后为空串的删除该键（与 `set_episode_title` 落盘口径一致）。键控实体桶（`settings.characters`/`locations`/`props`/`documents`、`assets.byId`）的 Record 键与值内嵌 id 一致性修复对**所有版本**执行，且**先于各桶的实体形状校验**（v0 数组键化在迁移链 ⑤ 按实体 id 建键、天然一致，但 v1 脏写/导入可产生 `characters.ch1.id === 'ch2'` 式分裂身份——引用按记录键解析，更新/删除按值内 id 定位，两者不一致时实体可显示却无法正确更新或删除）：**记录键本身先按 §8.1 的共同值域校验（`key.trim().length > 0`）**——空串或纯空白键条目确定性重发一个本桶未占用的新键（值内 id 随键同步为同一新 id）并记录警告（空身份与 upsert 边界的非空 id 约束冲突、空 React key 致 reconcile 错位）；重发时以完整原键建立「原键 → 新键」映射并同步改写指向该桶的**全部**结构化引用（均按精确等于原键匹配）：角色桶改写 `DialogueLine.speaker`、`SceneSpec.characterIds` 成员与 `SettingsDocument.relatedIds` 中 `kind: 'character'` 项的 `id`；地点桶改写 `SceneSpec.locationId` 与 `relatedIds` 中 `kind: 'location'` 项的 `id`；资产桶改写 `avatarAssetId` 与 `ShotRef.assetId`；props/documents 桶无被引用字段、无需改写；`relatedIds` 项须 kind 与目标桶对应才改写，不得因不同桶存在同字面 id 而跨命名空间改写——标准 JSON Record 中每个原键至多一个条目（JSON 键唯一），映射天然明确，引用随重发保留而非悬空；仅非标准解析保留重复键等歧义情形无法归属，相关引用保持悬空并记录警告（更正四十二轮「空键不可能承载合法引用」的表述——脏写的引用侧同样可以出现空串）；记录键合法时，内嵌 id 缺失、非字符串或 `trim()` 后为空均以记录键补齐、不一致时以记录键为准改写，均记录警告——键是引用解析的权威值，补齐/改写可无歧义地保住条目内容与全部既有引用；键在 Record 内天然唯一，新键又经未占用校验，改写后各值内 id 亦唯一，不产生碰撞。`project.name` 归一化对所有版本执行（§9.3 项目名校验口径的加载侧兜底——`load_project` 只反序列化文件，旧项目或手工修改可携带非法名称）：typeof 非 string、去首尾空白后为空或按字符数超过 64 时确定性修复——先去首尾空白，合法则采用规范化值；仍非法则回退为项目索引（`index.json`）中的名称，索引亦无合法名称时回退固定占位「未命名项目」，均记录警告。活动文档中的名称由此始终可保存，`rename_project` inverse 捕获的旧名才能经同一命令边界回放——否则撤销要么被边界拒绝，要么恢复一个 `save_project` 会拒绝的名称。`graph.viewport` 存在时校验其形状：非对象、`x`/`y` 非有限数值或 `zoom` 非正/非有限时删除该字段并记录警告——回退打开时 fitView（§3 缺省语义），无效变换不交给画布（否则可能出现空白或不可操作的视图）。`graph.aiRevision` 存在时须为非负安全整数，否则删除该字段并记录警告——回退 0（等同未应用过 AI 批次，执行卡按未落盘处理），不把不可比对的计数交给恢复对账。`settings.documents` 逐项校验 SettingsDocument 判别形状（§6，JSON 边界已擦除 TS 类型）：`relatedIds` 关联项不符合 `{ kind: 'character' | 'location'; id: string }` 形状时删除该项并记录警告——旧式字符串项无法解析归属（跨桶同名歧义，§6）、未知 kind、缺失或空 id 同论；形状合法但 `(kind, id)` 重复的关联项保留首见、其余删除并记录警告（重复关联会让反向索引/导航重复列出同一文档）。文档条目本身 `title`/`body` 非字符串等无法机械修复的形态，从 `documents` 隔离该条目并记录警告（内嵌 id 已经一致性改写补齐，不在本条判定范围）——否则按 `{ kind, id }` 构建的反向索引、导航与失效引用展示无法解析。`settings.characters`/`locations`/`props` 逐项校验实体形状（与 §9.3 upsert 边界同域；内嵌 id 已经一致性改写补齐，本条只判定其余字段）：必填字段缺失或类型错误（name 非空字符串、Character.gradient 字符串）的条目无法机械修复——从桶中隔离并记录警告，既有引用按 §8.2.3 悬空展示（否则 `name: null` 之类的值会交付画布，消费方 trim/渲染在运行期崩溃）；可选字段（bio/note/description/avatarAssetId）存在但类型错误时剥离该字段并记录警告。

   **ShotRef 目标命名空间与旧字段兼容（本步节点联合校验的一部分）**：资产桶完成键/id 修复且通过完整 `AssetRef` 形状筛选后，先兼容尚未由当前实现持久化的旧草案字段 `targetId`，再按当前联合校验每个普通对象 `shot.refs` 成员。旧字段与 `assetId`/`label` 任一并存，或旧值不是符合 §8.1 共同值域的字符串时，该 ref 按歧义/异型成员隔离并警告。`kind === 'audio'` 的旧值依原契约视为项目资产 id：资产键若在本步重发则跟随同一明确映射，再改名为 `assetId`；映射后资产仍缺失也保留为悬空引用。`kind === 'character' | 'location'` 仅当旧值按资产键修复前后的身份唯一命中活动 `image/*` 项目资产，且按对应设定桶修复前后的身份均未命中实体时才改名；否则隔离并警告。成功转换后删除 `targetId`；迁移器不得把角色或地点实体 id 当成资产 id，也不得隐式追随 `Character.avatarAssetId`。兼容完成后校验当前联合：`id` 适用上文列表 id 规则；`kind` 必须是 `character | location | audio`；且必须恰有 `assetId` 或 `label` 之一。自由位的 `label` 必须是字符串；引用位的 `assetId` 必须是非空字符串并只按当前项目 `assets.byId` 解析，资产键重发时跟随资产桶映射，目标缺失时按 §8.2.3 保留为悬空引用并警告，不删除用户选择。目标存在时，`character`/`location` 必须对应 `image/*`，`audio` 必须对应 `audio/*`；MIME 用途不匹配时保留为不可用引用并警告，不得改按其他命名空间解释。两字段并存、两字段皆无、值类型错误或未知 kind 无法无歧义修复时，仅隔离该条 ref 并警告，不隔离整个 shot。这是 v1 发布前文档契约修正，当前实现仅持久化自由位 `label`，不提升 `schemaVersion`；兼容规则只保护旧草案或手工导入数据。

   **角色 id/token 专项修复（第 1 步 ⑤ 的 v0 数组键化与本步 Record 修复共用，先于第 5 步文本扫描）**：两条路径都必须同时应用 §6 的 `[A-Za-z0-9_-]{1,64}` 子值域。v0 数组以实体原 `id` 为迁移身份：非空字符串 id 若只违反该子值域，确定性重发本桶未占用的安全 id；先按既有重复规则决定首见实体的归属，再以修复前完整字符串建立明确映射。v1 Record 则以记录键为权威身份：键违反子值域时重发未占用的安全键并把值内 `id` 同步为新键；键已安全时，即使值内 `id` 不安全或不一致，也按上文共同规则以键覆盖值内 `id`，不得据值内字段另行重键。随后按权威旧身份 → 新身份映射同步改写 `characterIds`、dialogue `speaker`、`kind === 'character'` 的 `SettingsDocument.relatedIds` 等所有结构化角色引用。文本改写不能先用新 token 正则扫描——旧 id 可能含 `]` 或换行；迁移器须按已知旧身份构造完整字面量 `@[character:<旧 id>]`，以不插值正则的字面量匹配替换为新 token。某旧值归属首见实体时 token 同步指向该实体的新 id；无法唯一归属时原文保留并警告，不猜测目标。全部改写完成后活动角色 id 与新写 token 才统一满足固定语法。

   **非法 id 与 Record 键的统一解释（优先于本步上文仅写“缺失”“空串”或“空白”的旧例）**：§8.1 的共同值域是 `typeof id === 'string' && id.trim().length > 0`。对节点、边、键控列表项与 v0 设定数组实体，缺失或任意非字符串 id（number/boolean/null/对象/数组）均为非法，须在通用重复 id 去重前为每个实体独立重发本域未占用的字符串 id 并警告，**不得**用 `String(value)` 强转（否则数字 `7` 会与合法字符串 `"7"` 碰撞）。合法引用的值域本就只允许字符串，因此不为非字符串旧 id 建映射：边的非字符串 source/target 或其他非字符串引用按各自形状规则隔离/剥离/标记悬空；字符串句柄也不得猜测为某个非字符串选项 id，无法解析时按孤儿边隔离。字符串型空白 id 则以修复前的**完整原字符串**分组并建立「原 id → 新 id」映射；同一原值只对应一个实体时同步改写精确等于该原值的边端点、句柄或同域引用，同一原值对应多个实体时视为歧义并隔离相关连接或保留悬空警告。键控实体桶的 Record 键在 JSON 中天然是字符串，先执行 `key.trim().length > 0` 校验：空串或纯空白键均重发一个本桶未占用的新键，值内 id 同步为新键，并把精确等于旧键的同桶引用同步到新键；记录键合法时，内嵌 id 缺失、非字符串或 `trim()` 后为空均以记录键补齐，不一致时仍以记录键为准。不得把空白键直接采用为权威 id，也不得仅 `trim()` 后原地改键——后者可能与既有键碰撞且漏改引用。

   **图片节点归一化（§13 首版，第 3 步节点校验细则的 image 分支）**：`meta.label`/`meta.episodeNo` 按 never 禁写剥离（同 shot，§4.1 ImageMeta）；`spec.prompt`/`spec.model`/`spec.size` 为必填字符串（异型即形态错位、隔离节点）；`spec.outputs` 缺失或非普通对象时重置为空对象并警告（未生成产物是合法状态 `outputs: {}`，字段缺失属脏写）；`outputs.primary` 存在但非普通对象、`assetId` 非非空字符串时剥离整个 primary 并警告；可选 `width`/`height` 存在但非正有限数时剥离该字段。`primary.assetId` 只按本项目 `assets.byId` 解析，目标缺失保留为悬空引用并警告（§8.2.3 不删除用户选择，UI 按缺失占位展示）。剧情流边（sequence/branch）端点为 image 的按孤儿边隔离——图片节点不参与任何连线（§4.2）。

4. 标记（而非清除）悬空的设定引用与资产引用。
5. 仅按 §8.1.2 的固定正则扫描文本中的 @ 提及 token；近似但非法的 token 形片段保留为普通文本并警告，合法 token 的目标已不存在时标记为失效（token 本身保留）。
6. 重建 id 生成器的计数基线，防止新 id 与存量冲突（当前 id = 类型前缀 + 时间戳 + 随机尾，天然无计数基线；本条为将来引入计数式 id 时的保留动作）。

## 十二、AI Agent 交互

用户通过对话让 AI 操作画布——创建/删除节点、修改 spec、连线、批量调整剧情结构。这一能力完全建立在第九节的命令通道上。

### 12.1 核心决策：Agent 是命令的另一个生产者

Agent 不直接触碰文档状态，只产出 `GraphCommand`（`actor: 'agent'`），经同一条 applyCommand 链路执行（目标形态；当前实现为 Agent 命令经 `ai/commands.ts` 校验后由 `ai/batchSim.ts` 折叠执行、整批一步撤销，见 §9 就地实施状态）。由此免费获得：

- 撤销/重做天然覆盖 AI 操作，误操作一键回滚；
- 持久化、归一化、悬空引用检测不需要为 Agent 写第二套；
- `actor` 字段为审计与 UI 标记（「此改动来自 AI」）提供依据。

### 12.2 应用内 Agent（首版）

不引入 Agent 编排框架。画布操作是「读快照 → 发一批结构化命令」的低轮次任务，朴素的 tool-calling 循环足够：

```
用户对话 → [系统提示 + 画布快照摘要 + 工具 schema] → LLM（BYOK，OpenAI 兼容 tool calling）
        → 解析 tool_calls / JSON 命令 → 整批校验（失败反馈并有限纠错）
        → 合法改动预览 → 用户确认 → 命令通道执行（整批一步撤销）
```

- **工具集 = 命令清单的封装**：读工具 `get_graph_snapshot` / `get_node` / `get_settings_snapshot` / `get_document`；写工具 `create_node` / `delete_node` / `update_node_spec` / `connect_edge` / `disconnect_edge` / `upsert_character` / `upsert_location` / `upsert_document` / `batch`。
- **模型可见的完整创建协议（[issue #75](https://github.com/hailingu/PlotWeave/issues/75)，已实现）**：`ai/toolSchemas.ts` 从节点／实体字段协议生成单写工具与批次成员的显式 schema；`batch.commands` 按 op、创建节点类型、实体新增／更新区分形状，声明必填字段，拒绝 schema 外的字段。对白行细化为 `line`／`action`，`text` 必填、`kind` 缺省 `line`、speaker 仅台词行可填角色 id 或本批 ref；分支选项、分镜引用、编号和实体引用也提供嵌套形状。默认值和既有简写继续有效，不新增写操作或持久化 schema。模型侧 schema 是输出协议，应用的两阶段校验仍为权威边界，动态实体存在性、目标节点类型、连线归属等仍由其判定。
- **完整批次示例与插入语义（[issue #75](https://github.com/hailingu/PlotWeave/issues/75)，已实现）**：`ai/creationGuide.ts` 随系统提示提供完整可解析 JSON 批次，示范场景插入及先 upsert 角色、后创建对白并以 ref 绑定 speaker；相同对象可作 `batch` 参数或工具不可用时的围栏输出。示例占位 id 必须换成当前快照 id，已有角色应先查询并复用。顺序插入 A→B 默认提议同批 `disconnect_edge A B`、创建 C、连接 A→C→B，避免绕过新内容的旧直连；无后继时只连 A→C，多后继／分支未明确时先澄清，明确增加路径时保留原路径。对白使用 `sequence`，场景下挂分镜才使用 `attach`。此为模型方案指引，不改变 §5 的多出口图契约，也不自动清理旧项目；预览确认、原子执行、整批撤销沿用原通道，真实模型的遵循情况仍是验证边界。
- **类型成员校验（[issue #49](https://github.com/hailingu/PlotWeave/issues/49)，已实现）**：节点类型、可修改节点类型与连线类型只接受协议表的自有键；`toString`、`constructor`、`__proto__` 等继承属性名均不属于合法类型。创建与连线在阶段 A 返回「未知节点类型 / 未知连线类型」并整批拒绝，空或缺省 `data` 也不能绕过；共享载荷校验在读取字段白名单前拒绝无自有条目的目标类型，使修改入口同样返回可读问题而不抛异常。tool、JSON 围栏与历史待执行卡的执行前重校验共用此边界；非法类型不会回退成分镜卡或剧情流边，整批拒绝不改变画布、撤销栈或提交计数，合法类型和既有纠错流程保持不变。
- **节点字段协议单一来源（issue 41）**：各类型 `data`/`patch` 的合法字段表由前端 `ai/nodeFields.ts` 生成并三处共用——系统提示、写工具描述（create_node / update_node_spec / batch 通道）与整批校验白名单，字段语义对齐 §4.2 节点 `spec`（如节奏卡只允许 `name`/`tone`/`episodeNo`）。模型输出表外字段时整批拒绝，具体校验错误按 tool 协议或 user 消息回喂模型做有限次纠错重试（首次产出 + 3 次重试，quota=3；耗尽即彻底失败），保留错误预览卡、画布不变，不静默丢弃或映射语义不匹配的字段。整批校验为两阶段契约：**阶段 A** 逐条收集上下文无关的形状错误（字段白名单/值形状/options 成员/连线类型/内在 optionIndex/实体 fields 形态——实体引用位与批次内 ref 相关，留待阶段 B），一次全量回喂，多错误批次一轮修完；**阶段 B** 形状全过后在「当前图 + 本批已建未删」虚拟状态上顺序折叠，**首错即停**——失败之后的命令本轮不校验不点名（级联误报由「不前进」消除），分层错误随修复重放逐轮暴露（PR #66 的 owner 决策，取代 issue 39 的完整清单 + contingent 自愈机制：依赖命令分类、暂定投影、ghost 登记、按位溯源等簿记整体退役）。update 目标类型未知时（经批次内 ref，或 token 被删除后同名重建换主），阶段 A 除「任何可写类型都不支持的字段」外，也对**唯一归属单个可写类型且协议为 array** 的字段（从协议表派生，如 `options`/`lines`/`characterIds`/`refs`）做容器校验——非数组值对任何可能的目标类型恒非法，与失败 create 的修复结果无关，同轮点名（[issue #67](https://github.com/hailingu/PlotWeave/issues/67) 收窄两阶段契约）；其余类型专属形状仍分层延后到阶段 B。阶段 B 在 `create_node` 登记 `ref` 别名时执行冲突守卫（[issue #117](https://github.com/hailingu/PlotWeave/issues/117)，已实现）：别名与任一在存节点 id（按折叠期当前状态判定——快照 id 被本批更早的 `delete_node` 删除后允许同名 ref 重建换主）或折叠期虚拟 id 的保留前缀 `__new__:` 相同即整批拒绝——批次校验按既有 id 优先解析、执行按本批别名表优先解析，冲突别名会让同一 token 在预览与执行绑定到不同节点（实体 ref 同款规则见 `entityRefCollisionIssue`）；重复 ref 以最后一条 create 为准，预览与执行同表 last-wins。**列表成员白名单（[issue #140](https://github.com/hailingu/PlotWeave/issues/140)，已实现）**：列表成员的自有键按成员级白名单校验、与各 itemObject schema 的 `additionalProperties: false` 同口径——`lines` 行成员（id/kind/text/speaker/side/vo）、`options` 对象成员（id/label）、`refs` 引用位成员（id/kind/assetId/label）、`relatedIds` 成员（kind/id）；未知自有键（含 JSON 自有 `__proto__` 键）按下标与键名点名、整批零变更，不再随成员 spread 进文档。此收紧只作用于 AI 入站通道；加载归一化的成员级政策（未知字段随成员原样保留、前向兼容保真）不变——两层按「入站从严、落盘保真」区分。
- **设定实体写通道（issue 44，首期已落地）**：`upsert_character` / `upsert_location` 落地 §9.2 的设定命令语义，实体字段协议由 `ai/entityFields.ts` 单一来源生成（机制同节点字段表，系统提示/工具描述/校验白名单三处共用）。`get_settings_snapshot` 读工具给出全部角色/地点的 id、名称与小传/备注。批次内规则：新建不带 entityId、由应用分配真实 id 与默认头像样式，`ref` 临时别名供同批 `characterIds` / `locationId` / `lines[].speaker` 引用（执行期解析为真实 id 落地，临时 ref 不落盘）；修改必须以 entityId 精确指向既有实体、fields 只写要改的字段（未提及字段保持不变），名称只作展示、不作为定位或覆盖依据——同名候选歧义由模型说明澄清，不做静默覆盖或合并。整批校验随之扩展：实体字段白名单与值形状（阶段 A）、场景/对白结构化引用的实体存在性与引用类型（跨类型误绑拒绝，阶段 B 按含批次 ref 的投影校验），无效整批拒绝；预览确认后按当前项目状态重校验再执行，用户在预览后的实体改动由此被发现。实体改动与节点绑定折叠为**一个复合命令**：一步撤销/重做同时恢复设定集与画布两侧，未参与编辑的 props/documents 透传保真。**边界**：不开放 AI 删除/合并实体，不开放道具编辑——模型应说明边界并可提供文本草稿由用户手动录入，不得创建分镜卡/场景卡冒充设定档案。
- **设定文档读写通道（issue 56，已实现）**：`upsert_document` 落地 §9.3 的文档命令语义，文档字段协议（title/body/relatedIds）同样由 `ai/entityFields.ts` 单一来源生成（三处共用）。左栏设定集提供文档查看/编辑 UI（§5，ui-design）；AI 侧正文**不进画布快照与校验快照**——`get_settings_snapshot` 的 documents 只列 id 与标题，全文经新读工具 `get_document` 按 id 按需读取，避免长文本膨胀上下文。批次内规则：新建不带 entityId（fields.title 必填）、修改必须以 entityId 精确指向既有文档，fields 只写要改的字段（body 整体替换，未提及字段保持不变）；`relatedIds` 为 kind+id 显式成对（§6），id 可填既有实体 id 或本批实体 ref（执行期解析为真实 id），存在性与引用类型在阶段 B 按投影校验，解析后 (kind, id) 重复即拒绝；指向不存在实体整批拒绝。文档改动与节点/实体改动折叠为同一复合命令：一步撤销/重做同时恢复，未参与编辑的文档与 props 透传保真；带文档命令的待执行卡随会话落盘，恢复后按当前设定集重校验。**边界**：不开放 AI 删除文档；道具编辑与 AI 删除/合并实体仍是上述 issue 44 边界。
- **快照摘要而非全量**：大项目全量 JSON 会超出上下文，默认只给压缩视图（节点 id/type/label/连接关系），详情由模型用读工具按需拉取。对白分别统计 `line` 台词句数与 `action` 旁白/动作条数（[issue #73](https://github.com/hailingu/PlotWeave/issues/73)），纯旁白节点不再只显示「0 句」。摘要不包含全文，同条数的内容编辑仍须通过 `get_node` 获取，续写或替换前应先读取目标详情。
- **自由文本写入体积预算（[issue #170](https://github.com/hailingu/PlotWeave/issues/170)，已实现）**：AI 可写自由文本按字段分级设上限——普通自由文本字段（节点 name/synopsis/picture/prompt/tone/time/weather/size、lines[].text、options[].label、refs[].label 自由文案、实体 name/bio/note、文档 title）≤ 65,536 字符；设定文档 body 因「长篇正文」定位放宽至 ≤ 1,048,576 字符（对齐文件级 1 MiB 先例）。字符数按 Unicode 码点计（与 JSON Schema `maxLength` 同口径，星号平面字符不双计；计数不物化码点数组）。预算常量在 `ai/textBudget.ts` 单点维护：入站校验（patchShape/entityFold）按域整批拒绝并回喂点名字段与实际字数的诊断，**不自行截断用户内容**；工具 schema 经协议表 `maxLength` 向模型广告同一预算（广告是输出协议，校验边界仍是权威执行点；实体 name 的通道化 schema 重建在生成形状上叠加 pattern/文案，不得替换丢预算；列表成员 id 是身份 token 而非自由文本，不背预算——运行态按非空白唯一保留既有超长 id，广告不得严于边界）。单批总体积不另设预算——模型工具调用参数随对话响应体受 §10.3 的 16 MiB 上限兜底；本预算管单字段/单成员的病态极值（审计探针曾实测 2 MiB synopsis 被原样接受）。上限内既有内容（含旧项目中超预算的既有文本）不受影响——预算只约束 AI 写入边界，加载归一化不以此拒绝或截断。
- **调用路径**：前端驱动循环；LLM 请求经 Rust command `llm_chat` 代理发出——API key 以密文随 settings 落盘、在 Rust 内存解密，前端不持有明文，同时绕开 webview 的 CORS 限制。
- **无批次的交付收敛（[issue #75](https://github.com/hailingu/PlotWeave/issues/75)、[issue #91](https://github.com/hailingu/PlotWeave/issues/91)，已实现）**：`runAgentLoop` 在追加内部反馈之前读取本轮用户输入识别预览需求。识别分两层（#91，query 改写替代开放动词的手工词表）：输入已含规范动作动词时直接按本地词表判定（明确暂不操作仍被讨论词表否决，如「先别修改节点」）；其余输入一律先经一次轻量 query 改写调用（`ai/queryRewrite.ts`）判定——讨论/否定片段不否决改写，否定辖域（「不要解释，直接扩写」）与「特别」这类偶发子串由改写调用判别（PR #92 评审）。改写只决定是否进入交付检查，不解析命令、不授予执行权限，回复为结构化 JSON（`{"action":true,"query":"…"}` / `{"action":false}`）并按整回复校验、query 须以规范动词开头（与词表同源）才采信，分类标记、解释文字、非动词开头或坏 JSON 一律按非动作回退（PR #92 评审），失败或非动作回退本地词表结果，回合照常进行且不计入读写预算；调用带独立 8 秒短超时，超时即回退、迟到结果丢弃、不阻塞主回合（PR #92 评审第四轮）；明确暂不操作由改写判为非动作（action:false）回退承担。模型已尝试工具／围栏批次或声称提供预览（含「确认后预览会展示……」式确认门控承诺，#91；谓词紧邻辖域内的否定式描述如「确认后预览不会显示」不构成承诺，而谓词外否定如「不会丢失原对白，预览会显示」不影响承诺，PR #92 评审）时，也进入交付检查，且该期待在本轮后续重试中保持。无可用批次、空批次、工具参数解析失败与既有校验失败共享首次产出 + 3 次纠正预算，最多另有 3 轮读取；混合调用中的读取也计入读取预算，耗尽后回喂限制原因，不继续执行读工具。任一工具解析错误会整批拒绝，不从其余工具或围栏中提取合法子集供执行。同轮读调用与合法围栏批次共存时保留批次预览。无批次耗尽以 `completionError` 返回明确诊断，展示侧附入所属助手正文并随原有会话文本持久化，无需改变会话 schema；已有校验失败保留不可执行的错误预览卡。助手正文回显的 `[应用批次记录]` JSON（含围栏包裹）不含 `commands` 数组，不构成批次、不产生预览卡，也不能把无批次回复当作成功交付（#91）；正文状态摘要不是命令，执行仅经预览卡确认。纠正指令允许信息不足时澄清或说明功能边界，不从自然语言或正文状态摘要猜测命令或目标。普通讨论、历史批次恢复及确认执行流程不因此自动写入。状态矩阵、验证范围及自然语言识别边界见 [UI 设计 §6.1](ui-design.md)。
- **可控性**：Agent 的写操作执行前弹批量预览（涉及哪些节点、什么变更），用户确认后才进命令通道；undo 始终兜底。
- **会话生命周期（[issue #47](https://github.com/hailingu/PlotWeave/issues/47)、[PR #57](https://github.com/hailingu/PlotWeave/pull/57)，已实现）**：切换检查器或折叠面板保持会话，重开从主文件恢复。失败会话在项目视图之外保留；加载等待共享保存链后优先采用该进程内快照，重开时提示并尝试保存。成功清除项目级错误与保留内容；读取失败时不挂载聊天操作区，避免发送或执行产生空回退写入；进出设置页仍保持停用，重开成功后恢复。损坏诊断不触发挂载保存。只保存主文件、按需重试及退出边界见 §10.1。在途模型回合按项目身份登记于进程内注册表（[issue #63](https://github.com/hailingu/PlotWeave/issues/63)）：进出设置页或返回首页卸载编辑器期间落定的回合，由重挂载/重开同一项目的会话面板独占认领——迟到回复经当前实例重定条目 id 后入列并经同一保存通道落盘，等待期间恢复忙碌态，认领后落定前再卸载则归还待下次认领；迟到响应不写入其他项目。认领的待执行卡按当前画布重校验（与恢复会话同口径，[PR #83](https://github.com/hailingu/PlotWeave/pull/83)）：在途回合中途的读工具与校验闭包属于已卸载实例，迟到批次的原始校验结果不得作为执行预览；回复正文仍可能引用离开前的旧画布内容（在途请求无法重绑定读回调），属该边界的组成。设置页停留期间直接退出应用（不回编辑器认领）或重启进程，在途回合不恢复、迟到回复不落盘——用户消息已先行持久化，重开呈现半截对话属记录边界。
- **历史展示**：不自动执行命令；已执行卡呈现为历史改动，不承诺当前撤销栈可撤销。待执行卡按当前画布重校验并再次确认。消息 id 恢复时重定基为 1..n；模型上下文按条数和累计字符裁剪，持久化总条数另有落盘边界上限——最多 200 条，可执行待执行卡优先占用容量，其余额度保留最新历史；待执行卡自身超额也从最旧起裁剪，重开只恢复保留下来的卡（[issue #64](https://github.com/hailingu/PlotWeave/issues/64)、[PR #85](https://github.com/hailingu/PlotWeave/pull/85)，见 §10.1）；容量由 `aiSessionStore` 写入主文件时施加，进程内快照（设置页重挂载、失败保留、退出冲刷）持全量形态；加载不裁剪、旧文件全量展示，下次实际变更保存才收敛。重启不恢复网络请求 busy 或自动重发，项目切换后的迟到响应不写入新项目。
- **跨轮批次上下文（[issue #73](https://github.com/hailingu/PlotWeave/issues/73)，已实现）**：`aiThreadModel.buildMessages` 在带卡片的助手历史消息尾部附加 `[应用批次记录]` 与单行 JSON，保留 `batchId`（所属消息 id）、`status`、`commandCount`（卡片内的命令数）、`changes` 和 `omittedChanges`。状态区分 `pending`（待确认）、`validation_failed`（校验拒绝）、`execution_failed`（上次确认执行失败）、`dismissed`（已忽略）和 `executed`（曾执行成功）。校验失败可带 `issues`，执行失败可带 `executionError`；失败时不把部分已解析命令解释成合法整批。完整命令、原始工具调用与独立 `note` 不重复送入历史；状态与所属消息一同保留或裁剪，不从回执位置或旧版回执文案猜测批次归属。
- **历史成功与当前效果分离**：`executed` 一律附 `currentEffect: "unknown"`，只说明历史上执行过，不保证已保存或撤销/后续编辑后仍生效。执行尚未确认画布落盘时另带 `canvasSavePending: true`；缺少该标记也不推断保存成功。当前内容由最新画布摘要及读工具提供，系统提示限制的是本轮尚未确认的新改动，不否认历史执行事实，也不要求重放历史批次。
- **上下文与失败记录的边界**：历史最多保留最新 40 条消息、累计 48,000 字符（包含附加的批次记录；最新一条单独超界仍保留，本轮输入另计）。每批最多 6 项预览、3 项校验诊断，每项及执行错误最多 160 字符加截断标记，保持为数据摘要。持久会话继续使用 `schemaVersion: 1`，仅为 `pending` 卡片增补可选非空字符串 `executionError`，由 `AiThread` 在执行失败时记录，重试成功或忽略时清除；旧会话缺省表示没有结构化失败记录。恢复原先合法的待执行卡时复用 `toInboundCommands` 剥离内部补丁包装，再由当前画布重建校验结果，合法 `update_node` 不因包装字段被误拒绝。校验拒绝卡缺少完整原始批次，恢复时保留拒绝状态及诊断，不把空命令或兼容会话中的合法子集当作完整可执行批次；需由模型重新提出完整方案。
- **执行状态与画布一致性**：执行回执的落盘与画布持久化以**提交身份**解耦：画布文档持有 `graph.aiRevision`（已应用 AI 批次的单调计数，缺省 0；只增不减，撤销不回退），每次成功落地一批命令自增一次。批次在内存执行后，卡片先以 `pending`（附执行后计数 `aiRevisionAfter`）落盘并按回执与卡片的关联（回执追加在会话尾部，不能按位置识别）压掉该卡的回执，承载批次的画布文档确认落盘（`whenCanvasCommitted`：注册之后开始的保存成功落定，在途的旧保存不算数）后才写 `executed` 与回执——画布未持久化时重开得到可重新执行的待执行卡，而不是声称已执行的历史卡。重开时带执行后计数的待执行卡与画布内计数对账：画布计数已达该值 = 批次已随画布落盘（涵盖执行后立即离开编辑器、卸载冲刷或项目级后台重试补落盘等路径），恢复为历史执行卡；未达 = 未落盘，按当前画布重校验后仍可再次执行。计数是文档内的持久身份，普通画布编辑与未落盘编辑都不影响判定——不以「与执行前签名不同」这类推断代替。**装配约束（[issue #139](https://github.com/hailingu/PlotWeave/issues/139)，已实现）**：组件层把批次计数与 `whenCanvasCommitted` 收成单一嵌套的提交身份对象（叶子契约模块 `ai/commitIdentity.ts` 的 `AiCommitIdentity`）下传——计数必带、画布确认等待器可选，「等待器存在而计数缺失」的误配在类型层不可表达，带等待器的装配执行成功必然产出携带 `aiRevisionAfter` 的未确认卡；无持久化的隔离测试装配省略整组对象，执行成功立即 `executed`（恢复对账只消费计数，不需要等待器）。

### 12.3 MCP 暴露（可选，后置）

同一套工具可经 MCP server（Rust 侧实现，stdio/HTTP）暴露给外部 LLM 客户端，让外部 Agent 操作画布。因为工具即命令，MCP 只是命令通道的第二个入口，边际成本低；但它依赖用户自行运行外部客户端，属于高级玩法，不替代产品内 Agent。触发条件：有明确的「在外部 Agent 工作流中编排 PlotWeave」需求时再做。

## 十三、后续演进预留

以下方向发生时需要修订本文档或另起文档：

- **画布内 AI 生成**（文生图/AI 编剧）：新增媒体节点类型（图片节点、视频节点，如角色立绘、场景概念图），建模遵循三分原则——**引用类输入走边**（如图生视频的立绘引用），**参数类配置走 `spec.params`**（尺寸/时长/seed），**操作类型由 `spec.operation` + 输入证据推断**（有参考图 → 图生图，无需用户显式选择）；产物是 `outputs` 里的 AssetRef 槽位（`primary` / `poster` / `preview`，附宽高、时长等 metadata）。节点的 prompt、模型选择作为 `data.spec` 字段随 `project.json` 持久化，无需额外存储；需要新增的是 job 状态机（落盘 + 启动恢复）与输入签名（防旧结果覆盖新编辑），进程内以 tokio task + 取消令牌实现。
  - **落地状态（2026-09-04，首片）**：文生图已上线——图片节点 `image`（§4.2 ImageSpec：prompt/model/size + `outputs.primary`）经 `llm_image_generate` 代理产出 `source=generated` 项目资产，以**复合命令**写回（资产入索引与 `outputs` 同栈撤销/重做，§7.3 库资产导入同构）；输入签名守护（prompt/model/size 规范化元组）与协作式取消（`llm_image_cancel` 取消标志 + 检查点放弃）为进程内实现，发起端同步占位作业表（设置加载的异步间隙内双击不重复发起计费请求）；取消请求的 IPC 拒绝不再静默（[issue #160](https://github.com/hailingu/PlotWeave/issues/160)）：用户取消失败仅在该取消请求仍拥有节点诊断归属时转入作业错误态（文案明示远端生成可能继续并计费、结果到达时仍按取消语义丢弃）。宿主节点删除时清除其全部作业状态（包括已落定的取消、生成、设置加载或计划解析错误），仅对 running 作业发送取消请求；撤销删除不恢复旧诊断，重新生成可正常落位（[PR #200 后续审查](https://github.com/hailingu/PlotWeave/pull/200#discussion_r4044155985)）。同节点启动后续作业、宿主节点删除或编辑器卸载即撤销旧请求的诊断归属；后续作业即使已完成、失败或再次取消，旧取消响应也不能覆盖其状态。已失效请求及卸载/宿主删除触发的取消失败均经控制台留痕定位 jobId，不产生未处理拒绝；迟到生成产物仍经 jobAlive 丢弃（[PR #200 审查修复](https://github.com/hailingu/PlotWeave/pull/200#discussion_r4042402798)）。作业生命周期 = **编辑器挂载期**：不跨重启持久化（重启即丢失进行中作业，产物本身已落盘），亦不跨编辑器卸载——打开设置页 / 返回首页卸载编辑器时即对全部进行中作业发协作式取消（检查点放弃，防孤儿媒体与卸载后写回）；跨界面保留随「job 落盘与启动恢复」演进一并解决。**仍属演进**：图生图（引用输入走边与 `spec.operation` 推断）、视频节点、job 落盘与启动恢复、宽高/时长 metadata 回填、§10.3 目录化模型清单。
- **多端同步/协作/官方代付**：另起《服务端领域模型》文档；`schemaVersion` 迁移机制届时成为前后端契约的一部分。
- **跨项目搜索、资产去重**：评估 SQLite 索引层。
