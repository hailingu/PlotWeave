import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  listChatModels,
  normalizeSettings,
  resolveImageModel,
  type AppSettings,
} from './types'

describe('listChatModels（§6 模型选择器：三层过滤的枚举）', () => {
  it('只列启用且 Base URL 就绪的 provider 下的模型，key = providerId:modelId', () => {
    const settings: AppSettings = normalizeSettings({
      providers: [
        { id: 'openai', enabled: true, baseUrl: 'https://x/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
        { id: 'volcengine-ark', enabled: false, models: ['doubao-x'] },
        { id: 'custom', label: '自建', baseUrl: '', models: ['m1'] },
      ],
    })
    const list = listChatModels(settings)
    expect(list.map((o) => o.key)).toEqual(['openai:gpt-4o', 'openai:gpt-4o-mini'])
    expect(list[0]).toMatchObject({ providerId: 'openai', providerLabel: 'OpenAI 兼容', model: 'gpt-4o' })
  })

  it('自定义 provider 的模型同样进入列表；无模型的 provider 不产生条目', () => {
    const withCustom = normalizeSettings({
      providers: [
        { id: 'openai', enabled: false },
        { id: 'my-relay', label: '中转', baseUrl: 'https://relay/v1', models: ['claude-y'] },
      ],
    })
    expect(listChatModels(withCustom).map((o) => o.key)).toEqual(['my-relay:claude-y'])
    // 默认设置：内置 openai 可用（两个模型）；ark 未配模型则不出现
    expect(new Set(listChatModels(defaultSettings()).map((o) => o.providerId))).toEqual(
      new Set(['openai']),
    )
  })

  it('keyEnc 密文随 provider 透传；非 pw1 envelope 的值丢弃', () => {
    const s = normalizeSettings({
      providers: [
        { id: 'openai', keyEnc: 'pw1:0123:abcd' },
        { id: 'volcengine-ark', keyEnc: 'plaintext-key' },
      ],
    })
    expect(s.providers.find((p) => p.id === 'openai')?.keyEnc).toBe('pw1:0123:abcd')
    expect(s.providers.find((p) => p.id === 'volcengine-ark')?.keyEnc).toBeUndefined()
    expect(listChatModels(s).every((o) => !o.key.includes('keyEnc'))).toBe(true)
  })
})

describe('defaultImage 与 resolveImageModel（§8.2/§13 图像生成默认模型）', () => {
  it('normalizeSettings 读取字符串 defaultImage，其余形态回退 null', () => {
    expect(normalizeSettings({ defaultImage: 'openai:gpt-image-1' }).defaultImage).toBe(
      'openai:gpt-image-1',
    )
    expect(normalizeSettings({ defaultImage: 42 }).defaultImage).toBeNull()
    expect(defaultSettings().defaultImage).toBeNull()
  })
  it('resolveImageModel：已选且 provider 启用、模型在清单内才解析；否则 null', () => {
    const settings = normalizeSettings({
      providers: [
        { id: 'openai', enabled: true, baseUrl: 'https://x/v1', models: ['gpt-image-1'] },
      ],
      defaultImage: 'openai:gpt-image-1',
    })
    const resolved = resolveImageModel(settings)
    expect(resolved).toMatchObject({ provider: { id: 'openai' }, model: 'gpt-image-1' })
    // 模型被移出清单 / provider 禁用后失效
    expect(
      resolveImageModel(
        normalizeSettings({
          providers: [{ id: 'openai', enabled: true, baseUrl: 'https://x/v1', models: [] }],
          defaultImage: 'openai:gpt-image-1',
        }),
      ),
    ).toBeNull()
    expect(
      resolveImageModel(
        normalizeSettings({
          providers: [{ id: 'openai', enabled: false, baseUrl: 'https://x/v1', models: ['gpt-image-1'] }],
          defaultImage: 'openai:gpt-image-1',
        }),
      ),
    ).toBeNull()
  })
})
