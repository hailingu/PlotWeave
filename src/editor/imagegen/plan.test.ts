/**
 * 生成计划解析（§13 文生图）的契约：节点显式 model 优先，空则回退
 * AppSettings.defaultImage；两者都不可用时给出可行动的失败文案；
 * 空 prompt 拒绝发起。
 */
import { describe, expect, it } from 'vitest'
import { IMAGE_SIZES, resolveImageGenPlan } from './plan'
import { normalizeSettings } from '../../settings/types'
import type { ImageNodeData } from '../nodes/types'

const settings = normalizeSettings({
  providers: [
    { id: 'openai', enabled: true, baseUrl: 'https://x/v1', models: ['gpt-image-1', 'gpt-4o'] },
    { id: 'ark', enabled: true, baseUrl: 'https://ark/v3', models: ['seedream-4'] },
  ],
  defaultImage: 'ark:seedream-4',
})

const node = (over: Partial<ImageNodeData> = {}): ImageNodeData => ({
  prompt: '雨夜霓虹街道，中景',
  model: '',
  size: '1024x1024',
  outputs: {},
  ...over,
})

describe('resolveImageGenPlan（§13 生成入口的模型解析）', () => {
  it('节点未选模型 → 回退 AppSettings.defaultImage', () => {
    const plan = resolveImageGenPlan(node(), settings)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.provider.id).toBe('ark')
      expect(plan.model).toBe('seedream-4')
    }
  })
  it('节点显式选择模型 → 覆盖默认；size 沿用节点值', () => {
    const plan = resolveImageGenPlan(node({ model: 'openai:gpt-image-1', size: '1024x1536' }), settings)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.provider.id).toBe('openai')
      expect(plan.model).toBe('gpt-image-1')
      expect(plan.size).toBe('1024x1536')
    }
  })
  it('节点指向失效组合（provider 禁用/模型移出清单）→ 失败文案', () => {
    const plan = resolveImageGenPlan(node({ model: 'openai:gone-model' }), settings)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('openai:gone-model')
  })
  it('未配置任何可用模型（节点与默认均空）→ 引导文案', () => {
    const empty = normalizeSettings({})
    const plan = resolveImageGenPlan(node(), empty)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.message).toContain('设置')
  })
  it('空 prompt（含纯空白）拒绝发起', () => {
    for (const prompt of ['', '   ']) {
      const plan = resolveImageGenPlan(node({ prompt }), settings)
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.message).toContain('Prompt')
    }
  })
  it('IMAGE_SIZES 提供三档方/竖/横构图（短剧竖版优先）', () => {
    expect(IMAGE_SIZES).toContain('1024x1024')
    expect(IMAGE_SIZES).toContain('1024x1536')
    expect(IMAGE_SIZES).toContain('1536x1024')
  })
})
