import {
  branchOptionHandle,
  connectionEndpointIssue,
  type EdgeKind,
  hasAttachHost,
  removedOptionHandles,
  SCENE_SHOT_HANDLE,
  wouldCreateCycle,
} from '../graphRules'
import { dataPatchOf } from '../nodes/patch'
import { AI_FIELD_KEYS } from './nodeFields'
import {
  entityScopeOf,
  foldUpsert,
  registerFailedEntityUpsert,
  type EntityFoldHost,
} from './entityFold'
import { contingentUpdateIssue, NODE_TYPE_LABELS, payloadIssue } from './payloadCheck'
import { branchOptionsError, isPositionalOptions, normalizeNodeFields, plainObject } from './patchShape'
import type { AiGraphSnapshot, BatchValidation } from './commands'
import {
  activeTentativeEdges,
  contingentEndpointId,
  contingentTypeOf,
  createGhostConnectIssue,
  dropTentativeEdge,
  isIntrinsicOptionIndex,
  registerTentativeEdge,
  releaseCreateGhostConnect,
  releaseDeletedCreateRef,
  retireCreateGhostConnects,
  reresolveTentativeEdges,
  tentativeTopology,
  type TentativeEdgeHost,
} from './tentativeEdges'
import {
  edgePairKey,
  residualBreaksCycle,
  residualEdgesAt,
  type FailedEdgeHost,
  type VirtualEdge,
} from './failedEdges'

/**
 * AI 批命令的逐条折叠校验实现域（commands.ts 拆分，issue 39）：在
 * 「当前图 + 本批已建未删」的虚拟状态上完成 ref 解析、白名单/载荷校验、
 * 成环与宿主唯一判定，产出预览条目与已校验命令。契约类型见 commands.ts，
 * 入口 validateAiBatch 由其 re-export；批次文本提取在 batchText.ts，
 * 模拟执行在 batchSim.ts。
 */

/** 各类型节点的合法字段白名单（issue 41 起引用 nodeFields.ts 的协议表）：
 * 与 nodes/types.ts 的 *NodeData 一一对应，工具描述与系统提示同源生成；
 * 白名单外字段一律整批拒绝——宁可拒绝也不静默写错字段。 */
const NODE_FIELD_KEYS = AI_FIELD_KEYS
const OP_LABELS = { create: '创建', update: '修改', delete: '删除', connect: '连线', disconnect: '断开' }

/** 折叠期新建节点的虚拟 id（不进画布，仅同批 ref 解析与 contingent 判定用）。 */
const virtualIdOf = (index: number): string => `__new__:${index}`
const EDGE_KIND_LABELS: Record<string, string> = {
  sequence: '剧情流',
  branch: '分支出口',
  attach: '分镜下挂',
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 预览标签尾部的理由后缀：有理由才追加「：理由」。 */
function reasonOf(cmd: Record<string, unknown>): string {
  const r = asText(cmd.reason)
  return r ? `：${r}` : ''
}

/**
 * 逐条折叠校验：维护「当前图 + 本批已建未删」的虚拟状态，
 * 让批次内引用（ref 建链）与成环/重复判定都按最终态计算。
 * 任一问题 → ok=false（整批拒绝），commands 为空；issues 收集全部命令
 * 的完整问题清单，不因首错短路——纠错回喂与预览卡都依赖完整清单，
 * 模型单轮即可修完所有被点名命令，否则多错误批次会在重试预算内逐个
 * 暴露、必然耗尽。失败的折叠在任何状态变更前返回，后续命令继续折叠
 * 不受污染；依赖失败前序变更结果的命令按 contingent 跳过本轮校验
 * （失败 create 的 ref 引用、失败 branch options 更新的出口连线、失败
 * 连线变更的后续连线，见 registerFailedMutation），合法性随前序修复
 * 自愈，不进问题清单以免诱导模型改写本正确的命令。
 *
 * 复杂度拆解（S3776）：每个 op 的折叠逻辑是独立的顶层函数
 * （foldCreate/foldUpdate/foldDelete/foldEdge），共享的虚拟图状态
 * 收敛在 FoldState；validateAiBatch 只负责建状态与分发。
 */

/** 折叠校验的虚拟图状态：随每条命令演进的最终态投影。
 * 实体域（issue 44）经 EntityFoldHost 接口并入：既有 + 本批投影的实体
 * 注册表、ref 别名、失败 upsert 的 ghost 登记由 entityFold.ts 消费；
 * contingent 出口连线的暂定投影簿记（branchOptions/exists 等共享状态）
 * 经 TentativeEdgeHost 接口由 tentativeEdges.ts 消费；失败连线变更的
 * 登记与残留边快照经 FailedEdgeHost 接口由 failedEdges.ts 消费。 */
interface FoldState extends EntityFoldHost, TentativeEdgeHost, FailedEdgeHost {
  labels: Map<string, string>
  types: Map<string, string>
  /** ref 别名 → 所属节点 id。 */
  refOwner: Map<string, string>
  /** 项目资产索引（id → MIME）：shot.refs 引用位校验用。 */
  assets: ReadonlyMap<string, string>
}

/** AI 可补丁的节点类型（NODE_FIELD_KEYS 的键域）：图片节点不在此域
 * （§13 首版 AI 只读）。foldUpdate 经 payloadCheck 拒绝白名单外类型后，
 * 由此谓词收口为字面量联合，供补丁命令的判别化构造（issue 16）。 */
type AiPatchableType = 'scene' | 'dialogue' | 'beat' | 'branch' | 'shot'
const isAiPatchableType = (t: string | undefined): t is AiPatchableType =>
  t !== undefined && t in NODE_FIELD_KEYS

/** nodeId/sourceId/targetId 解析：允许既有 id 或本批新建的 ref；
 * 已被本批删除的节点（含按 ref 引用的）一律视为不存在。 */
function resolveRef(st: FoldState, cmd: Record<string, unknown>, key: string): string | null {
  const s = asText(cmd[key])
  if (s === '') return null
  if (st.exists.has(s)) return s
  const owner = st.refOwner.get(s)
  return owner !== undefined && st.exists.has(owner) ? owner : null
}

/** 引用是否指向本批校验失败的 create（ref 已登记但未进虚拟图）。此类
 * 命令的合法性随前序修复自动恢复，调用方应跳过校验且不点名——完整
 * 清单只收集可独立判断的问题，否则「端点不存在」级联假阳性会诱导
 * 模型删除或改写本来正确的依赖命令。 */
function isContingentRef(st: FoldState, cmd: Record<string, unknown>, key: string): boolean {
  const s = asText(cmd[key])
  if (s === '' || st.exists.has(s)) return false
  const owner = st.refOwner.get(s)
  return owner !== undefined && !st.exists.has(owner)
}

function foldCreate(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  const nodeType = asText(cmd.nodeType)
  if (!(nodeType in NODE_TYPE_LABELS)) return st.fail(index, `未知节点类型：${nodeType || '（空）'}`)
  const data = cmd.data ?? {}
  if (!plainObject(data)) return st.fail(index, 'data 必须是字段对象')
  const dataIssue = payloadIssue(nodeType, data, st.assets, st.entityScope)
  if (dataIssue) return st.fail(index, dataIssue)
  const typeLabel = NODE_TYPE_LABELS[nodeType]
  const name = asText(data.name) || asText(data.prompt) || '未命名'
  const virtualId = virtualIdOf(index)
  const refName = typeof cmd.ref === 'string' ? cmd.ref.trim() : ''
  st.exists.add(virtualId)
  st.labels.set(virtualId, `${typeLabel} · ${name}（新建）`)
  st.types.set(virtualId, nodeType)
  if (refName !== '') st.refOwner.set(refName, virtualId)
  st.items.push({ kind: 'create', danger: false, key: `c${index}`, label: `${OP_LABELS.create} ${typeLabel} · ${name}` })
  const normalized = normalizeNodeFields(nodeType, data)
  // 新建分支节点登记选项 id，同批后续 connect_edge 才能解析稳定端口
  if (nodeType === 'branch' && Array.isArray(normalized.options)) {
    st.branchOptions.set(virtualId, normalized.options as Array<{ id: string; label: string }>)
  }
  st.commands.push({
    op: 'create_node',
    nodeType,
    ref: refName === '' ? undefined : refName,
    data: normalized,
  })
}

function foldUpdate(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  const patch = cmd.patch
  if (!plainObject(patch) || Object.keys(patch).length === 0) return st.fail(index, 'patch 为空')
  if (isContingentRef(st, cmd, 'nodeId')) {
    // 触及 options 的 contingent 更新退役该分支的 ghost 判重键（评审
    // 5169363253）：表替换后同下标连线不再必然同端口
    retireCreateGhostConnects(st, cmd)
    // contingent：目标节点尚未入虚拟图。任何节点类型都不支持的字段恒非法；
    // 失败 create 的 nodeType 已独立通过校验时，暂定类型可判——修正 data
    // 不改变已声明的类型语义，按该类型的完整写载荷错误即使 create 修复后
    // 仍存在，首轮即点名，不额外消耗纠错轮次
    const owner = st.refOwner.get(asText(cmd.nodeId))
    const issue = contingentUpdateIssue(
      owner === undefined ? undefined : st.types.get(owner),
      patch,
      st.assets,
      st.entityScope,
    )
    if (issue !== null) st.fail(index, issue)
    return
  }
  const id = resolveRef(st, cmd, 'nodeId')
  if (!id) return st.fail(index, `节点不存在：${asText(cmd.nodeId)}`)
  const nodeType = st.types.get(id)
  const payloadErr = payloadIssue(nodeType ?? '', patch, st.assets, st.entityScope)
  if (payloadErr) return st.fail(index, payloadErr)
  st.items.push({
    kind: 'update',
    danger: false,
    key: `u${index}`,
    label: `${OP_LABELS.update} ${st.labels.get(id) ?? '未知节点'}（${Object.keys(patch).join('、')}）${reasonOf(cmd)}`,
  })
  const normalized = normalizeNodeFields(nodeType ?? '', patch, st.branchOptions.get(id))
  if (nodeType === 'branch' && Array.isArray(normalized.options)) {
    foldBranchCascade(st, id, cmd, index, normalized)
  }
  // 键白名单已拒白名单外类型（isAiPatchableType 恒真）：运行态类型字串
  // 收口为字面量后判别化绑定补丁（issue 16），执行通道不再见宽 Record
  if (!isAiPatchableType(nodeType)) return st.fail(index, '节点类型不支持 AI 命令修改')
  st.commands.push({
    op: 'update_node',
    nodeId: asText(cmd.nodeId),
    patch: dataPatchOf(nodeType, normalized),
    reason: asText(cmd.reason),
  })
}

/** contingent 出口连线的折叠（foldConnectEdge 拆出，S3776）：仅在该出口
 * contingent 时介入——同端点同原始下标的重复连线无论修复后选项表如何都
 * 必然同端口，首轮点名（评审 5163489093）；否则登记暂定边（生效与否随
 * 修复后的选项表派生），不进虚拟图、不折叠命令。返回 true = 已介入
 * （点名或登记），调用方直接返回；false = 非 contingent，继续正常折叠。 */
function foldContingentConnect(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
  src: string,
  dst: string,
  pairLabel: string,
): boolean {
  if (!st.failedBranchOptionUpdates.has(src)) return false
  if (!registerTentativeEdge(st, cmd, src, dst)) st.fail(index, `重复连线：${pairLabel}`)
  return true
}

/** 分支选项替换的级联断线簿记（foldUpdate 内核）：登记刷新 + 被替换/
 * 删除选项的出口边从校验态移除（§8.2.2 级联与 simulateBatch 同规则，
 * 否则后续连线的成环检测被旧边误判）。级联断线同时以 danger 项进预览
 * （§6）：simulateBatch 会同样删除这些边——只显示普通"修改选项"会让
 * 一键确认静默删除剧情路径；danger 断线项置顶并计入 hasDeletes。 */
function foldBranchCascade(
  st: FoldState,
  id: string,
  cmd: Record<string, unknown>,
  index: number,
  normalized: Record<string, unknown>,
): void {
  const removed = removedOptionHandles(
    st.branchOptions.get(id) ?? [],
    normalized.options as Array<{ id: string }>,
  )
  if (removed.length > 0) {
    const gone = new Set(removed)
    let cascade = 0
    for (const e of st.virtualEdges) {
      if (e.source !== id || !e.sourceHandle || !gone.has(e.sourceHandle)) continue
      cascade += 1
      st.items.push({
        kind: 'disconnect',
        danger: true,
        key: `u${index}c${cascade}`,
        label: `${OP_LABELS.disconnect} ${st.labels.get(id) ?? id} → ${st.labels.get(e.target) ?? e.target}（选项被替换，级联删除连线）${reasonOf(cmd)}`,
      })
    }
    st.virtualEdges = st.virtualEdges.filter(
      (e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle)),
    )
  }
  // 成功替换选项即刷新选项表：清除早前失败更新留下的 contingent 标记，
  // 后续出口连线的 optionIndex/重复检查恢复按最新选项表独立判断；未解析
  // 投影按新表重解析（评审 5164170010）
  st.failedBranchOptionUpdates.delete(id)
  // reresolve 须在表覆盖前调用（按位继承的旧表长度取自当前表，评审 5169767128）
  const newOptions = normalized.options as Array<{ id: string; label: string }>
  reresolveTentativeEdges(
    st,
    id,
    newOptions,
    isPositionalOptions(plainObject(cmd.patch) ? (cmd.patch as Record<string, unknown>).options : undefined),
  )
  st.branchOptions.set(id, newOptions)
}

function foldDelete(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  if (isContingentRef(st, cmd, 'nodeId')) {
    // contingent 删除（评审 5169767128）：修复后该 create 被删除，其
    // ghost 判重键与投影边一并退役——后续同端点连线面对缺失端点而非
    // 重复/成环
    releaseDeletedCreateRef(st, asText(cmd.nodeId))
    return
  }
  const id = resolveRef(st, cmd, 'nodeId')
  if (!id) return st.fail(index, `节点不存在：${asText(cmd.nodeId)}`)
  if (st.types.get(id) === 'image') {
    // §13 首版边界（与 create/update 同口径）：AI 对图片节点只读——
    // 批量模拟的删除路径不走 deleteNodesByIds，会绕过产物回收留下
    // 永久索引的不可达资产，故整批拒绝
    return st.fail(index, '图片节点暂不支持 AI 命令删除（首版边界）')
  }
  st.exists.delete(id)
  for (const [ref, owner] of st.refOwner) if (owner === id) st.refOwner.delete(ref)
  st.virtualEdges.forEach((e) => {
    if (e.source === id) e.source = `__deleted__:${id}`
    if (e.target === id) e.target = `__deleted__:${id}`
  })
  st.items.push({
    kind: 'delete',
    danger: true,
    key: `d${index}`,
    label: `${OP_LABELS.delete} ${st.labels.get(id) ?? '未知节点'}${reasonOf(cmd)}`,
  })
  st.commands.push({ op: 'delete_node', nodeId: asText(cmd.nodeId), reason: asText(cmd.reason) })
}

/** 预览标签的连线种类后缀；branch 追加选项序号（S3358/S4624：独立成函数）。 */
function connectKindTag(kind: string, optionIndex: number | undefined): string {
  if (kind === 'sequence') return ''
  if (kind === 'branch') return `（${EDGE_KIND_LABELS[kind]} ${(optionIndex ?? 0) + 1}）`
  return `（${EDGE_KIND_LABELS[kind]}）`
}

/** 连线端口的分端口校验（§4.4）：产出目标 handle 与选项序号；
 * 返回 string = 错误文案。 */
function edgePortOf(
  st: FoldState,
  kind: string,
  cmd: Record<string, unknown>,
  src: string,
  dst: string,
): { handle: string | null; optionIndex: number | undefined } | string {
  if (kind === 'branch') {
    if (st.types.get(src) !== 'branch') {
      return `branch 出口只能来自分支节点：${st.labels.get(src) ?? src} → ${st.labels.get(dst) ?? dst}`
    }
    const options = st.branchOptions.get(src)
    const idx = cmd.optionIndex
    const idxValid = typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < (options?.length ?? -1)
    if (!idxValid || options === undefined) {
      const pair = `${st.labels.get(src) ?? src} → ${st.labels.get(dst) ?? dst}`
      return `optionIndex 必须是 0～${(options?.length ?? 1) - 1} 的整数：${pair}`
    }
    return { handle: branchOptionHandle(options[idx].id), optionIndex: idx }
  }
  if (kind === 'attach') {
    if (st.types.get(src) !== 'scene' || st.types.get(dst) !== 'shot') {
      return `分镜下挂只能从场景连向分镜卡：${st.labels.get(src) ?? src} → ${st.labels.get(dst) ?? dst}`
    }
    return { handle: SCENE_SHOT_HANDLE, optionIndex: undefined }
  }
  return { handle: null, optionIndex: undefined }
}

/** 端点解析与守卫（foldEdge 拆出，S3776）：引用依赖失败前序时静默
 * 跳过（返回 'contingent'）；真实缺失记入问题清单（返回 'missing'）；
 * 同一失败 ref 兼作两端为必然自环，独立于该 create 的修复结果，返回
 * 'selfloop' 交由 foldEdge 点名（不得被 contingent 屏蔽）；合法时返回
 * 解析出的端点对。 */
function resolveEndpoints(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
): { src: string; dst: string } | 'contingent' | 'missing' | 'selfloop' {
  const s = asText(cmd.sourceId)
  const t = asText(cmd.targetId)
  if (s !== '' && s === t && isContingentRef(st, cmd, 'sourceId')) return 'selfloop'
  if (isContingentRef(st, cmd, 'sourceId') || isContingentRef(st, cmd, 'targetId')) {
    return 'contingent'
  }
  const src = resolveRef(st, cmd, 'sourceId')
  const dst = resolveRef(st, cmd, 'targetId')
  if (!src || !dst) {
    st.fail(index, `端点不存在：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`)
    return 'missing'
  }
  return { src, dst }
}

/** 与选项表无关的连线放置约束（§5 端口归属、§4.4 宿主唯一）：独立于
 * optionIndex/handle，contingent 路径也必须校验并进完整清单。返回错误
 * 文案或 null。 */
function connectPlacementIssue(
  st: FoldState,
  kind: string,
  src: string,
  dst: string,
  pairLabel: string,
): string | null {
  const endpointIssue = connectionEndpointIssue(st.types.get(src), st.types.get(dst), kind as EdgeKind)
  if (endpointIssue) return `${endpointIssue}：${pairLabel}`
  if (kind === 'attach' && hasAttachHost(st.virtualEdges, dst)) {
    return `分镜卡已有宿主，换宿主须先断开：${pairLabel}`
  }
  return null
}

/** connect_edge 的折叠校验（foldEdge 拆出，S3776）：按连线语义分端口
 * 校验（§4.4），经端点规则、宿主唯一、重复与成环检查后入虚拟图。 */
function foldConnectEdge(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
  src: string,
  dst: string,
  pairLabel: string,
): void {
  const kind = asText(cmd.edgeKind) || 'sequence'
  if (!(kind in EDGE_KIND_LABELS)) return st.fail(index, `未知连线类型：${kind}`)
  // 选项表相关检查（optionIndex 范围、handle 解析、重复连线比句柄）依赖
  // source 分支的 options 状态：本批对该分支的 options 更新失败时延后
  // （随前序修复自愈）；端点类型、宿主唯一、成环等独立约束仍照常校验
  const optionContingent = kind === 'branch' && st.failedBranchOptionUpdates.has(src)
  // contingent 只豁免依赖修复后选项表的检查：内在非法的 optionIndex
  // 首轮即点名，完整清单不缺项（评审 5163320408）
  if (optionContingent && !isIntrinsicOptionIndex(cmd.optionIndex)) {
    return st.fail(index, `optionIndex 须为非负整数：${pairLabel}`)
  }
  let handle: string | null = null
  let optionIndex: number | undefined
  if (!optionContingent) {
    const port = edgePortOf(st, kind, cmd, src, dst)
    if (typeof port === 'string') return st.fail(index, port)
    handle = port.handle
    optionIndex = port.optionIndex
  }
  const placementIssue = connectPlacementIssue(st, kind, src, dst, pairLabel)
  if (placementIssue) return st.fail(index, placementIssue)
  // 虚拟图与已落定的暂定投影同端口都判重复（评审 5164943585）
  if (!optionContingent && duplicateConnectHit(st, kind, src, dst, handle)) {
    return st.fail(index, `重复连线：${pairLabel}`)
  }
  // attach 是派生从属边（§4.4 垂直语义）：自身不查环，也不参与
  // 剧情流环检测——环只可能出现在横向剧情流上
  if (kind !== 'attach' && cycleContingent(st, cmd, index, src, dst, pairLabel)) return
  // 独立约束全部通过：剩余校验随前序修复自愈，本轮不折叠不点名。端点已
  // 确定时登记暂定出口边（选项句柄待前序修复后解析）：后续连线的成环判定
  // 按「该连线生效」评估，不因本轮省略而漏报独立可判定的错误
  // contingent：出口连线只登记暂定边（生效与否随修复后的选项表派生），
  // 不进虚拟图、不折叠命令；同键重复首轮点名（评审 5163489093）
  if (foldContingentConnect(st, cmd, index, src, dst, pairLabel)) return
  st.virtualEdges.push({
    source: src,
    target: dst,
    sourceHandle: handle,
    ...(kind === 'branch' ? { type: 'branch' } : {}),
  })
  st.items.push({
    kind: 'connect',
    danger: false,
    key: `e${index}`,
    label: `${OP_LABELS.connect}${connectKindTag(kind, optionIndex)} ${pairLabel}${reasonOf(cmd)}`,
  })
  st.commands.push({
    op: 'connect_edge',
    sourceId: asText(cmd.sourceId),
    targetId: asText(cmd.targetId),
    edgeKind: kind,
    ...(optionIndex !== undefined ? { optionIndex } : {}),
    reason: asText(cmd.reason),
  })
}

/** 非 contingent 连线的判重（foldConnectEdge 拆出，S3776）：虚拟图同端点
 * 同端口之外，已落定的暂定投影同端口也判重复——其 contingent 前序修复后
 * 必然折入虚拟图，无论修复时序都是必然重复，首轮点名，不多耗纠错轮次
 * （评审 5164943585）。未解析投影只在 contingent 期生效，此处不可达。 */
function duplicateConnectHit(
  st: FoldState,
  kind: string,
  src: string,
  dst: string,
  handle: string | null,
): boolean {
  if (st.virtualEdges.some((e) => e.source === src && e.target === dst && (e.sourceHandle ?? null) === handle)) {
    return true
  }
  if (kind !== 'branch') return false
  return activeTentativeEdges(st).some(
    (e) =>
      e.unresolvedIndex === undefined &&
      branchOptionHandle(e.optionId) === handle &&
      e.source === src &&
      e.target === dst,
  )
}

/** 成环守卫（foldConnectEdge 拆出，S3776）：非 attach 连线加环检查。
 * 经更长路径成环仍独立点名；同对断线在本批失败且其残留边确实参与这条环
 * （端点写反场景）时 contingent 跳过——残留边随断线修正移除，反转连线
 * 自愈，报「成环」会诱导模型改写正确的反向连线。返回 true = 已处理
 * （contingent 或已点名），调用方直接返回。 */
function cycleContingent(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
  src: string,
  dst: string,
  pairLabel: string,
): boolean {
  const flow = cycleFlowOf(st)
  if (!wouldCreateCycle(flow, src, dst)) {
    return false
  }
  // 自环独立于任何前序断线结果，不适用 contingent 豁免
  if (src !== dst && residualBreaksCycle(st, edgePairKey('disconnect_edge', asText(cmd.sourceId), asText(cmd.targetId)), flow, src, dst)) return true
  st.fail(index, `会造成循环剧情：${pairLabel}`)
  return true
}

/** 成环判定的边集合（cycleContingent/contingentConnectIssue 共用）：虚拟图
 * + 暂定拓扑 + ghost 投影边（attach 派生边除外）——ghost 边按「该连线
 * 生效」参与（评审 5169767128），普通连线经 ghost 边成环同属必然。 */
function cycleFlowOf(st: FoldState): VirtualEdge[] {
  return [
    ...st.virtualEdges,
    ...tentativeTopology(st),
    ...st.ghostEdges.map((e) => ({ ...e, sourceHandle: null })),
  ].filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
}

/** contingent 连线（端点依赖失败 create）的逐端独立校验（评审
 * 5165573246、5168865025）：先检内在的连线类型与端点存在性，再按两端
 * 可判状态检端口约束——非 contingent 端点立即应用可观测检查，contingent
 * 端点以登记暂定类型参与；成环不可能经未入图的虚拟端点，无需拓扑判定。
 * 返回错误文案或 null。 */
function contingentConnectIntrinsicIssue(st: FoldState, cmd: Record<string, unknown>): string | null {
  const kind = asText(cmd.edgeKind) || 'sequence'
  const pair = `${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`
  if (!(kind in EDGE_KIND_LABELS)) return `未知连线类型：${kind}`
  const srcContingent = isContingentRef(st, cmd, 'sourceId')
  const dstContingent = isContingentRef(st, cmd, 'targetId')
  const src = srcContingent ? null : resolveRef(st, cmd, 'sourceId')
  const dst = dstContingent ? null : resolveRef(st, cmd, 'targetId')
  // 非 contingent 且缺失：修复 create 也不会使其存在，独立点名
  if ((!srcContingent && src === null) || (!dstContingent && dst === null)) return `端点不存在：${pair}`
  return contingentPortIssue(st, cmd, kind, pair, src, dst)
}

/** contingent 连线的端口约束（contingentConnectIntrinsicIssue 拆出，
 * S3776）：src/dst 为已解析端点 id 或 null（contingent）。两端类型可判
 * （contingent 取暂定类型）时报端点约束；attach 目标已解析时查宿主
 * 唯一；branch 源已解析且选项表未被失败更新触及时查上界与句柄；内在
 * 非法 optionIndex 不随任何修复生效。 */
function contingentPortIssue(
  st: FoldState,
  cmd: Record<string, unknown>,
  kind: string,
  pair: string,
  src: string | null,
  dst: string | null,
): string | null {
  const srcType = src !== null ? st.types.get(src) : contingentTypeOf(st, asText(cmd.sourceId))
  const dstType = dst !== null ? st.types.get(dst) : contingentTypeOf(st, asText(cmd.targetId))
  if (srcType !== undefined && dstType !== undefined) {
    const endpointIssue = connectionEndpointIssue(srcType, dstType, kind as EdgeKind)
    if (endpointIssue) return `${endpointIssue}：${pair}`
  }
  if (kind === 'attach' && dst !== null && hasAttachHost(st.virtualEdges, dst)) {
    return `分镜卡已有宿主，换宿主须先断开：${pair}`
  }
  if (kind === 'branch' && src !== null && !st.failedBranchOptionUpdates.has(src)) {
    const port = edgePortOf(st, kind, cmd, src, dst ?? asText(cmd.targetId))
    if (typeof port === 'string') return port
  }
  if (kind === 'branch' && srcType === 'branch' && !isIntrinsicOptionIndex(cmd.optionIndex)) {
    return `optionIndex 须为非负整数：${pair}`
  }
  return null
}

/** contingent 连线（端点依赖失败 create）的完整守卫（foldEdge 拆出，
 * S3776）：内在约束（评审 5165573246）→ ghost 判重（5169363253）→ ghost
 * 成环（5169767128，按「该连线生效」的拓扑评估），全过则登记 ghost 投影
 * 边供后续连线判定。返回错误文案或 null。 */
function contingentConnectIssue(st: FoldState, cmd: Record<string, unknown>): string | null {
  const issue = contingentConnectIntrinsicIssue(st, cmd) ?? createGhostConnectIssue(st, cmd)
  if (issue !== null) return issue
  const src = contingentEndpointId(st, asText(cmd.sourceId))
  const dst = contingentEndpointId(st, asText(cmd.targetId))
  if (asText(cmd.edgeKind) !== 'attach' && wouldCreateCycle(cycleFlowOf(st), src, dst)) {
    return `会造成循环剧情：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`
  }
  st.ghostEdges.push({ source: src, target: dst })
  return null
}

/** connect_edge / disconnect_edge 的折叠校验。 */
function foldEdge(st: FoldState, cmd: Record<string, unknown>, index: number, op: string): void {
  const ends = resolveEndpoints(st, cmd, index)
  if (ends === 'contingent') {
    // 端点依赖失败 create（非数组 options 等新拒绝类使该路径常态化）：
    // 内在约束、ghost 判重与 ghost 成环不随 create 修复自愈，首轮点名
    // （评审 5165573246、5169363253、5169767128）；断线释放 ghost 登记后
    // 静默跳过
    if (op === 'connect_edge') {
      const issue = contingentConnectIssue(st, cmd)
      if (issue !== null) return st.fail(index, issue)
    } else {
      releaseCreateGhostConnect(st, asText(cmd.sourceId), asText(cmd.targetId))
    }
    return
  }
  if (ends === 'missing') return
  if (ends === 'selfloop') {
    // 必然自环独立于任何失败前序（create 修复后仍非法），首轮即点名
    return st.fail(index, `会造成循环剧情：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`)
  }
  const { src, dst } = ends
  const pairLabel = `${st.labels.get(src) ?? '未知节点'} → ${st.labels.get(dst) ?? '未知节点'}`
  if (op === 'disconnect_edge') return foldDisconnectEdge(st, cmd, index, src, dst, pairLabel)
  foldConnectEdge(st, cmd, index, src, dst, pairLabel)
}

/** 断线的折叠校验（foldEdge 拆出，S3776）：断线命令无端口参数，按端点对
 * 生效——执行通道移除全部同端点边（simDisconnect 的 forward 过滤同语义），
 * 虚拟边与暂定投影一并清除，残留登记会使反向连线误报成环（评审
 * 5164943585）；仅投影命中时按 contingent 静默跳过（依赖前序修复）。 */
function foldDisconnectEdge(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
  src: string,
  dst: string,
  pairLabel: string,
): void {
  const hadEdge = st.virtualEdges.some((e) => e.source === src && e.target === dst)
  st.virtualEdges = st.virtualEdges.filter((e) => !(e.source === src && e.target === dst))
  const droppedTentative = dropTentativeEdge(st, src, dst)
  if (!hadEdge && !droppedTentative) {
    // 目标边不存在可能因本批同对的 connect 失败： contingent 跳过，
    // 随连线修正自愈，不误报「没有这条连线」
    if (st.failedEdgePairs.has(edgePairKey('connect_edge', asText(cmd.sourceId), asText(cmd.targetId)))) return
    return st.fail(index, `没有这条连线：${pairLabel}`)
  }
  // 仅命中前序暂定投影：该断线依赖前序修复，按 contingent 静默跳过
  if (!hadEdge) return
  st.items.push({
    kind: 'disconnect',
    danger: false,
    key: `x${index}`,
    label: `${OP_LABELS.disconnect} ${pairLabel}${reasonOf(cmd)}`,
  })
  st.commands.push({
    op: 'disconnect_edge',
    sourceId: asText(cmd.sourceId),
    targetId: asText(cmd.targetId),
    reason: asText(cmd.reason),
  })
}

/** 折叠器分发表：op → 处理函数。设定实体命令（issue 44）复用实体域的
 * 折叠内核（entityFold.ts），共享同一虚拟投影与问题收集。 */
const FOLDERS: Record<string, (st: FoldState, cmd: Record<string, unknown>, index: number) => void> = {
  create_node: foldCreate,
  update_node: foldUpdate,
  delete_node: foldDelete,
  connect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'connect_edge'),
  disconnect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'disconnect_edge'),
  upsert_character: (st, cmd, index) => foldUpsert(st, cmd, index, 'character'),
  upsert_location: (st, cmd, index) => foldUpsert(st, cmd, index, 'location'),
}

/** 失败的 branch options 更新分类登记（registerFailedMutation 拆出，
 * S3776）：选项容器非数组或成员异型、无从折叠时登记 contingent 标记；
 * 选项合法、结果已确定时以归一化后的暂定选项表供下游连线独立校验，并
 * 清除早前标记（级联断线簿记随前序修复后再折叠，为已记录边界）。 */
function registerFailedOptionsUpdate(
  st: FoldState,
  raw: Record<string, unknown>,
  target: string,
): void {
  const patch = plainObject(raw.patch) ? raw.patch : undefined
  if (patch === undefined) return
  // 非数组容器（issue 46 的拒绝形态）与成员异型同口径：无暂定表可派生，
  // 仅登记 contingent——出口连线随前序修复自愈，不按未变更的旧表误报
  // optionIndex 越界（评审 5163172679）
  if (!Array.isArray(patch.options) || branchOptionsError(patch.options as unknown[]) !== null) {
    st.failedBranchOptionUpdates.add(target)
    return
  }
  const normalized = normalizeNodeFields('branch', patch, st.branchOptions.get(target))
  // 暂定生效同步应用级联删边（§8.2.2 的删边语义）：被替换选项的出口边从
  // 虚拟图移除，后续连线按「更新修复后」的状态判定成环/重复，不再误报；
  // 仅删边不登记级联预览项——该更新本身尚未被接受
  const removed = removedOptionHandles(
    st.branchOptions.get(target) ?? [],
    normalized.options as Array<{ id: string }>,
  )
  if (removed.length > 0) {
    const gone = new Set(removed)
    st.virtualEdges = st.virtualEdges.filter(
      (e) => !(e.source === target && e.sourceHandle && gone.has(e.sourceHandle)),
    )
  }
  // 暂定表已确定：清除早前失败留下的 contingent 标记（与成功覆盖同口径），
  // 后续出口连线恢复按最新选项表独立校验 optionIndex/重复；未解析投影
  // 按暂定表重解析（评审 5164170010；先重解析再覆盖表，评审 5169767128）
  st.failedBranchOptionUpdates.delete(target)
  const newOptions = normalized.options as Array<{ id: string; label: string }>
  reresolveTentativeEdges(st, target, newOptions, isPositionalOptions(patch.options))
  st.branchOptions.set(target, newOptions)
}

/** 折叠失败后的依赖登记（分发循环调用）：create 失败登记其 ref（指向
 * 未入图的虚拟 id）、branch 的 options 更新失败登记目标、连线变更失败
 * 登记原始端点对——后续依赖这些变更结果的命令按 contingent 跳过、
 * 随前序修复自愈，而非被误报「节点不存在 / 下标越界 / 成环」。 */
function registerFailedMutation(st: FoldState, raw: Record<string, unknown>, index: number): void {
  if (raw.op === 'create_node') {
    const refName = typeof raw.ref === 'string' ? raw.ref.trim() : ''
    if (refName === '') return
    const virtualId = virtualIdOf(index)
    st.refOwner.set(refName, virtualId)
    // nodeType 字段已独立通过校验：登记为暂定类型，供后续 contingent 命令
    // 按该类型独立校验（修正 data 不改变已声明的类型语义）。自有键判定：
    // 协议表继承 Object.prototype，`in` 会命中 toString 等同名键
    const nodeType = asText(raw.nodeType)
    if (Object.prototype.hasOwnProperty.call(NODE_FIELD_KEYS, nodeType)) {
      st.types.set(virtualId, nodeType)
    }
    return
  }
  if (raw.op === 'update_node') {
    const target = resolveRef(st, raw, 'nodeId')
    // 失败更新只要触及 options 键（数组或非数组）都需分类登记：数组成员
    // 异型/非数组容器 → contingent 标记，数组合法 → 暂定表（评审 5163172679）
    if (
      target !== null &&
      st.types.get(target) === 'branch' &&
      plainObject(raw.patch) &&
      'options' in (raw.patch as Record<string, unknown>)
    ) {
      registerFailedOptionsUpdate(st, raw, target)
    }
    return
  }
  if (raw.op === 'connect_edge' || raw.op === 'disconnect_edge') {
    const source = asText(raw.sourceId)
    const target = asText(raw.targetId)
    st.failedEdgePairs.set(
      edgePairKey(raw.op as string, source, target),
      residualEdgesAt(st, source, target),
    )
    return
  }
  if (raw.op === 'upsert_character' || raw.op === 'upsert_location') {
    registerFailedEntityUpsert(st, raw, index)
  }
}

export function validateAiBatch(rawCommands: unknown, graph: AiGraphSnapshot): BatchValidation {
  const st: FoldState = {
    labels: new Map(graph.nodes.map((n) => [n.id, n.label])),
    types: new Map(graph.nodes.map((n) => [n.id, n.type])),
    branchOptions: new Map(
      graph.nodes.filter((n) => Array.isArray(n.options)).map((n) => [n.id, n.options!]),
    ),
    virtualEdges: graph.edges.map((e) => ({ ...e })),
    tentativeEdges: [],
    exists: new Set(graph.nodes.map((n) => n.id)),
    refOwner: new Map(),
    failedBranchOptionUpdates: new Set(),
    contingentConnectKeys: new Set(),
    ghostEdges: [],
    failedEdgePairs: new Map(),
    assets: graph.assets,
    // 设定集投影（issue 44）：快照未携带时不做实体校验（旧夹具兼容），
    // 运行时快照恒携带（graphSnapshotOf）
    characters: new Map((graph.settings?.characters ?? []).map((c) => [c.id, c.name])),
    locations: new Map((graph.settings?.locations ?? []).map((l) => [l.id, l.name])),
    virtualEntityIds: new Set(),
    entityRefs: new Map(),
    ghostEntities: new Set(),
    items: [],
    issues: [],
    commands: [],
    fail: (index, message) => st.issues.push({ index, message }),
  }
  // 实体解析口径（issue 44）：快照未携带设定集时不做实体校验（旧夹具兼容），
  // 运行时快照恒携带（graphSnapshotOf）
  if (graph.settings !== undefined) st.entityScope = entityScopeOf(st)

  if (!Array.isArray(rawCommands)) {
    return { ok: false, items: [], commands: [], issues: [{ index: -1, message: '批次不是命令数组' }], hasDeletes: false }
  }

  rawCommands.forEach((raw, index) => {
    if (!plainObject(raw)) return st.fail(index, '条目不是对象')
    const folder = FOLDERS[raw.op as string]
    if (!folder) return st.fail(index, `未知操作：${String(raw.op)}`)
    const issueCountBefore = st.issues.length
    folder(st, raw, index)
    if (st.issues.length > issueCountBefore) registerFailedMutation(st, raw, index)
  })

  const ok = st.issues.length === 0
  // 删除类与级联断线置顶（§6 危险操作升级）；其余按到达顺序稳定排列
  const sorted = [...st.items.filter((i) => i.danger), ...st.items.filter((i) => !i.danger)]
  return {
    ok,
    items: sorted,
    commands: ok ? st.commands : [],
    issues: st.issues,
    hasDeletes: sorted.some((i) => i.kind === 'delete' || (i.kind === 'disconnect' && i.danger)),
  }
}
