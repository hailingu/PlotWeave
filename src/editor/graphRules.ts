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

/** 分支选项出口端口前缀：option-<选项 id>。绑定稳定 id 而非数组下标，
 * 删除任一选项不会位移其余出口的连线归属（docs/data-model.md §4.2/§5）。 */
export const BRANCH_OPTION_HANDLE_PREFIX = 'option-'

export function branchOptionHandle(optionId: string): string {
  return `${BRANCH_OPTION_HANDLE_PREFIX}${optionId}`
}

/** 逆解析端口名中的选项 id；非选项端口返回 undefined。 */
export function branchOptionIdOf(handle?: string | null): string | undefined {
  if (!handle?.startsWith(BRANCH_OPTION_HANDLE_PREFIX)) return undefined
  return handle.slice(BRANCH_OPTION_HANDLE_PREFIX.length)
}

/** 删选项级联（§8.2.2）：返回「前态有、新态无」选项的出口句柄，
 * 供调用方把对应的 branch 边一并删除（同一撤销单元）；重排不影响。 */
export function removedOptionHandles(
  prev: Array<{ id: string }>,
  next: Array<{ id: string }>,
): string[] {
  const kept = new Set(next.map((o) => o.id))
  return prev.filter((o) => !kept.has(o.id)).map((o) => branchOptionHandle(o.id))
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

/** 新连线的差异化字段（§4.4，EditorView.onConnect 用）：
 * branch 选项出口 / attach 下挂 / 默认 sequence。 */
export function connectEdgeExtras(
  fromBranchOption: boolean,
  branchData: { optionLabel: string } | undefined,
  fromShotHandle: boolean,
): { type?: 'branch'; data?: { optionLabel: string }; className?: string } {
  if (fromBranchOption) return { type: 'branch' as const, data: branchData }
  if (fromShotHandle) return { className: 'pw-edge-attach' }
  return { className: 'pw-edge-sequence' }
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
