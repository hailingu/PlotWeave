// @vitest-environment happy-dom
/** PR #222：启动监听屏障及原生恢复事件的快照顺序；事件合同见数据模型 §7.2。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { listen, renderApp } = vi.hoisted(() => ({
  listen: vi.fn(),
  renderApp: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: renderApp }),
}))
vi.mock('./App', () => ({ App: () => null }))

beforeEach(() => {
  vi.resetModules()
  listen.mockReset().mockResolvedValue(() => {})
  renderApp.mockReset()
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
  document.body.innerHTML = '<div id="root"></div>'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.restoreAllMocks()
})

it('原生监听注册完成前不渲染会发起媒体请求的应用', async () => {
  let registered!: (unlisten: () => void) => void
  listen.mockReturnValue(
    new Promise((resolve) => {
      registered = resolve
    }),
  )
  await import('./main')
  expect(renderApp).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce())
  expect(listen.mock.calls[0][0]).toBe('library-diagnostics')
  const unlisten = vi.fn()
  registered(unlisten)
  await vi.waitFor(() => expect(renderApp).toHaveBeenCalledOnce())
  window.dispatchEvent(new Event('pagehide'))
  expect(unlisten).toHaveBeenCalledOnce()
})

it('恢复事件更新快照，迟到列表不能回退，迟到警告仍建立保护', async () => {
  await import('./main')
  await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce())
  const d = await import('./library/libraryDiagnostics')
  const deliver = listen.mock.calls[0][1]
  d.publishCleanupPending(['old'], '1')
  deliver({
    payload: { warnings: [], cleanupPending: [], diagnosticsRevision: '3' },
  })
  d.publishCleanupPending(['old'], '2')
  expect(d.cleanupPendingSnapshot()).toEqual([])
  deliver({
    payload: {
      warnings: ['冲突'],
      cleanupPending: ['old'],
      diagnosticsRevision: '2',
    },
  })
  expect(d.cleanupPendingSnapshot()).toEqual([])
  expect(d.libraryWarningsSnapshot()).toEqual(['冲突'])
  expect(d.libraryCleanupBlockedSnapshot()).toBe(true)
})

it('监听失败保留应用可用性，并暂停无法保证诊断完整性的清理指引', async () => {
  listen.mockRejectedValue(new Error('listener unavailable'))
  await import('./main')
  await vi.waitFor(() => expect(renderApp).toHaveBeenCalledOnce())
  const d = await import('./library/libraryDiagnostics')
  expect(d.libraryCleanupBlockedSnapshot()).toBe(true)
  expect(d.libraryWarningsSnapshot()).not.toHaveLength(0)
  expect(console.error).toHaveBeenCalledWith(
    '[Library] 实时诊断监听失败',
    expect.objectContaining({ code: 'LIBRARY_DIAGNOSTICS_LISTENER_FAILED' }),
  )
})

it('非法事件保留当前状态，后续合法事件仍能恢复更新', async () => {
  await import('./main')
  await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce())
  const d = await import('./library/libraryDiagnostics')
  const deliver = listen.mock.calls[0][1]
  d.publishCleanupPending(['pending'], '1')
  deliver({ payload: null })
  expect(d.cleanupPendingSnapshot()).toEqual(['pending'])
  deliver({
    payload: { warnings: [], cleanupPending: [], diagnosticsRevision: '2' },
  })
  expect(d.cleanupPendingSnapshot()).toEqual([])
})

it('浏览器预览直接渲染，不注册原生事件', async () => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  await import('./main')
  await vi.waitFor(() => expect(renderApp).toHaveBeenCalledOnce())
  expect(listen).not.toHaveBeenCalled()
})
