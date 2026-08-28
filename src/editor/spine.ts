import { edgeKindOf, wouldCreateCycle } from './graphRules'

/**
 * 剧情流接缝计划（docs/ui-design.md §3.5：大纲内拖拽排序 = 重排 sequence 边）。
 * 纯函数：给出拖拽节点与落点锚点，产出「删哪些边 / 加哪些边」的计划——
 * 由 EditorView 翻译为一条可撤销命令执行，本模块不触碰 React 状态。
 *
 * 语义：把 X 从剧情流原位拔出（前后邻居缝合直连 p→n），再插到锚点的
 * 前/后。剧情流 = sequence 边子图；attach（垂直派生）与 branch（选项出口）
 * 边不参与。
 */

export interface SplicePlan {
  removes: string[]
  adds: Array<{ source: string; target: string }>
}

type SpliceEdge = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  type?: string
  className?: string
}

const pairSig = (pairs: Array<{ source: string; target: string }>): string =>
  pairs.map((p) => `${p.source}->${p.target}`).sort().join(',')

/**
 * 计划把 draggedId 移动到 anchorId 的前/后。
 * 返回 null = 无法执行（锚点即自身、或防御性环检测未通过）；
 * removes/adds 全空 = 原位重放（无需变更）。
 */
export function planSpliceIntoSpine(
  edges: SpliceEdge[],
  draggedId: string,
  anchorId: string,
  position: 'before' | 'after',
): SplicePlan | null {
  if (draggedId === anchorId) return null
  const seq = edges.filter((e) => edgeKindOf(e) === 'sequence')
  // 锚点必须是剧情流成员（只有 attach 下挂边的分镜卡不可作锚点）
  if (!seq.some((e) => e.source === anchorId || e.target === anchorId)) return null
  const mine = seq.filter((e) => e.source === draggedId || e.target === draggedId)
  const mineIds = new Set(mine.map((e) => e.id))
  const remaining = seq.filter((e) => !mineIds.has(e.id))

  // 原位前邻/后邻（恰各一条时才可缝合；多出口的分叉不擅自直连）
  const oldIn = seq.filter((e) => e.target === draggedId)
  const oldOut = seq.filter((e) => e.source === draggedId)
  const prev = oldIn.length === 1 ? oldIn[0].source : null
  const next = oldOut.length === 1 ? oldOut[0].target : null

  const succOf = (id: string): string | null =>
    remaining.find((e) => e.source === id)?.target ?? null
  const predOf = (id: string): string | null =>
    remaining.find((e) => e.target === id)?.source ?? null

  let upstream: string | null
  let downstream: string | null
  if (position === 'after') {
    upstream = anchorId
    // 锚点恰是原前邻时，X 的新后继仍是原后继（其余边已随拔出移除）
    downstream = upstream === prev ? next : succOf(upstream)
  } else {
    downstream = anchorId
    upstream = downstream === next ? prev : predOf(downstream)
  }

  const adds: Array<{ source: string; target: string }> = []
  // 新位恰为原位时不缝合（否则会给 A→X→C 平行一条 A→C 捷径）
  const inPlace = upstream === prev && downstream === next
  if (!inPlace && prev !== null && next !== null) adds.push({ source: prev, target: next })
  if (upstream !== null) adds.push({ source: upstream, target: draggedId })
  if (downstream !== null) adds.push({ source: draggedId, target: downstream })

  // 原位重放：新边端点对与拔掉的原边完全一致 → 无需变更
  if (pairSig(adds) === pairSig(mine.map((e) => ({ source: e.source, target: e.target })))) {
    return { removes: [], adds: [] }
  }

  // 防御性环检测（剧情流理应无环；带外状态兜底）
  const flow: Array<{ source: string; target: string }> = remaining.map((e) => ({
    source: e.source,
    target: e.target,
  }))
  for (const a of adds) {
    if (wouldCreateCycle(flow, a.source, a.target)) return null
    flow.push(a)
  }
  return { removes: mine.map((e) => e.id), adds }
}
