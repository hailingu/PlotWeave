import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from './types'

/** Tauri 路径：mock IPC，window.__TAURI_INTERNALS__ 令 isTauri 为真，
 * resetModules 后动态 import 取得隔离实例。 */

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invoke(...args),
  }))
  invoke.mockReset()
})

const load = async (): Promise<typeof import('./settingsStore')> => import('./settingsStore')

const prefs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providers: [{ id: 'openai', label: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', enabled: true, models: ['gpt-4o'] }],
  defaultChat: 'openai:gpt-4o',
  ...over,
})

describe('settingsStore Tauri 路径', () => {
  it('load 调 load_prefs 并按 normalizeSettings 归一（缺字段补内置）', async () => {
    invoke.mockResolvedValueOnce(prefs({ providers: 'garbage', defaultChat: 7 }))
    const { settingsStore } = await load()
    const s: AppSettings = await settingsStore.load()
    expect(invoke.mock.calls[0]).toEqual(['load_prefs'])
    expect(s.providers.map((p) => p.id)).toEqual(['openai', 'volcengine-ark']) // 自定义全坏 → 只剩内置补全
    expect(s.defaultChat).toBeNull()
  })

  it('load 抛错时回退默认设置（不向上传播）', async () => {
    invoke.mockRejectedValueOnce(new Error('disk dead'))
    const { settingsStore } = await load()
    await expect(settingsStore.load()).resolves.toEqual(
      (await import('./types')).defaultSettings(),
    )
  })

  it('save 透传 prefs 给 save_prefs', async () => {
    invoke.mockResolvedValueOnce(undefined)
    const { settingsStore } = await load()
    const next = { providers: [], defaultChat: null } as unknown as AppSettings
    await settingsStore.save(next)
    expect(invoke.mock.calls[0]).toEqual(['save_prefs', { prefs: next }])
  })

  it('setProviderKey 调 set_provider_key 并把返回 envelope 合并进目标 provider', async () => {
    invoke.mockResolvedValueOnce('pw1:v2:cipher')
    const { settingsStore } = await load()
    const base: AppSettings = {
      providers: [
        { id: 'openai', label: 'A', baseUrl: 'u', enabled: true, models: [] },
        { id: 'volcengine-ark', label: 'B', baseUrl: 'u2', enabled: true, models: [] },
      ],
      defaultChat: null,
    }
    const updated = await settingsStore.setProviderKey(base, 'openai', 'sk-secret')
    expect(invoke.mock.calls[0]).toEqual([
      'set_provider_key',
      { providerId: 'openai', key: 'sk-secret' },
    ])
    expect(updated.providers[0].keyEnc).toBe('pw1:v2:cipher')
    expect(updated.providers[1].keyEnc).toBeUndefined()
  })
})
