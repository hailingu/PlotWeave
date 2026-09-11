import {
  branchOptionHandle,
  connectionEndpointIssue,
  type EdgeKind,
  type EndpointPair,
  hasAttachHost,
  removedOptionHandles,
  SCENE_SHOT_HANDLE,
  wouldCreateCycle,
} from '../graphRules'
import { dataPatchOf } from '../nodes/patch'
import { AI_FIELD_KEYS } from './nodeFields'
import {
  entityFieldsIssue,
  entityScopeOf,
  foldUpsert,
  type EntityFoldHost,
} from './entityFold'
import type { EntityKind } from './entityFields'
import { NODE_TYPE_LABELS, payloadIssue, unknownTargetFieldIssue } from './payloadCheck'
import { normalizeNodeFields, plainObject } from './patchShape'
import type { AiGraphSnapshot, BatchValidation } from './commands'

/**
 * AI 批命令的逐条折叠校验实现域（commands.ts 拆分，issue 39；两阶段契约
 * 为 owner 批准的变更）：阶段 A 逐条收集**上下文无关**的形状错误（字段
 * 白名单/值形状/options 成员/连线类型/内在 optionIndex/实体 fields 形态）
 * ——一次全量回喂，quota 按轮消耗，多错误批次一轮修完；阶段 B 在形状
 * 全过后于「当前图 + 本批已建未删」虚拟状态上顺序折叠，**首错即停**——
 * 失败之后的命令本轮不校验不点名，级联误报由「不前进」消除，分层错误
 * 随修复重放逐轮暴露。契约类型见 commands.ts，入口 validateAiBatch 由其
 * re-export；批次文本提取在 batchText.ts，模拟执行在 batchSim.ts。
 */

/** 各类型节点的合法字段白名单（issue 41 起引用 nodeFields.ts 的协议表）：
 * 与 nodes/types.ts 的 *NodeData 一一对应，工具描述与系统提示同源生成；
 * 白名单外字段一律整批拒绝——宁可拒绝也不静默写错字段。 */
const NODE_FIELD_KEYS = AI_FIELD_KEYS
const OP_LABELS = { create: '创建', update: '修改', delete: '删除', connect: '连线', disconnect: '断开' }

/** 折叠期新建节点的虚拟 id（不进画布，仅同批 ref 解析用）。 */
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

/** optionIndex 的内在合法性（非负整数；不依赖选项表）：阶段 A 的上下文
 * 无关检查——上界与句柄解析依赖折叠态，属阶段 B。 */
const isIntrinsicOptionIndex = (idx: unknown): idx is number =>
  typeof idx === 'number' && Number.isInteger(idx) && idx >= 0

/** 折叠校验的虚拟边：端点 + 源端口/连线类型（与 AiGraphSnapshot.edges 同形）。 */
type VirtualEdge = EndpointPair & { sourceHandle?: string | null; type?: string }

/** 折叠校验的虚拟图状态：随每条命令演进的最终态投影。
 * 实体域（issue 44）经 EntityFoldHost 接口并入：既有 + 本批投影的实体
 * 注册表与 ref 别名由 entityFold.ts 消费。 */
interface FoldState extends EntityFoldHost {
  labels: Map<string, string>
  types: Map<string, string>
  /** branch 节点 id → 选项列表（校验 optionIndex 并解析稳定选项 id 端口）。 */
  branchOptions: Map<string, Array<{ id: string; label: string }>>
  virtualEdges: VirtualEdge[]
  /** 本批尚未删除的节点 id（含 __new__ 虚拟 id）。 */
  exists: Set<string>
  /** ref 别名 → 所属节点 id（仅成功折叠的 create 登记——阶段 B 首错即停，
 * 失败 create 之后的命令不会进入折叠，ref 不会悬空指向未入图节点）。 */
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

/** 阶段 A：单条命令的上下文无关形状校验（只读快照态，不读批次内命令、
 * 不改折叠态）——全部命令一次收集，一次回喂。两类让位：实体引用位
 * （依赖批次内 ref 登记，entities 传缺省跳过，阶段 B 按真实投影校验）；
 * update 经批次内 ref 时目标类型未知，只做「任何可写类型都不支持的字段」
 * 与「唯一归属 array 字段的非数组值」（恒非法，issue 67）独立判定，其余
 * 类型专属错误随修复重放在阶段 B 点名（分层暴露）。 */
function shapeIssuesOf(
  st: FoldState,
  raw: Record<string, unknown>,
  index: number,
  deletedTokens: ReadonlySet<string>,
): void {
  const issue = shapeIssueOf(st, raw, deletedTokens)
  if (issue !== null) st.fail(index, issue)
}

/** 阶段 A 的单命令形状判定分发（shapeIssuesOf 拆出，S3358/S3776）。
 * deletedTokens = 此前 delete_node 的 nodeId token 集：这些 token 的归属
 * 可经「删除 + 同名 ref 重建」换主（快照类型过期），对应 update 的类型
 * 专属检查让位阶段 B；无关 token 不受牵连，仍进阶段 A 聚合（评审
 * 5174367120——快照节点只能被同名 token 删除，ref 删除只达批内虚拟
 * 节点，本就走全局键路径）。 */
function shapeIssueOf(
  st: FoldState,
  raw: Record<string, unknown>,
  deletedTokens: ReadonlySet<string>,
): string | null {
  if (raw.op === 'create_node') return createShapeIssue(st, raw)
  if (raw.op === 'update_node') return updateShapeIssue(st, raw, deletedTokens)
  if (raw.op === 'connect_edge') return connectShapeIssue(raw)
  if (raw.op === 'upsert_character' || raw.op === 'upsert_location') {
    return entityUpsertShapeIssue(raw)
  }
  return null
}

/** create 的形状校验（shapeIssuesOf 拆出，S3776）：节点类型与 data 形状。 */
function createShapeIssue(st: FoldState, raw: Record<string, unknown>): string | null {
  const nodeType = asText(raw.nodeType)
  if (!(nodeType in NODE_TYPE_LABELS)) return `未知节点类型：${nodeType || '（空）'}`
  const data = raw.data ?? {}
  if (!plainObject(data)) return 'data 必须是字段对象'
  return payloadIssue(nodeType, data, st.assets)
}

/** update 的形状校验（shapeIssuesOf 拆出，S3776）：既有节点按其类型全量
 * 校验；token 被更早的 delete_node 点名过（可经「删除 + 同名 ref 重建」
 * 换主，快照类型过期）或属批次内 ref（类型未知）时，只做全局键与唯一
 * 归属 array 容器的恒非法判定（issue 67），其余类型专属错误分层延后到
 * 阶段 B 的顺序解析。 */
function updateShapeIssue(
  st: FoldState,
  raw: Record<string, unknown>,
  deletedTokens: ReadonlySet<string>,
): string | null {
  const patch = raw.patch
  if (!plainObject(patch) || Object.keys(patch).length === 0) return 'patch 为空'
  const nodeId = asText(raw.nodeId)
  if (deletedTokens.has(nodeId)) return unknownTargetFieldIssue(patch)
  const knownType = st.exists.has(nodeId) ? st.types.get(nodeId) : undefined
  return knownType !== undefined
    ? payloadIssue(knownType, patch, st.assets)
    : unknownTargetFieldIssue(patch)
}

/** connect 的形状校验（shapeIssuesOf 拆出，S3776）：连线类型与内在
 * optionIndex（上界与句柄依赖折叠态，属阶段 B）。 */
function connectShapeIssue(raw: Record<string, unknown>): string | null {
  const kind = asText(raw.edgeKind) || 'sequence'
  if (!(kind in EDGE_KIND_LABELS)) return `未知连线类型：${kind}`
  if (kind === 'branch' && !isIntrinsicOptionIndex(raw.optionIndex)) {
    return `optionIndex 须为非负整数：${asText(raw.sourceId)} → ${asText(raw.targetId)}`
  }
  return null
}

/** 实体 upsert 的形状校验（shapeIssuesOf 拆出，S3776）：fields 形态与
 * entityId 结构性（目标解析与 ref 冲突属阶段 B）。 */
function entityUpsertShapeIssue(raw: Record<string, unknown>): string | null {
  const kind: EntityKind = raw.op === 'upsert_character' ? 'character' : 'location'
  const fields = raw.fields
  if (!plainObject(fields)) return 'fields 必须是字段对象'
  if (raw.entityId !== undefined && asText(raw.entityId) === '') {
    return `entityId 在场时须为非空白字符串（缺省才是新建）：${JSON.stringify(raw.entityId)}`
  }
  return entityFieldsIssue(kind, fields, raw.entityId === undefined ? 'create' : 'update')
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
    foldBranchCascade(st, id, index, normalized)
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

/** 分支选项替换的级联断线簿记（foldUpdate 内核）：登记刷新 + 被替换/
 * 删除选项的出口边从校验态移除（§8.2.2 级联与 simulateBatch 同规则，
 * 否则后续连线的成环检测被旧边误判）。级联断线同时以 danger 项进预览
 * （§6）：simulateBatch 会同样删除这些边——只显示普通"修改选项"会让
 * 一键确认静默删除剧情路径；danger 断线项置顶并计入 hasDeletes。 */
function foldBranchCascade(
  st: FoldState,
  id: string,
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
        label: `${OP_LABELS.disconnect} ${st.labels.get(id) ?? id} → ${st.labels.get(e.target) ?? e.target}（选项被替换，级联删除连线）`,
      })
    }
    st.virtualEdges = st.virtualEdges.filter(
      (e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle)),
    )
  }
  st.branchOptions.set(id, normalized.options as Array<{ id: string; label: string }>)
}

function foldDelete(st: FoldState, cmd: Record<string, unknown>, index: number): void {
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
    const idxValid = isIntrinsicOptionIndex(idx) && idx < (options?.length ?? -1)
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

/** 与选项表无关的连线放置约束（§5 端口归属、§4.4 宿主唯一）。返回错误
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
  const port = edgePortOf(st, kind, cmd, src, dst)
  if (typeof port === 'string') return st.fail(index, port)
  const placementIssue = connectPlacementIssue(st, kind, src, dst, pairLabel)
  if (placementIssue) return st.fail(index, placementIssue)
  const handle = port.handle
  if (st.virtualEdges.some((e) => e.source === src && e.target === dst && (e.sourceHandle ?? null) === handle)) {
    return st.fail(index, `重复连线：${pairLabel}`)
  }
  // attach 是派生从属边（§4.4 垂直语义）：自身不查环，也不参与
  // 剧情流环检测——环只可能出现在横向剧情流上
  const flow = st.virtualEdges.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
  if (kind !== 'attach' && wouldCreateCycle(flow, src, dst)) {
    return st.fail(index, `会造成循环剧情：${pairLabel}`)
  }
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
    label: `${OP_LABELS.connect}${connectKindTag(kind, port.optionIndex)} ${pairLabel}${reasonOf(cmd)}`,
  })
  st.commands.push({
    op: 'connect_edge',
    sourceId: asText(cmd.sourceId),
    targetId: asText(cmd.targetId),
    edgeKind: kind,
    ...(port.optionIndex !== undefined ? { optionIndex: port.optionIndex } : {}),
    reason: asText(cmd.reason),
  })
}

/** connect_edge / disconnect_edge 的折叠校验（阶段 B：形状已在阶段 A
 * 全过，这里只做依赖折叠态的结构校验）。 */
function foldEdge(st: FoldState, cmd: Record<string, unknown>, index: number, op: string): void {
  const src = resolveRef(st, cmd, 'sourceId')
  const dst = resolveRef(st, cmd, 'targetId')
  if (!src || !dst) {
    return st.fail(index, `端点不存在：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`)
  }
  const pairLabel = `${st.labels.get(src) ?? '未知节点'} → ${st.labels.get(dst) ?? '未知节点'}`
  if (op === 'disconnect_edge') return foldDisconnectEdge(st, cmd, index, src, dst, pairLabel)
  foldConnectEdge(st, cmd, index, src, dst, pairLabel)
}

/** 断线的折叠校验（foldEdge 拆出，S3776）：断线命令无端口参数，按端点对
 * 生效——执行通道移除全部同端点边（simDisconnect 的 forward 过滤同语义），
 * 校验态同口径清除，残留边会使反向连线误报成环（评审 5164943585）。 */
function foldDisconnectEdge(
  st: FoldState,
  cmd: Record<string, unknown>,
  index: number,
  src: string,
  dst: string,
  pairLabel: string,
): void {
  const hadEdge = st.virtualEdges.some((e) => e.source === src && e.target === dst)
  if (!hadEdge) return st.fail(index, `没有这条连线：${pairLabel}`)
  st.virtualEdges = st.virtualEdges.filter((e) => !(e.source === src && e.target === dst))
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

/** 阶段 A：全量形状校验（validateAiBatch 拆出，S3776）——一次收集、一次
 * 回喂。被 delete_node 点名过的 token 归属可变（快照类型过期）：仅这些
 * token 的 update 降级为全局键判定，类型专属检查让位阶段 B；无关 update
 * 保持阶段 A 聚合（评审 5174231991、5174367120）。 */
function collectShapeIssues(st: FoldState, commands: unknown[]): void {
  const deletedTokens = new Set<string>()
  for (const [index, raw] of commands.entries()) {
    if (!plainObject(raw)) {
      st.fail(index, '条目不是对象')
      continue
    }
    const cmd = raw as Record<string, unknown>
    const folder = FOLDERS[cmd.op as string]
    if (!folder) {
      st.fail(index, `未知操作：${String(cmd.op)}`)
      continue
    }
    shapeIssuesOf(st, cmd, index, deletedTokens)
    if (cmd.op === 'delete_node') deletedTokens.add(asText(cmd.nodeId))
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
    exists: new Set(graph.nodes.map((n) => n.id)),
    refOwner: new Map(),
    assets: graph.assets,
    // 设定集投影（issue 44）：快照未携带时不做实体校验（旧夹具兼容），
    // 运行时快照恒携带（graphSnapshotOf）
    characters: new Map((graph.settings?.characters ?? []).map((c) => [c.id, c.name])),
    locations: new Map((graph.settings?.locations ?? []).map((l) => [l.id, l.name])),
    virtualEntityIds: new Set(),
    entityRefs: new Map(),
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
  const commands = rawCommands as unknown[]

  collectShapeIssues(st, commands)

  // 阶段 B：形状全过后顺序折叠，首错即停——其后命令本轮不校验不点名，
  // 修复重写后从头重放，分层错误逐轮暴露
  if (st.issues.length === 0) {
    for (const [index, raw] of commands.entries()) {
      const cmd = raw as Record<string, unknown>
      FOLDERS[cmd.op as string](st, cmd, index)
      if (st.issues.length > 0) break
    }
  }

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
