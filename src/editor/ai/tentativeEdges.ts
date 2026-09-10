/**
 * contingent 出口连线的暂定投影与判重键簿记（batchFold.ts 拆分，评审
 * 迭代域）：依赖失败 branch options 更新的出口连线不进虚拟图，以「端点
 * + 原始下标」的未解析投影登记（raw:N 身份不绑定失败更新前的旧表，评审
 * 5169363253）——生效与否按当前选项表派生（activeTentativeEdges），表
 * 覆盖时重解析/级联退役（reresolveTentativeEdges），端点断线按执行通道
 * 语义移除全部匹配投影（dropTentativeEdge）；依赖失败 create 的连线以
 * ghost 判重键登记（createGhostConnectIssue 及释放/退役）。折叠状态由
 * batchFold.FoldState 经 TentativeEdgeHost 接口供给（同 EntityFoldHost
 * 模式，issue 44）。
 */

import { plainObject } from './patchShape'

/** 模块内文本 token 提取（batchFold.asText 同形；避免反向依赖）。 */
const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** contingent 出口边的暂定投影：登记时只保留原始下标（optionId 为 raw:
 * 哨兵、unresolvedIndex 记原始下标，评审 5169363253——失败更新前的旧表
 * id 不是绑定额）；表落定（成功或暂定生效）时经 reresolveTentativeEdges
 * 转为绑定稳定选项 id 的已解析投影（unresolvedIndex 缺省）。 */
export interface TentativeEdge {
  source: string
  target: string
  optionId: string
  unresolvedIndex?: number
}

/** 暂定投影簿记共享的折叠状态（batchFold.FoldState 经此接口供给）。 */
export interface TentativeEdgeHost {
  /** branch 节点 id → 选项列表（校验 optionIndex 并解析稳定选项 id 端口）。 */
  branchOptions: Map<string, Array<{ id: string; label: string }>>
  /** 依赖失败 options 更新的暂定出口边（端点与原始下标已确定、句柄与
   * 稳定 id 待表落定后解析；生效与否按当前选项表派生，见
   * activeTentativeEdges）。 */
  tentativeEdges: TentativeEdge[]
  /** 本批尚未删除的节点 id（含 __new__ 虚拟 id）。 */
  exists: Set<string>
  /** 节点 id → 类型（失败 create 的暂定类型由 registerFailedMutation 登记，
   * 供 contingent 端点的类型可判约束使用）。 */
  types: Map<string, string>
  /** ref 别名 → 所属节点 id（失败 create 指向未入图的虚拟 id，ghost
   * 判重键的端点身份经此解析）。 */
  refOwner: Map<string, string>
  /** 本批 options 更新失败的分支节点 id：其出口连线的 optionIndex 校验
   * 随前序修复自愈，按 contingent 跳过（同 ref 依赖，见 isContingentRef）。 */
  failedBranchOptionUpdates: Set<string>
  /** contingent 出口连线的判重键（端点 + 原始下标，raw: 域；表落定后经
   * 重解析转入 id: 域）：同键的后续连线无论修复后选项表如何都必然与前条
   * 同端口（重复或一同失效），首轮点名；绑定 id 被覆盖移除时随投影级联
   * 退役（见 reresolveTentativeEdges，评审 5164450788）；断线撤销登记与
   * 触及 options 的 contingent 更新按端点/源释放（ghost 域，评审
   * 5169363253）。 */
  contingentConnectKeys: Set<string>
}

/** optionIndex 的内在合法性（非负整数；不依赖选项表）：contingent 只豁免
 * 依赖修复后选项表的上界与句柄检查，内在非法值不随任何修复生效（评审
 * 5163320408）。类型谓词：通过即收窄为 number。 */
export const isIntrinsicOptionIndex = (idx: unknown): idx is number =>
  typeof idx === 'number' && Number.isInteger(idx) && idx >= 0

/** contingent 出口连线登记（foldConnectEdge 拆出，S3776）：身份只保留
 * 原始下标（raw:N 哨兵 + unresolvedIndex，评审 5169363253）——失败更新
 * 前的旧表 id 不是模型意图的代理（修复后的表才是绑定额），表落定（成功
 * 或暂定生效）时经 reresolveTentativeEdges 重解析才绑定稳定 id。同端点
 * 同下标的重复连线返回 false：无论修复后表如何，两条必然同端口（重复或
 * 一同失效），首轮点名；断线撤销登记时按键释放（dropTentativeEdge）。 */
export function registerTentativeEdge(
  st: TentativeEdgeHost,
  cmd: Record<string, unknown>,
  src: string,
  dst: string,
): boolean {
  const idx = cmd.optionIndex
  if (!isIntrinsicOptionIndex(idx)) return true
  const key = `${src}\u0000${dst}\u0000raw:${idx}`
  if (st.contingentConnectKeys.has(key)) return false
  st.contingentConnectKeys.add(key)
  st.tentativeEdges.push({ source: src, target: dst, optionId: `raw:${idx}`, unresolvedIndex: idx })
  return true
}

/** 生效的暂定出口边登记（评审 5164170010）：端点仍在、解析投影的稳定
 * 选项 id 仍在当前选项表内（表覆盖移除时已级联退役，见
 * reresolveTentativeEdges）；未解析投影（下标越出登记时的表长）在其
 * contingent 期（失败更新未修复）生效，表覆盖时重解析（同上）。 */
export function activeTentativeEdges(st: TentativeEdgeHost): TentativeEdge[] {
  return st.tentativeEdges.filter(
    (e) =>
      st.exists.has(e.source) &&
      st.exists.has(e.target) &&
      (e.unresolvedIndex !== undefined
        ? st.failedBranchOptionUpdates.has(e.source)
        : (st.branchOptions.get(e.source) ?? []).some((o) => o.id === e.optionId)),
  )
}

/** 选项表覆盖后重解析该分支的暂定投影（评审 5164170010）：未解析投影按
 * 新表落定——原下标落进新表则转为绑定该稳定选项 id 的常规投影并补登记
 * id 判重键，仍越界则撤销投影与回退键（该连线随本轮覆盖确定无法生效，
 * 其后同端点断线按真实缺失处理）；已解析投影绑定的选项 id 被本次覆盖
 * 移除时级联退役，投影与 id 判重键一并永久移除（§8.2.2 删边语义）——
 * 同 id 重新引入时旧边不复活、同端口重连不误判重复（评审 5164450788）。 */
export function reresolveTentativeEdges(
  st: TentativeEdgeHost,
  target: string,
  newTable: ReadonlyArray<{ id: string; label: string }>,
): void {
  st.tentativeEdges = st.tentativeEdges.flatMap((e) => {
    if (e.source !== target) return [e]
    if (e.unresolvedIndex !== undefined) {
      const option = newTable[e.unresolvedIndex]
      st.contingentConnectKeys.delete(`${e.source}\u0000${e.target}\u0000raw:${e.unresolvedIndex}`)
      if (option === undefined) return []
      st.contingentConnectKeys.add(`${e.source}\u0000${e.target}\u0000id:${option.id}`)
      return [{ source: e.source, target: e.target, optionId: option.id }]
    }
    if (newTable.some((o) => o.id === e.optionId)) return [e]
    st.contingentConnectKeys.delete(`${e.source}\u0000${e.target}\u0000id:${e.optionId}`)
    return []
  })
}

/** 断线命中前序暂定出口边（投影态已生效、未入虚拟图）：按端点对移除其
 * 全部登记与判重键——断线命令无端口参数，执行通道移除全部同端点边，
 * 残留投影会使反向连线误报成环（评审 5164943585）；返回是否命中。该
 * 断线同样依赖前序修复，按 contingent 静默跳过，后续命令按「已断开」
 * 的投影态判定；同端点同下标的后续 contingent 连线重新合法（评审
 * 5163489093，与撤销前断线的非 contingent 语义一致）。 */
export function dropTentativeEdge(st: TentativeEdgeHost, src: string, dst: string): boolean {
  const active = new Set(activeTentativeEdges(st))
  const hits = st.tentativeEdges.filter((e) => e.source === src && e.target === dst && active.has(e))
  if (hits.length === 0) return false
  st.tentativeEdges = st.tentativeEdges.filter((e) => !hits.includes(e))
  for (const e of hits) {
    const tail = e.unresolvedIndex !== undefined ? e.optionId : `id:${e.optionId}`
    st.contingentConnectKeys.delete(`${src}\u0000${dst}\u0000${tail}`)
  }
  return true
}

/** contingent 端点的可判类型（评审 5165573246）：token 指向本批失败
 * create 的 ref 时取其登记的暂定类型（nodeType 已独立过检），指向既有
 * 节点时取实际类型；悬空 token 或未登记暂定类型返回 undefined，对应
 * 检查维持 contingent 跳过。 */
export function contingentTypeOf(st: TentativeEdgeHost, token: string): string | undefined {
  if (st.exists.has(token)) return st.types.get(token)
  const owner = st.refOwner.get(token)
  return owner !== undefined ? st.types.get(owner) : undefined
}

/** contingent 连线的端点身份（评审 5169363253）：非 contingent 端点取
 * 解析 id，contingent 端点取失败 create 的 owner 虚拟 id（同一 ref 的
 * 后续命令得到同一身份），悬空 token 原样返回。 */
export function contingentEndpointId(st: TentativeEdgeHost, token: string): string {
  if (st.exists.has(token)) return token
  return st.refOwner.get(token) ?? token
}

/** 失败 create 端点的 contingent 连线 ghost 登记（评审 5169363253）：
 * 内在约束全部通过后按「端点身份 + 原始下标」登记判重键——同端点同下标
 * 的后续连线在修复后必然同端口（都绑定修复后表的同下标），重复首轮
 * 点名。非 branch 连线无下标身份，不登记（attach 重复即宿主冲突，属
 * 已知边界）；branchOptions 域键的 src/dst 与本域不相交（虚拟 id 不在
 * exists，注册表键的端点恒为已解析 id）。返回错误文案或 null。 */
export function createGhostConnectIssue(
  st: TentativeEdgeHost,
  cmd: Record<string, unknown>,
): string | null {
  if (textOf(cmd.edgeKind) !== 'branch' || !isIntrinsicOptionIndex(cmd.optionIndex)) return null
  const src = contingentEndpointId(st, textOf(cmd.sourceId))
  const dst = contingentEndpointId(st, textOf(cmd.targetId))
  const key = `${src}\u0000${dst}\u0000raw:${cmd.optionIndex}`
  if (st.contingentConnectKeys.has(key)) {
    return `重复连线：${textOf(cmd.sourceId)} → ${textOf(cmd.targetId)}`
  }
  st.contingentConnectKeys.add(key)
  return null
}

/** 端点断线释放 ghost 登记（评审 5169363253）：修复后该断线移除连线，
 * 其后同端点同下标重连不再必然重复。 */
export function releaseCreateGhostConnect(st: TentativeEdgeHost, source: string, target: string): void {
  dropGhostConnectKeys(st, contingentEndpointId(st, source), contingentEndpointId(st, target))
}

/** 触及 options 的 contingent 更新退役该分支的 ghost 键（评审
 * 5169363253）：更新替换选项表后，首条连线绑定 create 修复后的表、
 * 重连绑定更新后的表，同下标不再必然同端口。 */
export function retireCreateGhostConnects(st: TentativeEdgeHost, cmd: Record<string, unknown>): void {
  const owner = st.refOwner.get(textOf(cmd.nodeId))
  const patch = plainObject(cmd.patch) ? (cmd.patch as Record<string, unknown>) : undefined
  if (owner !== undefined && patch !== undefined && 'options' in patch) {
    dropGhostConnectKeys(st, owner)
  }
}

/** ghost 判重键的成对/按源删除：dst 缺省时清除该源的全部 raw 域键。 */
function dropGhostConnectKeys(st: TentativeEdgeHost, src: string, dst?: string): void {
  const prefix = dst === undefined ? `${src}\u0000` : `${src}\u0000${dst}\u0000raw:`
  for (const key of st.contingentConnectKeys) {
    if (key.startsWith(prefix)) st.contingentConnectKeys.delete(key)
  }
}
