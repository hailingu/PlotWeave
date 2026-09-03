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

/** 选项 id → 出口端口名（option-<id>）：连线与句柄改写的统一构造器，
 * 消费方不得手拼前缀（口径与 BRANCH_OPTION_HANDLE_PREFIX 单点维护）。 */
export function branchOptionHandle(optionId: string): string {
  return `${BRANCH_OPTION_HANDLE_PREFIX}${optionId}`
}

/** 逆解析端口名中的选项 id；非选项端口返回 undefined。
 * JSON 边界会擦除类型（句柄可能是数字/对象），非字符串一律视为非选项端口，
 * 不得对非字符串调用字符串方法。 */
export function branchOptionIdOf(handle?: string | null): string | undefined {
  if (typeof handle !== 'string') return undefined
  if (!handle.startsWith(BRANCH_OPTION_HANDLE_PREFIX)) return undefined
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

/** 连线端点类型约束（§5 端口归属）：与加载归一化的孤儿边规则对等——
 * 交互/AI 侧放行一条「保存后下次加载即被静默删除」的连线是坏体验。
 * 剧情流（sequence/branch）端点不得为分镜卡；sequence/attach 不得以
 * 分支为 source（分支只经选项出口）；attach 必须场景 → 分镜卡。
 * 返回拒绝原因，null 表示通过；端点类型未知不在此判定（存在性另行校验）。 */
export function connectionEndpointIssue(
  sourceType: string | undefined,
  targetType: string | undefined,
  kind: EdgeKind,
): string | null {
  if (kind === 'attach') {
    if (sourceType === 'branch') return '分支没有下挂端口（attach 须场景 → 分镜卡）'
    if (sourceType !== 'scene' || targetType !== 'shot') {
      return 'attach 下挂连线必须是场景 → 分镜卡'
    }
    return null
  }
  if (sourceType === 'shot' || targetType === 'shot') {
    return '分镜卡不参与剧情流（attach 之外的端点不得为分镜卡）'
  }
  if (kind === 'sequence' && sourceType === 'branch') {
    return '分支只经选项出口连出（sequence 不得以分支为 source）'
  }
  return null
}

/** attach 宿主唯一（§5）：分镜卡至多一条入向下挂边，换宿主是
 * 「断开 + 重连」同 batch 原子操作。与加载侧 isolateExtraAttachHosts
 * 对等——交互/AI 侧放行第二宿主会留下「重开即消失」的连线。 */
export function hasAttachHost(
  edges: Iterable<{
    source: string
    target: string
    sourceHandle?: string | null
    className?: string
    type?: string
  }>,
  target: string,
): boolean {
  for (const e of edges) {
    if (e.target === target && edgeKindOf(e) === 'attach') return true
  }
  return false
}

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

/** 拖线瞬间的连线语义归类：React Flow 的 Connection 不带 type/className，
 * 语义只能从端口推出——选项出口端口（option-<id>）即 branch、下挂端口即
 * attach、其余 sequence。与 edgeKindOf 分工：edgeKindOf 按已入库边的显式
 * 字段归类（落盘边 kind 显式，option-* 端口不得反推），本函数只用于
 * isValidConnection 的交互判定——误归 sequence 会被「分支不得以 sequence
 * 连出」拒绝，分支选项的连线全部拖不出来。 */
export function connectionKindOf(conn: { sourceHandle?: string | null }): EdgeKind {
  if (branchOptionIdOf(conn.sourceHandle) !== undefined) return 'branch'
  if (conn.sourceHandle === SCENE_SHOT_HANDLE) return 'attach'
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
