// @vitest-environment happy-dom
/** Swift 窗口关闭和应用退出复用三源固定点冲刷，不绕过失败或未就绪监听。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useExitFlush } from './useExitFlush'

const { hasCanvas, flushCanvas, hasProject, flushProject, hasAi, flushAi } =
  vi.hoisted(() => ({
    hasCanvas: vi.fn(() => false),
    flushCanvas: vi.fn(async (): Promise<void> => undefined),
    hasProject: vi.fn(() => false),
    flushProject: vi.fn(async (): Promise<string[]> => []),
    hasAi: vi.fn(() => false),
    flushAi: vi.fn(async (): Promise<string[]> => []),
  }))
vi.mock('./canvasSaveRegistry', () => ({
  hasPendingCanvasSaves: hasCanvas,
  flushPendingCanvasSaves: flushCanvas,
}))
vi.mock('./projectStore/saveChain', () => ({
  hasPendingProjectSaves: hasProject,
  flushPendingProjectSaves: flushProject,
}))
vi.mock('./aiSessionStore', () => ({
  hasPendingAiSessionSaves: hasAi,
  flushPendingAiSessionSaves: flushAi,
}))
vi.mock('@tauri-apps/api/window', () => {
  throw new Error('Swift 不加载 Tauri window')
})
vi.mock('@tauri-apps/api/event', () => {
  throw new Error('Swift 不加载 Tauri event')
})
vi.mock('@tauri-apps/api/core', () => {
  throw new Error('Swift 不加载 Tauri core')
})

let commands: string[] = []
let onRequest: (command: string) => unknown = () => ({ ok: null })

/** 真实事件入口只属于当前页面，载荷的退出意图由原生宿主持有。 */
function quit() {
  const host = window as Window & {
    __pwDispatchHostEvent?: (name: string, payload: unknown) => void
  }
  host.__pwDispatchHostEvent?.('app-quit-requested', null)
}

beforeEach(() => {
  commands = []
  onRequest = () => ({ ok: null })
  for (const pending of [hasCanvas, hasProject, hasAi])
    pending.mockReset().mockReturnValue(false)
  flushCanvas.mockReset().mockResolvedValue(undefined)
  flushProject.mockReset().mockResolvedValue([])
  flushAi.mockReset().mockResolvedValue([])
  Object.assign(window, {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'quit-session',
    },
    webkit: {
      messageHandlers: {
        plotweaveHost: {
          postMessage: async ({ command }: { command: string }) => {
            commands.push(command)
            return onRequest(command)
          },
        },
      },
    },
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__pwNativeHost')
  Reflect.deleteProperty(window, 'webkit')
})

it('先建立监听再ack，确认中重放的干净退出不会丢失', async () => {
  onRequest = (command) => {
    if (command === 'acknowledge_quit_listener') quit()
    return { ok: null }
  }
  renderHook(() => useExitFlush())
  await vi.waitFor(() => expect(commands).toContain('app_exit'))
  expect(commands).toEqual(['acknowledge_quit_listener', 'app_exit'])
})

it('冲刷中新编辑进入下一轮，三源固定点排空后才退出', async () => {
  let pending = true
  let rounds = 0
  hasCanvas.mockImplementation(() => pending)
  flushCanvas.mockImplementation(async () => {
    rounds += 1
    pending = rounds === 1
  })
  renderHook(() => useExitFlush())
  await vi.waitFor(() =>
    expect(commands).toContain('acknowledge_quit_listener'),
  )
  await act(async () => {
    quit()
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(commands).toContain('app_exit'))
  expect(rounds).toBe(2)
  expect(flushProject).toHaveBeenCalledTimes(2)
  expect(flushAi).toHaveBeenCalledTimes(2)
})

it('保存失败保留窗口并提示，用户重试退出成功后才放行', async () => {
  hasProject.mockReturnValue(true)
  flushProject.mockResolvedValue(['p1'])
  const view = renderHook(() => useExitFlush())
  await vi.waitFor(() =>
    expect(commands).toContain('acknowledge_quit_listener'),
  )
  await act(async () => {
    quit()
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(view.result.current).toContain('已阻止退出'))
  expect(commands).not.toContain('app_exit')
  hasProject.mockReturnValue(false)
  flushProject.mockResolvedValue([])
  await act(async () => {
    quit()
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(commands).toContain('app_exit'))
})

it('原生退出拒绝转为可见诊断，没有未处理拒绝', async () => {
  onRequest = (command) =>
    command === 'app_exit'
      ? { error: { code: 'PW_EXIT_FAILED', message: 'exit denied' } }
      : { ok: null }
  const view = renderHook(() => useExitFlush())
  await vi.waitFor(() =>
    expect(commands).toContain('acknowledge_quit_listener'),
  )
  await act(async () => {
    quit()
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(view.result.current).toContain('exit denied'))
})

it('重复退出请求共用在途冲刷，卸载后的完成不能授权关闭新会话', async () => {
  let finish!: () => void
  hasCanvas.mockReturnValue(true)
  flushCanvas.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const view = renderHook(() => useExitFlush())
  await vi.waitFor(() =>
    expect(commands).toContain('acknowledge_quit_listener'),
  )
  await act(async () => {
    quit()
    quit()
    await Promise.resolve()
  })
  expect(flushCanvas).toHaveBeenCalledOnce()
  view.unmount()
  hasCanvas.mockReturnValue(false)
  finish()
  await Promise.resolve()
  expect(commands).not.toContain('app_exit')
})
