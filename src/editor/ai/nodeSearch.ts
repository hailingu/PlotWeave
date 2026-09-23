/**
 * find_nodes 读工具的就地检索实现（issue #275 评审：被节选条目的可发现
 * 读取路径）。画布摘要按体积预算节选（graphDigest 计数上限），超出部分
 * 只留计数标记——模型按用户提到的名称无法定位未列出节点，也看不到被
 * 省略的连线关系。本模块按名称/提示词/选项/台词全文检索**全部**节点
 * （含未列入摘要的条目），命中条目附其全部关联连线（sequence/branch
 * 选项/attach），配合 get_node（按 id 读全文）补齐「裁剪可识别且可按需
 * 补读」的闭环。纯函数，标签复用 graphDigest 的 spineNodeLabel（同一
 * 格式，不做第二实现）。
 */
import type { Edge } from '@xyflow/react'
import { SCENE_SHOT_HANDLE, branchOptionIdOf, edgeKindOf } from '../graphRules'
import { spineNodeLabel } from './graphDigest'
import type { CanvasNode } from '../nodes/types'

/** 命中条目上限：防止宽关键词（单字）把检索本身变成第二次无界摘要。 */
export const FIND_NODES_MAX = 24

/** 单节点关联连线展示上限：超限计数声明。 */
const EDGES_PER_NODE_MAX = 12

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

/** 单个节点的关联连线行：kind + 端点 id（branch 带选项文案）。 */
function edgeLinesOf(
  nodeId: string,
  nodes: CanvasNode[],
  edges: Edge[],
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hit = edges.filter((e) => e.source === nodeId || e.target === nodeId)
  const shown = hit.slice(0, EDGES_PER_NODE_MAX).map((e) => {
    const kind = edgeKindOf(e)
    if (kind === 'branch') {
      const src = byId.get(e.source)
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
  })
  return hit.length > EDGES_PER_NODE_MAX
    ? [...shown, `  - （另有 ${hit.length - EDGES_PER_NODE_MAX} 条连线未列出）`]
    : shown
}

/** find_nodes 的检索结果文本：命中节点（含摘要未列出条目）+ 全部关联连线。 */
export function findNodesText(
  nodes: CanvasNode[],
  edges: Edge[],
  query: string,
): string {
  if (typeof query !== 'string' || query.trim() === '') {
    return (
      'find_nodes 需要 query 参数：按名称/提示词/选项/台词检索全部节点' +
      '（含画布摘要因体积预算未列出的条目），命中条目附其全部关联连线。'
    )
  }
  const q = query.trim().toLowerCase()
  const matched = nodes.filter((n) => searchBody(n).includes(q))
  if (matched.length === 0) {
    return `未找到匹配「${query}」的节点；可换关键词重试（大小写不敏感）。`
  }
  const shown = matched.slice(0, FIND_NODES_MAX)
  const lines: string[] = [
    `匹配「${query}」的节点（含摘要未列出的条目）：`,
    ...shown.flatMap((n) => [
      `- ${n.id} ${spineNodeLabel(n)}（${n.type}）`,
      ...edgeLinesOf(n.id, nodes, edges),
    ]),
  ]
  if (matched.length > FIND_NODES_MAX) {
    return [
      ...lines,
      `（另有 ${matched.length - FIND_NODES_MAX} 个匹配未列出；请用更具体的关键词缩小范围）`,
    ].join('\n')
  }
  return lines.join('\n')
}
