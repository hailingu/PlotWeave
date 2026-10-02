/** 选中节点的几何对齐：只计算位置，节点内容、连线与未选中节点保持原状。 */
import type { XYPosition } from '@xyflow/react'
import { hasUsableSize } from './autoLayout'
import type { CanvasNode } from './nodes/types'

/** 画布点阵与拖动吸附共用的画布单位间距。 */
export const CANVAS_GRID_SIZE = 22

/** 对齐选中包围盒的边缘或中心；水平动作只改 x，垂直动作只改 y。 */
export type CanvasAlignment =
  'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

/** 各动作的轴与包围盒锚点；同一比例同时用于整体和单节点边缘。 */
const ALIGNMENTS: Record<CanvasAlignment, { axis: 'x' | 'y'; anchor: number }> =
  {
    left: { axis: 'x', anchor: 0 },
    center: { axis: 'x', anchor: 0.5 },
    right: { axis: 'x', anchor: 1 },
    top: { axis: 'y', anchor: 0 },
    middle: { axis: 'y', anchor: 0.5 },
    bottom: { axis: 'y', anchor: 1 },
  }

/** 与自动排布使用同一尺寸优先级；调用前 hasUsableSize 已保证回退存在。 */
function dimensionOf(node: CanvasNode, axis: 'x' | 'y'): number {
  const dimension = axis === 'x' ? 'width' : 'height'
  const measured = node.measured?.[dimension]
  return measured !== undefined && Number.isFinite(measured) && measured > 0
    ? measured
    : (node[dimension] ?? 0) // hasUsableSize 已证明尺寸存在，0 仅消解类型缺失分支。
}

/** 返回有实际位移的选中节点；尺寸未就绪或位置非法时拒绝整批以便安全重试。 */
export function computeCanvasAlignment(
  nodes: CanvasNode[],
  alignment: CanvasAlignment,
): Map<string, XYPosition> {
  const selected = nodes.filter((node) => node.selected)
  const result = new Map<string, XYPosition>()
  if (selected.length < 2) return result
  if (!selected.every(hasUsableSize)) {
    throw new Error('部分选中节点尚未完成尺寸测量，请稍后重试')
  }
  const { axis, anchor } = ALIGNMENTS[alignment]
  const starts = selected.map((node) => node.position[axis])
  const ends = selected.map(
    (node) => node.position[axis] + dimensionOf(node, axis),
  )
  const min = Math.min(...starts)
  const max = Math.max(...ends)
  const target = min * (1 - anchor) + max * anchor
  for (const node of selected) {
    const coordinate = target - dimensionOf(node, axis) * anchor
    if (!Number.isFinite(coordinate))
      throw new Error('选中节点位置超出可对齐范围')
    if (coordinate !== node.position[axis]) {
      result.set(node.id, { ...node.position, [axis]: coordinate })
    }
  }
  return result
}
