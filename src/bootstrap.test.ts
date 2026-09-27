// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 引导入口契约（issue #358 评审 5326220397）：ES 模块先求值全部静态
 * 导入再执行模块体，把守卫装在 main.tsx 里会让应用导入图顶层求值期
 * 的抛错发生在守卫安装之前。本文件验证 bootstrap 的引导时序语义——
 * ./main 以桩替换，在桩求值时探测守卫是否已就位（真时序断言），
 * 不加载真实应用模块图。
 */
const mainEval = vi.hoisted(() => ({ guarded: false, loaded: false }))
vi.mock('./main', () => {
  const spy = vi.mocked(console.error)
  const callsBefore = spy.mock.calls.length
  const probe = new Event('unhandledrejection', { cancelable: true })
  ;(probe as { reason?: unknown }).reason = new Error('eval-time')
  window.dispatchEvent(probe)
  mainEval.guarded = spy.mock.calls.length > callsBefore
  mainEval.loaded = true
  return {}
})

describe('引导入口（issue #358 评审 5326220397）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('应用模块求值时守卫已安装；TLE 经动态导入以未处理拒绝被兜底', async () => {
    await import('./bootstrap')
    // bootstrap 对 ./main 是 void 动态导入：等它落定再断言求值期状态
    await vi.waitFor(() => expect(mainEval.loaded).toBe(true))
    // 应用本体（桩）求值瞬间守卫已就位——结构化诊断可见且不吞错
    expect(mainEval.guarded).toBe(true)
    // 引导完成后动态导入已发生（守卫先行，不阻塞应用加载）
    expect(mainEval.loaded).toBe(true)
    // 守卫持续在位：此后未处理拒绝同样被结构化上报
    const errorSpy = vi.mocked(console.error)
    const callsBefore = errorSpy.mock.calls.length
    const event = new Event('unhandledrejection', { cancelable: true })
    ;(event as { reason?: unknown }).reason = new Error('post-bootstrap')
    window.dispatchEvent(event)
    expect(errorSpy.mock.calls).toHaveLength(callsBefore + 1)
    const diagnostic = errorSpy.mock.calls[callsBefore]?.[1] as {
      code?: string
    }
    expect(diagnostic.code).toBe('UNHANDLED_REJECTION')
    expect(event.defaultPrevented).toBe(false)
  })
})
