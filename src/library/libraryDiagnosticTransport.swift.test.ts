// @vitest-environment happy-dom
/** Swift 恢复事件沿用诊断序号，初始化监听可在首个库请求前接收。 */
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLibraryDiagnostics } from './libraryDiagnosticTransport'
import {
  cleanupPendingSnapshot,
  libraryWarningsSnapshot,
} from './libraryDiagnostics'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('Swift 注册恢复事件，旧序号不回退，退订后不消费', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const host = Object.assign(new EventTarget(), {
    __pwNativeHost: {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'diagnostics',
    },
    webkit: { messageHandlers: { plotweaveHost: { postMessage: vi.fn() } } },
    __pwDispatchHostEvent: undefined as
      undefined | ((name: string, payload: unknown) => void),
  })
  vi.stubGlobal('window', host)
  const off = await initializeLibraryDiagnostics()
  expect(off).toBeTypeOf('function')
  host.__pwDispatchHostEvent?.('library-diagnostics', {
    warnings: ['恢复可见'],
    cleanupPending: [{ kind: 'routine', message: 'pending' }],
    diagnosticsRevision: '2',
  })
  host.__pwDispatchHostEvent?.('library-diagnostics', {
    warnings: [],
    cleanupPending: [],
    diagnosticsRevision: '1',
  })
  expect(cleanupPendingSnapshot()).toEqual([
    { kind: 'routine', message: 'pending' },
  ])
  expect(libraryWarningsSnapshot()).toContain('恢复可见')
  off?.()
  host.__pwDispatchHostEvent?.('library-diagnostics', {
    warnings: [],
    cleanupPending: [],
    diagnosticsRevision: '3',
  })
  expect(cleanupPendingSnapshot()).toHaveLength(1)
})
