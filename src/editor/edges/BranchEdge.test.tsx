// @vitest-environment happy-dom
/**
 * 分支连线渲染测试：渐变描边贝塞尔路径（getBezierPath 真实数学）、
 * 线中点选项胶囊按源节点 options 实时派生（issue #18：改名/撤销/重做的
 * 会话内新鲜度，不落 data 镜像）、悬空句柄回退。
 * EdgeLabelRenderer 依赖画布内的 portal 容器，隔离渲染时内联子内容；
 * useInternalNode 以桩替身供给源节点（真实订阅由 @xyflow/react 保证）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Position, type EdgeProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import BranchEdge, { type BranchFlowEdge } from './BranchEdge'

const useInternalNodeMock = vi.hoisted(() => vi.fn())
const edgeLookupMock = vi.hoisted(() => ({ current: new Map<string, { sourceHandle?: string | null }>() }))

vi.mock('@xyflow/react', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...orig,
    /** 标签渲染器桩：画布外无 portal 容器，内联渲染子内容。 */
    EdgeLabelRenderer: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
    useInternalNode: (id: string) => useInternalNodeMock(id),
    useStore: <T,>(selector: (s: { edgeLookup: Map<string, { sourceHandle?: string | null }> }) => T) =>
      selector({ edgeLookup: edgeLookupMock.current }),
  }
})

afterEach(cleanup)

type Option = { id: string; label: string }

/** 源节点桩：BranchEdge 经 useInternalNode(source) 读取其 options。 */
function branchSource(options: Option[], type = 'branch') {
  return { internals: { userNode: { id: 'br1', type, data: { prompt: '去哪', options } } } }
}

function setup(options: Option[] = [], sourceType = 'branch', handle = 'option-o1') {
  useInternalNodeMock.mockReset()
  useInternalNodeMock.mockReturnValue(branchSource(options, sourceType))
  edgeLookupMock.current = new Map([['e1', { sourceHandle: handle }]])
  const props = {
    id: 'e1',
    source: 'br1',
    target: 'd1',
    sourceHandle: handle,
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 80,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  } as unknown as EdgeProps<BranchFlowEdge>
  const { container, rerender } = render(
    <svg>
      <BranchEdge {...props} />
    </svg>,
  )
  const rerenderWith = (nextOptions: Option[]) => {
    useInternalNodeMock.mockReturnValue(branchSource(nextOptions, sourceType))
    rerender(
      <svg>
        <BranchEdge {...props} />
      </svg>,
    )
  }
  return { container, rerenderWith }
}

describe('BranchEdge（分支连线）', () => {
  it('渲染贝塞尔路径并以独立渐变描边（url 引用本边渐变 id）', () => {
    const { container } = setup([{ id: 'o1', label: '坦白' }])
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

  it('胶囊文案按 sourceHandle 绑定的选项 id 从源节点 options 派生', () => {
    setup([
      { id: 'o0', label: '坦白' },
      { id: 'o1', label: '隐瞒' },
    ])
    expect(screen.getByText('隐瞒')).toBeTruthy()
    expect(screen.queryByText('坦白')).toBeNull()
  })

  it('会话内改名选项文案，胶囊立即更新（issue #18 新鲜度）', () => {
    const { rerenderWith } = setup([{ id: 'o1', label: '隐瞒' }])
    expect(screen.getByText('隐瞒')).toBeTruthy()
    // patchNode 改名（含 undo/redo 走同一通道）：源节点 options 更新，
    // useInternalNode 订阅触发胶囊重派生
    rerenderWith([{ id: 'o1', label: '隐瞒（改）' }])
    expect(screen.getByText('隐瞒（改）')).toBeTruthy()
    expect(screen.queryByText('隐瞒')).toBeNull()
  })

  it('悬空句柄（指向已删选项）与非分支源回退空串，不渲染胶囊', () => {
    setup([{ id: 'o1', label: '隐瞒' }], 'branch', 'option-gone')
    expect(screen.queryByText('隐瞒')).toBeNull()

    setup([{ id: 'o1', label: '隐瞒' }], 'scene', 'option-o1')
    expect(screen.queryByText('隐瞒')).toBeNull()
  })
})
