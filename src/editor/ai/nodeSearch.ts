/**
 * find_nodes 读工具的就地检索实现（issue #275 评审：被节选条目的可发现
 * 读取路径）。画布摘要按体积预算节选（graphDigest 计数上限），超出部分
 * 只留计数标记——模型按用户提到的名称无法定位未列出节点，也看不到被
 * 省略的连线关系。本模块按 id/名称/提示词/选项/台词检索**全部**节点
 * （含未列入摘要的条目），命中条目附其关联连线（sequence/branch 选项/
 * attach），配合 get_node（按 id 读全文）补齐「裁剪可识别且可按需补读」
 * 的闭环。工具结果自身同受总量预算约束（PR #294 评审）：预算按**整条目**
 * （节点块或单条连线）消费，游标始终等于实际已列数——截断标记给出的
 * offset 续读不会跳过或重复任何条目；行级截断（200/行）防单个合法长
 * 字段（上限 65,536 字符）携带全文。精确 id 命中优先进入单节点连线
 * 分页视图：合法 id 子串碰撞（n1 命中 n10）不阻连续线枚举。纯函数，
 * 标签与截断复用 graphDigest 的 spineNodeLabel / cut。
 */
import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionIdOf, edgeKindOf } from '../graphRules'
import { GRAPH_DIGEST_MAX_CHARS, cut, spineNodeLabel } from './graphDigest'
import type { CanvasNode } from '../nodes/types'

/** 多命中时的节点页大小：与 FIND_NODES_MAX 同值。 */
export const FIND_NODES_MAX = 24

/** 单节点命中的连线页大小上限：预算内尽量多列，实际以字符预算为准。 */
const EDGES_PAGE = 64

/** 多命中视图里单节点连线展示上限：更大全集用单查该节点 id 翻页枚举。 */
const EDGES_PER_NODE_MAX = 12

/** 结果行级截断：单个合法字段可达 65,536 字符，不逐行携带全文。 */
const LINE_MAX = 200

/** 条目累积预算：为页尾游标标记预留头寸，保证总长不超过总量预算。 */
const PAGE_BUDGET = GRAPH_DIGEST_MAX_CHARS - 200

/** 各类型的可检索文本（小写）：id（已知 id 查其关联连线）+ 用户会提到
 * 的名称/提示词/选项/台词。 */
function searchBody(n: CanvasNode): string {
  switch (n.type) {
    case 'scene':
      return `${n.id} ${n.data.name} ${n.data.synopsis}`.toLowerCase()
    case 'beat':
      return `${n.id} ${n.data.name} ${n.data.tone}`.toLowerCase()
    case 'dialogue':
      return [n.id, n.data.name, ...n.data.lines.map((l) => l.text)]
        .join(' ')
        .toLowerCase()
    case 'branch':
      return `${n.id} ${n.data.prompt} ${n.data.options.map((o) => o.label).join(' ')}`.toLowerCase()
    case 'shot':
      return `${n.id} ${n.data.size} ${n.data.picture} ${n.data.prompt}`.toLowerCase()
    case 'image':
      return `${n.id} ${n.data.prompt}`.toLowerCase()
  }
}

/**
 * 单条关联连线行：kind + 端点 id（branch 带选项文案）。端点是补读路径
 * 的连线可发现性所在（get_node 不返回连线、摘要侧连线另有条数节选），
 * 属不可裁剪部分——选项文案按行预算余量裁剪（PR #294 评审），不整行
 * 截断到端点之前。
 */
function edgeLine(e: Edge, nodes: CanvasNode[]): string {
  const kind = edgeKindOf(e)
  const endpoints = `${e.source} → ${e.target}`
  if (kind === 'branch') {
    const src = nodes.find((n) => n.id === e.source)
    const optId = branchOptionIdOf(e.sourceHandle)
    const opt =
      src?.type === 'branch'
        ? src.data.options.find((o) => o.id === optId)
        : undefined
    const labelBudget = Math.max(0, LINE_MAX - endpoints.length - 24)
    return `  - branch(选项${cut(opt?.label ?? '?', labelBudget)}): ${endpoints}`
  }
  if (kind === 'attach' || e.sourceHandle === SCENE_SHOT_HANDLE) {
    return `  - attach: ${endpoints}`
  }
  return `  - sequence: ${endpoints}`
}

/** 节点在多命中视图中的展示块：节点行 + 前若干条连线 + 连线溢出指引。 */
function nodeBlock(
  n: CanvasNode,
  nodes: CanvasNode[],
  edges: Edge[],
): string[] {
  const hit = edges.filter((e) => e.source === n.id || e.target === n.id)
  return [
    `- ${n.id} ${spineNodeLabel(n)}（${n.type}）`,
    ...hit.slice(0, EDGES_PER_NODE_MAX).map((e) => edgeLine(e, nodes)),
    ...(hit.length > EDGES_PER_NODE_MAX
      ? [
          `  （另有 ${hit.length - EDGES_PER_NODE_MAX} 条连线未列出；单查该节点 id 可翻页枚举全部）`,
        ]
      : []),
  ]
}

/** 单节点命中的连线分页视图：按字符预算逐条列入，游标 = 实际已列数。 */
function singleNodeLines(
  target: CanvasNode,
  nodes: CanvasNode[],
  edges: Edge[],
  offset: number,
  query: string,
): string[] {
  const hit = edges.filter(
    (e) => e.source === target.id || e.target === target.id,
  )
  const lines = [
    `匹配「${query}」的节点（含摘要未列出的条目）：`,
    `- ${target.id} ${cut(spineNodeLabel(target), LINE_MAX)}（${target.type}）`,
  ]
  let used = lines.reduce((sum, l) => sum + l.length + 1, 0)
  let listed = 0
  for (const e of hit.slice(offset, offset + EDGES_PAGE)) {
    const line = cut(edgeLine(e, nodes), LINE_MAX)
    if (used + line.length + 1 > PAGE_BUDGET && listed > 0) break
    lines.push(line)
    used += line.length + 1
    listed += 1
  }
  const rest = hit.length - offset - listed
  if (rest > 0) {
    lines.push(
      `  （另有 ${rest} 条连线未列出；find_nodes("${target.id}", offset=${
        offset + listed
      }) 继续枚举）`,
    )
  }
  return lines
}

/** 多命中的节点分页视图：按字符预算整块列入节点，游标 = 实际已列数。 */
function pageLines(
  matched: CanvasNode[],
  nodes: CanvasNode[],
  edges: Edge[],
  offset: number,
  query: string,
): string[] {
  const header = `匹配「${query}」的节点（含摘要未列出的条目）：`
  const lines = [header]
  let used = header.length + 1
  let consumed = 0
  const pageEnd = Math.min(matched.length, offset + FIND_NODES_MAX)
  for (let i = offset; i < pageEnd; i += 1) {
    const block = nodeBlock(matched[i]!, nodes, edges).map((l) =>
      cut(l, LINE_MAX),
    )
    const cost = block.reduce((sum, l) => sum + l.length + 1, 0)
    if (used + cost > PAGE_BUDGET && consumed > 0) break
    lines.push(...block)
    used += cost
    consumed += 1
  }
  const rest = matched.length - offset - consumed
  if (rest > 0) {
    const hitBudget = consumed > 0 && offset + consumed < pageEnd
    lines.push(
      `（${hitBudget ? '本页已达字符预算，' : ''}另有 ${rest} 个匹配未列出，已列到第 ${
        offset + consumed
      } 个；find_nodes("${query.trim()}", offset=${offset + consumed}) 继续）`,
    )
  }
  return lines
}

/** find_nodes 检索结果：精确 id 命中优先进入单节点连线分页视图；否则
 * 模糊检索（多命中按节点翻页，每节点附前 12 条连线）。 */
export function findNodesText(
  nodes: CanvasNode[],
  edges: Edge[],
  query: string,
  offset = 0,
): string {
  if (typeof query !== 'string' || query.trim() === '') {
    return (
      'find_nodes 需要 query 参数：按 id/名称/提示词/选项/台词检索全部节点' +
      '（含画布摘要因体积预算未列出的条目），命中条目附其关联连线；' +
      '精确 id 直接进入该节点连线分页视图，offset 分页（多命中按节点、' +
      '单命中按该节点连线）。'
    )
  }
  const trimmed = query.trim()
  const exact = nodes.find((n) => n.id === trimmed)
  if (exact) {
    return singleNodeLines(exact, nodes, edges, offset, trimmed).join('\n')
  }
  const q = trimmed.toLowerCase()
  const matched = nodes.filter((n) => searchBody(n).includes(q))
  if (matched.length === 0) {
    return `未找到匹配「${query}」的节点；可换关键词重试（大小写不敏感），或改用精确节点 id。`
  }
  const lines =
    matched.length === 1
      ? singleNodeLines(matched[0]!, nodes, edges, offset, trimmed)
      : pageLines(matched, nodes, edges, offset, trimmed)
  return lines.join('\n')
}
