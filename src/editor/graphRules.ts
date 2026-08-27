/**
 * 连线规则的纯函数（docs/ui-design.md §4.3 连线实时校验）。
 * 画布交互（EditorView.isValidConnection）与 AI 批量命令校验
 * （ai/commands.ts）共用同一套语义，避免两处判定分叉。
 */

/** 最小边形状：只需端点，兼容 React Flow Edge 与批量校验的虚拟边。 */
export interface EndpointPair {
  source: string
  target: string
}

/** 索引卡底部端口：attach 下挂分镜卡（§4.4 垂直 = 派生从属）。 */
export const SCENE_SHOT_HANDLE = 'shots'

/** 分支选项出口端口前缀（0 基）：option-0、option-1…。 */
export const BRANCH_OPTION_HANDLE_PREFIX = 'option-'

export function branchOptionHandle(index: number): string {
  return `${BRANCH_OPTION_HANDLE_PREFIX}${index}`
}

/** 连线语义（§4.4）：横向剧情流 / 分支选项出口 / 分镜下挂。 */
export type EdgeKind = 'sequence' | 'branch' | 'attach'

/** 按边的运行态字段归类连线语义；未知形态一律按剧情流处理。 */
export function edgeKindOf(e: {
  type?: string
  className?: string
  sourceHandle?: string | null
}): EdgeKind {
  if (e.type === 'branch') return 'branch'
  if (e.sourceHandle === SCENE_SHOT_HANDLE || e.className === 'pw-edge-attach') return 'attach'
  return 'sequence'
}

/**
 * 成环检测：从 target 沿现有边能否回到 source。
 * 返回 true 表示这条连线会造成环（自环由调用方先行排除）。
 */
export function wouldCreateCycle(
  edges: Iterable<EndpointPair>,
  source: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>()
  for (const e of edges) {
    const list = adjacency.get(e.source) ?? []
    list.push(e.target)
    adjacency.set(e.source, list)
  }
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of adjacency.get(cur) ?? []) stack.push(next)
  }
  return false
}

/** 同端点重复边；sourceHandle 不同视为不同端口的不同边。 */
export function isDuplicateEdge(
  edges: Iterable<EndpointPair & { sourceHandle?: string | null }>,
  conn: EndpointPair & { sourceHandle?: string | null },
): boolean {
  for (const e of edges) {
    if (
      e.source === conn.source &&
      e.target === conn.target &&
      (e.sourceHandle ?? null) === (conn.sourceHandle ?? null)
    ) {
      return true
    }
  }
  return false
}
