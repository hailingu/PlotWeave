// @vitest-environment happy-dom
/**
 * 节点创建与复制 hook（从 EditorWindow 搬迁的节点写域）：＋节点/拖放共用
 * 的构建入口、入栈语义、单选行为与落点换算。断言画布状态与命令栈行为。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useNodeCreation } from './useNodeCreation'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

const existingNode = {
  id: 'sc1',
  type: 'scene',
  position: { x: 100, y: 100 },
  selected: true,
  data: { name: '既有场景', sceneNo: 1, characterIds: [], locationId: null },
} as unknown as CanvasNode

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [existingNode],
  edges: [],
  settings: {
    characters: [{ id: 'c1', name: '阿黎', gradient: 'linear-gradient(#000,#111)' }],
    locations: [],
  },
}

/** 画布容器替身：无显式落点时取 getBoundingClientRect 的中心。 */
const canvasRef = {
  current: {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
  } as unknown as HTMLDivElement,
}

function setup(project: EditorProjectContent = PROJECT) {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const setPlusOpen = vi.fn()
  const closeSettings = vi.fn()
  const screenToFlowPosition = vi.fn((pos: { x: number; y: number }) => pos)
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    return {
      doc,
      creation: useNodeCreation({
        doc,
        setPlusOpen,
        closeSettings,
        screenToFlowPosition,
        canvasRef,
        pushHistory,
      }),
    }
  })
  return { result, commands, setPlusOpen, closeSettings, screenToFlowPosition }
}

describe('useNodeCreation（§3.3 新建/复制）', () => {
  it('createNode：新节点选中、其余取消选中、单步入栈，并收起 ＋菜单与设置面板', () => {
    const { result, commands, setPlusOpen, closeSettings } = setup()
    act(() => result.current.creation.createNode('beat'))
    const nodes = result.current.doc.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes[0].selected).toBe(false)
    expect(nodes[1].type).toBe('beat')
    expect(nodes[1].selected).toBe(true)
    expect(commands).toHaveLength(1)
    expect(setPlusOpen).toHaveBeenCalledWith(false)
    expect(closeSettings).toHaveBeenCalled()

    act(() => commands[0].undo())
    expect(result.current.doc.nodes).toHaveLength(1)
    act(() => commands[0].redo())
    expect(result.current.doc.nodes).toHaveLength(2)
  })

  it('buildNewNode：无显式落点时按画布容器中心换算位置', () => {
    const { result, screenToFlowPosition } = setup()
    const node = result.current.creation.buildNewNode('scene')
    // 中心换算的结果进入工厂；最终落点由 nodeFactory 的阶梯偏移决定
    expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 60, y: 45 })
    expect(node.position.x).toBeLessThan(60)
    expect(node.position.y).toBeLessThan(45)
    expect(node.type).toBe('scene')
  })

  it('duplicateNode：同 data 新 id、右下偏移、只选中副本，入栈可撤销', () => {
    const { result, commands } = setup()
    act(() => result.current.creation.duplicateNode('sc1'))
    const nodes = result.current.doc.nodes
    expect(nodes).toHaveLength(2)
    const copy = nodes[1]
    expect(copy.id).not.toBe('sc1')
    expect(copy.id.startsWith('scene-')).toBe(true)
    expect(copy.position).toEqual({ x: 148, y: 140 })
    expect(copy.selected).toBe(true)
    expect(nodes[0].selected).toBe(false)
    expect(copy.data).not.toBe(existingNode.data)

    act(() => commands[0].undo())
    expect(result.current.doc.nodes.map((n) => n.id)).toEqual(['sc1'])
  })

  it('duplicateNode：未知 id 不写状态也不入栈', () => {
    const { result, commands } = setup()
    act(() => result.current.creation.duplicateNode('missing'))
    expect(result.current.doc.nodes).toHaveLength(1)
    expect(commands).toHaveLength(0)
  })
})
