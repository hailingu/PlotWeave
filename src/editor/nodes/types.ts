import type { Node } from '@xyflow/react'

/**
 * 画布节点数据模型（docs/ui-design.md §4.2 节点形态）。
 * 分族对齐生产管线「节奏卡 → 索引卡 → 剧本 → 分镜 → AI 燃料 → 渲染」：
 * 编剧侧（纸面浅色）= 节奏卡 / 索引卡 / 对白 / 分支；
 * 生成侧（深色石板）= 分镜卡，未来的渲染节点同族。
 * 首版为画布内存态结构，字段名对齐《数据模型设计》的 spec/meta 拆分；
 * 落盘时经 src/model/convert.ts 转换为 ProjectDocument（四分区信封）。
 */

/** 角色头像的派生视图：label 为单字名，gradient 为设定集头像配色的占位渐变。 */
export interface NodeAvatar {
  label: string
  gradient: string
}

/**
 * 场景节点（索引卡）：卡片分区对应索引卡字段。
 * 引用一律存设定集实体 id（§5 改名不断引用），渲染时经 ProjectSettings 解析；
 * 实体被删时按「失效引用」展示（§4.3），不自动清除。
 */
export interface SceneNodeData extends Record<string, unknown> {
  name: string
  /** 剧本场景头编号，展示为 SCENE 03。 */
  sceneNo: number
  /** 内景/外景徽标。 */
  interior: boolean
  /** 地点实体 id（设定集地点）。 */
  locationId?: string
  time: string
  weather?: string
  synopsis: string
  /** 在场角色实体 id 列表（设定集角色）。 */
  characterIds: string[]
  /** 集归属（§3.5 大纲分组的唯一依据；不建「集」实体表）。 */
  episodeNo?: number
}

/** 对白的一行：角色台词（带说话人与左右侧）或居中动作行。
 * id 为稳定标识（S6479：列表渲染/编辑的 key 不用数组下标）。 */
export interface DialogueLine {
  id: string
  kind: 'line' | 'action'
  text: string
  /** kind = line 时的说话人实体 id（设定集角色）；左右交替由 side 决定。 */
  speaker?: string
  side?: 'left' | 'right'
  /** 画外音标记（VO 徽标）。 */
  vo?: boolean
}

/** 对白节点（气泡流）：标题统计由 lines 派生（n 人 · m 句）。 */
export interface DialogueNodeData extends Record<string, unknown> {
  name: string
  lines: DialogueLine[]
  /** 集归属（§3.5）。 */
  episodeNo?: number
}

/** 节奏卡节点（节拍胶囊）：承载节奏而非内容。 */
export interface BeatNodeData extends Record<string, unknown> {
  name: string
  /** 情绪基调（emotionalTone）。 */
  tone: string
  /** 集归属（§3.5）。 */
  episodeNo?: number
}

/** 分支的一个选项：出口端口按稳定 id 定位（option-<id>），label 为胶囊文案。
 * 删选项不位移其余出口的连线归属；id 同时作列表渲染/编辑的 key（S6479）。 */
export interface BranchOption {
  id: string
  label: string
}

/** 分支节点（岔路路标）：分岔事由为问句，选项右缘各带独立出口端口。 */
export interface BranchNodeData extends Record<string, unknown> {
  prompt: string
  options: BranchOption[]
  /** 集归属（§3.5）。 */
  episodeNo?: number
}

/** 分镜卡的 AI 燃料引用位：引用位与自由位互斥（assetId / label 不共存）。
 * 引用位的唯一真相是 assetId（§8.1：只按本项目 assets.byId 解析，禁止镜像）；
 * kind 只表达垫图/底图/音频用途（character/location 限 image/* 资产，audio
 * 限 audio/* 资产）；自由位为手填文案。id 为列表项稳定标识（S6479），非引用目标。 */
export interface ShotRefBase {
  id: string
  kind: 'character' | 'location' | 'audio'
}

export type ShotRef =
  | (ShotRefBase & { assetId: string; label?: never })
  | (ShotRefBase & { label: string; assetId?: never })

/** 分镜卡节点（监视器卡，生成侧）：一张卡 = 一个镜头及其 AI 燃料。 */
export interface ShotNodeData extends Record<string, unknown> {
  /** 镜号。 */
  shotNo: number
  /** 景别（特写 / 中景 / 全景 …）。 */
  size: string
  /** 画面描述。 */
  picture: string
  /** 镜头 Prompt（AI 视频模型的直接输入）。 */
  prompt: string
  refs: ShotRef[]
}

export type SceneFlowNode = Node<SceneNodeData, 'scene'>
export type DialogueFlowNode = Node<DialogueNodeData, 'dialogue'>
export type BeatFlowNode = Node<BeatNodeData, 'beat'>
export type BranchFlowNode = Node<BranchNodeData, 'branch'>
export type ShotFlowNode = Node<ShotNodeData, 'shot'>

/** 画布节点的并集类型，供 useNodesState 使用。 */
export type CanvasNode =
  | SceneFlowNode
  | DialogueFlowNode
  | BeatFlowNode
  | BranchFlowNode
  | ShotFlowNode
