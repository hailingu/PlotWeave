// @vitest-environment happy-dom
/** 真实退出租约下，Hook 向 owner 报告拒绝并以已完成 Promise 吸收新动作。 */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useWebExitAction } from './useWebExitAction'
import { beginWebExitFence, hasPendingWebOperations } from './webExitFence'

afterEach(cleanup)

it.each(['draining', 'sealed'] as const)(
  '退出处于 %s 时不执行动作，报告给 owner 且返回 Promise 正常完成',
  async (phase) => {
    const action = vi.fn<(id: string) => Promise<void>>()
    const report = vi.fn()
    const { result } = renderHook(() => useWebExitAction(action))
    const fence = beginWebExitFence(report)
    try {
      if (phase === 'sealed') fence.seal()
      await expect(result.current('blocked-project')).resolves.toBeUndefined()
      expect(action).not.toHaveBeenCalled()
      expect(report).toHaveBeenCalledTimes(1)
      expect(hasPendingWebOperations()).toBe(false)
    } finally {
      fence.release()
    }
  },
)
