// @vitest-environment happy-dom
/**
 * 节点拖拽历史的行为回归（issue #269）：真实 useEditorDocument 状态 +
 * 真实 CommandStack 的集成 harness（与 useEditorGraphActions 生产装配
 * 同构——同款 setNodes/pushHistory 注入）。多帧拖拽整段只记一步撤销，
 * undo 恢复起点、redo 恢复落点；无位移与缺失 dragStart 不新增历史；
 * 未参与节点的位置与业务数据不动。断言经真实文档状态与栈的 LIFO 行使，
 * 不以 pushHistory 次数代替恢复正确性。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useNodeDragHistory } from './useNodeDragHistory'
import { CommandStack, type HistoryCommand } from './history'
import type { CanvasNode, SceneFlowNode } from './nodes/types'

function sceneNode(id: string, x: number): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '夜',
      synopsis: `${id} 的梗概`,
      characterIds: [],
    },
  }
}

/** 与 useEditorGraphActions 生产装配同构：真实文档 + 真实命令栈。 */
function setup(nodes: CanvasNode[]) {
  const project: EditorProjectContent = {
    id: 'p1',
    name: '测试项目',
    nodes,
    edges: [],
    settings: { characters: [], locations: [] },
  }
  const stack = new CommandStack()
  const pushHistory = vi.fn((cmd: HistoryCommand) => stack.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    const drag = useNodeDragHistory({
      nodesRef: doc.nodesRef,
      onNodesChange: doc.onNodesChange,
      setNodes: doc.setNodes,
      pushHistory,
    })
    return { doc, drag }
  })
  return { result, stack, pushHistory }
}

const posOf = (h: ReturnType<typeof setup>, id: string) => {
  const n = h.result.current.doc.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`节点不存在: ${id}`)
  return { ...n.position, data: n.data }
}

/** 模拟拖拽过程帧：React Flow 在拖拽中持续写节点位置。 */
const dragFrame = (
  h: ReturnType<typeof setup>,
  moves: Record<string, { x: number; y: number }>,
) =>
  act(() => {
    h.result.current.drag.onNodesChange(
      Object.entries(moves).map(([id, position]) => ({
        id,
        type: 'position',
        position,
        dragging: true,
      })),
    )
  })

describe('useNodeDragHistory（issue #269：整段拖拽只入栈一步）', () => {
  it('多帧拖拽只入栈一步：undo 恢复起点、redo 恢复落点', async () => {
    const h = setup([sceneNode('s1', 0), sceneNode('s2', 100)])
    const dragged = () => h.result.current.doc.nodes

    act(() =>
      h.result.current.drag.onNodeDragStart(
        null as never,
        dragged()[0]!,
        dragged(),
      ),
    )
    dragFrame(h, { s1: { x: 12, y: 4 } })
    dragFrame(h, { s1: { x: 30, y: 8 } })
    dragFrame(h, { s1: { x: 55, y: 12 } })
    act(() =>
      h.result.current.drag.onNodeDragStop(
        null as never,
        dragged()[0]!,
        dragged(),
      ),
    )

    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    await act(async () => h.stack.undo())
    expect(posOf(h, 's1').x).toBe(0)
    expect(posOf(h, 's1').y).toBe(0)
    await act(async () => h.stack.redo())
    expect(posOf(h, 's1').x).toBe(55)
    expect(posOf(h, 's1').y).toBe(12)
  })

  it('多节点整段拖拽：两个节点一步撤销，未参与节点位置与业务数据不动', async () => {
    const h = setup([
      sceneNode('a', 0),
      sceneNode('b', 50),
      sceneNode('c', 200),
    ])
    const untouchedBefore = JSON.stringify(posOf(h, 'c'))
    const aBefore = JSON.stringify({ ...posOf(h, 'a'), x: 0, y: 0 })
    const dragged = () => h.result.current.doc.nodes.filter((n) => n.id !== 'c')

    act(() =>
      h.result.current.drag.onNodeDragStart(
        null as never,
        dragged()[0]!,
        dragged(),
      ),
    )
    dragFrame(h, { a: { x: 10, y: 0 }, b: { x: 60, y: 0 } })
    act(() =>
      h.result.current.drag.onNodeDragStop(
        null as never,
        dragged()[0]!,
        dragged(),
      ),
    )

    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    await act(async () => h.stack.undo())
    expect(posOf(h, 'a').x).toBe(0)
    expect(posOf(h, 'b').x).toBe(50)
    // 未参与节点：位置与业务数据（含梗概）整体不变
    expect(JSON.stringify(posOf(h, 'c'))).toBe(untouchedBefore)
    // 参与节点：仅位置往返，业务数据不变
    expect(JSON.stringify({ ...posOf(h, 'a'), x: 0, y: 0 })).toBe(aBefore)
    await act(async () => h.stack.redo())
    expect(posOf(h, 'a').x).toBe(10)
    expect(posOf(h, 'b').x).toBe(60)
    expect(JSON.stringify(posOf(h, 'c'))).toBe(untouchedBefore)
  })
})

describe('框架位置变更过滤（issue #496）', () => {
  it('选择、测量、缺失坐标、未知节点与零位移不入栈，仍更新会话态', () => {
    const h = setup([sceneNode('s1', 0)])
    act(() =>
      h.result.current.drag.onNodesChange([
        { id: 's1', type: 'select', selected: true },
        {
          id: 's1',
          type: 'dimensions',
          dimensions: { width: 120, height: 60 },
        },
        { id: 's1', type: 'position', dragging: false },
        {
          id: 'missing',
          type: 'position',
          position: { x: 22, y: 0 },
          dragging: false,
        },
        {
          id: 's1',
          type: 'position',
          position: { x: 0, y: 0 },
          dragging: false,
        },
      ]),
    )
    expect(h.stack.canUndo).toBe(false)
    expect(h.result.current.doc.nodes[0]).toMatchObject({
      selected: true,
      measured: { width: 120, height: 60 },
      position: { x: 0, y: 0 },
    })
  })
})

describe('拖拽终帧历史（issue #496）', () => {
  it('拖拽最终 dragging=false 帧不重复记录历史', () => {
    const h = setup([sceneNode('a', 0), sceneNode('b', 100)])
    act(() =>
      h.result.current.drag.onNodeDragStart(
        null as never,
        h.result.current.doc.nodes[0]!,
        h.result.current.doc.nodes,
      ),
    )
    dragFrame(h, { a: { x: 22, y: 0 } })
    act(() =>
      h.result.current.drag.onNodesChange([
        {
          id: 'a',
          type: 'position',
          position: { x: 44, y: 0 },
          dragging: false,
        },
      ]),
    )
    expect(h.stack.canUndo).toBe(false)
    act(() =>
      h.result.current.drag.onNodeDragStop(
        null as never,
        h.result.current.doc.nodes[0]!,
        h.result.current.doc.nodes,
      ),
    )
    act(() =>
      h.result.current.drag.onNodesChange([
        {
          id: 'a',
          type: 'position',
          position: { x: 44, y: 0 },
          dragging: false,
        },
      ]),
    )
    act(() => h.stack.undo())
    expect(posOf(h, 'a').x).toBe(0)
    expect(posOf(h, 'b').x).toBe(100)
    expect(h.stack.canUndo).toBe(false)
    act(() => h.stack.redo())
    expect(posOf(h, 'a').x).toBe(44)
    expect(h.stack.canRedo).toBe(false)
  })
})

describe('useNodeDragHistory（issue #269：无位移与缺失 start 不入栈）', () => {
  it('无实际位移的拖拽不入栈（click/未拖动）', () => {
    const h = setup([sceneNode('s1', 0)])
    const nodes = h.result.current.doc.nodes
    act(() =>
      h.result.current.drag.onNodeDragStart(null as never, nodes[0]!, nodes),
    )
    act(() =>
      h.result.current.drag.onNodeDragStop(null as never, nodes[0]!, nodes),
    )
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.stack.canUndo).toBe(false)
  })

  it('缺失 dragStart 的 stop 不新增历史、不抛异常', () => {
    const h = setup([sceneNode('s1', 0)])
    const nodes = () => h.result.current.doc.nodes
    // 未经过 start 直接 stop（如事件乱序/首轮未接线）
    expect(() =>
      act(() =>
        h.result.current.drag.onNodeDragStop(
          null as never,
          nodes()[0]!,
          nodes(),
        ),
      ),
    ).not.toThrow()
    expect(h.pushHistory).not.toHaveBeenCalled()
  })
})
