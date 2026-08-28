import type { Edge } from '@xyflow/react'
import { edgeKindOf, SCENE_SHOT_HANDLE } from './graphRules'
import type { CanvasNode } from './nodes/types'

/**
 * 大纲视图的纯派生（docs/ui-design.md §3.5）。
 * 大纲 = 故事脊线的线性投影；「集」是逻辑分类而非实体表——
 * 节点以 `episodeNo` 归属集，集标题存文档级 `episodeTitles`，
 * 大纲行 = 集 ▸ 节拍 ▸ 场景头的缩进树。
 */

export interface OutlineRow {
  id: string
  /** 缩进层级：节拍 0 / 场景 1 / 对白与分支 2 / 分镜 3。 */
  level: number
  label: string
  /** 节拍行专属：兑现状态（§3.5，sequence 邻接派生）。 */
  beat?: { pending: boolean; label?: string }
}

/** 节拍兑现状态（§3.5）：由 sequence 边邻接派生，不落镜像字段。
 * 出边场景优先（节拍先立、场景随后承接），无出边场景再看入边场景。 */
export interface BeatFulfillment {
  status: 'pending' | 'fulfilled'
  /** 承载场景的行内标签，如「场 03 · 天台对峙」。 */
  sceneLabel?: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

const sceneLabel = (n: CanvasNode): string =>
  `场 ${pad2((n.data as { sceneNo: number }).sceneNo)} · ${(n.data as { name: string }).name}`

/** 派生全部节拍的兑现状态（画布胶囊与大纲行共用）。 */
export function beatFulfillmentMap(
  nodes: CanvasNode[],
  edges: Edge[],
): Map<string, BeatFulfillment> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seq = edges.filter((e) => edgeKindOf(e) === 'sequence')
  const outEdges = seq.filter((e) => e.source !== e.target)
  const map = new Map<string, BeatFulfillment>()
  for (const n of nodes) {
    if (n.type !== 'beat') continue
    const neighbors: string[] = [
      ...outEdges.filter((e) => e.source === n.id).map((e) => e.target),
      ...seq.filter((e) => e.target === n.id).map((e) => e.source),
    ]
    const host = neighbors
      .map((id) => byId.get(id))
      .find((cand): cand is CanvasNode => cand?.type === 'scene')
    map.set(
      n.id,
      host ? { status: 'fulfilled', sceneLabel: sceneLabel(host) } : { status: 'pending' },
    )
  }
  return map
}

export interface OutlineGroup {
  /** 集号；null = 未分集（组排在最后）。 */
  episode: number | null
  /** 行内标题（episodeTitles 的值，未命名时为空串）。 */
  title: string
  rows: OutlineRow[]
}

/** 大纲拖拽落点（§3.5 拖拽排序 = 重排 sequence 边；跨组 = 改集归属）。 */
export type OutlineDropTarget =
  | { kind: 'row'; anchorId: string; position: 'before' | 'after' }
  | { kind: 'groupEnd'; episode: number | null }

/** 行标签按类型派生（与旧大纲视图一致）。 */
function rowOf(n: CanvasNode): OutlineRow {
  switch (n.type) {
    case 'beat':
      return { id: n.id, level: 0, label: `节拍 · ${n.data.name}` }
    case 'scene':
      return { id: n.id, level: 1, label: `场 ${pad2(n.data.sceneNo)} · ${n.data.name}` }
    case 'dialogue':
      return { id: n.id, level: 2, label: `对白 · ${n.data.name}` }
    case 'branch':
      return { id: n.id, level: 2, label: `分支 · ${n.data.prompt}` }
    case 'shot':
      return { id: n.id, level: 3, label: `SHOT ${pad2(n.data.shotNo)} · ${n.data.size}` }
  }
}

/** 下挂分镜 → 宿主场景映射（attach 派生从属；大纲分组与集聚焦共用）。 */
export function hostSceneMap(nodes: CanvasNode[], edges: Edge[]): Map<string, CanvasNode> {
  const map = new Map<string, CanvasNode>()
  for (const e of edges) {
    if (e.sourceHandle === SCENE_SHOT_HANDLE) {
      const host = nodes.find((n) => n.id === e.source)
      if (host) map.set(e.target, host)
    }
  }
  return map
}

/** 节点的集归属：episodeNo 优先；下挂分镜随宿主场景（attach 派生从属）。
 * 大纲分组、画布集聚焦与拖拽落点归集共用同一判定。 */
export function episodeOfNode(
  n: CanvasNode,
  hostSceneOf: (shotId: string) => CanvasNode | undefined,
): number | null {
  const d = n.data as { episodeNo?: unknown }
  if (typeof d.episodeNo === 'number') return d.episodeNo
  if (n.type === 'shot') {
    const hd = hostSceneOf(n.id)?.data as { episodeNo?: unknown } | undefined
    if (typeof hd?.episodeNo === 'number') return hd.episodeNo
  }
  return null
}

/**
 * 派生大纲分组：按集号升序，未分集殿底；组内保持原有 x 序与缩进层级。
 * 完全没有 episodeNo 时退化为单个未分集组（与旧大纲视图等价）。
 */
export function buildOutlineGroups(
  nodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
): OutlineGroup[] {
  const sceneByShot = hostSceneMap(nodes, edges)
  const fulfillment = beatFulfillmentMap(nodes, edges)
  const byEpisode = new Map<number | null, OutlineRow[]>()
  for (const n of [...nodes].sort((a, b) => a.position.x - b.position.x)) {
    const row = rowOf(n)
    if (n.type === 'beat') {
      const f = fulfillment.get(n.id)
      row.beat =
        f && f.status === 'fulfilled'
          ? { pending: false, label: f.sceneLabel }
          : { pending: true }
    }
    const ep = episodeOfNode(n, (id) => sceneByShot.get(id))
    const list = byEpisode.get(ep) ?? []
    list.push(row)
    byEpisode.set(ep, list)
  }
  const groups: OutlineGroup[] = [...byEpisode.keys()]
    .filter((k): k is number => k !== null)
    .sort((a, b) => a - b)
    .map((ep) => ({ episode: ep, title: episodeTitles[ep] ?? '', rows: byEpisode.get(ep)! }))
  const ungrouped = byEpisode.get(null)
  if (ungrouped) groups.push({ episode: null, title: '', rows: ungrouped })
  return groups
}
