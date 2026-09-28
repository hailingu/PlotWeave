// @vitest-environment happy-dom
/**
 * issue #401 右栏 ai 聚合的引用稳定性回归：EditorLayout 捆绑的聚合对象在
 * 无成员变化的重渲染（位置帧）间引用稳定——AiThread 的 memo 边界
 * （issue #157）逐成员比较，聚合不得引入逐渲染重建的新比较对象；画布
 * 内容变化（摘要成员变化）时聚合必须重建（反 stale）。以 RightPanel
 * 捕获桩记录每次渲染收到的 ai 引用，位置帧经真实 onNodesChange 驱动
 * （与 positionFrameRender.test.tsx 同通道）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'
import type { NodeChange } from '@xyflow/react'

/** ReactFlow props 捕获桩（经 vi.hoisted 供 mock 工厂引用）。 */
const flow = vi.hoisted(() => ({
  onNodesChange: null as null | ((changes: NodeChange[]) => void),
}))
/** RightPanel 捕获桩逐渲染记录的 ai 聚合引用。 */
const seen = vi.hoisted(() => ({ ai: [] as unknown[] }))

vi.mock('@xyflow/react', async (orig) => {
  const actual = await orig<typeof import('@xyflow/react')>()
  return {
    ...actual,
    ReactFlow: (props: { onNodesChange?: (c: NodeChange[]) => void }) => {
      flow.onNodesChange = props.onNodesChange ?? null
      return null
    },
  }
})

// 捕获桩只记录收到的 ai 引用，不渲染会话面板（聚合内容与映射的
// 行为语义由 RightPanel.test.tsx / AiThread.context.test.tsx 覆盖）。
vi.mock('./panels/RightPanel', async (orig) => {
  const actual = await orig<typeof import('./panels/RightPanel')>()
  return {
    ...actual,
    RightPanel: (props: { ai?: unknown }) => {
      seen.ai.push(props.ai)
      return null
    },
  }
})

afterEach(cleanup)

const node = (id: string, x: number): CanvasNode =>
  ({
    id,
    type: 'beat',
    position: { x, y: 0 },
    data: { name: id, tone: '紧张', episodeNo: 1 },
  }) as unknown as CanvasNode

const PROJECT: EditorProjectContent = {
  id: 'p-401',
  name: '聚合稳定性',
  nodes: [node('b1', 0), node('b2', 300)],
  edges: [{ id: 'e1', source: 'b1', target: 'b2' }],
  settings: { characters: [], locations: [] },
}

function mount() {
  render(
    <EditorView
      project={PROJECT}
      onBackHome={vi.fn()}
      onRenameProject={vi.fn()}
      onSave={vi.fn()}
    />,
  )
}

/** 拖拽过程帧：经真实 onNodesChange 通道驱动 position 变更。 */
const dragFrame = (id: string, x: number) =>
  act(() => {
    flow.onNodesChange?.([
      { id, type: 'position', position: { x, y: 0 }, dragging: true },
    ])
  })

describe('EditorLayout 右栏 ai 聚合引用稳定性（issue #401）', () => {
  beforeEach(() => {
    seen.ai = []
  })

  it('位置帧间引用稳定：成员未变 ⇒ 同一聚合对象', () => {
    mount()
    expect(seen.ai.length).toBeGreaterThan(0)
    // 聚合内容可达性基线：成员照常可从聚合取得
    const first = seen.ai[0] as { projectId: string }
    expect(first.projectId).toBe('p-401')

    // 3 帧同向小幅位移（无内容变化）：聚合引用不逐帧重建
    for (let i = 1; i <= 3; i++) dragFrame('b1', 10 * i)
    expect(new Set(seen.ai).size).toBe(1)
  })

  it('内容变化重建聚合（反 stale）：新增节点后引用更新', () => {
    mount()
    const before = seen.ai[0]
    // 真实内容新增（positionFrameRender.test 同款入口）：摘要成员变化
    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
    expect(seen.ai.length).toBeGreaterThan(1)
    expect(seen.ai[seen.ai.length - 1]).not.toBe(before)
  })
})
