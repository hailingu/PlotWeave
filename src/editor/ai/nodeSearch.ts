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

/** 查询回显上限：页头不原样回显模型给出的超长检索串。 */
const ECHO_MAX = 60

/** id 展示上限：超长 id（运行态原样保留的脏数据）缩写展示并声明；
 * 完整 id 可经绑定原始 ID 的句柄分段读取。 */
const ID_MAX = 80

/** id 的有界展示：超长时缩写并附带声明。 */
function idOf(id: string): string {
  return id.length > ID_MAX ? `${id.slice(0, ID_MAX)}…（id 已缩写）` : id
}

/** id 分段段长：单段远低于预算；段本身不做行级截断（各段按序拼接
 * 无损还原完整 id）。 */
const ID_SEGMENT = 8_000

/**
 * 「id:<前缀>」模式：唯一前缀搜索或绑定原始 ID 指纹的稳定句柄，
 * 按 offset（=段号，1 起）分段返回完整 id；多命中列出候选句柄。
 * 无指纹的旧位置句柄拒绝解析，避免画布增删后指向错误节点。
 */
function idSegments(
  nodes: CanvasNode[],
  prefix: string,
  offset: number,
): string {
  if (STABLE_REF.test(prefix)) {
    const target = handleTarget(nodes, prefix)
    if (!target) return '句柄目标不在当前画布或句柄冲突；请重新检索节点。'
    return segmentsOf(target.id, ordinalRef(target.id, nodes), offset)
  }
  if (/#\d+$/.test(prefix)) {
    return '旧序号句柄不再支持；请重新按名称或前缀检索，使用绑定节点 ID 的新句柄。'
  }
  if (/#\d+~/.test(prefix)) {
    return '无效或过期句柄；请重新检索节点。'
  }
  const matches = nodes.filter((n) => n.id.startsWith(prefix))
  if (matches.length > 1) {
    // 列表序号只供辨认；实际句柄携带原始 ID 指纹，画布增删后仍定位原节点。
    return [
      `id 前缀命中 ${matches.length} 个节点，前缀不足定位。候选按画布顺序编号：`,
      ...matches
        .slice(0, FIND_NODES_MAX)
        .map(
          (n, i) =>
            `- #${i + 1} ${idOf(n.id)}；find_nodes(${idHandleQuery(n.id, nodes)}, offset=1)`,
        ),
      ...(matches.length > FIND_NODES_MAX
        ? [
            `（另有 ${matches.length - FIND_NODES_MAX} 个命中未列出，请加长前缀缩小范围）`,
          ]
        : []),
      '（使用候选行的句柄读取完整 id；或加长前缀）',
    ].join('\n')
  }
  if (matches.length === 0) {
    return `没有 id 以「${cut(prefix, ECHO_MAX)}」开头的节点；请使用检索结果中给出的前缀（或「前缀#序号」直达句柄）。`
  }
  return segmentsOf(matches[0]!.id, ordinalRef(matches[0]!.id, nodes), offset)
}

/** 单个完整 id 的分段读取（offset=段号，1 起）；ref 绑定原始 ID，
 * 各段提示一致携带，多段恢复不退化为碰撞列表。 */
function segmentsOf(id: string, ref: string, offset: number): string {
  const parts = Math.ceil(id.length / ID_SEGMENT)
  const part = Math.min(Math.max(offset, 1), parts)
  const segment = id.slice((part - 1) * ID_SEGMENT, part * ID_SEGMENT)
  const lines = [
    `节点 ${idOf(id)} 完整 id 第 ${part}/${parts} 段（总长 ${id.length} 字符）：`,
    segment,
  ]
  if (part < parts) {
    const query = JSON.stringify('id:' + ref)
    lines.push(
      `（find_nodes(${query}, offset=${part + 1}) 读下一段；各段按序拼接为完整 id）`,
    )
  }
  return lines.join('\n')
}

/** 固定长 ID 指纹只用于本地句柄身份匹配，不承担鉴权。 */
function idFingerprint(id: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  let c = 0x85ebca6b
  let d = 0xc2b2ae35
  for (let i = 0; i < id.length; i += 1) {
    // i < id.length 保证这里必有码点；指纹按固定索引扫描原始字符串。
    const code = id.codePointAt(i)!
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x27d4eb2d)
    c = Math.imul(c ^ code, 0x165667b1)
    d = Math.imul(d ^ code, 0x9e3779b1)
  }
  return [a, b, c, d]
    .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

/** 句柄语法：序号供阅读，指纹绑定原始 ID；前缀可含任意字符。 */
const STABLE_REF = /^([\s\S]*)#([1-9]\d*)~([0-9a-f]{32})$/

/** 仅在指纹与前缀共同唯一定位时接受句柄；删除与碰撞均显式失效。 */
function handleTarget(nodes: CanvasNode[], ref: string): CanvasNode | null {
  const match = STABLE_REF.exec(ref)
  if (!match) return null
  const hits = nodes.filter(
    (n) => n.id.startsWith(match[1]!) && idFingerprint(n.id) === match[3],
  )
  return hits.length === 1 ? hits[0]! : null
}

/** 节点句柄：80 字符前缀 + 展示序号 + 原始 ID 指纹。 */
function ordinalRef(id: string, nodes: CanvasNode[]): string {
  const base = id.slice(0, ID_MAX)
  const ordinal =
    nodes.filter((n) => n.id.startsWith(base)).findIndex((n) => n.id === id) + 1
  return `${base}#${ordinal}~${idFingerprint(id)}`
}

/** 供工具提示使用的 JSON 编码 ID 句柄查询。 */
function idHandleQuery(id: string, nodes: CanvasNode[]): string {
  return JSON.stringify('id:' + ordinalRef(id, nodes))
}

/** 缩写 id 的恢复提示行：使用绑定原始 ID 的分段读取句柄。 */
function idHint(id: string, nodes: CanvasNode[]): string[] {
  return id.length > ID_MAX
    ? [
        `  （id 超长已缩写；完整 id 分段读取：find_nodes(${idHandleQuery(id, nodes)}, offset=1)）`,
      ]
    : []
}

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
  const endpoints = `${idOf(e.source)} → ${idOf(e.target)}`
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
    `- ${idOf(n.id)} ${cut(spineNodeLabel(n), LINE_MAX)}（${n.type}）`,
    ...idHint(n.id, nodes),
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
    `匹配「${cut(query, ECHO_MAX)}」的节点（含摘要未列出的条目）：`,
    `- ${idOf(target.id)} ${cut(spineNodeLabel(target), LINE_MAX)}（${target.type}）`,
    ...idHint(target.id, nodes),
  ]
  const continuationQuery = JSON.stringify(
    target.id.length > ID_MAX
      ? `node:${ordinalRef(target.id, nodes)}`
      : target.id,
  )
  const pageBudget = PAGE_BUDGET - continuationQuery.length
  let used = lines.reduce((sum, l) => sum + l.length + 1, 0)
  let listed = 0
  for (const e of hit.slice(offset, offset + EDGES_PAGE)) {
    const line = cut(edgeLine(e, nodes), LINE_MAX)
    if (used + line.length + 1 > pageBudget && listed > 0) break
    lines.push(line)
    used += line.length + 1
    listed += 1
  }
  const rest = hit.length - offset - listed
  if (rest > 0) {
    lines.push(
      `  （另有 ${rest} 条连线未列出；find_nodes(${continuationQuery}, offset=${offset + listed}) 继续枚举）`,
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
  const header = `匹配「${cut(query, ECHO_MAX)}」的节点（含摘要未列出的条目）：`
  const lines = [header]
  // 续页必须保持原查询语义；过长查询由调用方复用原始 query，避免提示突破预算。
  const serializedQuery = JSON.stringify(query.trim())
  const nextQuery = serializedQuery.length <= 1_000 ? serializedQuery : null
  const pageBudget = PAGE_BUDGET - (nextQuery?.length ?? 0)
  let used = header.length + 1
  let consumed = 0
  const pageEnd = Math.min(matched.length, offset + FIND_NODES_MAX)
  for (let i = offset; i < pageEnd; i += 1) {
    const block = nodeBlock(matched[i]!, nodes, edges).map((l) =>
      cut(l, LINE_MAX),
    )
    const cost = block.reduce((sum, l) => sum + l.length + 1, 0)
    if (used + cost > pageBudget && consumed > 0) break
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
      } 个；${
        nextQuery
          ? `find_nodes(${nextQuery}, offset=${offset + consumed}) 继续`
          : `请以本次原始 query 和 offset=${offset + consumed} 调用 find_nodes 继续`
      }）`,
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
  if (trimmed.startsWith('id:')) {
    return idSegments(nodes, trimmed.slice(3), offset)
  }
  if (trimmed.startsWith('node:')) {
    if (!STABLE_REF.test(trimmed.slice(5))) {
      return '无效节点句柄；请重新检索节点。'
    }
    const target = handleTarget(nodes, trimmed.slice(5))
    return target
      ? singleNodeLines(target, nodes, edges, offset, trimmed).join('\n')
      : '句柄目标不在当前画布或句柄冲突；请重新检索节点。'
  }
  const q = trimmed.toLowerCase()
  const matched = nodes.filter((n) => searchBody(n).includes(q))
  if (matched.length === 0) {
    return `未找到匹配「${cut(trimmed, ECHO_MAX)}」的节点；可换关键词重试（大小写不敏感），或改用精确节点 id。`
  }
  const lines =
    matched.length === 1
      ? singleNodeLines(matched[0]!, nodes, edges, offset, trimmed)
      : pageLines(matched, nodes, edges, offset, trimmed)
  return lines.join('\n')
}
