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
    /** 上次确认执行失败的诊断（仅 pending 保存）；供后续轮次辨认失败，
     * 重试成功或忽略后清除。旧会话缺省表示没有结构化失败记录。 */
    executionError?: string
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
      ...(value.card.status === 'pending' &&
      typeof value.card.executionError === 'string' && value.card.executionError.trim() !== ''
        ? { executionError: value.card.executionError }
        : {}),
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

/** 去掉执行确认的运行时标注（落盘确认与持久化映射共用）：uncommitted 与
 * aiRevisionAfter 都只在等待画布落盘期间有意义。 */
export function stripExecutionRuntime(
  card: NonNullable<ThreadEntry['card']>,
): NonNullable<ThreadEntry['card']> {
  const next = { ...card }
  delete next.uncommitted
  delete next.aiRevisionAfter
  return next
}

/** 去掉回执与卡片的运行时关联标注（不落盘）。 */
function stripReceiptLink(entry: ThreadEntry): ThreadEntry {
  if (entry.cardReceiptFor === undefined) return entry
  const next = { ...entry }
  delete next.cardReceiptFor
  return next
}

/** 落盘形态映射（不含容量裁剪）：未确认画布落盘的执行卡降级为 pending 并
 * 剔除其回执（按关联而非位置——回执总是追加在会话尾部）——画布若尚未
 * 持久化，重开后该卡应重新可执行，而不是同时声称已执行；保留
 * aiRevisionAfter 供重开时与画布批次计数对账。其余条目原样（剥掉运行时
 * 关联标注）。面板保存通道与进程内快照（重挂载种子、失败保留、退出冲刷
 * 待写）持此全量形态——会话内跨设置页/首页导航不丢历史（issue #64）。 */
export function persistedEntries(thread: ThreadEntry[]): ThreadEntry[] {
  const uncommitted = new Set(
    thread.filter((entry) => entry.card?.uncommitted).map((entry) => entry.id),
  )
  const entries: ThreadEntry[] = []
  for (const entry of thread) {
    if (
      entry.kind === 'note' &&
      entry.cardReceiptFor !== undefined &&
      uncommitted.has(entry.cardReceiptFor)
    ) {
      continue
    }
    if (entry.card?.uncommitted) {
      const card = { ...stripExecutionRuntime(entry.card), status: 'pending' as const }
      if (entry.card.aiRevisionAfter !== undefined) card.aiRevisionAfter = entry.card.aiRevisionAfter
      entries.push({ ...stripReceiptLink(entry), card })
      continue
    }
    entries.push(stripReceiptLink(entry))
  }
  return entries
}

/** 落盘总条数上限（issue #64）：待执行卡优先，同类自新向旧保留。预览卡的
 * 命令与补丁载荷使单条可能很大，历史无界会让 ai-session.json 与每次全量
 * 重写的体积随对话线性增长。裁剪只发生在落盘边界（diskSessionOf，由
 * aiSessionStore 写入时施加）：内存线程与进程内快照不裁，加载路径不裁
 * （旧文件全量展示，下次实际变更保存才收敛）。 */
const PERSISTED_ENTRIES_MAX = 200

/** 在总容量内优先保留可执行 pending 卡（含降级的未确认执行卡），再用
 * 最新历史补齐；卡片自身超额时也从最旧起裁剪。选择按数组位置，不依赖
 * id 大小，输出保持原时间线顺序且不重复、不修改输入。校验拒绝卡不可
 * 执行，按普通历史分配剩余额度。 */
function capPersistedEntries(entries: ThreadEntry[]): ThreadEntry[] {
  if (entries.length <= PERSISTED_ENTRIES_MAX) return entries
  const selected = new Set<number>()
  for (let i = entries.length - 1; i >= 0 && selected.size < PERSISTED_ENTRIES_MAX; i--) {
    const card = entries[i].card
    if (card?.status === 'pending' && card.v.ok) selected.add(i)
  }
  for (let i = entries.length - 1; i >= 0 && selected.size < PERSISTED_ENTRIES_MAX; i--) {
    selected.add(i)
  }
  return entries.filter((_, index) => selected.has(index))
}

/** 落盘边界的容量变换（issue #64）：写入主文件（或浏览器内存回退等价物）
 * 前把全量落盘形态裁剪到容量内。产出新会话对象，不修改调用方快照——
 * 进程内保留区（退出冲刷重试、回吐失败事件）继续持全量。 */
export function diskSessionOf(session: AiSession): AiSession {
  return {
    schemaVersion: session.schemaVersion,
    entries: capPersistedEntries(session.entries),
  }
}
