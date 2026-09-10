import { wouldCreateCycle, type EndpointPair } from '../graphRules'

/**
 * 失败连线变更的登记簿记（batchFold.ts 拆分，评审迭代域）：失败的
 * connect/disconnect 以「op + 模型自报端点 token」为键登记（含拼错的
 * 端点），失败断线另存同对残留边的身份快照——供后续连线判定「修正这条
 * 断线能否消除环」（contingent 自愈）。共享状态由 batchFold.FoldState
 * 经 FailedEdgeHost 接口供给（同 TentativeEdgeHost 模式）。
 */

/** 折叠校验的虚拟边：端点 + 源端口/连线类型（与 AiGraphSnapshot.edges 同形）。 */
export type VirtualEdge = EndpointPair & { sourceHandle?: string | null; type?: string }

/** 失败连线簿记共享的折叠状态（batchFold.FoldState 经此接口供给）。 */
export interface FailedEdgeHost {
  virtualEdges: VirtualEdge[]
  /** 本批失败的连线变更（op + 原始端点 token 对）→ 失败断线登记时同对
   * 残留边的身份快照（失败连线命令为空集）：依赖其变更结果的后续连线
   * 命令按 contingent 跳过。快照用于判定「修正这条断线能否消除环」——
   * 本批后加的边不在快照内，不随之自愈。 */
  failedEdgePairs: Map<string, ReadonlySet<string>>
}

/** 失败连线变更的原始端点对键（op + 模型自报 token，含拼错的端点）。 */
export function edgePairKey(op: string, source: string, target: string): string {
  return `${op}\u0000${source}\u0000${target}`
}

/** 虚拟边身份键（端点 + 源端口）：失败断线的残留快照与当前边按此比对。 */
export function edgeIdentityOf(e: VirtualEdge): string {
  return `${e.source}\u0000${e.target}\u0000${e.sourceHandle ?? ''}`
}

/** 失败断线登记时的同对残留边快照（含端点写反：两方向都算同一对）：
 * 修正断线只可能移除这些边；快照外的边由本批后续命令新增，修正后仍在。 */
export function residualEdgesAt(st: FailedEdgeHost, source: string, target: string): ReadonlySet<string> {
  return new Set(
    st.virtualEdges
      .filter((e) => (e.source === source && e.target === target) || (e.source === target && e.target === source))
      .map(edgeIdentityOf),
  )
}

/** 残留边快照全部移除后即不成环 → 这条环随断线修正自愈，按 contingent
 * 跳过；环依赖快照外（本批新增）的边时独立点名，不被早先断线失败豁免。 */
export function residualBreaksCycle(
  st: FailedEdgeHost,
  pairKey: string,
  flow: readonly VirtualEdge[],
  src: string,
  dst: string,
): boolean {
  const residual = st.failedEdgePairs.get(pairKey)
  if (residual === undefined || residual.size === 0) return false
  const remaining = flow.filter((e) => !residual.has(edgeIdentityOf(e)))
  return !wouldCreateCycle(remaining, src, dst)
}
