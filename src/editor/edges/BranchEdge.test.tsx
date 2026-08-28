// @vitest-environment happy-dom
/**
 * 分支连线渲染测试：渐变描边贝塞尔路径（getBezierPath 真实数学）、
 * 线中点选项胶囊显隐、渐变 id 逐边独立。
 * EdgeLabelRenderer 依赖画布内的 portal 容器，隔离渲染时内联子内容。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Position, type EdgeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import BranchEdge, { type BranchFlowEdge } from './BranchEdge'

vi.mock('@xyflow/react', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...orig,
    /** 标签渲染器桩：画布外无 portal 容器，内联渲染子内容。 */
    EdgeLabelRenderer: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  }
})

afterEach(cleanup)

function setup(data?: { optionLabel: string }) {
  const props = {
    id: 'e1',
    source: 'br1',
    target: 'd1',
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 80,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data,
  } as unknown as EdgeProps<BranchFlowEdge>
  const { container } = render(
    <svg>
      <BranchEdge {...props} />
    </svg>,
  )
  return { container }
}

describe('BranchEdge（分支连线）', () => {
  it('渲染贝塞尔路径并以独立渐变描边（url 引用本边渐变 id）', () => {
    const { container } = setup({ optionLabel: '坦白' })
    const path = container.querySelector('path')
    expect(path?.getAttribute('d')).toContain('C') // 三次贝塞尔
    const stroke = path?.getAttribute('style') ?? ''
    const gradientId = container.querySelector('linearGradient')?.id
    expect(gradientId).toMatch(/^pw-branch-g-/)
    expect(stroke).toContain(`url(#${gradientId})`)
  })

  it('两条边实例的渐变 id 互不相同（defs 不串色）', () => {
    const { container } = render(
      <svg>
        {(['e1', 'e2'] as const).map((id) => (
          <BranchEdge
            key={id}
            {...({
              id,
              source: 'a',
              target: 'b',
              sourceX: 0,
              sourceY: 0,
              targetX: 10,
              targetY: 10,
              sourcePosition: Position.Right,
              targetPosition: Position.Left,
            } as unknown as EdgeProps<BranchFlowEdge>)}
          />
        ))}
      </svg>,
    )
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('有线中点选项胶囊；无 optionLabel 数据时不渲染标签', () => {
    setup({ optionLabel: '隐瞒' })
    expect(screen.getByText('隐瞒')).toBeTruthy()
    cleanup()

    setup(undefined)
    expect(screen.queryByText('隐瞒')).toBeNull()
  })
})
