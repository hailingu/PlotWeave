// @vitest-environment happy-dom
/** 对齐失败可重试，历史回放只修改位置，保留之后的新内容与当前选中态。 */
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { CommandStack } from './history'
import { useCanvasAlignment } from './useCanvasAlignment'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'

/** 未测量新节点与已测量节点共存，直接操作真实文档状态和命令栈。 */
function setup() {
  const project: EditorProjectContent = {
    id: 'alignment',
    name: '对齐',
    edges: [],
    settings: { characters: [], locations: [] },
    nodes: [
      {
        id: 'a',
        type: 'beat',
        selected: true,
        position: { x: 10, y: 0 },
        data: { name: '开场', tone: '' },
      },
      {
        id: 'b',
        type: 'beat',
        selected: true,
        position: { x: 100, y: 50 },
        width: 40,
        height: 20,
        data: { name: '转折', tone: '' },
      },
    ],
  }
  const stack = new CommandStack()
  const result = renderHook(() => {
    const doc = useEditorDocument(project)
    const [error, onError] = useState<string | null>(null)
    const actions = useCanvasAlignment({
      nodesRef: doc.nodesRef,
      setNodes: doc.setNodes,
      pushHistory: (command) => stack.push(command),
      onError,
    })
    return { doc, actions, error }
  }).result
  return { result, stack }
}

describe('useCanvasAlignment', () => {
  it('尺寸未就绪时零变更，测量完成后的同一动作可以重试', () => {
    const { result, stack } = setup()
    act(() => result.current.actions.onAlignNodes('left'))
    expect(result.current.error).toContain('尺寸测量')
    expect(result.current.doc.nodes[1]!.position.x).toBe(100)
    expect(stack.canUndo).toBe(false)
    act(() =>
      result.current.doc.setNodes((nodes) =>
        nodes.map((node) =>
          node.id === 'a'
            ? { ...node, measured: { width: 80, height: 40 } }
            : node,
        ),
      ),
    )
    act(() => result.current.actions.onAlignNodes('left'))
    expect(result.current.doc.nodes[1]!.position.x).toBe(10)
    act(() => stack.undo())
    expect(result.current.doc.nodes[1]!.position.x).toBe(100)
    expect(stack.canUndo).toBe(false)
  })

  it('撤销重做只还原位置，不覆盖后续内容与选中态', () => {
    const { result, stack } = setup()
    act(() =>
      result.current.doc.setNodes((nodes) =>
        nodes.map((node) => ({
          ...node,
          measured: { width: 80, height: 40 },
        })),
      ),
    )
    act(() => result.current.actions.onAlignNodes('left'))
    act(() =>
      result.current.doc.setNodes((nodes) =>
        nodes.map((node) =>
          node.id === 'b' && node.type === 'beat'
            ? {
                ...node,
                selected: false,
                data: { ...node.data, name: '新内容' },
              }
            : node,
        ),
      ),
    )
    act(() => stack.undo())
    expect(result.current.doc.nodes[1]).toMatchObject({
      position: { x: 100, y: 50 },
      selected: false,
      data: { name: '新内容' },
    })
    act(() => stack.redo())
    expect(result.current.doc.nodes[1]).toMatchObject({
      position: { x: 10, y: 50 },
      selected: false,
      data: { name: '新内容' },
    })
  })
})
