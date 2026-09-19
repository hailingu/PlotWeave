/** 图库操作诊断的会话存储：读取和写入共享提示，跨面板挂载保留至用户关闭。 */
let warnings: readonly string[] = []
/** 删除隔离区待清理状态（issue #135）：当前快照语义（非历史累积）——
 * 真实删除返回 cleanupPending 时对用户可见；空状态不显示（不误报）。 */
let cleanupPending: readonly string[] = []
/** 用户关闭时的待清理快照引用：内容不变保持隐藏，变化（新数组）即重新
 * 显示（publish 内容不变不重建数组，见 publishCleanupPending）。 */
let dismissedPending: readonly string[] | null = null
const listeners = new Set<() => void>()

/** 接收后端诊断并去重；干净响应不抹掉尚未阅读的一次性修复提示。 */
export function publishLibraryWarnings(input: unknown): void {
  if (!Array.isArray(input)) return
  const valid = input.filter(
    (item): item is string => typeof item === 'string' && item !== '',
  )
  const next = [...new Set([...warnings, ...valid])]
  if (next.length === warnings.length) return
  warnings = next
  for (const listener of listeners) listener()
}

/** 发布删除隔离区待清理状态（issue #135）：快照语义——新内容整体替换旧
 * 状态（不累积新旧两份）；内容不变即无操作（不重建数组、不重复打扰）。 */
export function publishCleanupPending(input: unknown): void {
  const next = Array.isArray(input)
    ? input.filter(
        (item): item is string => typeof item === 'string' && item !== '',
      )
    : []
  const unchanged =
    next.length === cleanupPending.length &&
    next.every((item, i) => item === cleanupPending[i])
  if (unchanged) return
  cleanupPending = next
  for (const listener of listeners) listener()
}

/** 待清理快照：用户已关闭本轮（数组引用未变）时隐藏。隐藏态返回共享
 * 冻结空数组——useSyncExternalStore 依赖引用稳定性，逐次新建空数组会
 * 造成无限重渲染。 */
const EMPTY_PENDING: readonly string[] = Object.freeze([])

export function cleanupPendingSnapshot(): readonly string[] {
  if (dismissedPending === cleanupPending) return EMPTY_PENDING
  return cleanupPending
}

/** 返回稳定快照供 React 外部存储订阅；不暴露可变的诊断数组。 */
export function libraryWarningsSnapshot(): readonly string[] {
  return warnings
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
