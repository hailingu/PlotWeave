/**
 * [issue #401](https://github.com/hailingu/PlotWeave/issues/401) 右栏接口
 * 聚合的类型层回归：✦AI 能力（校验/读工具/落地回调、会话快照与保存通道、
 * 提交身份、画布摘要、设置入口）只能经 `ai` 聚合对象进入右栏——平铺形态
 * 在编译期拒绝，防止接口重新退化为逐字段漂移（每增一项 AI 能力需同步改
 * 右栏接口、子面板 Pick 列表与装配代码三处的旧问题）。误配由 tsc 把关
 * （@ts-expect-error 与 satisfies），不设运行时断言（先例：
 * AiThread.commitIdentity.type.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import { RightPanel } from './RightPanel'
import { EMPTY_SETTINGS } from '../settings'

type RightPanelProps = ComponentProps<typeof RightPanel>

const LAYOUT = {
  open: true,
  width: 320,
  onResize: () => undefined,
  tab: 'ai' as const,
  onTabChange: () => undefined,
  settings: EMPTY_SETTINGS,
}

describe('RightPanel AI 能力聚合（issue #401）', () => {
  it('误配编译期拒绝：AI 回调不再是右栏平铺 prop', () => {
    const flatCallback = {
      ...LAYOUT,
      // @ts-expect-error —— onValidateAi 已收进 ai 聚合，独立可选形态不再存在
      onValidateAi: () => null,
    } satisfies RightPanelProps
    expect(flatCallback).toBeTruthy()
  })

  it('误配编译期拒绝：会话快照不再是右栏平铺 prop', () => {
    const flatSession = {
      ...LAYOUT,
      // @ts-expect-error —— aiSession 平铺形态已由 ai.session 取代
      aiSession: { schemaVersion: 1, entries: [] },
    } satisfies RightPanelProps
    expect(flatSession).toBeTruthy()
  })

  it('合法形态：布局与检查器字段 + ai 聚合（projectId 必带）', () => {
    const grouped = {
      ...LAYOUT,
      ai: { projectId: 'p401' },
    } satisfies RightPanelProps
    // 形状合法性由 satisfies 在编译期保证；运行时断言仅消费变量，无行为语义
    expect(grouped).toBeTruthy()
  })
})
