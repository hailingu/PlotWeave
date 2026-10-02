import type { Node } from '@xyflow/react'
import type {
  BeatSessionData,
  BranchSessionData,
  DialogueSessionData,
  ImageSessionData,
  NodeMetaPassthrough,
  SceneSessionData,
  ShotSessionData,
} from '../../model/session'
import type { DialogueLine } from '../../model/document'

/**
 * 画布节点数据模型（docs/ui-design.md §4.2 节点形态）。
 * 分族对齐生产管线「节奏卡 → 索引卡 → 剧本 → 分镜 → AI 燃料 → 渲染」：
 * 编剧侧（纸面浅色）= 节奏卡 / 索引卡 / 对白 / 分支；
 * 生成侧（深色石板）= 分镜卡，未来的渲染节点同族。
 *
 * 类型所有权（issue #353 方向一）：data 形状由磁盘格式所有者 src/model/
 * 以最小接口定义（session.ts 的 *SessionData，索引签名对齐 React Flow
 * `Node<Data extends Record<string, unknown>>` 泛型约束，issue 16），
 * 本模块按节点类型继承为运行态别名并与 React Flow 组合——结构兼容而非
 * 反向引用；data↔文档 spec 的互转按类型构造于 src/model/serialize.ts，
 * 宽 cast 只允许出现在 serialize/normalize 边界模块。补丁路径仍使用
 * nodes/patch.ts 的 PatchShape（剥离索引签名）判别化收口。
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
 * 各 *NodeData 为 model/session *SessionData 的运行态别名——形状单点在
 * 模型层（索引签名满足 React Flow 泛型约束），此处仅固定命名。
 */
export type SceneNodeData = SceneSessionData

/** 对白节点（气泡流）：标题统计由 lines 派生（n 人 · m 句）。 */
export type DialogueNodeData = DialogueSessionData

/** 节奏卡节点（节拍胶囊）：承载节奏而非内容。 */
export type BeatNodeData = BeatSessionData

/** 分支节点（岔路路标）：分岔事由为问句，选项右缘各带独立出口端口。 */
export type BranchNodeData = BranchSessionData

/** 分镜卡节点（监视器卡，生成侧）：一张卡 = 一个镜头及其 AI 燃料。 */
export type ShotNodeData = ShotSessionData

/** 图片节点（生成侧媒体节点，§13 文生图首版）。 */
export type ImageNodeData = ImageSessionData

export type {
  /** 对白的一行（领域形状单点在 model/document，issue #353）。 */
  DialogueLine,
  /** 分支选项（领域形状单点在 model/document）。 */
  BranchOption,
  /** 分镜引用位基形状。 */
  ShotRefBase,
  /** 分镜引用位判别联合（引用位/自由位互斥）。 */
  ShotRef,
  /** 生成产物引用（与落盘 document.GeneratedOutput 同型）。 */
  GeneratedOutput,
} from '../../model/document'

/** 行级补丁形状（issue #231 合法清除通道）：允许对可选字段显式
 * undefined——kind 切换清空 speaker/side、说话人选择清空 speaker；合并为
 * 逐键覆盖，序列化剥离 undefined 键。领域形状 DialogueLine 本身不放宽。 */
export type LinePatch = {
  [K in keyof DialogueLine]?: DialogueLine[K] | undefined
}

/** 各节点形态的 React Flow 别名：为 useNodesState 等泛型上下文钉住
 * Node<Data, Type> 的精确组合，避免在各消费点重复展开联合。 */
export type SceneFlowNode = Node<SceneNodeData, 'scene'>
/** 对白节点的 React Flow 别名（组语义见上方共享注释）。 */
export type DialogueFlowNode = Node<DialogueNodeData, 'dialogue'>
/** 节拍节点的 React Flow 别名（同上）。 */
export type BeatFlowNode = Node<BeatNodeData, 'beat'>
/** 分支节点的 React Flow 别名（同上）。 */
export type BranchFlowNode = Node<BranchNodeData, 'branch'>
/** 分镜卡节点的 React Flow 别名（同上）。 */
export type ShotFlowNode = Node<ShotNodeData, 'shot'>
/** 图片节点的 React Flow 别名（同上）。 */
export type ImageFlowNode = Node<ImageNodeData, 'image'>

export type {
  /** 落盘 meta 时间戳透传（§4.1 演进占位；单点在 model/session）。 */
  NodeMetaPassthrough,
} from '../../model/session'

/** 画布节点的并集类型，供 useNodesState 使用。 */
export type CanvasNode = (
  | SceneFlowNode
  | DialogueFlowNode
  | BeatFlowNode
  | BranchFlowNode
  | ShotFlowNode
  | ImageFlowNode
) &
  NodeMetaPassthrough
