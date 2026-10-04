/** 运行环境判定边界（issue #473）：属性存在性与每次调用时读取宿主。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTauriRuntime } from './runtime'

afterEach(() => vi.unstubAllGlobals())

describe('isTauriRuntime', () => {
  it('无 window 时安全返回 false', () => {
    vi.stubGlobal('window', undefined)
    expect(isTauriRuntime()).toBe(false)
  })

  it.each([{}, { __TAURI__: {} }])('浏览器未注入 IPC 桥：%j', (host) => {
    vi.stubGlobal('window', host)
    expect(isTauriRuntime()).toBe(false)
  })

  it.each([{}, null, undefined])(
    '哨兵只检查存在性，不要求值为真：%j',
    (value) => {
      vi.stubGlobal('window', { __TAURI_INTERNALS__: value })
      expect(isTauriRuntime()).toBe(true)
    },
  )

  it('同一会话中再次调用会读取当前宿主，不缓存结果', () => {
    const host: Record<string, unknown> = {}
    vi.stubGlobal('window', host)
    expect(isTauriRuntime()).toBe(false)
    host.__TAURI_INTERNALS__ = {}
    expect(isTauriRuntime()).toBe(true)
    Reflect.deleteProperty(host, '__TAURI_INTERNALS__')
    expect(isTauriRuntime()).toBe(false)
  })
})
