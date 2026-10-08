import type { EdgeTypes, NodeTypes } from '@xyflow/react'
import { SceneNode } from './nodes/SceneNode'
import { DialogueNode } from './nodes/DialogueNode'
import { BeatNode } from './nodes/BeatNode'
import { BranchNode } from './nodes/BranchNode'
import { ShotNode } from './nodes/ShotNode'
import { ImageNode } from './nodes/ImageNode'
import { BranchEdge } from './edges/BranchEdge'

/**
 * 画布渲染注册的单一来源（docs/ui-design.md §4.2/§13）：编辑器画布
 * （EditorCanvasRegion）与原生外壳的画布演示页（src/editor/nativeCanvas，P1
 * 视觉首片）共用同一份节点/连线注册与背景网格参数——新增节点类型只在
 * 此登记，两端同时可见，避免演示页漂移出第二套注册表。
 */

/** 画布节点类型注册：索引卡 / 对白 / 节奏卡 / 分支 / 分镜卡 / 图片节点。 */
export const canvasNodeTypes: NodeTypes = {
  scene: SceneNode,
  dialogue: DialogueNode,
  beat: BeatNode,
  branch: BranchNode,
  shot: ShotNode,
  image: ImageNode,
}

/** 连线类型注册：branch = 中性曲线 + 选项标签；sequence 用默认贝塞尔加样式类。 */
export const canvasEdgeTypes: EdgeTypes = {
  branch: BranchEdge,
}

/** 背景点阵间距（像素），与画布网格视觉密度一致。 */
export { CANVAS_GRID_SIZE as CANVAS_DOT_GAP } from './canvasAlignment'
