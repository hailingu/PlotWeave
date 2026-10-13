/** React 业务入口复用页级 future 登记；入场拒绝通过退出 owner 显示，不触发未处理拒绝。 */
import { useCallback } from 'react'
import {
  isWebExitPending,
  reportWebExitPending,
  runWebOperation,
} from './webExitFence'

/** 覆盖动作全生命周期及其结果交付，保留原动作的失败合同。 */
export function useWebExitAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return useCallback(
    (...args: Args) => {
      if (isWebExitPending()) {
        reportWebExitPending()
        return Promise.resolve()
      }
      return runWebOperation(() => action(...args))
    },
    [action],
  )
}
