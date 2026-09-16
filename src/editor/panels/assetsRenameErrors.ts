/**
 * 重命名未解决失败的跨挂载所有者（PR #180 评审修复，issue #125）：
 * AssetsPanel 按 tab 条件挂载，在途失败可能在无挂载期间落定——hook
 * 本地状态随实例销毁会把可见反馈静默吞掉；未解决集合放模块级（模块
 * 作用域跨实例共享），重挂载实例以其为初始值恢复。记录/解除由
 * useAssetRename 调用；测试经 resetRenameErrorsForTests 重置（模块
 * 状态不随组件 cleanup 清理）。
 */

/** 每资产未解决的重命名失败（id → 诊断文案）。 */
const unresolvedRenameErrors = new Map<string, string>()

/** 记录一次失败（跨挂载保留，直至同资产重试成功或删除终结）。 */
export const recordRenameError = (id: string, error: unknown): void => {
  unresolvedRenameErrors.set(id, String(error))
}

/** 解除某资产的未解决失败（无条目时无操作），返回是否有条目被移除。 */
export const resolveRenameError = (id: string): boolean =>
  unresolvedRenameErrors.delete(id)

/** 合并当前未解决失败为横幅文案（分号分隔；空集合为 null）。 */
export const joinedRenameErrors = (): string | null =>
  [...unresolvedRenameErrors.values()].join('；') || null

/** 仅供测试重置跨挂载错误集合（模块级状态不随组件 cleanup 清理）。 */
export const resetRenameErrorsForTests = (): void => {
  unresolvedRenameErrors.clear()
}
