import type { Edge } from '@xyflow/react'
import { branchOptionIdOf, edgeKindOf } from './graphRules'
import { beatFulfillmentMap, episodeOfNode, hostSceneMap, sceneLabel, type BeatFulfillment } from './outline'
import type { BranchFlowNode, CanvasNode } from './nodes/types'

/**
 * 导出大纲投影（issue #48，docs/ui-design.md §3.5「可选大纲注释」）。
 *
 * 大纲 = 故事脊线的语义投影，而非画布坐标投影：组内顺序由剧情流
 * （`sequence` 边）决定，画布 x 序只用于同级并列（多入口、未接入剧情流）
 * 的确定性排序；分镜下挂（`attach`）不参与剧情流，也不进入大纲
 * （分镜卡另以剧本附录输出）。分支是结构信息：问句、全部选项与各选项去向
 * 一并输出，未连线选项显式标注，不把替代路径平铺成一条已发生的剧情。
 */

/** 大纲行的语义分类：节点行 / 分支问句行 / 选项去向行 / 组内分段标题。 */
export type ExportOutlineRowKind = 'node' | 'branch' | 'option' | 'marker'

export interface ExportOutlineRow {
  /** 行的语义类别：渲染层据此决定样式，也便于单独断言某类行。 */
  kind: ExportOutlineRowKind
  /** 缩进层级：节拍/场景 0，对白/分支/分段标题 1，选项 2。 */
  level: number
  /** 行文本（不含 Markdown 项目符号与缩进，由渲染层生成）。 */
  text: string
}

/** 一个集分组；`episode` 为 null = 未分集（排在已分集之后）。 */
export interface ExportOutlineGroup {
  /** 集号；null = 未分集。 */
  episode: number | null
  /** `episodeTitles` 的集标题；未命名时为空串。 */
  title: string
  rows: ExportOutlineRow[]
}

/** 导出范围概要：本次导出覆盖的内容计数与大纲可用性。 */
export interface ExportOutlineSummary {
  /** 出现过的集号（升序）。 */
  episodes: number[]
  scenes: number
  dialogues: number
  beats: number
  branches: number
  /** 是否存在可导出的大纲内容（节奏卡或分支）。 */
  hasOutline: boolean
}

/** 大纲内的节点成员；分镜卡与图片节点不是叙事单元，一律不进入大纲。 */
type OutlineNode = Exclude<CanvasNode, { type: 'shot' } | { type: 'image' }>

/** 节点是否进入导出大纲（分镜卡与图片节点排除）。 */
function isOutlineNode(n: CanvasNode): n is OutlineNode {
  return n.type !== 'shot' && n.type !== 'image'
}

/** 防御性文本：字段缺失或非字符串时退化为空串，不产出 "undefined" 字样。 */
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 节拍行：名称 + 基调（§4.2 节奏卡只有这两项）与兑现状态。 */
function beatText(n: OutlineNode, f: BeatFulfillment | undefined): string {
  const d = n.data as { name?: unknown; tone?: unknown }
  const tone = text(d.tone)
  const tonePart = tone === '' ? '' : ` · ${tone}`
  const state = f?.status === 'fulfilled' ? `✓ 兑现于 ${f.sceneLabel ?? ''}` : '待兑现'
  return `节拍 · ${text(d.name)}${tonePart} · ${state}`
}

/** 非分支节点的行文本（分支行由 branchText 单独派生问句）。 */
function rowText(n: OutlineNode, f: BeatFulfillment | undefined): string {
  switch (n.type) {
    case 'beat':
      return beatText(n, f)
    case 'scene':
      return sceneLabel(n)
    case 'dialogue':
      return `对白 · ${text((n.data as { name?: unknown }).name)}`
    case 'branch':
      return branchText(n)
  }
}

/** 分支问句行：`prompt` 即名称（§4.3 分支改名走 spec.prompt）。 */
function branchText(n: OutlineNode): string {
  return `分支 · ${text((n.data as { prompt?: unknown }).prompt)}`
}

/** 选项去向：目标节点的可读标签；未连线与失效目标分别显式标注。 */
function optionDestination(edge: Edge | undefined, byId: ReadonlyMap<string, CanvasNode>): string {
  if (!edge) return '（未连线）'
  return destinationLabel(byId, edge.target) ?? '（目标已删除）'
}

/** 分支选项行：未连线显式标注，不静默丢失出口（issue #48 验收）。 */
function optionRows(
  branch: OutlineNode,
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
): ExportOutlineRow[] {
  const options = (branch.data as BranchFlowNode['data']).options
  if (!Array.isArray(options)) return []
  return options.map((opt) => {
    const edge = edges.find(
      (e) =>
        e.source === branch.id &&
        edgeKindOf(e) === 'branch' &&
        branchOptionIdOf(e.sourceHandle) === opt.id,
    )
    return {
      kind: 'option' as const,
      level: 2,
      text: `${text(opt.label)} → ${optionDestination(edge, byId)}`,
    }
  })
}

/** 节点的可读去向标签（悬空或非叙事目标返回 null）。 */
function destinationLabel(byId: ReadonlyMap<string, CanvasNode>, id: string): string | null {
  const node = byId.get(id)
  if (!node || !isOutlineNode(node)) return null
  return node.type === 'scene' ? sceneLabel(node) : rowText(node, undefined)
}

/** 每组的剧情流边：两端都在本组、且 source 为叙事节点的 sequence 边。
 * 未接入剧情流的节点不得把下游节点拖进脊线（其自身的边在此被排除）。 */
function spineEdges(edges: Edge[], member: ReadonlySet<string>): Edge[] {
  return edges.filter(
    (e) =>
      edgeKindOf(e) === 'sequence' &&
      member.has(e.source) &&
      member.has(e.target),
  )
}

/** 每个节点的入边来源集合（组内剧情流；自环不计入）。 */
function parentSources(spine: Edge[]): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>()
  for (const e of spine) {
    if (e.source === e.target) continue
    const set = parents.get(e.target) ?? new Set<string>()
    set.add(e.source)
    parents.set(e.target, set)
  }
  return parents
}

/** 组内节点按画布 x 序（并列再按 id）；x 序只做同级确定性排序，
 * 不用于推断分支去向。 */
function byCanvasX(nodes: OutlineNode[]): OutlineNode[] {
  return [...nodes].sort((a, b) => a.position.x - b.position.x || (a.id < b.id ? -1 : 1))
}

/** 每个汇合点的规范前邻：入边来源中画布 x 最小者（并列按 id）。
 * x 序在此只做多路径的确定性归一，不推断分支去向。 */
function canonicalParents(
  byId: ReadonlyMap<string, CanvasNode>,
  parents: ReadonlyMap<string, Set<string>>,
): Map<string, string> {
  const canonical = new Map<string, string>()
  for (const [id, sources] of parents) {
    const ordered = [...sources].sort((a, b) => {
      const na = byId.get(a)
      const nb = byId.get(b)
      return (na?.position.x ?? 0) - (nb?.position.x ?? 0) || (a < b ? -1 : 1)
    })
    canonical.set(id, ordered[0])
  }
  return canonical
}

/** 展开一条组的叙事主线：入口按 x 序深度优先，每个节点只作一次主线成员；
 * 汇合点的其余入边不在行内重复平铺，改由节点行上的「汇合 n 条路径」标注。
 * 多入口（并列起点）与汇合标注共同表达「这不是一条已发生的线性剧情」。 */
function routeNodes(
  spine: Edge[],
  memberNodes: OutlineNode[],
  byId: ReadonlyMap<string, CanvasNode>,
): OutlineNode[] {
  const parents = parentSources(spine)
  const canonical = canonicalParents(byId, parents)
  const visits: OutlineNode[] = []
  const emitted = new Set<string>()
  const stack: OutlineNode[] = byCanvasX(memberNodes.filter((n) => !parents.has(n.id))).reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (emitted.has(node.id)) continue
    emitted.add(node.id)
    visits.push(node)
    const next = spine
      .filter((e) => e.source === node.id && byId.has(e.target))
      .map((e) => byId.get(e.target)!)
      .filter((n): n is OutlineNode => isOutlineNode(n) && canonical.get(n.id) === node.id)
    for (const n of byCanvasX(next).reverse()) stack.push(n)
  }
  return visits
}

/** 节点行的后缀标注：叙事入口 / 分支汇合；均不适用时为空串。
 * 「入口」只在组内存在叙事入边时标注——整组都无连线时不逐行重复。 */
function nodeSuffix(node: OutlineNode, inbound: ReadonlySet<string>, mergeCount: number): string {
  const marks: string[] = []
  if (inbound.size > 0 && !inbound.has(node.id)) marks.push('入口')
  if (mergeCount > 1) marks.push(`汇合 ${mergeCount} 条路径`)
  return marks.length > 0 ? ` · ${marks.join(' · ')}` : ''
}

/** 节点行 + 紧随其后的选项行；分支选项紧跟问句，不拆到别处。 */
function nodeRows(
  n: OutlineNode,
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
  suffix: string,
): ExportOutlineRow[] {
  const rows: ExportOutlineRow[] = [
    { kind: 'node', level: 0, text: `${rowText(n, fulfillment.get(n.id))}${suffix}` },
  ]
  if (n.type === 'branch') rows.push(...optionRows(n, edges, byId))
  return rows
}

/** 单组的行集合：叙事主线行 + 未接入剧情流节点的显式分段。 */
function groupRows(
  memberNodes: OutlineNode[],
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
): ExportOutlineRow[] {
  const member = new Set(memberNodes.map((n) => n.id))
  const spine = spineEdges(edges, member)
  const parents = parentSources(spine)
  const inFlow = new Set<string>()
  const inbound = new Set<string>()
  for (const e of edges) {
    if (edgeKindOf(e) === 'attach' || !member.has(e.source) || !member.has(e.target)) continue
    inFlow.add(e.source)
    inFlow.add(e.target)
    inbound.add(e.target)
  }
  const routes = routeNodes(spine, memberNodes.filter((n) => inFlow.has(n.id)), byId)
  const rows: ExportOutlineRow[] = []
  for (const node of routes) {
    const merge = parents.get(node.id)?.size ?? 0
    rows.push(...nodeRows(node, edges, byId, fulfillment, nodeSuffix(node, inbound, merge)))
  }
  const detached = byCanvasX(memberNodes.filter((n) => !inFlow.has(n.id)))
  // 全组无剧情流连线时按 x 序列出即可：没有主线可对照，不贴分段标题
  if (routes.length > 0 && detached.length > 0) {
    rows.push({ kind: 'marker', level: 1, text: '（未接入剧情流）' })
  }
  for (const n of detached) rows.push(...nodeRows(n, edges, byId, fulfillment, ''))
  return rows
}

/** 导出大纲分组：集号升序、未分集殿底；组内按剧情流展开。 */
export function buildExportOutline(
  nodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
): ExportOutlineGroup[] {
  const narrative = nodes.filter(isOutlineNode)
  const byId = new Map(narrative.map((n) => [n.id, n as CanvasNode]))
  const sceneByShot = hostSceneMap(nodes, edges)
  const fulfillment = beatFulfillmentMap(nodes, edges)
  const byEpisode = new Map<number | null, OutlineNode[]>()
  for (const n of narrative) {
    const ep = episodeOfNode(n, (id) => sceneByShot.get(id))
    const list = byEpisode.get(ep)
    if (list) list.push(n)
    else byEpisode.set(ep, [n])
  }
  const ordered = [...byEpisode.keys()]
    .filter((k): k is number => k !== null)
    .sort((a, b) => a - b)
  const groups: ExportOutlineGroup[] = ordered.map((ep) => ({
    episode: ep,
    title: text(episodeTitles[ep]),
    rows: groupRows(byCanvasX(byEpisode.get(ep)!), edges, byId, fulfillment),
  }))
  const ungrouped = byEpisode.get(null)
  if (ungrouped) {
    groups.push({
      episode: null,
      title: '',
      rows: groupRows(byCanvasX(ungrouped), edges, byId, fulfillment),
    })
  }
  return groups
}

/** 导出范围概要：只统计画布实际内容，不从文案反推。 */
export function summariseExportOutline(nodes: CanvasNode[]): ExportOutlineSummary {
  const narrative = nodes.filter(isOutlineNode)
  const episodes = [...new Set(narrative.map((n) => (n.data as { episodeNo?: unknown }).episodeNo))]
    .filter((ep): ep is number => typeof ep === 'number')
    .sort((a, b) => a - b)
  const count = (type: CanvasNode['type']) => narrative.filter((n) => n.type === type).length
  const beats = count('beat')
  const branches = count('branch')
  return {
    episodes,
    scenes: count('scene'),
    dialogues: count('dialogue'),
    beats,
    branches,
    hasOutline: beats > 0 || branches > 0,
  }
}
