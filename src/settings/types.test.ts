import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  listChatModels,
  normalizeSettings,
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
})
