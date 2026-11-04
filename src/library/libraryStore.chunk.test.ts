import { beforeEach, expect, it, vi } from 'vitest'

const limit = 64 * 1024
const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  invoke.mockReset()
  vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
})

it.each(['tauri', 'swift'])(
  '%s 大文件按有界帧传输且包间可处理事件',
  async (host) => {
    const window = new EventTarget()
    let ticks = 0
    let previousTick = -1
    const received: number[] = []
    const consume = async (_command: unknown, payload: unknown) => {
      const args = (
        payload as { request: { data: string; offset: number; total: number } }
      ).request
      const bytes = Array.from(atob(args.data), (c) => c.charCodeAt(0))
      expect(bytes.length).toBeLessThanOrEqual(limit)
      expect(ticks).toBeGreaterThan(previousTick)
      previousTick = ticks
      expect(args.offset).toBe(received.length)
      received.push(...bytes)
      if (received.length !== args.total) return { received: received.length }
      return {
        id: 'large',
        name: '',
        kind: 'bad',
        tags: [1, 'kept'],
        cleanupPending: [],
        diagnosticsRevision: '8',
      }
    }
    if (host === 'swift') {
      Object.assign(window, {
        __pwNativeHost: {
          kind: 'swift',
          protocolVersion: 1,
          sessionId: 'chunk-test',
        },
        webkit: {
          messageHandlers: {
            plotweaveHost: {
              postMessage: async (request: {
                command: unknown
                args: unknown
              }) => ({ ok: await consume(request.command, request.args) }),
            },
          },
        },
      })
    } else {
      Object.assign(window, { __TAURI_INTERNALS__: {} })
      invoke.mockImplementation(consume)
    }
    vi.stubGlobal('window', window)
    const timer = setInterval(() => {
      ticks++
    }, 0)
    try {
      const { libraryStore } = await import('./libraryStore')
      const bytes = Uint8Array.from(
        { length: limit * 2 + 3 },
        (_, i) => i % 256,
      )
      const asset = await libraryStore.put(
        new File([bytes], 'large.png', { type: 'image/png' }),
        'reference',
      )
      expect(received).toEqual(Array.from(bytes))
      expect(asset).toMatchObject({
        id: 'large',
        name: '未命名资产',
        kind: 'other',
        tags: ['kept'],
      })
    } finally {
      clearInterval(timer)
    }
  },
)

it.each(['mismatch', 'transport', 'abort-failure'])(
  '分块%s保留原错误并取消暂存',
  async (failure) => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const original = new Error('original transport failure')
    invoke.mockImplementation(async (_command, payload) => {
      const request = (payload as { request: { total: number } }).request
      if (request.total === 0) {
        if (failure === 'abort-failure') throw new Error('abort failed')
        return { aborted: true }
      }
      if (failure === 'mismatch') return { received: -1 }
      throw original
    })
    try {
      const { libraryStore } = await import('./libraryStore')
      const result = libraryStore.put(
        new File([new Uint8Array(limit + 1)], 'failure.bmp', {
          type: 'image/bmp',
        }),
        'reference',
      )
      if (failure === 'mismatch')
        await expect(result).rejects.toThrow('素材上传进度不一致')
      else await expect(result).rejects.toBe(original)
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(invoke.mock.calls[1]?.[1]).toMatchObject({
        request: { total: 0, offset: 0, data: '' },
      })
      if (failure === 'abort-failure')
        expect(warn.mock.calls[0]?.[2]).toMatchObject({
          code: 'LIBRARY_UPLOAD_ABORT_FAILED',
        })
      else expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  },
)
