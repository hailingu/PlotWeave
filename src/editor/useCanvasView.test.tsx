// @vitest-environment happy-dom
/**
 * 画布视图派生与定位 hook（从 EditorWindow 搬迁，§3.5/§7.2）：镜数、节拍
 * 兑现、集聚焦投影与大纲联动的选中/居中行为。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { useCanvasView } from './useCanvasView'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

const scene = (id: string, name: string, episodeNo?: number): CanvasNode =>
  ({
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    selected: id === 's1',
    data: {
      name,
      sceneNo: Number(id.slice(1)),
      interior: false,
      time: '🌙 夜',
      synopsis: '',
      characterIds: [],
      locationId: null,
      episodeNo,
    },
  }) as unknown as CanvasNode

const beat = (id: string, episodeNo?: number): CanvasNode =>
  ({
    id,
    type: 'beat',
    position: { x: 0, y: 0 },
    data: { name: id, tone: '', episodeNo },
  }) as unknown as CanvasNode

const shot = {
  id: 'sh1',
  type: 'shot',
  position: { x: 0, y: 0 },
  data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [] },
} as unknown as CanvasNode

const EDGES: Edge[] = [
  { id: 'e-attach', source: 's1', target: 'sh1', sourceHandle: 'shots', selected: true },
  { id: 'e-seq', source: 'b1', target: 's1', className: 'pw-edge-sequence' },
]

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [scene('s1', '天台', 1), scene('s2', '车站', 2), shot, beat('b1', 1), beat('b2')],
  edges: EDGES,
  settings: { characters: [], locations: [] },
}

function setup(project: EditorProjectContent = PROJECT) {
  const fitView = vi.fn()
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    return { doc, view: useCanvasView(doc, fitView) }
  })
  return { result, fitView }
}

describe('useCanvasView（§3.5/§7.2 派生与定位）', () => {
  it('shotCountOf 派生 attach 下挂边数量', () => {
    const { result } = setup()
    expect(result.current.view.shotCountOf('s1')).toBe(1)
    expect(result.current.view.shotCountOf('s2')).toBe(0)
  })

  it('beatFulfillmentOf：被场景承载 = fulfilled，孤立 = pending，非节拍 = null', () => {
    const { result } = setup()
    expect(result.current.view.beatFulfillmentOf('b1')).toEqual({
      status: 'fulfilled',
      sceneLabel: '场 01 · 天台',
    })
    expect(result.current.view.beatFulfillmentOf('b2')).toEqual({ status: 'pending' })
    expect(result.current.view.beatFulfillmentOf('s1')).toBeNull()
  })

  it('displayNodes：集聚焦时非成员降透明度，分镜卡随宿主场景分集', () => {
    const { result } = setup()
    act(() => result.current.doc.setFocusedEpisode(1))
    const byId = new Map(result.current.view.displayNodes.map((n) => [n.id, n]))
    expect(byId.get('s1')?.className).toBeUndefined()
    expect(byId.get('b1')?.className).toBeUndefined()
    expect(byId.get('sh1')?.className).toBeUndefined()
    expect(byId.get('s2')?.className).toBe('pw-node-dim')
    expect(byId.get('b2')?.className).toBe('pw-node-dim')
  })

  it('selectedNode / selectedNodeIds / selectedEdgeIds 读取选中态', () => {
    const { result } = setup()
    expect(result.current.view.selectedNode?.id).toBe('s1')
    expect(result.current.view.selectedNodeIds()).toEqual(['s1'])
    expect(result.current.view.selectedEdgeIds()).toEqual(['e-attach'])
  })

  it('locateNode：单选该节点并居中', () => {
    const { result, fitView } = setup()
    act(() => result.current.view.locateNode('s2'))
    expect(result.current.doc.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['s2'])
    expect(fitView).toHaveBeenCalledWith({ nodes: [{ id: 's2' }], duration: 400, maxZoom: 1 })
  })
})
