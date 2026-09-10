// @vitest-environment happy-dom
/**
 * 退出冲刷屏障：有未落盘会话时阻止窗口关闭并冲刷；冲刷仍失败保留窗口
 * 并给出可见诊断（issue #47 历轮评审修复）。macOS ⌘Q/Dock 退出（Rust 侧原生接管
 * 后经 app-quit-requested 事件到达）共用同一道屏障，干净后走受控
 * app_exit 退出（issue #47 评审）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useExitFlush } from './useExitFlush'

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>
type QuitHandler = () => Promise<void>

const hasPending = vi.fn(() => true)
const flushPending = vi.fn(async (): Promise<string[]> => [])
const destroy = vi.fn(async () => undefined)
const invoke = vi.fn(async (cmd: string): Promise<unknown> => cmd)

const closeHandlers: CloseHandler[] = []
const quitHandlers: QuitHandler[] = []

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
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: QuitHandler) => {
    quitHandlers.push(handler)
    return () => undefined
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => invoke(cmd),
}))

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  closeHandlers.length = 0
  quitHandlers.length = 0
  hasPending.mockReturnValue(true)
  flushPending.mockResolvedValue([])
  destroy.mockClear()
  invoke.mockClear()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.clearAllMocks()
})

/** 挂载屏障并等关闭/退出监听注册完成。 */
async function mountBarrier() {
  const view = renderHook(() => useExitFlush())
  await act(async () => { await Promise.resolve() })
  expect(closeHandlers).toHaveLength(1)
  expect(quitHandlers).toHaveLength(1)
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
    expect(result.current).toContain('AI 会话保存失败')
  })

})

describe('useExitFlush（⌘Q 应用级退出冲刷屏障）', () => {
  it('无待保存：直接受控退出（app_exit）', async () => {
    hasPending.mockReturnValue(false)
    await mountBarrier()
    await act(async () => { await quitHandlers[0]() })
    expect(flushPending).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('app_exit')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('有待保存先冲刷：排空后受控退出，不销毁窗口走关闭路径', async () => {
    hasPending.mockReturnValue(false).mockReturnValueOnce(true)
    await mountBarrier()
    await act(async () => { await quitHandlers[0]() })
    expect(flushPending).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('app_exit')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('冲刷仍有不可恢复项：不退出并显示可见诊断', async () => {
    flushPending.mockResolvedValue(['p1'])
    const { result } = await mountBarrier()
    await act(async () => { await quitHandlers[0]() })
    expect(invoke).not.toHaveBeenCalled()
    expect(result.current).toContain('已阻止退出')
  })
})
