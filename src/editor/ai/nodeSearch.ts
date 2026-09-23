/**
 * find_nodes 读工具的就地检索实现（issue #275 评审：被节选条目的可发现
 * 读取路径）。画布摘要按体积预算节选（graphDigest 计数上限），超出部分
 * 只留计数标记——模型按用户提到的名称无法定位未列出节点，也看不到被
 * 省略的连线关系。本模块按 id/名称/提示词/选项/台词检索**全部**节点
 * （含未列入摘要的条目），命中条目附其关联连线（sequence/branch 选项/
 * attach），配合 get_node（按 id 读全文）补齐「裁剪可识别且可按需补读」
 * 的闭环。工具结果自身同受总量预算约束（PR #294 评审）：行级截断 +
 * 24,000 字符硬上限，多命中翻节点页（24/页）、单节点命中翻连线页
 * （64/页），截断处均给出 offset 续读入口。纯函数，标签与截断复用
 * graphDigest 的 spineNodeLabel / cut（同一格式，不做第二实现）。
 */
import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionIdOf, edgeKindOf } from '../graphRules'
import { GRAPH_DIGEST_MAX_CHARS, cut, spineNodeLabel } from './graphDigest'
import type { CanvasNode } from '../nodes/types'

/** 多命中时的节点页大小：与 FIND_NODES_MAX 同值。 */
export const FIND_NODES_MAX = 24

/** 单节点命中的连线页大小：行短（端点 id + 选项文案），可容纳更大页。 */
const EDGES_PAGE = 64

/** 多命中视图里单节点连线展示上限：更大全集用单查该节点 id 翻页枚举。 */
const EDGES_PER_NODE_MAX = 12

/** 结果行级截断：单个合法字段可达 65,536 字符，不逐行携带全文。 */
const LINE_MAX = 200

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

/** 单条关联连线行：kind + 端点 id（branch 带选项文案）。 */
function edgeLine(e: Edge, nodes: CanvasNode[]): string {
  const kind = edgeKindOf(e)
  if (kind === 'branch') {
    const src = nodes.find((n) => n.id === e.source)
    const optId = branchOptionIdOf(e.sourceHandle)
    const opt =
      src?.type === 'branch'
        ? src.data.options.find((o) => o.id === optId)
        : undefined
    return `  - branch(选项${opt?.label ?? '?'}): ${e.source} → ${e.target}`
  }
  if (kind === 'attach' || e.sourceHandle === SCENE_SHOT_HANDLE) {
    return `  - attach: ${e.source} → ${e.target}`
  }
  return `  - sequence: ${e.source} → ${e.target}`
}

/** 字符硬上限：截断并声明未发送量与续读入口。 */
function clampResult(text: string): string {
  if (text.length <= GRAPH_DIGEST_MAX_CHARS) return text
  const marker = `（结果超出 ${GRAPH_DIGEST_MAX_CHARS} 字符预算，已截断约 ${
    text.length - GRAPH_DIGEST_MAX_CHARS
  } 字符；用更具体的关键词或 offset 分页读取）`
  const keep = GRAPH_DIGEST_MAX_CHARS - marker.length - 1
  return `${text.slice(0, keep)}\n${marker}`
}

/** find_nodes 检索结果：多命中翻节点页（offset 起的 24 个），每节点附
 * 前 12 条连线；单节点命中翻连线页（offset 起的 64 条）——枢纽节点的
 * 全部出口可枚举。 */
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
      'offset 分页（多命中按节点、单命中按该节点连线）。'
    )
  }
  const q = query.trim().toLowerCase()
  const matched = nodes.filter((n) => searchBody(n).includes(q))
  if (matched.length === 0) {
    return `未找到匹配「${query}」的节点；可换关键词重试（大小写不敏感）。`
  }
  const lines =
    matched.length === 1
      ? singleNodeLines(matched[0]!, nodes, edges, offset, query)
      : pageLines(matched, nodes, edges, offset, query)
  return clampResult(lines.map((l) => cut(l, LINE_MAX)).join('\n'))
}

/** 单节点命中：该节点 + 其连线分页（offset 起的 EDGES_PAGE 条）。 */
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
  const page = hit.slice(offset, offset + EDGES_PAGE)
  const rest = hit.length - offset - page.length
  return [
    `匹配「${query}」的节点（含摘要未列出的条目）：`,
    `- ${target.id} ${spineNodeLabel(target)}（${target.type}）`,
    ...page.map((e) => edgeLine(e, nodes)),
    ...(rest > 0
      ? [
          `  （另有 ${rest} 条连线未列出；find_nodes("${target.id}", offset=${
            offset + EDGES_PAGE
          }) 继续枚举）`,
        ]
      : []),
  ]
}

/** 多命中：节点分页（offset 起的 FIND_NODES_MAX 个），每节点附前
 * EDGES_PER_NODE_MAX 条连线；剩余连线以单查 id 的翻页入口声明。 */
function pageLines(
  matched: CanvasNode[],
  nodes: CanvasNode[],
  edges: Edge[],
  offset: number,
  query: string,
): string[] {
  const page = matched.slice(offset, offset + FIND_NODES_MAX)
  const rest = matched.length - offset - page.length
  const lines: string[] = [
    `匹配「${query}」的节点（含摘要未列出的条目）：`,
    ...page.flatMap((n) => {
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
    }),
    ...(rest > 0
      ? [
          `（另有 ${rest} 个匹配未列出；find_nodes("${query.trim()}", offset=${
            offset + FIND_NODES_MAX
          }) 继续）`,
        ]
      : []),
  ]
  return lines
}
