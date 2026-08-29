/**
 * ProjectDocument 落盘格式（docs/data-model.md v1 §3–§7）。
 * 纯 TS 类型，无框架依赖：React Flow 运行态与本格式之间的互转见 convert.ts。
 */

/** 当前文档版本；旧扁平存储格式视为 0，由 §11 迁移链升级。 */
export const CURRENT_SCHEMA_VERSION = 1

/** 画布坐标点（像素）。 */
export interface Point {
  x: number
  y: number
}

/** 视口：画布平移与缩放状态；随文档持久化，但变更不触发脏保存（transient）。 */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** 节点类型：编剧侧（节奏卡/索引卡/对白/分支）+ 生成侧（分镜卡）。 */
export type NodeType = 'scene' | 'beat' | 'dialogue' | 'branch' | 'shot'

/** 场景（索引卡）：一个时空单元的叙事容器。 */
export interface SceneSpec {
  sceneNo: number
  interior: boolean
  locationId?: string
  time?: string
  weather?: string
  synopsis: string
  characterIds: string[]
}

/** 节奏卡：场景内的情节拍点，承载节奏而非内容。 */
export interface BeatSpec {
  tone: string
}

/** 对白的一行：角色台词或居中动作行；id 为稳定标识（列表 key 不用数组下标）。 */
export interface DialogueLine {
  id: string
  kind: 'line' | 'action'
  text: string
  speaker?: string
  side?: 'left' | 'right'
  vo?: boolean
}

/** 对白节点：台词/动作行的有序列表。 */
export interface DialogueSpec {
  lines: DialogueLine[]
}

/** 分支选项：端口/胶囊渲染的唯一真相；边经 sourceHandle（option-<选项 id>）引用，
 * 删选项不位移其余出口的连线归属。 */
export interface BranchOption {
  id: string
  label: string
}

/** 分支节点 spec：分岔问句 + 选项列表。 */
export interface BranchSpec {
  prompt: string
  options: BranchOption[]
}

/** 分镜卡引用位：引用位与自由位互斥（targetId / label 不共存，§4.2）。
 * 引用位的唯一真相是 targetId（§8.1）——显示名按 id 实时解析；
 * 自由位为手填文案。落两者即镜像字段（禁止）。 */
export interface ShotRefBase {
  /** 列表项稳定标识（列表 key），非引用目标。 */
  id: string
  kind: 'character' | 'location' | 'audio'
}

export type ShotRef =
  | (ShotRefBase & { targetId: string; label?: never })
  | (ShotRefBase & { label: string; targetId?: never })

/** 分镜卡（监视器卡）：一张卡 = 一个镜头及其 AI 燃料。 */
export interface ShotSpec {
  shotNo: number
  size: string
  picture: string
  prompt: string
  refs: ShotRef[]
}

/** 节点 spec 的判别联合：形状由 StoryNode.type 决定。 */
export type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec

/** 节点 meta：标题与集归属等元信息（§4.1）。 */
export interface NodeMeta {
  /** 节点标题；分支/分镜卡省略（由 spec.prompt / spec.shotNo 派生，不落镜像字段）。 */
  label?: string
  /** 集归属（大纲分组的唯一依据；分镜卡随宿主场景）。 */
  episodeNo?: number
  /** 首版运行态不维护时间戳，落盘可省略；保留字段为演进占位。 */
  createdAt?: string
  updatedAt?: string
}

/** 画布节点：叙事单元，四分区（layout/ui/spec/meta）。 */
export interface StoryNode {
  id: string
  type: NodeType
  /** 渲染布局：位置必填，尺寸/层级可选。 */
  layout: {
    position: Point
    size?: { width: number; height: number }
    zIndex?: number
  }
  /** 会话态，加载时重置（§11.2）。 */
  ui: {
    selected: boolean
    /** 首版节点无折叠形态，恒 true；保留字段为演进占位。 */
    expanded: boolean
  }
  data: {
    spec: NodeSpec
    meta: NodeMeta
  }
}

/** 剧情连线：按 data.kind 判别的三种变体（§5）。
 * branch 变体必须携带 sourceHandle（option-<选项 id>）——边上无镜像 label 后
 * 胶囊文案的唯一解析依据，缺句柄的 branch 边非法（归一化按孤儿边隔离）。 */
interface EdgeBase {
  id: string
  source: string
  target: string
  targetHandle?: string
}

export interface SequenceEdge extends EdgeBase {
  sourceHandle?: string
  data: { kind: 'sequence'; order?: number }
}

export interface BranchEdge extends EdgeBase {
  /** 必填：option-<选项 id>。 */
  sourceHandle: string
  data: { kind: 'branch'; order?: number }
}

export interface AttachEdge extends EdgeBase {
  /** 索引卡底部端口 shots。 */
  sourceHandle?: string
  data: { kind: 'attach'; order?: number }
}

export type StoryEdge = SequenceEdge | BranchEdge | AttachEdge

/** 设定集实体：节点只存 id 引用，改一处全部引用同时生效。 */
export interface Character {
  id: string
  name: string
  /** 头像配色渐变（设定集头像与节点头像串共用）。 */
  gradient: string
  /** 一句小传。 */
  bio?: string
  /** 引用 assets.byId（项目资产落地后启用）。 */
  avatarAssetId?: string
}

/** 地点实体：节点按 id 引用。 */
export interface Location {
  id: string
  name: string
  note?: string
}

/** 道具实体：节点按 id 引用。 */
export interface PropItem {
  id: string
  name: string
  description?: string
}

/** 设定文档条目：长篇自由文本（人物小传/世界观/术语表，§6），
 * 持久化于 settings.documents；与结构化条目双向关联。 */
export interface SettingsDocument {
  id: string
  title: string
  body: string
  /** 关联的 Character / Location id。 */
  relatedIds: string[]
}

/** 资产引用：媒体本体是文件，文档只存引用（§7.1）。 */
export interface AssetRef {
  id: string
  relPath: string
  mime: string
  source: 'upload' | 'generated'
  createdAt: string
}

/** 项目文档：画布数据的序列化真源（单文件 project.json）。 */
export interface ProjectDocument {
  schemaVersion: number
  project: {
    id: string
    name: string
    description?: string
    createdAt: string
    updatedAt: string
  }
  graph: {
    nodes: StoryNode[]
    edges: StoryEdge[]
    /** 视口随文档持久化；缺省 = 从未保存过视口（打开时 fitView），字段可省略。 */
    viewport?: Viewport
  }
  settings: {
    characters: Record<string, Character>
    locations: Record<string, Location>
    props: Record<string, PropItem>
    /** 长篇自由文本条目（§6）；编辑器首版只透传不编辑。 */
    documents: Record<string, SettingsDocument>
  }
  /** 集标题表：键 = 集号（不建「集」实体表）。 */
  episodeTitles: Record<number, string>
  assets: {
    byId: Record<string, AssetRef>
  }
}
