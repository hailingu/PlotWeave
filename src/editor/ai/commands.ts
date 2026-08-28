import { branchOptionHandle, SCENE_SHOT_HANDLE, wouldCreateCycle } from '../graphRules'

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
    /** branch 节点必填：选项条数，branch 连线的 optionIndex 越界校验用。 */
    optionsCount?: number
  }>
  edges: Array<{ source: string; target: string; sourceHandle?: string | null; type?: string }>
}

/** 预览卡的单行条目（§6：逐项列出受影响节点与变更类型）。 */
export interface PreviewItem {
  kind: 'delete' | 'disconnect' | 'create' | 'update' | 'connect'
  danger: boolean
  label: string
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
export function extractBatchJson(text: string): { commands: unknown[] } | undefined {
  const fence = /```json\s*([\s\S]*?)```/gi
  let last: string | null = null
  for (const m of text.matchAll(fence)) last = m[1]
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
 */
export function validateAiBatch(rawCommands: unknown, graph: AiGraphSnapshot): BatchValidation {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]))
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const optionsCounts = new Map(
    graph.nodes.filter((n) => typeof n.optionsCount === 'number').map((n) => [n.id, n.optionsCount as number]),
  )
  const virtualEdges: Array<{
    source: string
    target: string
    sourceHandle?: string | null
    type?: string
  }> = graph.edges.map((e) => ({ ...e }))
  const exists = new Set(labels.keys())
  const refOwner = new Map<string, string>()

  const items: PreviewItem[] = []
  const issues: BatchIssue[] = []
  const commands: AiCommand[] = []

  if (!Array.isArray(rawCommands)) {
    return { ok: false, items, commands, issues: [{ index: -1, message: '批次不是命令数组' }], hasDeletes: false }
  }

  const fail = (index: number, message: string) => issues.push({ index, message })

  rawCommands.forEach((raw, index) => {
    if (issues.length > 0) return // 已坏，仅统计首个问题即可
    if (!plainObject(raw)) return fail(index, '条目不是对象')
    const cmd = raw as Record<string, unknown>
    const op = cmd.op

    if (op === 'create_node') {
      const nodeType = asText(cmd.nodeType)
      if (!(nodeType in NODE_TYPE_LABELS)) return fail(index, `未知节点类型：${nodeType || '（空）'}`)
      const data = cmd.data ?? {}
      if (!plainObject(data)) return fail(index, 'data 必须是字段对象')
      const keyError = checkFieldKeys(nodeType, data)
      if (keyError) return fail(index, keyError)
      const typeLabel = NODE_TYPE_LABELS[nodeType]
      const name = asText(data.name) || asText(data.prompt) || '未命名'
      const virtualId = `__new__:${index}`
      const refName = typeof cmd.ref === 'string' ? cmd.ref.trim() : ''
      exists.add(virtualId)
      labels.set(virtualId, `${typeLabel} · ${name}（新建）`)
      types.set(virtualId, nodeType)
      if (refName !== '') refOwner.set(refName, virtualId)
      items.push({ kind: 'create', danger: false, label: `${OP_LABELS.create} ${typeLabel} · ${name}` })
      commands.push({ op: 'create_node', nodeType, ref: refName === '' ? undefined : refName, data })
      return
    }

    // 以下操作的 nodeId 允许引用本批新建节点的 ref 或既有 id；
    // 已被本批删除的节点（含按 ref 引用的）一律视为不存在。
    const resolve = (key: string): string | null => {
      const s = asText(cmd[key])
      if (s === '') return null
      if (exists.has(s)) return s
      const owner = refOwner.get(s)
      return owner !== undefined && exists.has(owner) ? owner : null
    }
    const describe = (id: string): string => labels.get(id) ?? '未知节点'
    const typeOf = (id: string): string => types.get(id) ?? ''
    const reasonSuffix = () => {
      const r = asText(cmd.reason)
      return r ? `：${r}` : ''
    }

    if (op === 'update_node') {
      const id = resolve('nodeId')
      if (!id) return fail(index, `节点不存在：${asText(cmd.nodeId)}`)
      const patch = cmd.patch
      if (!plainObject(patch) || Object.keys(patch).length === 0) return fail(index, 'patch 为空')
      const keyError = checkFieldKeys(typeOf(id), patch)
      if (keyError) return fail(index, keyError)
      items.push({
        kind: 'update',
        danger: false,
        label: `${OP_LABELS.update} ${describe(id)}（${Object.keys(patch).join('、')}）${reasonSuffix()}`,
      })
      commands.push({ op: 'update_node', nodeId: asText(cmd.nodeId), patch, reason: asText(cmd.reason) })
      return
    }

    if (op === 'delete_node') {
      const id = resolve('nodeId')
      if (!id) return fail(index, `节点不存在：${asText(cmd.nodeId)}`)
      exists.delete(id)
      for (const [ref, owner] of refOwner) if (owner === id) refOwner.delete(ref)
      virtualEdges.forEach((e) => {
        if (e.source === id) e.source = `__deleted__:${id}`
        if (e.target === id) e.target = `__deleted__:${id}`
      })
      items.push({ kind: 'delete', danger: true, label: `${OP_LABELS.delete} ${describe(id)}${reasonSuffix()}` })
      commands.push({ op: 'delete_node', nodeId: asText(cmd.nodeId), reason: asText(cmd.reason) })
      return
    }

    if (op === 'connect_edge' || op === 'disconnect_edge') {
      const src = resolve('sourceId')
      const dst = resolve('targetId')
      if (!src || !dst) {
        return fail(
          index,
          `端点不存在：${asText(cmd.sourceId)} → ${asText(cmd.targetId)}`,
        )
      }
      const pairLabel = `${describe(src)} → ${describe(dst)}`

      if (op === 'disconnect_edge') {
        const hitIdx = virtualEdges.findIndex((e) => e.source === src && e.target === dst)
        if (hitIdx < 0) return fail(index, `没有这条连线：${pairLabel}`)
        virtualEdges.splice(hitIdx, 1)
        items.push({
          kind: 'disconnect',
          danger: false,
          label: `${OP_LABELS.disconnect} ${pairLabel}${reasonSuffix()}`,
        })
        commands.push({
          op,
          sourceId: asText(cmd.sourceId),
          targetId: asText(cmd.targetId),
          reason: asText(cmd.reason),
        })
        return
      }

      // connect_edge：按连线语义分端口校验（§4.4）
      const kind = asText(cmd.edgeKind) || 'sequence'
      if (!(kind in EDGE_KIND_LABELS)) return fail(index, `未知连线类型：${kind}`)
      let handle: string | null = null
      let optionIndex: number | undefined
      if (kind === 'branch') {
        if (typeOf(src) !== 'branch') return fail(index, `branch 出口只能来自分支节点：${pairLabel}`)
        const count = optionsCounts.get(src)
        const idx = cmd.optionIndex
        if (typeof idx !== 'number' || !Number.isInteger(idx) || count === undefined || idx < 0 || idx >= count) {
          return fail(index, `optionIndex 必须是 0～${(count ?? 1) - 1} 的整数：${pairLabel}`)
        }
        handle = branchOptionHandle(idx)
        optionIndex = idx
      } else if (kind === 'attach') {
        if (typeOf(src) !== 'scene' || typeOf(dst) !== 'shot') {
          return fail(index, `分镜下挂只能从场景连向分镜卡：${pairLabel}`)
        }
        handle = SCENE_SHOT_HANDLE
      }
      if (
        virtualEdges.some(
          (e) =>
            e.source === src && e.target === dst && (e.sourceHandle ?? null) === handle,
        )
      ) {
        return fail(index, `重复连线：${pairLabel}`)
      }
      // attach 是派生从属边（§4.4 垂直语义）：自身不查环，也不参与
      // 剧情流环检测——环只可能出现在横向剧情流上
      if (kind !== 'attach') {
        const flowEdges = virtualEdges.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
        if (wouldCreateCycle(flowEdges, src, dst)) {
          return fail(index, `会造成循环剧情：${pairLabel}`)
        }
      }
      virtualEdges.push({
        source: src,
        target: dst,
        sourceHandle: handle,
        ...(kind === 'branch' ? { type: 'branch' } : {}),
      })
      const kindTag = kind === 'sequence' ? '' : `（${EDGE_KIND_LABELS[kind]}${kind === 'branch' ? ` ${optionIndex! + 1}` : ''}）`
      items.push({
        kind: 'connect',
        danger: false,
        label: `${OP_LABELS.connect}${kindTag} ${pairLabel}${reasonSuffix()}`,
      })
      commands.push({
        op: 'connect_edge',
        sourceId: asText(cmd.sourceId),
        targetId: asText(cmd.targetId),
        edgeKind: kind,
        ...(optionIndex !== undefined ? { optionIndex } : {}),
        reason: asText(cmd.reason),
      })
      return
    }

    fail(index, `未知操作：${String(op)}`)
  })

  const ok = issues.length === 0
  // 删除类置顶（§6 危险操作升级）；其余按到达顺序稳定排列
  const sorted = [...items.filter((i) => i.danger), ...items.filter((i) => !i.danger)]
  return {
    ok,
    items: sorted,
    commands: ok ? commands : [],
    issues,
    hasDeletes: sorted.some((i) => i.kind === 'delete'),
  }
}
