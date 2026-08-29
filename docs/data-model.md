# PlotWeave 数据模型设计

> 状态：v1（2026-08-28 定稿）
> 本版相对草案的修订：ProjectDocument 补 `episodeTitles` 字段；§4.2 各 spec 字段对齐 UI 设计已实现的节点形态（场景卡 sceneNo/interior/weather、对白行 kind/side/vo、分支 options 入 spec）；§5 分支边不再持久化 label 拷贝；§6 Character/Location 字段对齐运行态实体（gradient/bio/note，长篇自由文本由 SettingsDocument 承载）；§11 明确归一化管线位于前端模型层，并登记 schemaVersion 0（旧扁平存储格式）→ 1 的迁移。
>
> 定稿评审修订（2026-08-29）：§9 补 `set_episode_title` 命令（集标题变更走命令通道）；`settings.documents` 补为 SettingsDocument 的持久化位置；§10.5 `load_project` 职责更正为信封级兼容（与 §11 分层一致）；分支边 `sourceHandle` 由数组下标（option-N）改为稳定选项 id（option-\<id\>），删除选项连带其连线进同一 `batch`，杜绝下标位移导致的静默改接。
>
> 二轮评审修订（2026-08-29）：§11.1 迁移链首环写明「补选项稳定 id → 改写旧式下标句柄 → 孤儿边隔离」的先后依赖（P1）；§9 设定文档命令显式化为 `upsert_document` / `delete_document`（含 inverse 捕获）；docs/ui-design.md §10 对照清单标记全部落地。
>
> 三轮评审修订（2026-08-29）：§9.3 inverse 改为 InverseCommand 判别联合，捕获表补 inverse.type 列；ui-design §4.2 端口描述收口 option-\<id\>。
>
> 四轮评审修订（2026-08-29）：§4.2 ShotRef 契约改为 targetId 引用目标（§8.1 单一真相，显示名实时解析），label 降级为自由引用位兜底；ui-design §4.3 分支改名路由更正为 `update_node_spec`（标题由 spec.prompt 派生，不落 meta.label 镜像）。
>
> 五轮评审修订（2026-08-29）：§9.3 `connect_edge` 负载说明去掉 label（分支胶囊文案按 sourceHandle 派生）；ui-design §4.2 引用位描述统一为 `spec.refs`（删去不存在的 spec.params）；§7.3 写明项目复制的资产携带规则（索引随文档走，整目录拷贝随 §7.1 落地）。
>
> 六轮评审修订（2026-08-29）：§4.2 ShotRef 改为引用位/自由位互斥判别联合（targetId 与 label 不共存，迁移不得残留旧 label）；§9.3 命令信封改为判别相关的 GraphCommand，type 与 patch 异型组合在类型层不可表示；ui-design §4.2 节奏卡字段名对齐 `tone`、§7.4 集持久化改为已定稿的 episodeTitles。
>
> 七轮评审修订（2026-08-29）：ShotRef 对侧成员补 never 禁写（混写形状彻底不可表示）；GraphCommand 收敛为单一判别联合名（GraphCommandOf\<K\> 供已知类型提取）；§9 补 `rename_project` 命令（payload + inverse 捕获旧名）；ui-design §4.3 注明分镜卡无内联改名（镜号标题由 spec.shotNo 派生，面板内编辑）。
>
> 八轮评审修订（2026-08-29）：§11.1 迁移链首环补第三步——旧式边判别字段（type/className）改写为显式 data.kind；§9.3 batch.commands 放宽为 `Array<GraphCommand | InverseCommand>`（batch 的 undo 是子命令 inverse 的逆序数组，须可赋值）；§10.5 `save_project` 索引同步扩为 name/updatedAt（rename_project 的索引一致性在此发生）。
>
> 九轮评审修订（2026-08-29）：§11.1 首环改写步骤补全——③ 明确删除镜像的 data.optionLabel（改写后按稳定句柄重新派生）、④ 节点结构转换（旧 React Flow 形状拆入四分区，未转换不得 stamped 为 v1）；ui-design §3.2 项目卡片的分集信息数据源改为已定稿的 episodeTitles/episodeNo，卡片展示归 UI 迭代项。
>
> 十轮评审修订（2026-08-29）：§11.1 首环补 ⑤ 信封装配——文档级映射（name/updated_at/节点边上移/settings 数组键化）与缺省回退（id 回填、createdAt 同刻、viewport 不伪造、props/documents/assets 空桶）明文化，Rust `wrap_legacy` 与前端 `serializeProject` 的分工注记。
>
> 十一轮评审修订（2026-08-29）：§3 `graph.viewport` 改为可选字段（缺省 = 从未保存过视口，打开 fitView——与迁移装配及实现一致，v0 迁移件不再结构性无效）；§7.3 项目复制明文要求替换 `project.id`（持久化层强制 id = 目标路径 id）并取新创建时间；ui-design §4.2/§4.3 场景面板补内外景（interior）/天气（weather）两个用户可编辑字段。
>
> 十二轮评审修订（2026-08-29）：§5 StoryEdge 改为按 kind 判别的三变体联合，branch 变体必填 `sourceHandle`（无镜像 label 后唯一的文案解析依据，缺句柄非法）；§8.2.2 选项级联收敛到命令层——applyCommand 内置检测被移除选项并断开其出口边，不依赖调用方拼装 batch。
>
> 十三轮评审修订（2026-08-29）：§11.1 ⑤ 信封装配补 `episodeTitles` 归一化与缺省 `{}`（v0 早于集标题功能的文件没有该字段）；§9.3 inverse 表为选项级联的 `update_node_spec` 定义 `batch` 型 inverse（旧 spec 补丁 + 被级联边的 connect_edge）；§5 `AttachEdge.sourceHandle` 收紧为必填字面量 `'shots'`（§4.3 attach 仅从该端口发起）。
>
> 十四轮评审修订（2026-08-29）：§11.1 ④ 明确 `ui.expanded` 初始化为 `true`（旧节点无该字段）；§5 补句柄保留字面量规则——`shots` 为 attach 专属，kind/句柄矛盾者命令层拒绝、归一化隔离；ui-design §4.3 节奏卡面板字段更正为「名称 + 基调」（内容即节点标题 meta.label，BeatSpec 无正文字段）。
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

文档**不**持久化会话态：撤销/重做栈、选中态（`ui.selected` 加载时重置）、拖拽中的临时位置。这些留在内存，随会话结束消失。

## 四、节点模型

### 4.1 通用结构

```ts
/** 画布节点：叙事单元（场景/桥段/对白/分支）。 */
interface StoryNode {
  id: string
  type: NodeType                     // 'scene' | 'beat' | 'dialogue' | 'branch'
  layout: {                          // 渲染布局
    position: { x: number; y: number }
    size?: { width: number; height: number }
    zIndex?: number
  }
  ui: {                              // 会话态，加载时重置
    selected: boolean
    expanded: boolean                // 首版节点无折叠形态，恒 true；保留字段为演进占位
  }
  data: {
    spec: NodeSpec                   // 用户意图，按节点类型不同（见 4.2）
    meta: {                          // 元信息
      label?: string                 // 节点标题；分支/分镜卡省略（标题由 spec.prompt / spec.shotNo 派生，不落镜像字段）
      episodeNo?: number             // 集归属（大纲分组的唯一依据；分镜卡随宿主场景，不单独分集）
      createdAt?: string             // 首版运行态不维护时间戳，落盘可省略；保留字段为演进占位
      updatedAt?: string
    }
  }
}
```

节点数据只保留四个分区：渲染布局（`layout`）、会话状态（`ui`）、用户意图（`data.spec`）、元信息（`data.meta`）。画布没有执行引擎，因此不设输入缓存、产物、运行状态等分区——没有写者的字段不进模型（原则 5）。

「集」是逻辑分类而非实体：首版集 = 编号 + 大纲行内标题，标题存文档级 `episodeTitles: Record<number, string>`（键 = 集号），不建「集」实体表。

### 4.2 各类型 spec

节点里写的一切内容——梗概、台词、以及将来 AI 生成的 prompt——都是 `spec` 的字段，随 `project.json` 持久化，无需额外存储。

```ts
type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec

/** 场景：一个时空单元的叙事容器（UI 形态 = 索引卡，字段对齐 ui-design §4.2）。 */
interface SceneSpec {
  sceneNo: number            // 剧本场景头编号，展示为 SCENE 03
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

/** 对白的一行：角色台词或居中动作行；id 为稳定标识（列表 key 不用数组下标）。 */
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
  options: Array<{ id: string; label: string }>  // id 为稳定标识；sourceHandle 按 id 定位（option-<id>），删选项不位移其他连线
}

/** 分镜卡（生成侧）：一张卡 = 一个镜头及其 AI 燃料。
 * 画布一等节点类型，经 attach 边垂直下挂在索引卡正下方（见 4.3），
 * 不参与横向剧情流；首版为结构占位，拖拽引用与渲染联动随演进评审。 */
interface ShotSpec {
  shotNo: number             // 镜号
  size: string               // 景别（特写 / 中景 / 全景…）
  picture: string            // 画面描述
  prompt: string             // 镜头 Prompt（AI 视频模型的直接输入）
  refs: ShotRef[]            // 引用位：角色垫图 / 场景底图 / 音频
}

/** 分镜卡引用位：引用位与自由位互斥（targetId / label 不共存——
 * 对侧成员以 never 禁写，混写形状在类型层不可表示）。
 * 引用位的唯一真相是 targetId（§8.1）——显示名按 id 实时解析，改名不断引用，
 * 被删按 §8.2.3 失效展示；落 label 即镜像字段（禁止，§8.1.1）。
 * 项目资产（§7.1）落地后 audio 引用目标为 assets.byId 资产 id。 */
type ShotRef =
  | { id: string; kind: 'character' | 'location' | 'audio'; targetId: string; label?: never }  // 引用位
  | { id: string; kind: 'character' | 'location' | 'audio'; label: string; targetId?: never }  // 自由位：手填文案
```

### 4.3 端口与连接

直接使用 React Flow 多 handle：

- `scene` / `beat` / `dialogue`：`input`（target）+ `output`（source）各一个。
- `branch`：一个 `input`（target）+ 多个出口 source handle（`option-<选项 id>`，动态增删；用稳定 id 而非数组下标，删除任一选项不影响其余出口的连线归属）。
- `scene`：额外带底部 source handle（`shots`），经 attach 边垂直下挂分镜卡——**横向 = 剧情顺序，垂直 = 派生从属**（一对多合法，attach 不参与剧情流环检测）。
- 连接校验在前端交互层（`isValidConnection`）做：禁止自环、禁止成环（BFS 传递闭包检查）；命令层不重复校验。

## 五、边模型

```ts
/** 剧情连线：按 data.kind 判别的三种变体。
 * branch 变体必须携带 sourceHandle（option-<选项 id>）——边上无镜像 label 后
 * 胶囊文案的唯一解析依据，缺句柄的 branch 边非法（归一化按孤儿边隔离）。 */
interface EdgeBase {
  id: string
  source: string
  target: string
  targetHandle?: string
}

interface SequenceEdge extends EdgeBase {
  sourceHandle?: string
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

- `sequence`：剧情顺序流，无 label。
- `branch`：从 branch 节点出口引出；**边上不存 label 拷贝**——胶囊文案按 `sourceHandle`（`option-<选项 id>`）解析分支节点 `spec.options` 中同 id 选项的 label 派生（§8.1.1 禁止镜像字段）；多结局用多条 branch 边指向不同子图表达。
- `attach`：索引卡底部端口 → 分镜卡顶部端口的派生从属边（垂直下挂），无 label，不参与剧情流环检测。

**句柄保留字面量**：`shots` 为 attach 变体专属（§4.3 attach 仅从索引卡底部端口发起）。`sequence`/`branch` 边携带 `shots` 句柄、或 `attach` 边携带非 `shots` 句柄，均属 kind/句柄矛盾——命令层校验拒绝，漏网者由归一化按孤儿边隔离（§11.3）。

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
  relatedIds: string[]       // 关联的 Character / Location id
}
```

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
  relPath: string            // 项目资产相对项目目录；库资产相对 library/ 目录
  mime: string
  source: 'upload' | 'generated'
  createdAt: string
}
```

### 7.2 库资产的分类与编组

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

- **分工**：`kind` 回答"是什么"，`view` 回答"哪个角度"，`groupId` 把同一主体的三视图绑成一组；`tags` 只用于前两者覆盖不了的自由维度（如「赛博朋克」「雨夜」）。能用结构化字段表达的不写成标签，避免同义标签发散。
- **迁移规则（`prop` → `wardrobe`）**：现实剧组服化道同属一个部门，旧 `prop`（道具）条目并入 `wardrobe`（服装/妆发/道具）；新增 `colorlight` 承载色彩脚本（color script）与光影氛围参考。
- **绑定方式**：分类信息写在 `library.json` 索引项里、以资产 id 为键；改标签、换组、改视角只更新索引，不动媒体文件。
- **快速读取**：`library.json` 启动时全量载入内存（桌面量级，数千条索引项仅数百 KB），列表页筛选/搜索全走内存过滤，媒体文件懒加载。规模失控时再迁 SQLite（见十三）。

### 7.3 流转规则

- **库资产进入项目 = 拷贝**：把库素材放上画布或设为角色头像时，文件拷入项目 `assets/` 并生成项目级 AssetRef（新 id）。项目不持有对库文件的引用，因此库侧可随时清理而不产生项目内的悬空引用。
- **AI 生成结果（未来接入）必须落盘后再引用**：厂商临时 URL 不得出现在文档里——临时链接会过期，直接引用会导致画布内容日后无法打开。生成结果默认落项目资产，用户可显式「收藏到资产库」。
- **延迟回收**：删除引用资产的节点/设定时不立即删文件，由后续「清理未引用资产」命令统一回收（首版可只做手动触发）。
- **项目复制 = 文档级复制**：复制件的 `project.id` 必须替换为目标项目的新 id（持久化层强制 id = 目标路径 id，禁止沿用源 id），创建时间取复制时刻；资产索引随文档原样带走（与 `avatarAssetId` 等
  引用字段保持一致解析，§8.1）；媒体文件的整目录拷贝（project.json + assets/）
  随 §7.1 项目资产落地时升级为 Rust 侧原子复制——届时复制件的 relPath 指向
  自己目录内的新文件。§7.1 落地前应用不管理媒体文件，不存在「索引在而文件不在
  自己目录」的中间态。

## 八、引用模型与联动规则

节点、设定、资产之间的引用是画布最容易出错的区域。本节定义引用的分类、唯一真相归属与联动规则。核心只有一条：**每个引用事实只存一处，其余全部是派生视图**。

### 8.1 引用类型与真相归属

| 引用类型 | 例子 | 唯一真相 | 派生物（不持久化） |
| --- | --- | --- | --- |
| 剧情流向 | 场景 → 对白 | `graph.edges` | 无 |
| 节点 → 设定 | 场景的 `characterIds` | spec 字段（id 数组） | 反向索引（「谁引用了这个角色」） |
| 文本内 @ 提及 | 对白文本里的 @角色 | 文本 token（只存 id） | 提及列表、高亮、反向索引——**不落边** |
| 节点/设定 → 资产 | 角色头像 `avatarAssetId` | assetId 字段 | 引用计数（清理未引用资产时现算） |
| 节点 → 节点输入（未来媒体节点） | 视频节点的立绘输入 | `graph.edges` | 执行输入在解析时现算，不物化镜像 |

细则：

1. **禁止镜像字段**：不设任何「引用的第二份拷贝」（如 inputs 镜像、边上冗余的引用标签副本）。派生信息需要时现算或重建，不持久化。
2. **文本 token 只存 id**：`@[character:{id}]` 形式，不存名称快照；显示名永远按 id 实时解析——改名不断引用，也无需回写任何文本。
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

### 9.1 命令结构

单写者场景无需并发基线与路径级补丁。命令信封固定为六个字段：`id` / `type` / `actor`（变更来源：用户操作或 AI Agent，用于审计与 UI 标记，见十二节）/ `patch`（正向补丁）/ `inverse`（逆向补丁，执行时自动捕获）/ `timestamp`；另有可选的 `transient` 标记（瞬时 UI 命令：不落盘、不进撤销栈）。

`patch` 的具体形状由 `type` 决定，完整定义见 9.3。

### 9.2 命令清单

| 类别 | 命令 | 说明 |
| --- | --- | --- |
| 节点 | `create_node` / `delete_node` / `move_node` / `resize_node` | delete 连带删除关联边，inverse 一并恢复 |
| 节点数据 | `update_node_spec` / `update_node_meta` / `update_node_ui` | |
| 连接 | `connect_edge` / `disconnect_edge` | |
| 设定 | `upsert_character` / `delete_character`（地点、道具同构） |
| 设定文档 | `upsert_document` / `delete_document` | | |
| 集标题 | `set_episode_title` | title 为空串 = 删除该集的标题键 |
| 项目 | `rename_project` | 改 `project.name`；name 在信任边界校验，索引同步由持久化层负责 |
| 资产 | `set_asset` / `remove_asset` | |
| 视口 | `update_viewport` | transient，不进撤销栈 |
| 批量 | `batch` | 一等命令，整批作为单个撤销单元 |

### 9.3 命令数据模型

命令创建时只携带**变更意图**（目标值）；`inverse` 不由创建者填写，而是 `applyCommand` 执行时从变更前文档（docBefore）自动捕获。这保证 undo 数据永远与文档真实旧值一致，创建者不可能填错。

```ts
type Point = { x: number; y: number }
type Size = { width: number; height: number }
type Viewport = { x: number; y: number; zoom: number }
type NodeMeta = StoryNode['data']['meta']
type NodeUi = StoryNode['ui']

/** 命令类型与负载形状的映射。 */
interface CommandPayloads {
  // ── 节点 ──
  create_node: { node: StoryNode }              // 完整节点，含初始 layout/spec/meta
  delete_node: { nodeId: string }               // inverse 捕获被删节点 + 连带边
  move_node: { nodeId: string; to: Point }
  resize_node: { nodeId: string; to: Size }
  // ── 节点数据（set 为部分对象，只写变更字段）──
  update_node_spec: { nodeId: string; set: Partial<NodeSpec> }
  update_node_meta: { nodeId: string; set: Partial<NodeMeta> }
  update_node_ui: { nodeId: string; set: Partial<NodeUi> }
  // ── 连接 ──
  connect_edge: { edge: StoryEdge }             // 完整边，含 data.kind；branch 边不落 label（胶囊文案按 sourceHandle 派生，§5）
  disconnect_edge: { edgeId: string }           // inverse 捕获被删边
  // ── 设定（地点、道具同构，略）──
  upsert_character: { character: Character }    // id 已存在 = 更新，否则 = 新增
  delete_character: { characterId: string }     // inverse 捕获被删实体
  // ── 设定文档（SettingsDocument，§6）──
  upsert_document: { document: SettingsDocument }  // id 已存在 = 更新，否则 = 新增
  delete_document: { documentId: string }          // inverse 捕获被删文档
  // ── 集标题 ──
  set_episode_title: { episodeNo: number; title: string }  // title 为空串 = 删除该键
  // ── 项目 ──
  rename_project: { name: string }
  // ── 资产 ──
  set_asset: { asset: AssetRef }
  remove_asset: { assetId: string }             // 只移除索引，不删文件（见 7.3）
  // ── 视口 ──
  update_viewport: { to: Viewport }
  // ── 批量 ──
  batch: { commands: Array<GraphCommand | InverseCommand> }  // 子命令，逆序 undo；batch 自身的 inverse = 子命令 inverse 的逆序数组（InverseCommand 形状）
}

type CommandType = keyof CommandPayloads

/** inverse 的类型安全形状：自带类型标签，patch 形状随标签走。
 * 多命令复合的 undo（如 delete_node 的连带边恢复）统一用 batch 承载。 */
type InverseCommand = {
  [K in CommandType]: { type: K; patch: CommandPayloads[K] }
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

| 命令 | inverse 内容 | inverse.type |
| --- | --- | --- |
| `create_node` | 等效 `delete_node { nodeId }` | `delete_node` |
| `delete_node` | 等效 `create_node { node }` + 每条连带边的 `connect_edge`，进同一 `batch` | `batch` |
| `move_node` / `resize_node` / `update_viewport` | 同结构，`to` 换为 docBefore 中的旧值 | 同正向 |
| `update_node_*` | 同结构，`set` 只含被覆盖字段的旧值；**例外**：触发选项级联的 `update_node_spec`（§8.2.2）→ inverse 为 `batch`——旧 spec 补丁 + 每条被级联删除边的 `connect_edge`，整体恢复 | `batch` |
| `connect_edge` / `disconnect_edge` | 互逆，边数据取自 docBefore | 对偶命令 |
| `upsert_character` | 新增 → `delete_character`；更新 → 旧实体整体 | 视新增/更新而定 |
| `delete_character` | 等效 `upsert_character { character: 旧实体 }` | `upsert_character` |
| `upsert_document` | 新增 → `delete_document`；更新 → 旧文档整体 | 视新增/更新而定 |
| `delete_document` | 等效 `upsert_document { document: 旧文档 }` | `upsert_document` |
| `set_episode_title` | 同结构，title 换为旧值；原来无该键 → inverse 为空串（即删除） | `set_episode_title` |
| `rename_project` | 同结构，name 换为 docBefore 中的旧名 | `rename_project` |
| `set_asset` / `remove_asset` | 互逆，AssetRef 取自 docBefore | 对偶命令 |
| `batch` | 子命令 inverse 的**逆序**数组，进同一 `batch` | `batch` |

### 9.4 撤销规则

- 撤销/重做栈仅存于会话，不持久化；上限 50 条。
- 拖拽中发 `move_node { transient: true }`，松手时补发一条正式命令进撤销栈。
- `update_node_ui`（选中、展开折叠）与 `update_viewport` 不进撤销栈。

## 十、本地存储体系

命令产出的文档变更，经防抖持久化回调落到以下布局。

### 10.1 目录布局

```
应用数据目录/                           # Tauri app_data_dir，禁止硬编码路径
├── projects/
│   └── {projectId}/
│       ├── project.json               # ProjectDocument
│       └── assets/                    # 项目资产（自包含）
│           ├── {assetId}.png
│           └── {assetId}.mp4
├── library/                           # 个人资产库（跨项目复用）
│   └── assets/
│       └── {assetId}.png
├── library.json                       # 库索引：assets.byId（分类/视角/标签）+ groups.byId（编组）
├── index.json                         # 项目索引：首页列表元数据（id/名称/缩略图/updatedAt）
└── settings.json                      # AppSettings：provider 配置与模型选择（不含 API key）
```

### 10.2 写入安全

单写者场景**不需要**文件锁、版本号等并发机制；但需要防崩溃截断——写到一半进程被杀、断电、磁盘满，会留下截断的 JSON，导致整个项目无法打开。因此：

- 写 `project.json.tmp`，flush 后 rename 覆盖 `project.json`（rename 原子，读者只见旧版或新版，不见半个文件）。`index.json` / `library.json` / `settings.json` 同样处理。
- 前端防抖 500ms 提交一次；失败回队重试；`flushPersist()` 在关闭窗口/切换项目前调用。

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

### 10.4 密钥管理

provider 的 API key 以**密文 `keyEnc`** 存于 provider 配置：Rust `seal` 模块 AES-256-GCM 加密（密钥 = 应用常数 + IOPlatformUUID + 随机盐，封装于 envelope），明文只在加密/请求的进程内存中出现；历史钥匙串数据保留只读回退，不再写入。

### 10.5 Rust 持久化命令（Tauri commands）

| 命令 | 职责 |
| --- | --- |
| `list_projects()` | 读 `index.json`，返回项目列表 |
| `create_project(name)` | 建目录 + 初始 `project.json` + 更新索引 |
| `load_project(projectId)` | 读 `project.json`；信封级兼容（旧扁平格式包装为 v0 信封）。节点级 schemaVersion 迁移与归一化在前端模型层（见十一），Rust 不参与 |
| `save_project(projectId, doc)` | tmp + rename 原子写 + 更新索引的 name/updatedAt（重命名后索引同步在此发生） |
| `import_asset(projectId, file)` | 拷贝入项目 `assets/`，返回 `AssetRef` |
| `list_library_assets()` | 读 `library.json`，返回资产库列表（含编组） |
| `import_library_asset(file, meta)` | 拷贝入 `library/assets/` + 更新库索引，meta 含 name/kind/view/groupId/tags |
| `update_library_asset(assetId, patch)` | 修改索引项：改名、改标签、改视角、换编组（只动索引不动文件） |
| `delete_library_asset(assetId)` | 删库文件 + 索引项（不影响已拷入项目的副本） |
| `collect_library_asset(projectId, projectAssetId, meta)` | 把项目资产拷贝入资产库（「收藏」） |
| `get_settings()` / `update_settings(patch)` | 非敏感配置读写 |
| `set_provider_key(provider, key)` | 加密并返回 envelope 密文（由前端随 settings 落盘；解密走 `seal::open`，无独立读命令） |
| `llm_chat(messages, tools)` | LLM 请求代理：key 由 settings 密文在 Rust 内存解密，绕开 webview CORS（见 12.2） |

## 十一、加载与归一化

`load_project` 返回后、交付画布前执行归一化管线，保证任何历史版本的文档都以当前形态进入会话。管线位于**前端模型层**（纯 TS，无框架依赖，与 §2 分层一致）——Rust 持久化层对节点/边结构不透明，只做信封透传与项目名/id 校验；信封级兼容（旧扁平格式缺 `schemaVersion` 时包装为 v0 信封）由 Rust 在 `load_project` 内完成。

1. `schemaVersion` 低于当前版本时按迁移链逐级升级；高于当前版本时拒绝并提示升级应用。**迁移链首环**：schemaVersion 0（首版扁平存储格式：顶层 `name`/`updated_at`/`nodes`/`edges`/`settings`/`episodeTitles`，节点数据未分区、设定集为数组）→ 1（本文档结构）。首环包含四次改写与一次信封装配，改写全部发生在孤儿边隔离之前：① 补列表项稳定 id（`branch.options` 等）；② 把分支边的旧式下标句柄（`option-0`、`option-1`…）按「下标 → 迁移后选项 id」改写为稳定 id 句柄（`option-<id>`）——必须在补 id 之后，否则旧连线会在加载时被误隔离，无法解析的越界下标原样保留，交由第 3 步隔离并警告；③ 把边的旧式运行态判别字段（`type: 'branch'`、`className: 'pw-edge-attach'/'pw-edge-sequence'`）按归类规则（§4.3 连线语义）改写为显式 `data.kind`，**并删除镜像的 `data.optionLabel`**（§5 禁止边上落 label，胶囊文案按改写后的稳定句柄重新派生）；④ 节点结构转换：旧 React Flow 形状（顶层 `position`/`selected`、类型字段平铺于 `data`）拆入四分区（`layout`/`ui`/`data.spec`/`data.meta`），`ui.selected` 重置、`ui.expanded` 初始化为 `true`（旧节点无该字段）——v0 节点未经此转换不得 stamped 为 v1。⑤ **信封装配**（文档级映射与缺省回退，经 Rust `wrap_legacy` + 前端 `serializeProject` 协作完成）：顶层 `name` → `project.name`；顶层 `updated_at`（epoch 毫秒）→ ISO 8601 → `project.updatedAt`，`createdAt` 缺省与 `updatedAt` 同刻；`project.id` 由项目文件名回填（信任边界校验）；`nodes`/`edges` 上移 `graph`，`viewport` 缺省不伪造（打开时 fitView）；`settings` 数组 → `Record<id, 实体>`（characters/locations），`props`/`documents` 补空桶；`episodeTitles` 归一化（字符串键 → 数字键、去空标题），缺省 `{}`（v0 早于集标题功能的文件没有该字段）；`assets` 补 `{ byId: {} }`。⑤ 完成前文档不得 stamped 为 v1。
2. 重置所有节点 `ui.selected = false`。
3. 隔离孤儿边（source/target 节点已不存在；branch 边的 `sourceHandle` 指向的选项已不存在同论）并记录警告——修复而非拒绝，单条坏数据不阻断加载（见 8.2.4）。
4. 标记（而非清除）悬空的设定引用与资产引用。
5. 扫描文本中的 @ 提及 token，目标已不存在的标记为失效（token 本身保留，见 8.1.2）。
6. 重建 id 生成器的计数基线，防止新 id 与存量冲突（当前 id = 类型前缀 + 时间戳 + 随机尾，天然无计数基线；本条为将来引入计数式 id 时的保留动作）。

## 十二、AI Agent 交互

用户通过对话让 AI 操作画布——创建/删除节点、修改 spec、连线、批量调整剧情结构。这一能力完全建立在第九节的命令通道上。

### 12.1 核心决策：Agent 是命令的另一个生产者

Agent 不直接触碰文档状态，只产出 `GraphCommand`（`actor: 'agent'`），经同一条 applyCommand 链路执行。由此免费获得：

- 撤销/重做天然覆盖 AI 操作，误操作一键回滚；
- 持久化、归一化、悬空引用检测不需要为 Agent 写第二套；
- `actor` 字段为审计与 UI 标记（「此改动来自 AI」）提供依据。

### 12.2 应用内 Agent（首版）

不引入 Agent 编排框架。画布操作是「读快照 → 发一批结构化命令」的低轮次任务，朴素的 tool-calling 循环足够：

```
用户对话 → [系统提示 + 画布快照摘要 + 工具 schema] → LLM（BYOK，OpenAI 兼容 tool calling）
        → 解析 tool_calls → 映射为 GraphCommand 批量执行 → 结果摘要回喂 →（需要时再一轮）
```

- **工具集 = 命令清单的封装**：读工具 `get_graph_snapshot` / `get_node`；写工具 `create_node` / `delete_node` / `update_node_spec` / `connect_edge` / `disconnect_edge` / `batch`。
- **快照摘要而非全量**：大项目全量 JSON 会超出上下文，默认只给压缩视图（节点 id/type/label/连接关系），详情由模型用读工具按需拉取。
- **调用路径**：前端驱动循环；LLM 请求经 Rust command `llm_chat` 代理发出——API key 以密文随 settings 落盘、在 Rust 内存解密，前端不持有明文，同时绕开 webview 的 CORS 限制。
- **可控性**：Agent 的写操作执行前弹批量预览（涉及哪些节点、什么变更），用户确认后才进命令通道；undo 始终兜底。

### 12.3 MCP 暴露（可选，后置）

同一套工具可经 MCP server（Rust 侧实现，stdio/HTTP）暴露给外部 LLM 客户端，让外部 Agent 操作画布。因为工具即命令，MCP 只是命令通道的第二个入口，边际成本低；但它依赖用户自行运行外部客户端，属于高级玩法，不替代产品内 Agent。触发条件：有明确的「在外部 Agent 工作流中编排 PlotWeave」需求时再做。

## 十三、后续演进预留

以下方向发生时需要修订本文档或另起文档：

- **画布内 AI 生成**（文生图/AI 编剧）：新增媒体节点类型（图片节点、视频节点，如角色立绘、场景概念图），建模遵循三分原则——**引用类输入走边**（如图生视频的立绘引用），**参数类配置走 `spec.params`**（尺寸/时长/seed），**操作类型由 `spec.operation` + 输入证据推断**（有参考图 → 图生图，无需用户显式选择）；产物是 `outputs` 里的 AssetRef 槽位（`primary` / `poster` / `preview`，附宽高、时长等 metadata）。节点的 prompt、模型选择作为 `data.spec` 字段随 `project.json` 持久化，无需额外存储；需要新增的是 job 状态机（落盘 + 启动恢复）与输入签名（防旧结果覆盖新编辑），进程内以 tokio task + 取消令牌实现。
- **多端同步/协作/官方代付**：另起《服务端领域模型》文档；`schemaVersion` 迁移机制届时成为前后端契约的一部分。
- **跨项目搜索、资产去重**：评估 SQLite 索引层。
