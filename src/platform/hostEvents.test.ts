// @vitest-environment happy-dom
/** 两类原生事件共享监听生命周期，浏览器不加载 SDK。 */
import { afterEach, expect, it, vi } from 'vitest'
import { listenHostEvent } from './hostEvents'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it('Swift 事件按名称分发，退订只解除自身监听，页面结束清理全部', async () => {
  const host = Object.assign(new EventTarget(), {
    __pwNativeHost: { kind: 'swift', protocolVersion: 1, sessionId: 's1' },
    webkit: { messageHandlers: { plotweaveHost: { postMessage: vi.fn() } } },
    __pwDispatchHostEvent: undefined as
      undefined | ((name: string, payload: unknown) => void),
  })
  vi.stubGlobal('window', host)
  const library = vi.fn()
  const quit = vi.fn()
  const offLibrary = await listenHostEvent('library-diagnostics', library)
  await listenHostEvent('app-quit-requested', quit)
  host.__pwDispatchHostEvent?.('library-diagnostics', {
    diagnosticsRevision: '1',
  })
  expect(library).toHaveBeenCalledWith({ diagnosticsRevision: '1' })
  expect(quit).not.toHaveBeenCalled()
  offLibrary()
  host.__pwDispatchHostEvent?.('library-diagnostics', {})
  host.__pwDispatchHostEvent?.('unknown', {})
  host.__pwDispatchHostEvent?.('app-quit-requested', null)
  expect(library).toHaveBeenCalledOnce()
  expect(quit).toHaveBeenCalledOnce()
  const dispatch = host.__pwDispatchHostEvent
  host.dispatchEvent(new Event('pagehide'))
  dispatch?.('app-quit-requested', null)
  expect(quit).toHaveBeenCalledOnce()
  expect(host.__pwDispatchHostEvent).toBeUndefined()
})

it('浏览器监听是安全空操作，不触及原生 SDK', async () => {
  vi.stubGlobal('window', {})
  const { listen } = await import('@tauri-apps/api/event')
  const off = await listenHostEvent('library-diagnostics', vi.fn())
  off()
  expect(listen).not.toHaveBeenCalled()
})

it('分发使用当前监听快照，回调退订只影响下一次事件', async () => {
  const host = Object.assign(new EventTarget(), {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'snapshot',
    },
    webkit: { messageHandlers: { plotweaveHost: { postMessage: vi.fn() } } },
    __pwDispatchHostEvent: undefined as
      undefined | ((name: string, payload: unknown) => void),
  })
  vi.stubGlobal('window', host)
  let offPeer = () => {}
  const offFirst = await listenHostEvent('library-diagnostics', () => offPeer())
  const peer = vi.fn()
  offPeer = await listenHostEvent('library-diagnostics', peer)
  host.__pwDispatchHostEvent?.('library-diagnostics', { revision: 1 })
  host.__pwDispatchHostEvent?.('library-diagnostics', { revision: 2 })
  expect(peer).toHaveBeenCalledExactlyOnceWith({ revision: 1 })
  offFirst()
})

it('旧会话分发器和旧退订不能消费或解除新会话事件', async () => {
  const host = Object.assign(new EventTarget(), {
    __pwNativeHost: { kind: 'swift', protocolVersion: 1, sessionId: 'old' },
    webkit: { messageHandlers: { plotweaveHost: { postMessage: vi.fn() } } },
    __pwDispatchHostEvent: undefined as
      undefined | ((name: string, payload: unknown) => void),
  })
  vi.stubGlobal('window', host)
  const old = vi.fn()
  const next = vi.fn()
  const offOld = await listenHostEvent('app-quit-requested', old)
  const oldDispatch = host.__pwDispatchHostEvent
  host.__pwNativeHost.sessionId = 'next'
  const offNext = await listenHostEvent('app-quit-requested', next)
  oldDispatch?.('app-quit-requested', null)
  offOld()
  host.__pwDispatchHostEvent?.('app-quit-requested', null)
  expect(old).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledOnce()
  offNext()
})

it('一个消费者抛错不吞掉其他监听并留下结构化诊断', async () => {
  const host = Object.assign(new EventTarget(), {
    __pwNativeHost: { kind: 'swift', protocolVersion: 1, sessionId: 'events' },
    webkit: { messageHandlers: { plotweaveHost: { postMessage: vi.fn() } } },
    __pwDispatchHostEvent: undefined as
      undefined | ((name: string, payload: unknown) => void),
  })
  vi.stubGlobal('window', host)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const offFailed = await listenHostEvent('library-diagnostics', () => {
    throw new Error('consumer failed')
  })
  const peer = vi.fn()
  const offPeer = await listenHostEvent('library-diagnostics', peer)
  expect(() =>
    host.__pwDispatchHostEvent?.('library-diagnostics', {}),
  ).not.toThrow()
  expect(peer).toHaveBeenCalledOnce()
  expect(error).toHaveBeenCalledWith(
    '[Host] 事件消费失败',
    expect.objectContaining({ code: 'PW_HOST_EVENT_HANDLER_FAILED' }),
    {
      level: 'ERROR',
      target: 'plotweave::frontend::host',
      code: 'PW_HOST_EVENT_HANDLER_FAILED',
      message: '[Host] 事件消费失败',
    },
  )
  offFailed()
  offPeer()
  error.mockRestore()
})
