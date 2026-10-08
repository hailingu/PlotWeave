// @vitest-environment happy-dom
/** 原生内容卡的真实 React Flow 回归：方向、稳定行出口、选择和实时目标投影。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { ReactFlow, Position, useEdgesState, type Edge } from '@xyflow/react'
import { NodeEditContext, type NodeEditApi } from '../nodeEdit'
import { BranchNode } from './BranchNode'
import { BeatNode } from './BeatNode'
import { BranchEdge } from '../edges/BranchEdge'
import type { BranchOption, CanvasNode } from './types'

afterEach(cleanup)

const OPTIONS: BranchOption[] = [
  { id: 'a', label: '坦白' },
  { id: 'b', label: '隐瞒' },
  { id: 'c', label: '沉默' },
]
const NODE_TYPES = { branch: BranchNode, beat: BeatNode }
const EDGE_TYPES = { branch: BranchEdge }
const API: NodeEditApi = {
  projectId: 'ports',
  openSettingsId: null,
  toggleSettings: vi.fn(),
  closeSettings: vi.fn(),
  patchNode: vi.fn(),
  duplicateNode: vi.fn(),
  deleteNode: vi.fn(),
  shotCountOf: () => 0,
  beatFulfillmentOf: () => null,
  settings: { characters: [], locations: [] },
  assets: undefined,
}

/** 提供框架可计算的尺寸和句柄；真实浏览器另验证 CSS 几何。 */
function nodes(options: BranchOption[], targetName: string): CanvasNode[] {
  return [
    {
      id: 'branch',
      type: 'branch',
      position: { x: 0, y: 0 },
      width: 320,
      height: 224,
      data: { prompt: '是否坦白？', options },
      handles: options.map((o, index) => ({
        id: `option-${o.id}`,
        type: 'source',
        position: Position.Right,
        x: 320,
        y: 80 + index * 48,
        width: 28,
        height: 28,
      })),
    },
    {
      id: 'target',
      type: 'beat',
      position: { x: 500, y: 0 },
      width: 300,
      height: 100,
      data: { name: targetName, tone: '平静' },
      handles: [
        {
          type: 'target',
          position: Position.Left,
          x: 0,
          y: 50,
          width: 28,
          height: 28,
        },
      ],
    },
  ]
}

/** 选择经过真实框架事件；节点与目标改名经过受控投影更新，不替换 Handle。 */
function CanvasFixture({
  options = OPTIONS,
  targetName = '天台摊牌',
}: {
  readonly options?: BranchOption[]
  readonly targetName?: string
}) {
  const [edges, , onEdgesChange] = useEdgesState<Edge>([
    {
      id: 'e1',
      type: 'branch',
      source: 'branch',
      sourceHandle: 'option-a',
      target: 'target',
    },
  ])
  return (
    <NodeEditContext.Provider value={API}>
      <ReactFlow
        nodes={nodes(options, targetName)}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onEdgesChange={onEdgesChange}
      />
    </NodeEditContext.Provider>
  )
}

/** 可访问名称是方向与所属条目的公开 UI 合同（docs/ui-design.md §4.3）。 */
function port(name: string): HTMLElement {
  return screen.getByLabelText(name)
}

describe('外置端口与分支连接', () => {
  it('输入和输出具有不同方向标记，三行各有一个稳定出口，输入没有箭头', () => {
    render(<CanvasFixture />)
    expect(port('分支入口').dataset.pwPort).toBe('in')
    expect(port('分支入口').querySelector('svg')).toBeNull()
    for (const option of OPTIONS) {
      const output = port(`分支出口：${option.label}`)
      expect(output.dataset.pwPort).toBe('out')
      expect(output.dataset.handleid).toBe(`option-${option.id}`)
      expect(output.querySelector('svg')).not.toBeNull()
    }
    expect(document.querySelectorAll('.pw-branch .source')).toHaveLength(3)
  })

  it('重排行与目标改名保留出口 ID，目标摘要和连线标签从当前投影派生', () => {
    const { rerender } = render(<CanvasFixture />)
    const changed = [
      { id: 'c', label: '沉默' },
      { id: 'a', label: '坦白（改）' },
    ]
    rerender(<CanvasFixture options={changed} targetName="雨夜天台" />)
    const output = port('分支出口：坦白（改）')
    expect(output.dataset.handleid).toBe('option-a')
    const row = output.closest('.pw-branch-opt') as HTMLElement
    expect(within(row).getByText('雨夜天台')).toBeTruthy()
    expect(document.querySelector('.pw-edge-label')?.textContent).toBe(
      '坦白（改）',
    )
    expect(screen.queryByLabelText('分支出口：隐瞒')).toBeNull()
  })

  it('选择连线只激活对应行和两端口，取消后复原，不激活其他出口', () => {
    const { container } = render(<CanvasFixture />)
    const edge = container.querySelector('.react-flow__edge[data-id="e1"]')!
    fireEvent.click(edge)
    expect(port('分支出口：坦白').classList.contains('pw-port-active')).toBe(
      true,
    )
    expect(port('节奏卡入口').classList.contains('pw-port-active')).toBe(true)
    expect(port('分支出口：隐瞒').classList.contains('pw-port-active')).toBe(
      false,
    )
    expect(
      port('分支出口：坦白')
        .closest('.pw-branch-opt')
        ?.classList.contains('pw-branch-opt-active'),
    ).toBe(true)
    fireEvent.click(container.querySelector('.react-flow__pane')!)
    expect(port('分支出口：坦白').classList.contains('pw-port-active')).toBe(
      false,
    )
    expect(port('节奏卡入口').classList.contains('pw-port-active')).toBe(false)
  })
})
