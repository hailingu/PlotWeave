/**
 * contingent 出口连线的暂定投影簿记（batchFold.ts 拆分，评审迭代域）：
 * 依赖失败 branch options 更新的出口连线不进虚拟图，以「端点 + 稳定选项
 * id」的投影登记于此——生效与否按当前选项表派生（activeTentativeEdges），
 * 选项表覆盖时重解析/级联退役（reresolveTentativeEdges），端点断线按执行
 * 通道语义移除全部匹配投影（dropTentativeEdge）。折叠状态由
 * batchFold.FoldState 经 TentativeEdgeHost 接口供给（同 EntityFoldHost
 * 模式，issue 44）。
 */

/** contingent 出口边的暂定投影：解析到稳定选项 id 的常规投影，或下标越出
 * 登记时表长的未解析投影（optionId 为 raw: 哨兵、unresolvedIndex 记原始
 * 下标，评审 5164170010）。 */
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
  /** 依赖失败 options 更新的暂定出口边（端点与稳定选项 id 已确定、句柄待
   * 解析；生效与否按当前选项表派生，见 activeTentativeEdges）。 */
  tentativeEdges: TentativeEdge[]
  /** 本批尚未删除的节点 id（含 __new__ 虚拟 id）。 */
  exists: Set<string>
  /** 本批 options 更新失败的分支节点 id：其出口连线的 optionIndex 校验
   * 随前序修复自愈，按 contingent 跳过（同 ref 依赖，见 isContingentRef）。 */
  failedBranchOptionUpdates: Set<string>
  /** contingent 出口连线的判重键（端点 + 登记时解析的稳定选项 id；不可
   * 解析退回 #原始下标）：同键的后续连线无论修复后选项表如何都必然与前条
   * 同端口（重复或一同失效），首轮点名；换位/改名保留 id 时重连仍同键
   * （真阳性，评审 5163729170），绑定选项被成功或投影覆盖移除时随投影
   * 级联退役（见 reresolveTentativeEdges，评审 5164450788）；断线撤销
   * 登记时按键释放（见 dropTentativeEdge）。 */
  contingentConnectKeys: Set<string>
}

/** contingent 出口连线登记（foldConnectEdge 拆出，S3776）：记录暂定投影
 * ——常规投影绑定当前表该下标的稳定选项 id，下标越出当前表长时登记未解
 * 析投影（optionId 为 raw: 哨兵、记原始下标，评审 5164170010），使后续
 * 同端点断线与成环判定按「该连线生效」评估。同端点的重复连线返回 false：
 * 判重键分域编码——id 域绑定登记时解析的稳定选项 id，越界回退域带 raw:
 * 前缀，选项 id 字面量再巧也不与回退键相撞（评审 5164170010）；换位/
 * 改名保留 id 时重连仍同键（真阳性，评审 5163729170），覆盖移除的选项
 * 随投影级联退役（见 reresolveTentativeEdges，评审 5164450788）。 */
export function registerTentativeEdge(
  st: TentativeEdgeHost,
  cmd: Record<string, unknown>,
  src: string,
  dst: string,
): boolean {
  const idx = cmd.optionIndex
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) return true
  const option = (st.branchOptions.get(src) ?? [])[idx]
  const key = option !== undefined
    ? `${src}\u0000${dst}\u0000id:${option.id}`
    : `${src}\u0000${dst}\u0000raw:${idx}`
  if (st.contingentConnectKeys.has(key)) return false
  st.contingentConnectKeys.add(key)
  st.tentativeEdges.push(
    option !== undefined
      ? { source: src, target: dst, optionId: option.id }
      : { source: src, target: dst, optionId: `raw:${idx}`, unresolvedIndex: idx },
  )
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
