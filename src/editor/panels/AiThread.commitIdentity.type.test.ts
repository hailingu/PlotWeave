/**
 * [issue #139](https://github.com/hailingu/PlotWeave/issues/139) 提交身份
 * 契约的类型层回归：画布确认等待器（whenCanvasCommitted）不得脱离画布
 * 批次计数（aiRevision）独立传入——缺计数的装配执行成功后会产出无
 * aiRevisionAfter 的未确认卡，落盘降级 pending 后失去与画布对账的身份，
 * 重开时已随画布落盘的批次可被再次执行。误配在编译期拒绝，由 tsc 把关
 * （@ts-expect-error 与 satisfies），不设运行时断言（先例：
 * model/serialize.type.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import type { ComponentProps } from 'react'
import type { AiThread } from './AiThread'

type AiThreadProps = ComponentProps<typeof AiThread>

describe('AiThread 提交身份耦合（issue #139）', () => {
  it('误配编译期拒绝：等待器不再是可独立传入的 prop', () => {
    const flatMisassembled = {
      projectId: 'p139',
      // @ts-expect-error —— whenCanvasCommitted 已收进 commitIdentity，独立可选形态不再存在
      whenCanvasCommitted: () => Promise.resolve(),
    } satisfies AiThreadProps
    expect(flatMisassembled).toBeTruthy()
  })

  it('误配编译期拒绝：嵌套提交身份缺批次计数', () => {
    const waiterWithoutCount = {
      projectId: 'p139',
      // @ts-expect-error —— 缺 aiRevision 的提交身份不可构造（等待器 ⇒ 计数必在）
      commitIdentity: { whenCanvasCommitted: () => Promise.resolve() },
    } satisfies AiThreadProps
    expect(waiterWithoutCount).toBeTruthy()
  })

  it('合法形态：完整提交身份 / 仅计数（恢复对账）/ 省略整组（隔离装配）', () => {
    const full = {
      projectId: 'p139',
      commitIdentity: {
        aiRevision: 0,
        whenCanvasCommitted: () => Promise.resolve(),
      },
    } satisfies AiThreadProps
    const restoreOnly = {
      projectId: 'p139',
      commitIdentity: { aiRevision: 3 },
    } satisfies AiThreadProps
    const isolated = { projectId: 'p139' } satisfies AiThreadProps
    // 形状合法性由 satisfies 在编译期保证；运行时断言仅消费变量，无行为语义
    expect(full).toBeTruthy()
    expect(restoreOnly).toBeTruthy()
    expect(isolated).toBeTruthy()
  })
})
