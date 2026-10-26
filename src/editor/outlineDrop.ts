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
import { connectionEndpointIssue, edgeKindOf } from './graphRules'

/** 大纲拖拽的接缝计划：行落点直接锚定锚点；组尾落点从该组最后一个
 * 剧情流行向上找第一个可执行锚点。 */
export function outlineSplicePlan(
  nodes: CanvasNode[],
  edges: Edge[],
  titles: Record<number, string>,
  draggedId: string,
  target: OutlineDropTarget,
): { plan: SplicePlan; anchorId: string } | null {
  const types = new Map(nodes.map((n) => [n.id, n.type]))
  // 端点契约与手绘/AI 连线一致；必须验证整份计划后才能拔出原节点（#903）。
  const planAt = (anchorId: string, position: 'before' | 'after') => {
    const plan = planSpliceIntoSpine(edges, draggedId, anchorId, position)
    return plan?.adds.every(
      (e) =>
        !connectionEndpointIssue(
          types.get(e.source),
          types.get(e.target),
          'sequence',
        ),
    )
      ? plan
      : null
  }
  if (target.kind === 'row') {
    const plan = planAt(target.anchorId, target.position)
    return plan ? { plan, anchorId: target.anchorId } : null
  }
  const group = buildOutlineGroups(nodes, edges, titles).find(
    (g) => g.episode === target.episode,
  )
  const spineRows = (group?.rows ?? []).filter(
    (r) => r.id !== draggedId && r.level < 3,
  )
  const sequenceIds = new Set(
    edges
      .filter((e) => edgeKindOf(e) === 'sequence')
      .flatMap((e) => [e.source, e.target]),
  )
  // 已在本组且无其他 sequence 成员可排序，是无操作；跨组及真实拒绝仍上浮（#904）。
  if (
    group?.rows.some((r) => r.id === draggedId) &&
    !spineRows.some((r) => sequenceIds.has(r.id))
  )
    return { plan: { removes: [], adds: [] }, anchorId: draggedId }
  // 逆序值迭代取代下标读取（issue #230）：语义与原逆向下标循环一致
  for (const row of [...spineRows].reverse()) {
    const plan = planAt(row.id, 'after')
    if (plan) return { plan, anchorId: row.id }
  }
  return null
}

/** 大纲拖拽的边重排应用：redo = 去旧边加新边；undo = 去新边还原旧边。 */
export function spliceEdgesWith(
  eds: Edge[],
  removed: Edge[],
  added: Edge[],
  redo: boolean,
): Edge[] {
  const dropIds = new Set((redo ? removed : added).map((e) => e.id))
  const kept = eds.filter((e) => !dropIds.has(e.id))
  return redo ? [...kept, ...added] : [...kept, ...removed]
}
