/**
 * ProjectDocument 落盘格式（docs/data-model.md v1 §3–§7）。
 * 纯 TS 类型，无框架依赖：React Flow 运行态与本格式之间的互转见 convert.ts。
 */

/** 当前文档版本；旧扁平存储格式视为 0，由 §11 迁移链升级。 */
export const CURRENT_SCHEMA_VERSION = 1

export interface Point {
  x: number
  y: number
}

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

export interface DialogueSpec {
  lines: DialogueLine[]
}

/** 分支选项：端口/胶囊渲染的唯一真相；边经 sourceHandle（option-N）引用下标。 */
export interface BranchOption {
  id: string
  label: string
}

export interface BranchSpec {
  prompt: string
  options: BranchOption[]
}

/** 分镜卡引用位：首版为缩略 chip 占位，项目资产落地后升级为 AssetRef 引用。 */
export interface ShotRef {
  id: string
  kind: 'character' | 'location' | 'audio'
  label: string
}

/** 分镜卡（监视器卡）：一张卡 = 一个镜头及其 AI 燃料。 */
export interface ShotSpec {
  shotNo: number
  size: string
  picture: string
  prompt: string
  refs: ShotRef[]
}

export type NodeSpec = SceneSpec | BeatSpec | DialogueSpec | BranchSpec | ShotSpec

/** 画布节点：叙事单元，四分区（layout/ui/spec/meta）。 */
export interface StoryNode {
  id: string
  type: NodeType
  layout: {
    position: Point
    size?: { width: number; height: number }
    zIndex?: number
  }
  /** 会话态，加载时重置（§11.2）。 */
  ui: {
    selected: boolean
    expanded: boolean
  }
  data: {
    spec: NodeSpec
    meta: {
      /** 节点标题；分支/分镜卡省略（由 spec.prompt / spec.shotNo 派生，不落镜像字段）。 */
      label?: string
      episodeNo?: number
      createdAt?: string
      updatedAt?: string
    }
  }
}

/** 剧情连线：顺序流 / 分支流 / 派生从属。 */
export interface StoryEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data: {
    kind: 'sequence' | 'branch' | 'attach'
    order?: number
  }
}

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

export interface Location {
  id: string
  name: string
  note?: string
}

export interface PropItem {
  id: string
  name: string
  description?: string
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
    viewport: Viewport
  }
  settings: {
    characters: Record<string, Character>
    locations: Record<string, Location>
    props: Record<string, PropItem>
  }
  /** 集标题表：键 = 集号（不建「集」实体表）。 */
  episodeTitles: Record<number, string>
  assets: {
    byId: Record<string, AssetRef>
  }
}
