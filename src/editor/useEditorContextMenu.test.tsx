// @vitest-environment happy-dom
/**
 * 右键菜单触发 hook（从 EditorWindow 搬迁，§4.3）：节点/连线/空白三种菜单
 * 载荷，以及节点菜单的右键单选行为。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Edge } from '@xyflow/react'
import { useEditorContextMenu } from './useEditorContextMenu'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

const scene = (id: string): CanvasNode =>
  ({
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    selected: false,
    data: { name: id, sceneNo: 1, characterIds: [], locationId: null },
  }) as unknown as CanvasNode

const EDGE: Edge = { id: 'e1', source: 'n1', target: 'n2' }

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [scene('n1'), scene('n2')],
  edges: [EDGE],
  settings: { characters: [], locations: [] },
}

const fakeEvent = () =>
  ({ preventDefault: vi.fn(), clientX: 12, clientY: 34 }) as unknown as ReactMouseEvent

function setup() {
  const setCtxMenu = vi.fn()
  const { result } = renderHook(() => {
    const doc = useEditorDocument(PROJECT)
    return { doc, menu: useEditorContextMenu(doc, setCtxMenu) }
  })
  return { result, setCtxMenu }
}

describe('useEditorContextMenu（§4.3）', () => {
  it('节点菜单：阻止默认菜单、单选该节点并写入触发点', () => {
    const { result, setCtxMenu } = setup()
    const event = fakeEvent()
    act(() => result.current.menu.onNodeContextMenu(event, result.current.doc.nodes[1]))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(setCtxMenu).toHaveBeenCalledWith({ x: 12, y: 34, nodeId: 'n2' })
    expect(result.current.doc.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['n2'])
  })

  it('连线菜单：只记录边 id', () => {
    const { result, setCtxMenu } = setup()
    act(() => result.current.menu.onEdgeContextMenu(fakeEvent(), EDGE))
    expect(setCtxMenu).toHaveBeenCalledWith({ x: 12, y: 34, edgeId: 'e1' })
  })

  it('空白菜单：节点与边 id 皆无', () => {
    const { result, setCtxMenu } = setup()
    act(() => result.current.menu.onPaneContextMenu(fakeEvent()))
    expect(setCtxMenu).toHaveBeenCalledWith({ x: 12, y: 34 })
  })
})
