import type { BatchValidation } from './commands'

/** 项目级 AI 会话的独立落盘格式；不进入画布 ProjectDocument。 */
export interface AiSession {
  schemaVersion: 1
  entries: ThreadEntry[]
}

/** 可恢复会话条目：消息、改动预览及其执行回执均只作为历史记录保存。 */
export interface ThreadEntry {
  id: number
  kind: 'msg' | 'note'
  role?: 'user' | 'assistant'
  text: string
  /** 运行时标注（不落盘，归一化丢弃）：回执对应的预览卡条目 id。
   * 未确认画布落盘的执行不落回执——回执可能被追加在会话尾部而非卡片
   * 紧邻位置，必须按关联而非位置识别。 */
  cardReceiptFor?: number
  card?: {
    v: BatchValidation
    status: 'pending' | 'executed' | 'dismissed'
    /** 运行时标注（落盘无权威语义，归一化丢弃、恢复时重derive）：
     * 跨会话恢复的历史执行卡。撤销栈不随会话持久化，历史卡不得
     * 宣称当前 ⌘Z 可整批撤销。 */
    historical?: true
    /** 运行时标注（不落盘：持久化映射把未确认卡降级为 pending）：
     * 批次已在内存执行，但承载它的画布文档尚未确认落盘。 */
    uncommitted?: true
    /** 执行后的画布批次计数（仅未确认卡随 pending 落盘）：重开时与画布
     * 内的计数比对判定批次是否已随画布落盘——画布计数已达该值即已应用，
     * 恢复为历史执行卡；未达即未落盘，恢复为可再次执行的待执行卡。
     * 确认落盘后即剥离。 */
    aiRevisionAfter?: number
  }
}

/** 会话加载归一化结果；损坏条目隔离而不影响项目画布。 */
export interface AiSessionNormalizeResult {
  session: AiSession
  repaired: boolean
}

const EMPTY_SESSION: AiSession = { schemaVersion: 1, entries: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPreviewItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['delete', 'disconnect', 'create', 'update', 'connect', 'create_entity', 'update_entity'].includes(
      value.kind as string,
    ) &&
    typeof value.danger === 'boolean' &&
    typeof value.label === 'string' &&
    typeof value.key === 'string'
  )
}

function isBatchIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    Number.isSafeInteger(value.index) &&
    typeof value.message === 'string'
  )
}

function isPersistedCommand(value: unknown): boolean {
  if (!isRecord(value) || typeof value.op !== 'string') return false
  if (value.op === 'update_node') {
    return (
      typeof value.nodeId === 'string' &&
      isRecord(value.patch) &&
      typeof value.patch.nodeType === 'string' &&
      isRecord(value.patch.patch)
    )
  }
  if (value.op === 'upsert_character' || value.op === 'upsert_location') return isRecord(value.fields)
  return ['create_node', 'delete_node', 'connect_edge', 'disconnect_edge'].includes(value.op)
}

function isValidation(value: unknown): value is BatchValidation {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    Array.isArray(value.items) && value.items.every(isPreviewItem) &&
    Array.isArray(value.commands) && value.commands.every(isPersistedCommand) &&
    Array.isArray(value.issues) && value.issues.every(isBatchIssue) &&
    typeof value.hasDeletes === 'boolean'
  )
}

function entryOf(value: unknown): ThreadEntry | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.text !== 'string'
  ) {
    return null
  }
  if (value.kind === 'note') return { id: value.id, kind: 'note', text: value.text }
  if (value.kind !== 'msg' || (value.role !== 'user' && value.role !== 'assistant')) return null
  if (value.card === undefined) return { id: value.id, kind: 'msg', role: value.role, text: value.text }
  if (!isRecord(value.card) || !isValidation(value.card.v)) return null
  if (value.card.status !== 'pending' && value.card.status !== 'executed' && value.card.status !== 'dismissed') {
    return null
  }
  return {
    id: value.id,
    kind: 'msg',
    role: value.role,
    text: value.text,
    card: {
      v: value.card.v,
      status: value.card.status,
      ...(typeof value.card.aiRevisionAfter === 'number' &&
      Number.isSafeInteger(value.card.aiRevisionAfter) &&
      value.card.aiRevisionAfter >= 0
        ? { aiRevisionAfter: value.card.aiRevisionAfter }
        : {}),
    },
  }
}

/** 从不可信的本地 JSON 恢复历史；旧项目无文件时返回空会话。 */
export function normalizeAiSession(raw: unknown): AiSessionNormalizeResult {
  if (raw === undefined || raw === null) return { session: EMPTY_SESSION, repaired: false }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    return { session: EMPTY_SESSION, repaired: true }
  }
  let repaired = false
  const seen = new Set<number>()
  const entries = raw.entries.flatMap((value) => {
    const entry = entryOf(value)
    if (entry === null || seen.has(entry?.id)) {
      repaired = true
      return []
    }
    seen.add(entry.id)
    return [entry]
  })
  return { session: { schemaVersion: 1, entries }, repaired }
}

/** JSON 形状的深度相等（会话条目为纯数据；运行时标注字段同样参与比较，
 * 分叉判定宁严勿松）。 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEquals(item, b[index]))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) =>
    deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** 判断 base 的历史是否为 superset 的逐条前缀（深度相等）：保留区与磁盘
 * 历史的调和判定（评审 pullrequestreview-5161978174）——只有当磁盘历史
 * 完全包含于保留快照（保留快照是其超集）时，保留快照才可无丢失地覆盖
 * 落盘；分叉或磁盘更长时必须载入磁盘版本，不得以保留快照直接覆盖。 */
export function isSessionPrefix(base: AiSession, superset: AiSession): boolean {
  return (
    base.entries.length <= superset.entries.length &&
    base.entries.every((entry, index) => deepEquals(entry, superset.entries[index]))
  )
}
