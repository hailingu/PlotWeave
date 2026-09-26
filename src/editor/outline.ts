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
  /** 节拍行专属：兑现状态（§3.5，sequence 邻接派生）；兑现场景名可显式
   * undefined（= 无宿主场景名，issue #231）。 */
  beat?: { pending: boolean; label?: string | undefined }
}

/** 节拍兑现状态（§3.5）：由 sequence 边邻接派生，不落镜像字段。
 * 出边场景优先（节拍先立、场景随后承接），无出边场景再看入边场景。 */
export interface BeatFulfillment {
  status: 'pending' | 'fulfilled'
  /** 承载场景的行内标签，如「场 03 · 天台对峙」。 */
  sceneLabel?: string
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 场景行内标签，如「场 03 · 天台对峙」：大纲行、节拍兑现状态与导出大纲
 * 共用同一口径（名称字段防御非字符串，脏数据不产出 "undefined" 字样）。 */
export const sceneLabel = (n: CanvasNode): string => {
  const d = n.data as { sceneNo: number; name: unknown }
  return `场 ${pad2(d.sceneNo)} · ${typeof d.name === 'string' ? d.name : ''}`
}

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
      host
        ? { status: 'fulfilled', sceneLabel: sceneLabel(host) }
        : { status: 'pending' },
    )
  }
  return map
}

/** 大纲分组（§3.5）：一集一组，未分集殿底；rows 为该集的缩进树行。 */
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

/** 行标签按类型派生（与旧大纲视图一致）。图片节点不进大纲（生成产物非
 * 叙事单元，buildOutlineGroups 已先行跳过；case 仅为联合穷尽性兜底）。 */
function rowOf(n: CanvasNode): OutlineRow {
  switch (n.type) {
    case 'beat':
      return { id: n.id, level: 0, label: `节拍 · ${n.data.name}` }
    case 'scene':
      return {
        id: n.id,
        level: 1,
        label: `场 ${pad2(n.data.sceneNo)} · ${n.data.name}`,
      }
    case 'dialogue':
      return { id: n.id, level: 2, label: `对白 · ${n.data.name}` }
    case 'branch':
      return { id: n.id, level: 2, label: `分支 · ${n.data.prompt}` }
    case 'shot':
      return {
        id: n.id,
        level: 3,
        label: `SHOT ${pad2(n.data.shotNo)} · ${n.data.size}`,
      }
    case 'image':
      return { id: n.id, level: 0, label: '图片节点' }
  }
}

/** 下挂分镜 → 宿主场景映射（attach 派生从属；大纲分组与集聚焦共用）。 */
export function hostSceneMap(
  nodes: CanvasNode[],
  edges: Edge[],
): Map<string, CanvasNode> {
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

/** 压暗投影缓存（issue #273）：以源节点对象为键——源节点不可变（React
 * Flow 以新对象表达变化），同一源节点恒得同一投影对象，React Flow 的
 * `adoptUserNodes`（userNode 身份不变即复用内部节点）便不会因无关节点
 * 移动而重建全部非成员。WeakMap 随源节点回收，不持有已替换节点。 */
const DIM_PROJECTION = new WeakMap<CanvasNode, CanvasNode>()

function dimmedOf(n: CanvasNode): CanvasNode {
  const cached = DIM_PROJECTION.get(n)
  if (cached !== undefined) return cached
  const dim = { ...n, className: 'pw-node-dim' } as CanvasNode
  DIM_PROJECTION.set(n, dim)
  return dim
}

/** 集聚焦的画布投影（§3.5）：成员保持原样，非成员加降透明度类（~30%）。
 * className 是运行态样式（落盘时由模型层序列化剥离），不入持久化。
 * 未变化的非成员复用同一投影对象（issue #273）。 */
export function applyEpisodeFocus(
  nodes: CanvasNode[],
  edges: Edge[],
  focused: number | null,
): CanvasNode[] {
  if (focused === null) return nodes
  const sceneByShot = hostSceneMap(nodes, edges)
  return nodes.map((n) =>
    episodeOfNode(n, (id) => sceneByShot.get(id)) === focused ? n : dimmedOf(n),
  )
}

/** 剧情流分组：一集一组（集号升序、未分集殿底），组内先剧情流路由序、
 * 后未接入成员——左侧大纲列表、剧本导出正文与创作大纲附录三投影共用
 * 的规范分区（issue #340 评审：单一实现，杜绝投影间语义漂移）。 */
export interface StorylineGroup<T extends CanvasNode = CanvasNode> {
  episode: number | null
  /** 接入剧情流的成员：组内叙事边拓扑序（就绪节点按 x/id 稳定交织）。 */
  routed: T[]
  /** 未接入剧情流的成员（无任何叙事边端点），x/id 序殿后。 */
  detached: T[]
}

/** 组内叙事约束边的前驱表：两端须同组、非自环；attach 不参与拓扑
 * （分镜以宿主块插放，见 shotsByHost）。 */
function narrativeParents<T extends CanvasNode>(
  members: T[],
  edges: Edge[],
): Map<string, Set<string>> {
  const member = new Set(members.map((n) => n.id))
  const parents = new Map<string, Set<string>>()
  for (const e of edges) {
    if (
      e.source === e.target ||
      edgeKindOf(e) === 'attach' ||
      !member.has(e.source) ||
      !member.has(e.target)
    )
      continue
    const set = parents.get(e.target) ?? new Set<string>()
    set.add(e.source)
    parents.set(e.target, set)
  }
  return parents
}

/** 拓扑路由（仅叙事流成员）：就绪节点按 x/id 稳定交织；成环残留按 x/id
 * 补齐——列表不得丢行（会话图经加载管线隔离，运行态防御）。 */
function topoRoute<T extends CanvasNode>(
  members: T[],
  parents: Map<string, Set<string>>,
  inFlow: ReadonlySet<string>,
  byXId: (list: T[]) => T[],
): { routed: T[]; routedIds: Set<string> } {
  const routed: T[] = []
  const routedIds = new Set<string>()
  let ready = byXId(
    members.filter((n) => inFlow.has(n.id) && !parents.has(n.id)),
  )
  while (ready.length > 0) {
    const node = ready.shift()!
    routed.push(node)
    routedIds.add(node.id)
    for (const candidate of members) {
      const sources = parents.get(candidate.id)
      if (sources?.delete(node.id) && sources.size === 0) ready.push(candidate)
    }
    ready = byXId(ready)
  }
  for (const node of byXId(members))
    if (inFlow.has(node.id) && !routedIds.has(node.id)) {
      routed.push(node)
      // 补齐必须同步登记，否则 shotsByHost 将同一节点再收进 detached
      routedIds.add(node.id)
    }
  return { routed, routedIds }
}

/** 分镜块归集（attach 派生从属，issue #340 评审二轮）：分镜行紧随宿主
 * （块内 x/id 序），不与就绪/未接入的一般排序竞争 x——否则宿主解锁后
 * 下一叙事节点（x 更小）会把 level-3 行越到别的场景之下。宿主不在本组
 * （跨集归属或悬空 attach）的分镜留在 x/id 序。 */
function shotsByHost<T extends CanvasNode>(
  members: T[],
  edges: Edge[],
  routedIds: ReadonlySet<string>,
  byXId: (list: T[]) => T[],
): { blocks: Map<string, T[]>; free: T[] } {
  const blocks = new Map<string, T[]>()
  const free: T[] = []
  for (const node of byXId(members)) {
    if (routedIds.has(node.id)) continue
    const host = edges.find(
      (e) =>
        edgeKindOf(e) === 'attach' &&
        e.target === node.id &&
        members.some((m) => m.id === e.source),
    )?.source
    if (host === undefined) free.push(node)
    else {
      const list = blocks.get(host)
      if (list) list.push(node)
      else blocks.set(host, [node])
    }
  }
  return { blocks, free }
}

/** 组内分区与路由（storylineGroups 内核）：叙事边拓扑路由 + 分镜块插放；
 * 「接入剧情流」按调用方给定的全量范围判定，跨集连接的节点在本组作无
 * 组内前驱的根参与路由。 */
function partitionGroup<T extends CanvasNode>(
  members: T[],
  edges: Edge[],
  inFlow: ReadonlySet<string>,
): { routed: T[]; detached: T[] } {
  const byXId = (list: T[]): T[] =>
    [...list].sort(
      (a, b) => a.position.x - b.position.x || (a.id < b.id ? -1 : 1),
    )
  const parents = narrativeParents(members, edges)
  const { routed, routedIds } = topoRoute(members, parents, inFlow, byXId)
  const { blocks, free } = shotsByHost(members, edges, routedIds, byXId)
  const withBlocks = (list: T[]): T[] =>
    list.flatMap((n) => [n, ...(blocks.get(n.id) ?? [])])
  return { routed: withBlocks(routed), detached: withBlocks(free) }
}

/**
 * 剧情流分组排序（§3.5 故事脊线的线性投影；issue #340 及其评审）：集号
 * 升序、未分集殿底；组内先路由后未接入分区。「接入剧情流」按叙事边
 * （非 attach）端点在全量成员范围判定——跨集边计入，跨集连接的节点在本组
 * 作无组内前驱的根参与路由，与附录既有口径一致；约束边只取组内两端
 * （跨集路径不把依赖带入集内行序）。attach 派生从属以宿主块承载：分镜行
 * 紧随宿主（块内 x/id 序），宿主未接入时分镜一并留在未接入分区。左侧
 * 大纲列表、剧本导出正文与创作大纲附录共用。
 */
export function storylineGroups<T extends CanvasNode>(
  nodes: T[],
  edges: Edge[],
): StorylineGroup<T>[] {
  const sceneByShot = hostSceneMap(nodes, edges)
  const byEpisode = new Map<number | null, T[]>()
  for (const n of nodes) {
    const ep = episodeOfNode(n, (id) => sceneByShot.get(id))
    const list = byEpisode.get(ep)
    if (list) list.push(n)
    else byEpisode.set(ep, [n])
  }
  const ids = new Set(nodes.map((n) => n.id))
  const inFlow = new Set<string>()
  for (const e of edges) {
    if (
      e.source === e.target ||
      edgeKindOf(e) === 'attach' ||
      !ids.has(e.source) ||
      !ids.has(e.target)
    )
      continue
    inFlow.add(e.source)
    inFlow.add(e.target)
  }
  const groupOf = (members: T[], episode: number | null) => ({
    episode,
    ...partitionGroup(members, edges, inFlow),
  })
  const groups = [...byEpisode.keys()]
    .filter((k): k is number => k !== null)
    .sort((a, b) => a - b)
    .map((ep) => groupOf(byEpisode.get(ep)!, ep))
  const ungrouped = byEpisode.get(null)
  if (ungrouped) groups.push(groupOf(ungrouped, null))
  return groups
}

/**
 * 派生大纲分组：按集号升序，未分集殿底；组内按剧情流分区序（
 * storylineGroups，issue #340：拖拽重排连线后列表随之更新，不再沿用
 * 画布 x 序）。图片节点不进大纲（生成产物非叙事单元，§13）。
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
  const ordered = storylineGroups(
    nodes.filter((n) => n.type !== 'image'),
    edges,
  ).flatMap((g) => [...g.routed, ...g.detached])
  for (const n of ordered) {
    const row = rowOf(n)
    if (n.type === 'beat') {
      const f = fulfillment.get(n.id)
      row.beat =
        f?.status === 'fulfilled'
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
    .map((ep) => ({
      episode: ep,
      title: episodeTitles[ep] ?? '',
      rows: byEpisode.get(ep)!,
    }))
  const ungrouped = byEpisode.get(null)
  if (ungrouped) groups.push({ episode: null, title: '', rows: ungrouped })
  return groups
}
