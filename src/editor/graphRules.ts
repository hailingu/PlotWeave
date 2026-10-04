/**
 * 连线规则的纯函数（docs/ui-design.md §4.3 连线实时校验）。
 * 画布交互（EditorView.isValidConnection）与 AI 批量命令校验
 * （ai/commands.ts）共用同一套语义，避免两处判定分叉。
 *
 * 类型所有权（issue #353 方向一）：端口字面量、选项句柄编码与连线语义
 * 判别是落盘格式的一部分，由 src/model/graphSemantics.ts 单点定义，本模块
 * 再导出对接交互层；连接校验等交互专属规则保留在此。
 */
import {
  branchOptionHandle,
  branchOptionIdOf,
  edgeKindOf,
  SCENE_SHOT_HANDLE,
  type EdgeKind,
} from '../model/graphSemantics'

export {
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  branchOptionHandle,
  branchOptionIdOf,
  edgeKindOf,
  type EdgeKind,
} from '../model/graphSemantics'

/** 最小边形状：只需端点，兼容 React Flow Edge 与批量校验的虚拟边。 */
export interface EndpointPair {
  source: string
  target: string
}

/** 删选项级联（§8.2.2）：返回「前态有、新态无」选项的出口句柄，
 * 供调用方把对应的 branch 边一并删除（同一撤销单元）；重排不影响。 */
export function removedOptionHandles(
  prev: Array<{ id: string }>,
  next: Array<{ id: string }>,
): string[] {
  const kept = new Set(next.map((o) => o.id))
  return prev
    .filter((o) => !kept.has(o.id))
    .map((o) => branchOptionHandle(o.id))
}

/** 连线端点类型约束（§5 端口归属，§13 图片节点）：与加载归一化的孤儿边
 * 规则对等——交互/AI 侧放行一条「保存后下次加载即被静默删除」的连线是
 * 坏体验。剧情流（sequence/branch）端点不得为分镜卡或图片节点（图片节点
 * 是自由摆放的生成产物，不经边挂接）；sequence/attach 不得以分支为
 * source（分支只经选项出口）；attach 必须场景 → 分镜卡。
 * 返回拒绝原因，null 表示通过；端点类型未知不在此判定（存在性另行校验）。 */
export function connectionEndpointIssue(
  sourceType: string | undefined,
  targetType: string | undefined,
  kind: EdgeKind,
): string | null {
  if (kind === 'attach') {
    if (sourceType === 'branch')
      return '分支没有下挂端口（attach 须场景 → 分镜卡）'
    if (sourceType !== 'scene' || targetType !== 'shot') {
      return 'attach 下挂连线必须是场景 → 分镜卡'
    }
    return null
  }
  if (sourceType === 'shot' || targetType === 'shot') {
    return '分镜卡不参与剧情流（attach 之外的端点不得为分镜卡）'
  }
  if (sourceType === 'image' || targetType === 'image') {
    return '图片节点不参与剧情流（生成产物自由摆放，无连线端口）'
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
    sourceHandle?: string | null | undefined
    className?: string | undefined
    type?: string | undefined
  }>,
  target: string,
): boolean {
  for (const e of edges) {
    if (e.target === target && edgeKindOf(e) === 'attach') return true
  }
  return false
}

/** 拖线瞬间的连线语义归类：React Flow 的 Connection 不带 type/className，
 * 语义只能从端口推出——选项出口端口（option-<id>）即 branch、下挂端口即
 * attach、其余 sequence。与 edgeKindOf 分工：edgeKindOf 按已入库边的显式
 * 字段归类（落盘边 kind 显式，option-* 端口不得反推），本函数只用于
 * isValidConnection 的交互判定——误归 sequence 会被「分支不得以 sequence
 * 连出」拒绝，分支选项的连线全部拖不出来。 */
export function connectionKindOf(conn: {
  sourceHandle?: string | null
}): EdgeKind {
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
 * branch 选项出口 / attach 下挂 / 默认 sequence。胶囊文案由 BranchEdge
 * 按 sourceHandle 从源节点实时派生，运行态不落 data 镜像（issue #18）。 */
export function connectEdgeExtras(
  fromBranchOption: boolean,
  fromShotHandle: boolean,
): { type?: 'branch'; className?: string } {
  if (fromBranchOption) return { type: 'branch' as const }
  if (fromShotHandle) return { className: 'pw-edge-attach' }
  return { className: 'pw-edge-sequence' }
}

/** 同端点重复边；sourceHandle 不同视为不同端口的不同边。 */
export function isDuplicateEdge(
  edges: Iterable<EndpointPair & { sourceHandle?: string | null | undefined }>,
  conn: EndpointPair & { sourceHandle?: string | null | undefined },
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
