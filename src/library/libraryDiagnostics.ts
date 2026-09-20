/** 图库操作诊断的会话存储：读取和写入共享提示，跨面板挂载保留至用户关闭。 */
let warnings: readonly string[] = []
/** 清理保护独立于提示可见性：警告可能是仅存原媒体的唯一冲突信号。
 * 会话内收到有效警告即保守暂停目录级指引；关闭提示、干净或迟到响应
 * 均不能证明现场已核对。完全重启后由新一轮恢复诊断重新判定。 */
let cleanupBlocked = false

/** 待清理条目的语义分类（issue #229）：机器可读 kind 由后端生产点给出，
 * 前端不经中文文案推导——展示措辞/本地化调整不改变分类。
 * routine：索引已提交、仅能力保留的待释放项（可给 .trash 清理指引）；
 * evidence：冲突/待核对的证据保留项（绝不附删除指引）。 */
export interface CleanupPendingEntry {
  kind: 'routine' | 'evidence'
  message: string
}

/** 条目归一化 fail-safe：未知/缺失 kind、裸字符串（旧形态或脏数据）一律
 * 归证据类（不给删除指引）；缺/空 message 的条目无法展示，丢弃。 */
function normalizePendingEntry(item: unknown): CleanupPendingEntry | null {
  if (typeof item === 'string') return item === '' ? null : evidenceEntry(item)
  if (item === null || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  if (typeof o.message !== 'string' || o.message === '') return null
  return o.kind === 'routine'
    ? { kind: 'routine', message: o.message }
    : evidenceEntry(o.message)
}

function evidenceEntry(message: string): CleanupPendingEntry {
  return { kind: 'evidence', message }
}

/** 内容相等（kind + message 逐条相同）——结构化对象按值比较，新载荷的
 * 新对象引用不得被误判为内容变化（关闭状态的保持依赖此判定）。 */
function samePendingContent(
  a: readonly CleanupPendingEntry[],
  b: readonly CleanupPendingEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, i) => item.kind === b[i]!.kind && item.message === b[i]!.message,
    )
  )
}

/** 删除隔离区待清理状态（issue #135）：当前快照语义（非历史累积）——
 * 真实删除返回 cleanupPending 时对用户可见；空状态不显示（不误报）。 */
let cleanupPending: readonly CleanupPendingEntry[] = []
/** 本前端会话已接受的最大后端序号；隐藏提示不重置它，失败响应不推进它。 */
let cleanupRevision = 0n
/** 用户关闭时的待清理快照引用：内容不变保持隐藏，变化（新数组）即重新
 * 显示（publish 内容不变不重建数组，见 publishCleanupPending）。 */
let dismissedPending: readonly CleanupPendingEntry[] | null = null
const listeners = new Set<() => void>()

/** 接收后端诊断并去重；干净响应不抹掉尚未阅读的一次性修复提示。 */
export function publishLibraryWarnings(input: unknown): void {
  if (!Array.isArray(input)) return
  const valid = input.filter(
    (item): item is string => typeof item === 'string' && item !== '',
  )
  if (valid.length > 0) cleanupBlocked = true
  const next = [...new Set([...warnings, ...valid])]
  if (next.length === warnings.length) return
  warnings = next
  for (const listener of listeners) listener()
}

/** 校验 IPC 的规范十进制 u64 字符串，避免 JS number 丢失大整数顺序。 */
function parseCleanupRevision(input: unknown): bigint | null {
  if (typeof input !== 'string' || !/^[1-9]\d{0,19}$/.test(input)) return null
  const revision = BigInt(input)
  return revision <= 18446744073709551615n ? revision : null
}

/** 只接受后端持锁生成的更新快照；同内容也推进序号，但不重建数组或重显。
 * 非法载荷保留当前状态并给出诊断，旧/重复序号不改变快照或关闭状态。
 * 条目经 normalizePendingEntry 归一化（未知形态 fail-safe 归证据类）。 */
export function publishCleanupPending(
  input: unknown,
  rawRevision: unknown,
): void {
  const revision = parseCleanupRevision(rawRevision)
  if (revision === null || !Array.isArray(input)) {
    console.warn('[Library] 无效待清理快照', {
      code: 'LIBRARY_DIAGNOSTICS_SNAPSHOT_INVALID',
    })
    return
  }
  if (revision <= cleanupRevision) return
  cleanupRevision = revision
  const next = input
    .map(normalizePendingEntry)
    .filter((item): item is CleanupPendingEntry => item !== null)
  if (samePendingContent(next, cleanupPending)) return
  cleanupPending = next
  for (const listener of listeners) listener()
}

/** 待清理快照：用户已关闭本轮（数组引用未变）时隐藏。隐藏态返回共享
 * 冻结空数组——useSyncExternalStore 依赖引用稳定性，逐次新建空数组会
 * 造成无限重渲染。 */
const EMPTY_PENDING: readonly CleanupPendingEntry[] = Object.freeze([])

export function cleanupPendingSnapshot(): readonly CleanupPendingEntry[] {
  if (dismissedPending === cleanupPending) return EMPTY_PENDING
  return cleanupPending
}

/** 待清理条目的呈现分区（issue #229）：按机器码 kind 分类——routine 项
 * 可附 .trash 清理指引，其余一律归证据区（fail-safe：运行期绕过类型的
 * 未知 kind 同样不给删除指引）。返回展示文案列表。 */
export function partitionCleanupPending(
  entries: readonly CleanupPendingEntry[],
): {
  routine: string[]
  evidence: string[]
} {
  const routine: string[] = []
  const evidence: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'routine') {
      routine.push(entry.message)
    } else {
      evidence.push(entry.message)
    }
  }
  return { routine, evidence }
}

/** 返回稳定快照供 React 外部存储订阅；不暴露可变的诊断数组。 */
export function libraryWarningsSnapshot(): readonly string[] {
  return warnings
}

/** 返回不随提示关闭而清除的会话保护状态；不依赖警告文案识别冲突。 */
export function libraryCleanupBlockedSnapshot(): boolean {
  return cleanupBlocked
}

/** 订阅诊断变化；卸载只解除订阅，保留用户尚未关闭的提示。 */
export function subscribeLibraryWarnings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 用户主动关闭本轮提示（含待清理显示）；后续操作产生的诊断仍可重新显示。 */
export function dismissLibraryWarnings(): void {
  warnings = []
  dismissedPending = cleanupPending
  for (const listener of listeners) listener()
}
