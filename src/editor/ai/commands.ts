import {
  branchOptionHandle,
  connectionEndpointIssue,
  type EdgeKind,
  removedOptionHandles,
  SCENE_SHOT_HANDLE,
  wouldCreateCycle,
} from '../graphRules'
import { uid } from '../../uid'

/**
 * AI 批量命令的解析与校验（docs/ui-design.md §6 改动预览卡、数据模型 §12）。
 *
 * 核心约束：Agent 只产出命令，写操作执行前必须整批预览；任一条非法即
 * 整批拒绝（预览卡 = 一个 batch 命令，执行后一步撤销）。本模块是纯函数：
 * 输入模型的回复文本与画布快照，输出可直接渲染的预览条目与待执行命令，
 * 不触碰任何 React 状态。
 */

/** 模型可产出的五类命令（对齐数据模型 §12.2 写工具集的首版子集）。 */
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
  commands: AiCommand[]
  issues: BatchIssue[]
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
 * 各类型节点的合法字段（与 nodes/types.ts 的 *NodeData 一一对应，
 * 即 ⚙️ 设置面板可编辑的字段）。AI 的 data/patch 出现白名单之外的字段
 * 一律整批拒绝——宁可拒绝也不静默写错字段。
 * episodeNo（§3.5 分集）：编剧侧四类可写；分镜卡随宿主场景，不可单独分集。
 */
const NODE_FIELD_KEYS: Record<string, readonly string[]> = {
  scene: ['name', 'sceneNo', 'interior', 'locationId', 'time', 'weather', 'synopsis', 'characterIds', 'episodeNo'],
  dialogue: ['name', 'lines', 'episodeNo'],
  beat: ['name', 'tone', 'episodeNo'],
  branch: ['prompt', 'options', 'episodeNo'],
  shot: ['shotNo', 'size', 'picture', 'prompt', 'refs'],
}
const OP_LABELS = { create: '创建', update: '修改', delete: '删除', connect: '连线', disconnect: '断开' }
const EDGE_KIND_LABELS: Record<string, string> = {
  sequence: '剧情流',
  branch: '分支出口',
  attach: '分镜下挂',
}

/**
 * 从助手回复中提取批次对象：优先取最后一个 ```json 围栏，
 * 其次裸 `{"commands":[...]}` 前缀。无法解析返回 undefined（纯讨论回复）。
 */

/** 取最后一个 ```json 围栏的正文；无闭合围栏返回 null。
 * 用 indexOf 线性扫描等价替代 /```json\s*([\s\S]*?)```/gi 的惰性匹配，
 * 消除超线性回溯（SonarQube S8786）；大小写不敏感与「取最后一个」
 * 语义由 extractBatchJson 测试钉住。标记大小写不敏感按码元逐段比较，
 * 避免 toLowerCase 改变字符串长度导致下标漂移（如 İ）。 */
function lastFenceBody(text: string): string | null {
  let last: string | null = null
  let from = 0
  for (;;) {
    const open = text.indexOf('```', from)
    if (open === -1) break
    const afterTicks = open + 3
    if (text.slice(afterTicks, afterTicks + 4).toLowerCase() !== 'json') {
      from = afterTicks
      continue
    }
    let bodyStart = afterTicks + 4
    while (bodyStart < text.length && /\s/.test(text[bodyStart])) bodyStart++
    const close = text.indexOf('```', bodyStart)
    if (close === -1) break // 之后不再有 ```，自然也不再有可闭合的围栏
    last = text.slice(bodyStart, close)
    from = close + 3
  }
  return last
}

export function extractBatchJson(text: string): { commands: unknown[] } | undefined {
  const last = lastFenceBody(text)
  const candidates: string[] = []
  if (last !== null) candidates.push(last)
  const trimmed = text.trim()
  if (trimmed.startsWith('{"commands"')) candidates.push(trimmed)
  for (const raw of candidates) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isBatchShape(parsed)) return parsed
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined
}

function isBatchShape(v: unknown): v is { commands: unknown[] } {
  return (
    typeof v === 'object' && v !== null && Array.isArray((v as { commands?: unknown }).commands)
  )
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 预览标签尾部的理由后缀：有理由才追加「：理由」。 */
function reasonOf(cmd: Record<string, unknown>): string {
  const r = asText(cmd.reason)
  return r ? `：${r}` : ''
}

/** data/patch 字段白名单校验；返回错误文案或 null。 */
function checkFieldKeys(nodeType: string, fields: Record<string, unknown>): string | null {
  const allowed = NODE_FIELD_KEYS[nodeType]
  if (!allowed) return null
  const unknownKeys = Object.keys(fields).filter((k) => !allowed.includes(k))
  if (unknownKeys.length === 0) return null
  return `未知字段：${unknownKeys.join('、')}（${NODE_TYPE_LABELS[nodeType]} 允许：${allowed.join('、')}）`
}

/**
 * 逐条折叠校验：维护「当前图 + 本批已建未删」的虚拟状态，
 * 让批次内引用（ref 建链）与成环/重复判定都按最终态计算。
 * 任一问题 → ok=false（整批拒绝），commands 为空。
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
  items: PreviewItem[]
  issues: BatchIssue[]
  commands: AiCommand[]
  fail: (index: number, message: string) => void
}

/** nodeId/sourceId/targetId 解析：允许既有 id 或本批新建的 ref；
 * 已被本批删除的节点（含按 ref 引用的）一律视为不存在。 */
function resolveRef(st: FoldState, cmd: Record<string, unknown>, key: string): string | null {
  const s = asText(cmd[key])
  if (s === '') return null
  if (st.exists.has(s)) return s
  const owner = st.refOwner.get(s)
  return owner !== undefined && st.exists.has(owner) ? owner : null
}

/** 入站归一化（信任边界）：列表项稳定 id 补齐（S6479）。
 * AI 可按旧契约发送无 id 的台词行/引用位、或纯字符串选项；
 * 进画布前统一升级为带 id 结构。已有 id 仅在「非空且列表内唯一」时
 * 保留（幂等）；空串/重复 id 就地重生成——这些 id 直接作 React key，
 * 冲突会导致行复用/误编辑。非对象条目原样放行（形状校验不在本层）。 */
function normalizeNodeFields(nodeType: string, fields: Record<string, unknown>): Record<string, unknown> {
  /** 列表项 id 归一化：非空唯一保留，否则重生成。 */
  const normalizeIds = (items: unknown[], prefix: string): unknown[] => {
    const seen = new Set<string>()
    return items.map((item) => {
      if (!plainObject(item)) return item
      const id = item.id
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id)
        return item
      }
      const fresh = uid(prefix)
      seen.add(fresh)
      return { ...item, id: fresh }
    })
  }
  const out = { ...fields }
  if (nodeType === 'dialogue' && Array.isArray(out.lines)) {
    out.lines = normalizeIds(out.lines as unknown[], 'line')
  }
  if (nodeType === 'branch' && Array.isArray(out.options)) {
    out.options = normalizeIds(
      (out.options as unknown[]).map((o) => (typeof o === 'string' ? { label: o } : o)),
      'opt',
    )
  }
  if (nodeType === 'shot' && Array.isArray(out.refs)) {
    out.refs = normalizeIds(out.refs as unknown[], 'ref')
  }
  return out
}

/** 分支 options 入站成员校验（信任边界）：字符串选项（随后由归一化升级为
 * {label} 对象）或带字符串 label 的普通对象才合法。异型成员（null/数字/
 * 缺 label/对象形态 label）若放行，级联簿记的 removedOptionHandles 会对
 * o.id 解引用直接抛异常，对象形态 label 进画布后还会被 BranchNode 当
 * React 子节点渲染而崩溃——返回拒绝原因，null 表示通过。 */
function branchOptionsError(options: unknown[]): string | null {
  const bad = options.some((o) => typeof o !== 'string' && (!plainObject(o) || typeof o.label !== 'string'))
  return bad ? '分支 options 含异型成员（须为字符串或带字符串 label 的对象）' : null
}

/** shot.refs 成员的引用位联合（§4.2 ShotRef 的信任边界对等）。 */
function isShotRefMember(r: unknown): boolean {
  if (!plainObject(r)) return false
  if (r.kind !== 'character' && r.kind !== 'location' && r.kind !== 'audio') return false
  const hasAsset = typeof r.assetId === 'string'
  const hasLabel = typeof r.label === 'string'
  return hasAsset !== hasLabel
}

/** 各类型的标量字段值形状（nodeValueShapeError 的分类型明细）。 */
function scalarShapeIssues(nodeType: string, fields: Record<string, unknown>): string[] {
  const issues: string[] = []
  const str = (f: string) => {
    if (fields[f] !== undefined && typeof fields[f] !== 'string') issues.push(`${f} 须为字符串`)
  }
  // 数值字段只拦类型（崩溃形状）；正整数/安全整数域由 §9.3 命令边界与
  // §11.1 加载归一化负责——批量层历史上即容忍 episodeNo: 0（加载时删除）
  const finiteNumber = (f: string) => {
    const v = fields[f]
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
      issues.push(`${f} 须为数字`)
    }
  }
  switch (nodeType) {
    case 'scene':
      ;['name', 'locationId', 'time', 'weather', 'synopsis'].forEach(str)
      finiteNumber('sceneNo')
      finiteNumber('episodeNo')
      if (fields.interior !== undefined && typeof fields.interior !== 'boolean') {
        issues.push('interior 须为布尔')
      }
      break
    case 'dialogue':
      str('name')
      finiteNumber('episodeNo')
      break
    case 'beat':
      str('name')
      str('tone')
      finiteNumber('episodeNo')
      break
    case 'branch':
      str('prompt')
      finiteNumber('episodeNo')
      break
    case 'shot':
      ;['size', 'picture', 'prompt'].forEach(str)
      finiteNumber('shotNo')
      break
    default:
      break
  }
  return issues
}

/** 各类型的列表成员值形状（nodeValueShapeError 的分类型明细）。 */
function listShapeIssues(nodeType: string, fields: Record<string, unknown>): string[] {
  const issues: string[] = []
  if (nodeType === 'scene' && fields.characterIds !== undefined) {
    const arr = fields.characterIds
    if (!Array.isArray(arr) || arr.some((c) => typeof c !== 'string')) {
      issues.push('characterIds 须为字符串数组')
    }
  }
  if (nodeType === 'dialogue' && fields.lines !== undefined) {
    const arr = fields.lines
    const bad =
      !Array.isArray(arr) ||
      arr.some(
        (l) =>
          !plainObject(l) ||
          typeof l.text !== 'string' ||
          ('speaker' in l && typeof l.speaker !== 'string'),
      )
    if (bad) issues.push('lines 须为带字符串 text 的对象数组（speaker 可选字符串）')
  }
  if (nodeType === 'shot' && fields.refs !== undefined) {
    const arr = fields.refs
    if (!Array.isArray(arr) || arr.some((r) => !isShotRefMember(r))) {
      issues.push('refs 须为引用位对象数组（kind ∈ character/location/audio，assetId/label 恰一为字符串）')
    }
  }
  return issues
}

/** 逐类型载荷值形状校验（信任边界，§9.3/§11.3 的批命令对等）：字段键
 * 白名单只拦未知字段，异型**值**若放行会经 buildCanvasNode 摊进活动节点，
 * 渲染层（ShotNode 的 picture/refs、DialogueNode 的 lines）解引用即崩，
 * 加载归一化来不及兜底。字段存在才校验（patch 局部更新）；null 表示通过。 */
function nodeValueShapeError(nodeType: string, fields: Record<string, unknown>): string | null {
  const issues = [...scalarShapeIssues(nodeType, fields), ...listShapeIssues(nodeType, fields)]
  return issues.length > 0 ? `载荷形状错误：${issues.join('；')}` : null
}

function foldCreate(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  const nodeType = asText(cmd.nodeType)
  if (!(nodeType in NODE_TYPE_LABELS)) return st.fail(index, `未知节点类型：${nodeType || '（空）'}`)
  const data = cmd.data ?? {}
  if (!plainObject(data)) return st.fail(index, 'data 必须是字段对象')
  const keyError = checkFieldKeys(nodeType, data)
  if (keyError) return st.fail(index, keyError)
  const shapeError = nodeValueShapeError(nodeType, data)
  if (shapeError) return st.fail(index, shapeError)
  if (nodeType === 'branch' && Array.isArray(data.options)) {
    const optError = branchOptionsError(data.options as unknown[])
    if (optError) return st.fail(index, optError)
  }
  const typeLabel = NODE_TYPE_LABELS[nodeType]
  const name = asText(data.name) || asText(data.prompt) || '未命名'
  const virtualId = `__new__:${index}`
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
  const id = resolveRef(st, cmd, 'nodeId')
  if (!id) return st.fail(index, `节点不存在：${asText(cmd.nodeId)}`)
  const patch = cmd.patch
  if (!plainObject(patch) || Object.keys(patch).length === 0) return st.fail(index, 'patch 为空')
  const keyError = checkFieldKeys(st.types.get(id) ?? '', patch)
  if (keyError) return st.fail(index, keyError)
  const patchShapeError = nodeValueShapeError(st.types.get(id) ?? '', patch)
  if (patchShapeError) return st.fail(index, patchShapeError)
  if (st.types.get(id) === 'branch' && Array.isArray(patch.options)) {
    const optError = branchOptionsError(patch.options as unknown[])
    if (optError) return st.fail(index, optError)
  }
  st.items.push({
    kind: 'update',
    danger: false,
    key: `u${index}`,
    label: `${OP_LABELS.update} ${st.labels.get(id) ?? '未知节点'}（${Object.keys(patch).join('、')}）${reasonOf(cmd)}`,
  })
  const normalized = normalizeNodeFields(st.types.get(id) ?? '', patch)
  // 分支选项被替换时：登记刷新 + 被删选项的出口边从校验态移除（§8.2.2
  // 级联与 simulateBatch 同规则）——否则后续连线的成环检测会被旧边误判
  if (st.types.get(id) === 'branch' && Array.isArray(normalized.options)) {
    const removed = removedOptionHandles(
      st.branchOptions.get(id) ?? [],
      normalized.options as Array<{ id: string }>,
    )
    if (removed.length > 0) {
      const gone = new Set(removed)
      st.virtualEdges = st.virtualEdges.filter(
        (e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle)),
      )
    }
    st.branchOptions.set(id, normalized.options as Array<{ id: string; label: string }>)
  }
  st.commands.push({
    op: 'update_node',
    nodeId: asText(cmd.nodeId),
    patch: normalized,
    reason: asText(cmd.reason),
  })
}

function foldDelete(st: FoldState, cmd: Record<string, unknown>, index: number): void {
  const id = resolveRef(st, cmd, 'nodeId')
  if (!id) return st.fail(index, `节点不存在：${asText(cmd.nodeId)}`)
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

/** connect_edge / disconnect_edge 的折叠校验。 */
function foldEdge(st: FoldState, cmd: Record<string, unknown>, index: number, op: string): void {
  const src = resolveRef(st, cmd, 'sourceId')
  const dst = resolveRef(st, cmd, 'targetId')
  if (!src || !dst) {
    return st.fail(index, `端点不存在：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`)
  }
  const pairLabel = `${st.labels.get(src) ?? '未知节点'} → ${st.labels.get(dst) ?? '未知节点'}`

  if (op === 'disconnect_edge') {
    const hitIdx = st.virtualEdges.findIndex((e) => e.source === src && e.target === dst)
    if (hitIdx < 0) return st.fail(index, `没有这条连线：${pairLabel}`)
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

  // connect_edge：按连线语义分端口校验（§4.4）
  const kind = asText(cmd.edgeKind) || 'sequence'
  if (!(kind in EDGE_KIND_LABELS)) return st.fail(index, `未知连线类型：${kind}`)
  const port = edgePortOf(st, kind, cmd, src, dst)
  if (typeof port === 'string') return st.fail(index, port)
  const { handle, optionIndex } = port
  // 端点类型约束（§5 端口归属）：与加载归一化的孤儿边规则对等——放行
  // 「保存后下次加载即被静默删除」的连线（分镜卡参与剧情流等）是坏体验
  const endpointIssue = connectionEndpointIssue(
    st.types.get(src),
    st.types.get(dst),
    kind as EdgeKind,
  )
  if (endpointIssue) return st.fail(index, `${endpointIssue}：${pairLabel}`)
  if (st.virtualEdges.some((e) => e.source === src && e.target === dst && (e.sourceHandle ?? null) === handle)) {
    return st.fail(index, `重复连线：${pairLabel}`)
  }
  // attach 是派生从属边（§4.4 垂直语义）：自身不查环，也不参与
  // 剧情流环检测——环只可能出现在横向剧情流上
  if (kind !== 'attach') {
    const flowEdges = st.virtualEdges.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
    if (wouldCreateCycle(flowEdges, src, dst)) {
      return st.fail(index, `会造成循环剧情：${pairLabel}`)
    }
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

/** 折叠器分发表：op → 处理函数。 */
const FOLDERS: Record<string, (st: FoldState, cmd: Record<string, unknown>, index: number) => void> = {
  create_node: foldCreate,
  update_node: foldUpdate,
  delete_node: foldDelete,
  connect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'connect_edge'),
  disconnect_edge: (st, cmd, index) => foldEdge(st, cmd, index, 'disconnect_edge'),
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
    items: [],
    issues: [],
    commands: [],
    fail: (index, message) => st.issues.push({ index, message }),
  }

  if (!Array.isArray(rawCommands)) {
    return { ok: false, items: [], commands: [], issues: [{ index: -1, message: '批次不是命令数组' }], hasDeletes: false }
  }

  rawCommands.forEach((raw, index) => {
    if (st.issues.length > 0) return // 已坏，仅统计首个问题即可
    if (!plainObject(raw)) return st.fail(index, '条目不是对象')
    const folder = FOLDERS[raw.op as string]
    if (folder) folder(st, raw, index)
    else st.fail(index, `未知操作：${String(raw.op)}`)
  })

  const ok = st.issues.length === 0
  // 删除类置顶（§6 危险操作升级）；其余按到达顺序稳定排列
  const sorted = [...st.items.filter((i) => i.danger), ...st.items.filter((i) => !i.danger)]
  return {
    ok,
    items: sorted,
    commands: ok ? st.commands : [],
    issues: st.issues,
    hasDeletes: sorted.some((i) => i.kind === 'delete'),
  }
}
