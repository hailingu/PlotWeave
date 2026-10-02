# 数据模型：图模型

[返回数据模型索引](README.md) · 相关主题：[设定与引用](settings-and-references.md)、[资产](assets.md)

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
