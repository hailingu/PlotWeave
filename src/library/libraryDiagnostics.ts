/** 图库操作诊断的会话存储：读取和写入共享提示，跨面板挂载保留至用户关闭。 */
let warnings: readonly string[] = []
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

/** 用户主动关闭本轮提示；后续操作产生的诊断仍可重新显示。 */
export function dismissLibraryWarnings(): void {
  warnings = []
  for (const listener of listeners) listener()
}
