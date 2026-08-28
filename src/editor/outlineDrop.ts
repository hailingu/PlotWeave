/**
 * 大纲拖拽的落点接缝计划与边重排应用（docs/ui-design.md §3.5）。
 * 纯函数，供 EditorView.onOutlineDrop 翻译为一条可撤销命令：
 * 计划本身由 spine.ts 产出，这里负责「行落点 / 组尾落点」两种
 * 目标形态到具体锚点的换算，以及 redo/undo 两向的边集变换。
 */
import type { Edge } from '@xyflow/react'
import { buildOutlineGroups, type OutlineDropTarget } from './outline'
import { planSpliceIntoSpine, type SplicePlan } from './spine'
import type { CanvasNode } from './nodes/types'

/** 大纲拖拽的接缝计划：行落点直接锚定锚点；组尾落点从该组最后一个
 * 剧情流行向上找第一个可执行锚点。 */
export function outlineSplicePlan(
  nodes: CanvasNode[],
  edges: Edge[],
  titles: Record<number, string>,
  draggedId: string,
  target: OutlineDropTarget,
): { plan: SplicePlan; anchorId: string } | null {
  if (target.kind === 'row') {
    const plan = planSpliceIntoSpine(edges, draggedId, target.anchorId, target.position)
    return plan ? { plan, anchorId: target.anchorId } : null
  }
  const group = buildOutlineGroups(nodes, edges, titles).find((g) => g.episode === target.episode)
  const spineRows = (group?.rows ?? []).filter((r) => r.id !== draggedId && r.level < 3)
  for (let i = spineRows.length - 1; i >= 0; i--) {
    const plan = planSpliceIntoSpine(edges, draggedId, spineRows[i].id, 'after')
    if (plan) return { plan, anchorId: spineRows[i].id }
  }
  return null
}

/** 大纲拖拽的边重排应用：redo = 去旧边加新边；undo = 去新边还原旧边。 */
export function spliceEdgesWith(eds: Edge[], removed: Edge[], added: Edge[], redo: boolean): Edge[] {
  const dropIds = new Set((redo ? removed : added).map((e) => e.id))
  const kept = eds.filter((e) => !dropIds.has(e.id))
  return redo ? [...kept, ...added] : [...kept, ...removed]
}
