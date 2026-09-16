// @vitest-environment happy-dom
/**
 * PreviewCard 校验问题清单的序号语义（issue #150）：命令级问题按
 * 「第 N 条」编序（N 从 1 起）；批次级整体错误（index=-1，如
 * 「批次不是命令数组」）不编序号——不得显示为「第 0 条」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import PreviewCard from './PreviewCard'
import type { BatchValidation } from '../ai/commands'

afterEach(cleanup)

const validationWith = (
  issues: BatchValidation['issues'],
): BatchValidation => ({
  ok: false,
  items: [],
  commands: [],
  issues,
  hasDeletes: false,
})

describe('PreviewCard 校验问题序号（issue #150）', () => {
  it('批次级整体错误（index=-1）：只显示消息本身，不出现「第 0 条」', () => {
    render(
      <PreviewCard
        v={validationWith([{ index: -1, message: '批次不是命令数组' }])}
        status="pending"
        armed={false}
        busy={false}
        onArm={vi.fn()}
        onExecute={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText('批次不是命令数组')).toBeTruthy()
    expect(screen.queryByText(/第 0 条/)).toBeNull()
  })

  it('命令级问题仍按正确序号显示（第 N 条，N 从 1 起）', () => {
    render(
      <PreviewCard
        v={validationWith([
          { index: 0, message: '未知节点类型：foo' },
          { index: 2, message: '端点不存在：a → b' },
        ])}
        status="pending"
        armed={false}
        busy={false}
        onArm={vi.fn()}
        onExecute={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText('第 1 条：未知节点类型：foo')).toBeTruthy()
    expect(screen.getByText('第 3 条：端点不存在：a → b')).toBeTruthy()
  })
})
