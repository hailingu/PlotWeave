import type { Node } from '@xyflow/react'

/**
 * 画布节点数据模型（docs/ui-design.md §4.2 四种节点形态）。
 * 首版为画布内存态占位结构，字段名对齐《数据模型设计》的 spec/meta 拆分，
 * 持久化落地时由 ProjectDocument 替换。
 */

/** 角色头像的派生视图：label 为单字名，gradient 为设定集头像配色的占位渐变。 */
export interface NodeAvatar {
  label: string
  gradient: string
}

/** 场景节点（场记板）：板面分区对应真实场记板字段。 */
export interface SceneNodeData extends Record<string, unknown> {
  name: string
  /** 剧本场景头编号，展示为 SCENE 03。 */
  sceneNo: number
  /** 分镜层入口计数，首版恒为 0 占位（§7.4）。 */
  shotCount: number
  /** 内景/外景徽标。 */
  interior: boolean
  location: string
  time: string
  weather?: string
  synopsis: string
  characters: NodeAvatar[]
}

/** 对白的一行：角色台词（带说话人与左右侧）或居中动作行。 */
export interface DialogueLine {
  kind: 'line' | 'action'
  text: string
  /** kind = line 时的说话人头像；左右交替由 side 决定。 */
  speaker?: NodeAvatar
  side?: 'left' | 'right'
  /** 画外音标记（VO 徽标）。 */
  vo?: boolean
}

/** 对白节点（气泡流）：标题统计由 lines 派生（n 人 · m 句）。 */
export interface DialogueNodeData extends Record<string, unknown> {
  name: string
  lines: DialogueLine[]
}

/** 桥段节点（节奏拍点胶囊）：承载节奏而非内容。 */
export interface BeatNodeData extends Record<string, unknown> {
  name: string
  /** 情绪基调（emotionalTone）。 */
  tone: string
}

/** 分支节点（岔路路标）：分岔事由为问句，选项右缘各带独立出口端口。 */
export interface BranchNodeData extends Record<string, unknown> {
  prompt: string
  options: string[]
}

export type SceneFlowNode = Node<SceneNodeData, 'scene'>
export type DialogueFlowNode = Node<DialogueNodeData, 'dialogue'>
export type BeatFlowNode = Node<BeatNodeData, 'beat'>
export type BranchFlowNode = Node<BranchNodeData, 'branch'>

/** 画布节点的并集类型，供 useNodesState 使用。 */
export type CanvasNode =
  | SceneFlowNode
  | DialogueFlowNode
  | BeatFlowNode
  | BranchFlowNode
