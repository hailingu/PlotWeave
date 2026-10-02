import type { Edge } from '@xyflow/react'
import { branchOptionIdOf, edgeKindOf } from './graphRules'
import {
  beatFulfillmentMap,
  sceneLabel,
  storylineGroups,
  type BeatFulfillment,
  type StorylineGroup,
} from './outline'
import type { BranchFlowNode, CanvasNode } from './nodes/types'

/**
 * 导出大纲投影（issue #48，docs/ui-design.md §3.5「可选大纲注释」）。
 *
 * 大纲 = 故事脊线的语义投影，而非画布坐标投影：组内顺序由剧情流
 * （`sequence` 与 `branch` 边）决定，画布 x 序只用于同级并列（多入口、未接入剧情流）
 * 的确定性排序；分镜下挂（`attach`）不参与剧情流，也不进入大纲
 * （分镜卡另以剧本附录输出）。分支是结构信息：问句、全部选项与各选项去向
 * 一并输出，未连线选项显式标注，不把替代路径平铺成一条已发生的剧情。
 */

/** 大纲行的语义分类：节点行 / 分支问句行 / 选项去向行 / 组内分段标题。 */
export type ExportOutlineRowKind = 'node' | 'branch' | 'option' | 'marker'

/** 导出大纲的结构化行：语义分类 + 缩进层级 + 纯文本（Markdown 项目
 * 符号与缩进由渲染层生成，本结构不含）。 */
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
  const state =
    f?.status === 'fulfilled' ? `✓ 兑现于 ${f.sceneLabel ?? ''}` : '待兑现'
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

/** 选项去向：全部已连目标的可读标签，逐个列出（同一选项可连多个目标——
 * `isDuplicateEdge` 含 target，交互与落盘模型均允许；只取首条会静默丢路径）。
 * 未连线与失效目标分别显式标注。 */
function optionDestination(
  targets: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
): string {
  if (targets.length === 0) return '（未连线）'
  return targets
    .map(
      (e) => destinationLabel(byId, e.target, fulfillment) ?? '（目标已删除）',
    )
    .join(' / ')
}

/** 分支选项行：未连线显式标注，不静默丢失出口（issue #48 验收）。 */
function optionRows(
  branch: OutlineNode,
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
): ExportOutlineRow[] {
  const options = (branch.data as BranchFlowNode['data']).options
  if (!Array.isArray(options)) return []
  return options.map((opt) => {
    const targets = edges.filter(
      (e) =>
        e.source === branch.id &&
        edgeKindOf(e) === 'branch' &&
        branchOptionIdOf(e.sourceHandle) === opt.id,
    )
    return {
      kind: 'option' as const,
      level: 2,
      text: `${text(opt.label)} → ${optionDestination(targets, byId, fulfillment)}`,
    }
  })
}

/** 节点的可读去向标签（悬空或非叙事目标返回 null）；节奏卡目标沿用其
 * 兑现状态，避免选项目的行与节拍自身行在同一导出内自相矛盾。 */
function destinationLabel(
  byId: ReadonlyMap<string, CanvasNode>,
  id: string,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
): string | null {
  const node = byId.get(id)
  if (!node || !isOutlineNode(node)) return null
  return node.type === 'scene'
    ? sceneLabel(node)
    : rowText(node, fulfillment.get(node.id))
}

/** 指定节点范围内的叙事边：只接纳两端均在范围内的 sequence / branch，排除 attach。 */
function narrativeEdgesWithin(
  edges: Edge[],
  member: ReadonlySet<string>,
): Edge[] {
  return edges.filter(
    (e) =>
      edgeKindOf(e) !== 'attach' &&
      member.has(e.source) &&
      member.has(e.target),
  )
}

/** 节点行的后缀标注：叙事入口 / 分支汇合；均不适用时为空串。
 * 「入口」只在组内存在叙事入边时标注——整组都无连线时不逐行重复。 */
function nodeSuffix(
  node: OutlineNode,
  inbound: ReadonlySet<string>,
  mergeCount: number,
): string {
  const marks: string[] = []
  if (inbound.size > 0 && !inbound.has(node.id)) marks.push('入口')
  if (mergeCount > 1) marks.push(`汇合 ${mergeCount} 条路径`)
  return marks.length > 0 ? ` · ${marks.join(' · ')}` : ''
}

/** 按类型生成行类别与层级：分支问句独立分类为一级，选项紧跟问句。 */
function nodeRows(
  n: OutlineNode,
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
  suffix: string,
): ExportOutlineRow[] {
  const level = n.type === 'dialogue' || n.type === 'branch' ? 1 : 0
  const kind = n.type === 'branch' ? 'branch' : 'node'
  const rows: ExportOutlineRow[] = [
    { kind, level, text: `${rowText(n, fulfillment.get(n.id))}${suffix}` },
  ]
  if (n.type === 'branch') rows.push(...optionRows(n, edges, byId, fulfillment))
  return rows
}

/** 单组的行集合：分区与排序来自 storylineGroups 规范实现（issue #340 评审，
 * 与大纲列表/导出正文共用），汇合计数仅使用组内叙事边。 */
function groupRows(
  group: StorylineGroup<OutlineNode>,
  edges: Edge[],
  byId: ReadonlyMap<string, CanvasNode>,
  fulfillment: ReadonlyMap<string, BeatFulfillment>,
): ExportOutlineRow[] {
  const member = new Set([...group.routed, ...group.detached].map((n) => n.id))
  const flow = narrativeEdgesWithin(edges, member)
  const incomingPaths = new Map<string, number>()
  const inbound = new Set<string>()
  for (const e of flow) {
    inbound.add(e.target)
    // 汇合按叙事入边逐条计数，保留同一分支的不同选项；自环不算路径。
    if (e.source !== e.target) {
      incomingPaths.set(e.target, (incomingPaths.get(e.target) ?? 0) + 1)
    }
  }
  const rows: ExportOutlineRow[] = []
  for (const node of group.routed) {
    const merge = incomingPaths.get(node.id) ?? 0
    rows.push(
      ...nodeRows(
        node,
        edges,
        byId,
        fulfillment,
        nodeSuffix(node, inbound, merge),
      ),
    )
  }
  // 全组没有任何叙事边端点时按 x 序列出即可，不贴分段标题。
  if (group.routed.length > 0 && group.detached.length > 0) {
    rows.push({ kind: 'marker', level: 1, text: '（未接入剧情流）' })
  }
  for (const n of group.detached)
    rows.push(...nodeRows(n, edges, byId, fulfillment, ''))
  return rows
}

/** 导出大纲分组：集号升序、未分集殿底；组内按剧情流展开（分区与排序
 * 共用 storylineGroups 规范实现）。 */
export function buildExportOutline(
  nodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
): ExportOutlineGroup[] {
  const narrative = nodes.filter(isOutlineNode)
  const byId = new Map(narrative.map((n) => [n.id, n as CanvasNode]))
  const fulfillment = beatFulfillmentMap(nodes, edges)
  return storylineGroups(narrative, edges).map((group) => ({
    episode: group.episode,
    // 未分集组无标题；episodeNo 索引仅在非空组执行（noUncheckedIndexedAccess）
    title: group.episode === null ? '' : text(episodeTitles[group.episode]),
    rows: groupRows(group, edges, byId, fulfillment),
  }))
}

/** 导出范围概要：只统计画布实际内容，不从文案反推。 */
export function summariseExportOutline(
  nodes: CanvasNode[],
): ExportOutlineSummary {
  const narrative = nodes.filter(isOutlineNode)
  const episodes = [
    ...new Set(
      narrative.map((n) => (n.data as { episodeNo?: unknown }).episodeNo),
    ),
  ]
    .filter((ep): ep is number => typeof ep === 'number')
    .sort((a, b) => a - b)
  const count = (type: CanvasNode['type']) =>
    narrative.filter((n) => n.type === type).length
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
