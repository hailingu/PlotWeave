// @vitest-environment happy-dom
/**
 * 退出冲刷屏障：有未落盘会话时阻止窗口关闭并冲刷；冲刷仍失败保留窗口
 * 并给出可见诊断（issue #47 历轮评审修复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useExitFlush } from './useExitFlush'

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>

const hasPending = vi.fn(() => true)
const flushPending = vi.fn(async (): Promise<string[]> => [])
const destroy = vi.fn(async () => undefined)
const closeHandlers: CloseHandler[] = []

vi.mock('./aiSessionStore', () => ({
  hasPendingAiSessionSaves: () => hasPending(),
  flushPendingAiSessionSaves: () => flushPending(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: CloseHandler) => {
      closeHandlers.push(handler)
      return () => undefined
    },
    destroy,
  }),
}))

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  closeHandlers.length = 0
  hasPending.mockReturnValue(true)
  flushPending.mockResolvedValue([])
  destroy.mockClear()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.clearAllMocks()
})

/** 挂载屏障并等关闭监听注册完成。 */
async function mountBarrier() {
  const view = renderHook(() => useExitFlush())
  await act(async () => { await Promise.resolve() })
  expect(closeHandlers).toHaveLength(1)
  return view
}

describe('useExitFlush（窗口关闭冲刷屏障）', () => {
  it('无待重试会话：直接放行关闭，不冲刷', async () => {
    hasPending.mockReturnValue(false)
    await mountBarrier()
    const event = { preventDefault: vi.fn() }
    await act(async () => { await closeHandlers[0](event) })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(flushPending).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it('有待重试会话：阻止关闭并冲刷，成功后销毁窗口放行', async () => {
    // 首查有待保存；冲刷排空后重查应转false（恒真mock会让重查循环永不退出）
    hasPending.mockReturnValue(false).mockReturnValueOnce(true)
    const { result } = await mountBarrier()
    const event = { preventDefault: vi.fn() }
    await act(async () => { await closeHandlers[0](event) })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(flushPending).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('冲刷落定后又进入新保存：重查未排空前不得销毁窗口', async () => {
    hasPending.mockReturnValue(false).mockReturnValueOnce(true).mockReturnValueOnce(true)
    await mountBarrier()
    await act(async () => { await closeHandlers[0]({ preventDefault: vi.fn() }) })
    expect(flushPending).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('冲刷仍失败：保留窗口并给出可见诊断', async () => {
    flushPending.mockResolvedValue(['p1'])
    const { result } = await mountBarrier()
    await act(async () => { await closeHandlers[0]({ preventDefault: vi.fn() }) })
    expect(destroy).not.toHaveBeenCalled()
    expect(result.current).toContain('已阻止退出')
  })
})
