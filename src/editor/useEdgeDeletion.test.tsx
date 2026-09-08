// @vitest-environment happy-dom
/**
 * 连线删除 hook（从 EditorWindow 搬迁的连线写域）：删除一组边一步可撤销，
 * 撤销按删除前顺序复原；未知 id 不产生命令。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useEdgeDeletion } from './useEdgeDeletion'
import type { HistoryCommand } from './history'

const edges: Edge[] = [
  { id: 'e1', source: 'a', target: 'b' },
  { id: 'e2', source: 'b', target: 'c' },
]

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [],
  edges,
  settings: { characters: [], locations: [] },
}

function setup(project: EditorProjectContent = PROJECT) {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    return { doc, deleteEdgesByIds: useEdgeDeletion(doc, pushHistory) }
  })
  return { result, commands, pushHistory }
}

describe('useEdgeDeletion（§4.3 删除可撤销）', () => {
  it('删除选中边并入栈；undo 追加复原，redo 再删', () => {
    const { result, commands } = setup()
    act(() => result.current.deleteEdgesByIds(['e1']))
    expect(result.current.doc.edges.map((e) => e.id)).toEqual(['e2'])
    expect(commands).toHaveLength(1)

    // 既有语义：undo 把被删边追加到末尾（非原位插回），此处守护该行为不变
    act(() => commands[0].undo())
    expect(result.current.doc.edges.map((e) => e.id)).toEqual(['e2', 'e1'])
    act(() => commands[0].redo())
    expect(result.current.doc.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('未知 id 不写状态也不入栈', () => {
    const { result, pushHistory } = setup()
    act(() => result.current.deleteEdgesByIds(['missing']))
    expect(result.current.doc.edges).toHaveLength(2)
    expect(pushHistory).not.toHaveBeenCalled()
  })
})
