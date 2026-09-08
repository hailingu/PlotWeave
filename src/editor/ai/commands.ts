import {
  branchOptionHandle,
  connectionEndpointIssue,
  type EdgeKind,
  hasAttachHost,
  removedOptionHandles,
  SCENE_SHOT_HANDLE,
  wouldCreateCycle,
} from '../graphRules'
import { dataPatchOf, type NodeDataPatch } from '../nodes/patch'
import { AI_FIELD_KEYS } from './nodeFields'
import { branchOptionsError, nodeValueShapeError, normalizeNodeFields, plainObject } from './patchShape'

/**
 * AI 批量命令的解析与校验（docs/ui-design.md §6 改动预览卡、数据模型 §12）。
 *
 * 核心约束：Agent 只产出命令，写操作执行前必须整批预览；任一条非法即
 * 整批拒绝（预览卡 = 一个 batch 命令，执行后一步撤销）。本模块是纯函数：
 * 输入模型的回复文本与画布快照，输出可直接渲染的预览条目与待执行命令，
 * 不触碰任何 React 状态。
 */

/** 模型可产出的五类命令（对齐数据模型 §12.2 写工具集的首版子集）。
 * 这是**入站**信任边界的形态：update_node 的 patch 是模型自报的
 * Record，合法性与目标节点类型的绑定由 validateAiBatch 校验（§9.3），
 * 校验通过后以 ValidatedCommand 进入执行通道（issue 16）。 */
export type AiCommand =
  | { op: 'create_node'; nodeType: string; ref?: unknown; data?: unknown; reason?: unknown }
  | { op: 'update_node'; nodeId: string; patch: Record<string, unknown>; reason?: unknown }
  | { op: 'delete_node'; nodeId: string; reason?: unknown }
  | {
      op: 'connect_edge'
      sourceId: string
      targetId: string
      /** 连线语义（§4.4）：缺省为剧情流。 */
      edgeKind?: unknown
      /** edgeKind = branch 时的选项下标（0 基，必须在分支选项范围内）。 */
      optionIndex?: unknown
      reason?: unknown
    }
  | { op: 'disconnect_edge'; sourceId: string; targetId: string; reason?: unknown }

/** 校验通过的执行命令（BatchValidation.commands → applyAiBatch →
 * simulateBatch 的形态）：与入站 AiCommand 同构，唯一差别是 update_node
 * 的 patch 已按目标节点类型完成键白名单与值形状校验并判别化绑定
 * NodeDataPatch（issue 16）——执行与撤销路径不再接受宽 Record 补丁。 */
export type ValidatedCommand =
  | Extract<AiCommand, { op: 'create_node' | 'delete_node' | 'connect_edge' | 'disconnect_edge' }>
  | (Omit<Extract<AiCommand, { op: 'update_node' }>, 'patch'> & { patch: NodeDataPatch })

/** 执行命令 → 入站形态（applyAiBatch 重校验用）：判别补丁剥回模型侧的
 * 宽 Record——validateAiBatch 的契约是入站信任边界，目标节点类型必须
 * 对当前画布快照重推导（预览与确认之间画布可能变化），wrapper 的
 * nodeType 只是编译期绑定，重校验不消费。剥壳无信息丢失（patch 本体
 * 原样回交）。 */
export function toInboundCommands(batch: ValidatedCommand[]): AiCommand[] {
  return batch.map((cmd) => {
    if (cmd.op !== 'update_node') return cmd
    return {
      op: 'update_node',
      nodeId: cmd.nodeId,
      patch: cmd.patch.patch as Record<string, unknown>,
      ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}),
    }
  })
}

/** 校验所需的压缩图快照：节点 id/类型/人读标签、现有边端点与端口。 */
export interface AiGraphSnapshot {
  nodes: Array<{
    id: string
    type: string
    label: string
    /** branch 节点必填：选项（id + 文案），branch 连线的 optionIndex 校验与端口 id 解析用。 */
    options?: Array<{ id: string; label: string }>
  }>
  edges: Array<{ source: string; target: string; sourceHandle?: string | null; type?: string }>
  /** 项目资产索引（id → MIME）：shot.refs 引用位的资产存在性与用途匹配校验
   * （§7.1/§11.3 的批命令对等）。空索引 = 无资产，引用位一律拒绝。 */
  assets: ReadonlyMap<string, string>
}

/** 预览卡的单行条目（§6：逐项列出受影响节点与变更类型）。 */
export interface PreviewItem {
  kind: 'delete' | 'disconnect' | 'create' | 'update' | 'connect'
  danger: boolean
  label: string
  /** 渲染 key = 来源命令序号（折叠时注入，排序后仍唯一稳定）。 */
  key: string
}

export interface BatchIssue {
  index: number
  message: string
}

export interface BatchValidation {
  /** false = 整批拒绝（原子性：不允许只执行一半）。 */
  ok: boolean
  /** 展示顺序：删除类置顶（§6 危险操作置顶），其余保持命令顺序。 */
  items: PreviewItem[]
  /** 待执行命令：已校验的合法子集，原始顺序（执行语义必须按序折叠）。 */
  commands: ValidatedCommand[]
  issues: BatchIssue[]
  /** 删除类或级联断线（danger）在预览中：置顶展示并要求二次确认（§6）。 */
  hasDeletes: boolean
}

const NODE_TYPE_LABELS: Record<string, string> = {
  scene: '场景',
  beat: '节奏卡',
  dialogue: '对白',
  branch: '分支',
  shot: '分镜卡',
}

/**
 * 各类型节点的合法字段白名单（issue 41 起引用 nodeFields.ts 的协议表）：
 * 与 nodes/types.ts 的 *NodeData 一一对应（⚙️ 设置面板可编辑的字段），
 * 工具描述与系统提示由同一来源生成。AI 的 data/patch 出现白名单之外的
 * 字段一律整批拒绝——宁可拒绝也不静默写错字段。
 */
const NODE_FIELD_KEYS = AI_FIELD_KEYS
const OP_LABELS = { create: '创建', update: '修改', delete: '删除', connect: '连线', disconnect: '断开' }

/** 折叠期新建节点的虚拟 id（不进画布，仅同批 ref 解析与 contingent 判定用）。 */
const virtualIdOf = (index: number): string => `__new__:${index}`
const EDGE_KIND_LABELS: Record<string, string> = {
  sequence: '剧情流',
  branch: '分支出口',
  attach: '分镜下挂',
}

/**
 * 从助手回复文本提取批次对象的解析在 batchText.ts（围栏回退通道）；
 * 本模块消费已解析的 commands 数组，负责折叠校验与执行形态。
 */

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 预览标签尾部的理由后缀：有理由才追加「：理由」。 */
function reasonOf(cmd: Record<string, unknown>): string {
  const r = asText(cmd.reason)
  return r ? `：${r}` : ''
}

/** data/patch 字段白名单校验；返回错误文案或 null。无白名单条目的类型
 * 一律整批拒绝——如 §13 首版的图片节点（AI 命令暂不创建/修改，快照
 * 只读可见）：白名单缺失若放行，update_node 可携任意字段直抵画布
 * （prompt 注入对象后快照/生成即崩，畸形 outputs 落盘重开被静默修复）。 */
function checkFieldKeys(nodeType: string, fields: Record<string, unknown>): string | null {
  const allowed = NODE_FIELD_KEYS[nodeType]
  if (!allowed) {
    return `${NODE_TYPE_LABELS[nodeType] ?? (nodeType || '未知类型')} 暂不支持 AI 命令修改`
  }
  const unknownKeys = Object.keys(fields).filter((k) => !allowed.includes(k))
  if (unknownKeys.length === 0) return null
  return `未知字段：${unknownKeys.join('、')}（${NODE_TYPE_LABELS[nodeType]} 允许：${allowed.join('、')}）`
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
 * 收敛在 FoldState；本函数只负责建状态与分发。
 */

/** 折叠校验的虚拟图状态：随每条命令演进的最终态投影。 */
interface FoldState {
  labels: Map<string, string>
  types: Map<string, string>
  /** branch 节点 id → 选项列表（校验 optionIndex 并解析稳定选项 id 端口）。 */
  branchOptions: Map<string, Array<{ id: string; label: string }>>
  virtualEdges: Array<{ source: string; target: string; sourceHandle?: string | null; type?: string }>
  /** 本批尚未删除的节点 id（含 __new__ 虚拟 id）。 */
  exists: Set<string>
  /** ref 别名 → 所属节点 id。 */
  refOwner: Map<string, string>
  /** 本批 options 更新失败的分支节点 id：其出口连线的 optionIndex 校验
   * 随前序修复自愈，按 contingent 跳过（同 ref 依赖，见 isContingentRef）。 */
  failedBranchOptionUpdates: Set<string>
  /** 本批失败的连线变更（op + 原始端点 token 对）：依赖其变更结果的后续
   * 连线命令按 contingent 跳过（见 isContingentEdgePair）。 */
  failedEdgePairs: Set<string>
  /** 项目资产索引（id → MIME）：shot.refs 引用位校验用。 */
  assets: ReadonlyMap<string, string>
  items: PreviewItem[]
  issues: BatchIssue[]
  commands: ValidatedCommand[]
  fail: (index: number, message: string) => void
}

/** AI 可补丁的节点类型（NODE_FIELD_KEYS 的键域）：图片节点不在此域
 * （§13 首版 AI 只读）。foldUpdate 经 checkFieldKeys 拒绝白名单外类型后，
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
  const keyError = checkFieldKeys(nodeType, data)
  if (keyError) return st.fail(index, keyError)
  const shapeError = nodeValueShapeError(nodeType, data, st.assets)
  if (shapeError) return st.fail(index, shapeError)
  if (nodeType === 'branch' && Array.isArray(data.options)) {
    const optError = branchOptionsError(data.options as unknown[])
    if (optError) return st.fail(index, optError)
  }
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
  if (isContingentRef(st, cmd, 'nodeId')) return
  const id = resolveRef(st, cmd, 'nodeId')
  if (!id) return st.fail(index, `节点不存在：${asText(cmd.nodeId)}`)
  const nodeType = st.types.get(id)
  const patch = cmd.patch
  if (!plainObject(patch) || Object.keys(patch).length === 0) return st.fail(index, 'patch 为空')
  const keyError = checkFieldKeys(nodeType ?? '', patch)
  if (keyError) return st.fail(index, keyError)
  const patchShapeError = nodeValueShapeError(nodeType ?? '', patch, st.assets)
  if (patchShapeError) return st.fail(index, patchShapeError)
  if (nodeType === 'branch' && Array.isArray(patch.options)) {
    const optError = branchOptionsError(patch.options as unknown[])
    if (optError) return st.fail(index, optError)
  }
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
  // 后续出口连线的 optionIndex/重复检查恢复按最新选项表独立判断
  st.failedBranchOptionUpdates.delete(id)
  st.branchOptions.set(id, normalized.options as Array<{ id: string; label: string }>)
}

function foldDelete(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  if (isContingentRef(st, cmd, 'nodeId')) return
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
  if (!optionContingent && st.virtualEdges.some((e) => e.source === src && e.target === dst && (e.sourceHandle ?? null) === handle)) {
    return st.fail(index, `重复连线：${pairLabel}`)
  }
  // attach 是派生从属边（§4.4 垂直语义）：自身不查环，也不参与
  // 剧情流环检测——环只可能出现在横向剧情流上
  if (kind !== 'attach' && cycleContingent(st, cmd, index, src, dst, pairLabel)) return
  // 独立约束全部通过：剩余校验随前序修复自愈，本轮不折叠不点名
  if (optionContingent) return
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

/** 成环守卫（foldConnectEdge 拆出，S3776）：非 attach 连线加环检查。
 * 经更长路径成环仍独立点名；同对断线在本批失败（如端点写反报「没有
 * 这条连线」）时 contingent 跳过——残留边随断线修正移除，反转连线
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
  if (!wouldCreateCycle(st.virtualEdges.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE), src, dst)) {
    return false
  }
  // 自环独立于任何前序断线结果，不适用 contingent 豁免
  if (src !== dst && st.failedEdgePairs.has(edgePairKey('disconnect_edge', cmd))) return true
  st.fail(index, `会造成循环剧情：${pairLabel}`)
  return true
}

/** connect_edge / disconnect_edge 的折叠校验。 */
function foldEdge(st: FoldState, cmd: Record<string, unknown>, index: number, op: string): void {
  const ends = resolveEndpoints(st, cmd, index)
  if (ends === 'contingent' || ends === 'missing') return
  if (ends === 'selfloop') {
    // 必然自环独立于任何失败前序（create 修复后仍非法），首轮即点名
    return st.fail(index, `会造成循环剧情：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`)
  }
  const { src, dst } = ends
  const pairLabel = `${st.labels.get(src) ?? '未知节点'} → ${st.labels.get(dst) ?? '未知节点'}`

  if (op === 'disconnect_edge') {
    const hitIdx = st.virtualEdges.findIndex((e) => e.source === src && e.target === dst)
    if (hitIdx < 0) {
      // 目标边不存在可能因本批同对的 connect 失败： contingent 跳过，
      // 随连线修正自愈，不误报「没有这条连线」
      if (st.failedEdgePairs.has(edgePairKey('connect_edge', cmd))) return
      return st.fail(index, `没有这条连线：${pairLabel}`)
    }
    st.virtualEdges.splice(hitIdx, 1)
    st.items.push({
      kind: 'disconnect',
      danger: false,
      key: `x${index}`,
      label: `${OP_LABELS.disconnect} ${pairLabel}${reasonOf(cmd)}`,
    })
    st.commands.push({
      op,
      sourceId: asText(cmd.sourceId),
      targetId: asText(cmd.targetId),
      reason: asText(cmd.reason),
    })
    return
  }
  foldConnectEdge(st, cmd, index, src, dst, pairLabel)
}

/** 折叠器分发表：op → 处理函数。 */
const FOLDERS: Record<string, (st: FoldState, cmd: Record<string, unknown>, index: number) => void> = {
  create_node: foldCreate,
  update_node: foldUpdate,
  delete_node: foldDelete,
  connect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'connect_edge'),
  disconnect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'disconnect_edge'),
}

/** 失败连线变更的原始端点对键（op + 模型自报 token，含拼错的端点）。 */
function edgePairKey(op: string, cmd: Record<string, unknown>): string {
  return `${op}\u0000${asText(cmd.sourceId)}\u0000${asText(cmd.targetId)}`
}

/** 折叠失败后的依赖登记（分发循环调用）：create 失败登记其 ref（指向
 * 未入图的虚拟 id）、branch 的 options 更新失败登记目标、连线变更失败
 * 登记原始端点对——后续依赖这些变更结果的命令按 contingent 跳过、
 * 随前序修复自愈，而非被误报「节点不存在 / 下标越界 / 成环」。 */
/** 失败的 branch options 更新分类登记（registerFailedMutation 拆出，
 * S3776）：选项自身异型、结果无从折叠时登记 contingent 标记；选项合法、
 * 结果已确定时以归一化后的暂定选项表供下游连线独立校验（级联断线簿记
 * 随前序修复后再折叠，为已记录边界）。 */
function registerFailedOptionsUpdate(
  st: FoldState,
  raw: Record<string, unknown>,
  target: string,
): void {
  const patch = plainObject(raw.patch) ? raw.patch : undefined
  if (patch === undefined || !Array.isArray(patch.options)) return
  if (branchOptionsError(patch.options as unknown[]) !== null) {
    st.failedBranchOptionUpdates.add(target)
    return
  }
  const normalized = normalizeNodeFields('branch', patch, st.branchOptions.get(target))
  st.branchOptions.set(target, normalized.options as Array<{ id: string; label: string }>)
}

function registerFailedMutation(st: FoldState, raw: Record<string, unknown>, index: number): void {
  if (raw.op === 'create_node') {
    const refName = typeof raw.ref === 'string' ? raw.ref.trim() : ''
    if (refName !== '') st.refOwner.set(refName, virtualIdOf(index))
    return
  }
  if (raw.op === 'update_node') {
    const target = resolveRef(st, raw, 'nodeId')
    if (
      target !== null &&
      st.types.get(target) === 'branch' &&
      plainObject(raw.patch) &&
      Array.isArray((raw.patch as Record<string, unknown>).options)
    ) {
      registerFailedOptionsUpdate(st, raw, target)
    }
    return
  }
  if (raw.op === 'connect_edge' || raw.op === 'disconnect_edge') {
    st.failedEdgePairs.add(edgePairKey(raw.op as string, raw))
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
    failedBranchOptionUpdates: new Set(),
    failedEdgePairs: new Set(),
    assets: graph.assets,
    items: [],
    issues: [],
    commands: [],
    fail: (index, message) => st.issues.push({ index, message }),
  }

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
