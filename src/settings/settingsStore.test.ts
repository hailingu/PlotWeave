import { describe, expect, it } from 'vitest'
import { settingsStore } from './settingsStore'
import { defaultSettings, type AppSettings } from './types'

/** 浏览器预览的内存回退实现（模块级 memorySettings 会话内共享）。 */

describe('settingsStore 内存回退', () => {
  it('首次 load 返回默认设置，二次 load 同一引用（会话内保持）', async () => {
    const first = await settingsStore.load()
    expect(first).toEqual(defaultSettings())
    await expect(settingsStore.load()).resolves.toBe(first)
  })

  it('save 后 load 返回保存的对象', async () => {
    const next: AppSettings = {
      providers: [{ id: 'openai', label: 'OpenAI 兼容', baseUrl: 'https://x/v1', enabled: false, models: ['m1'] }],
      defaultChat: 'openai:m1',
      defaultImage: null,
    }
    await settingsStore.save(next)
    await expect(settingsStore.load()).resolves.toEqual(next)
  })

  it('setProviderKey 生成 preview envelope：base64 可还原明文，只改目标 provider', async () => {
    const base: AppSettings = {
      providers: [
        { id: 'openai', label: 'A', baseUrl: 'u1', enabled: true, models: [] },
        { id: 'volcengine-ark', label: 'B', baseUrl: 'u2', enabled: true, models: [] },
      ],
      defaultChat: null,
      defaultImage: null,
    }
    const updated = await settingsStore.setProviderKey(base, 'volcengine-ark', 'sk-预览密钥')
    expect(updated.providers[0]).toBe(base.providers[0]) // 未命中原引用不动
    const enc = updated.providers[1].keyEnc ?? ''
    expect(enc.startsWith('pw1:preview:')).toBe(true)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(enc.slice('pw1:preview:'.length)), (c) => c.charCodeAt(0)),
    )
    expect(decoded).toBe('sk-预览密钥')
  })

  it('setProviderKey 不修改传入的旧对象（返回新 settings）', async () => {
    const base: AppSettings = { providers: [{ id: 'p', label: 'P', baseUrl: 'u', enabled: true, models: [] }], defaultChat: null, defaultImage: null }
    await settingsStore.setProviderKey(base, 'p', 'k')
    expect(base.providers[0].keyEnc).toBeUndefined()
  })
})
