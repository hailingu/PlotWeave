/**
 * 重命名状态的跨挂载所有者（PR #180 评审修复，issue #125）：AssetsPanel
 * 按 tab 条件挂载，在途请求可能在无挂载期间、或新旧实例交替时落定——
 * 代际、回滚基线与未解决错误若归 hook 本地，迟到的响应要么丢失可见性
 * （本地 setState 随实例销毁），要么绕过新实例的终结（代际各自为政）。
 * 三者统一收在本模块（模块作用域跨实例共享），未解决错误经订阅通知
 * （useSyncExternalStore）驱动当前挂载实例；测试经
 * resetRenameStateForTests 重置（模块状态不随组件 cleanup 清理）。
 */

/** 每资产最近发起的重命名代际序号。 */
const renameSeq = new Map<string, number>()
/** 每资产未决改名链条锚定的已落盘基线。 */
const renameBaseline = new Map<string, string>()
/** 每资产未解决的重命名失败（id → 诊断文案）。 */
const unresolvedErrors = new Map<string, string>()

const listeners = new Set<() => void>()

/** 未解决错误集合变化时通知订阅者（代际/基线变化不影响展示）。 */
const notify = (): void => {
  for (const listener of listeners) listener()
}

/** 订阅未解决错误集合变化（useSyncExternalStore 的订阅端）。 */
export const subscribeRenameErrors = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前未解决失败的合并横幅文案（分号分隔；空集合为 null——字符串
 * 基元满足 getSnapshot 的引用稳定性要求）。 */
export const renameErrorsSnapshot = (): string | null =>
  [...unresolvedErrors.values()].join('；') || null

/** 发起一次重命名：代际 +1、链条起点锚定基线（已锚定则沿用——中途
 * 意图发起时的调用方值可能是乐观值，不得重锚），返回本次代际序号。 */
export const beginRename = (id: string, baseline: string): number => {
  const seq = (renameSeq.get(id) ?? 0) + 1
  renameSeq.set(id, seq)
  if (!renameBaseline.has(id)) renameBaseline.set(id, baseline)
  return seq
}

/** 重命名成功（门面按资产 FIFO，最终成功即磁盘真值）：推进锚定基线并
 * 解除该资产的未解决错误（含旧实例排队成功的跨实例解除）。 */
export const completeRename = (id: string, name: string): void => {
  renameBaseline.set(id, name)
  if (unresolvedErrors.delete(id)) notify()
}

/** 重命名失败处置（仅最新代际生效；被新意图或删除终结取代的迟到失败
 * 静默）：消费锚定基线并记录错误。返回回滚基线（快照优先、锚点兜底，
 * 由调用方传入快照名）；undefined 表示已被取代，不作处置。 */
export const failRename = (
  id: string,
  seq: number,
  error: unknown,
  snapshotName?: string,
): string | undefined => {
  if (renameSeq.get(id) !== seq) return undefined
  const baseline = snapshotName ?? renameBaseline.get(id)
  renameBaseline.delete(id)
  unresolvedErrors.set(id, String(error))
  notify()
  return baseline
}

/** 删除终结：代际 +1 失效一切在途响应（跨实例）、清除锚定基线并解除
 * 该资产的未解决错误。 */
export const forgetRename = (id: string): void => {
  renameSeq.set(id, (renameSeq.get(id) ?? 0) + 1)
  renameBaseline.delete(id)
  if (unresolvedErrors.delete(id)) notify()
}

/** 仅供测试重置跨挂载重命名状态（模块级状态不随组件 cleanup 清理）。 */
export const resetRenameStateForTests = (): void => {
  renameSeq.clear()
  renameBaseline.clear()
  unresolvedErrors.clear()
  notify()
}
