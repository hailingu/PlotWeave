// @vitest-environment happy-dom
/**
 * 节点字段补丁 hook（从 EditorWindow 搬迁的节点写域）：合并键、撤销/重做
 * 语义，以及分支选项级联删除必须与选项补丁同处一个撤销单元。测试以真实的
 * useEditorDocument 组合，只断言画布状态与命令栈行为，不触实现细节。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useNodePatch } from './useNodePatch'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

const branchNode = {
  id: 'br1',
  type: 'branch',
  position: { x: 0, y: 0 },
  data: {
    prompt: '走哪条路',
    options: [
      { id: 'o1', label: '上楼' },
      { id: 'o2', label: '下楼' },
    ],
  },
} as unknown as CanvasNode

const optionEdge = (handle: string): Edge => ({
  id: `e-br1-${handle}-sc1`,
  source: 'br1',
  target: 'sc1',
  sourceHandle: handle,
})

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [branchNode],
  edges: [optionEdge('option-o1'), optionEdge('option-o2')],
  settings: { characters: [], locations: [] },
}

function setup(project: EditorProjectContent = PROJECT) {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    return { doc, patch: useNodePatch(doc, pushHistory) }
  })
  return { result, commands, pushHistory }
}

const branchData = (node: CanvasNode | undefined) =>
  node?.data as { prompt: string; options: Array<{ id: string }> }

describe('useNodePatch（§4.3 编辑即命令）', () => {
  it('patchNode 实时合并字段并按「patch:<id>:<keys>」生成合并键', () => {
    const { result, commands } = setup()
    act(() =>
      result.current.patch.patchNode('br1', { nodeType: 'branch', patch: { prompt: '新问句' } }),
    )
    expect(branchData(result.current.doc.nodes[0]).prompt).toBe('新问句')
    expect(commands).toHaveLength(1)
    expect(commands[0].coalesceKey).toBe('patch:br1:prompt')

    act(() => commands[0].undo())
    expect(branchData(result.current.doc.nodes[0]).prompt).toBe('走哪条路')
    act(() => commands[0].redo())
    expect(branchData(result.current.doc.nodes[0]).prompt).toBe('新问句')
  })

  it('未知节点 id 不写状态也不入栈', () => {
    const { result, pushHistory } = setup()
    act(() =>
      result.current.patch.patchNode('missing', { nodeType: 'branch', patch: { prompt: 'x' } }),
    )
    expect(pushHistory).not.toHaveBeenCalled()
    expect(branchData(result.current.doc.nodes[0]).prompt).toBe('走哪条路')
  })

  it('删除分支选项连带删除其出口边，且与选项补丁同处一个撤销单元', () => {
    const { result, commands } = setup()
    act(() =>
      result.current.patch.patchNode('br1', {
        nodeType: 'branch',
        patch: { options: [{ id: 'o1', label: '上楼' }] },
      }),
    )
    expect(result.current.doc.edges.map((e) => e.id)).toEqual(['e-br1-option-o1-sc1'])
    expect(branchData(result.current.doc.nodes[0]).options).toHaveLength(1)
    // 有边级联时不可与普通补丁合并撤销，必须单独成步
    expect(commands).toHaveLength(1)
    expect(commands[0].coalesceKey).toBeUndefined()

    act(() => commands[0].undo())
    expect(result.current.doc.edges.map((e) => e.id)).toEqual([
      'e-br1-option-o1-sc1',
      'e-br1-option-o2-sc1',
    ])
    expect(branchData(result.current.doc.nodes[0]).options).toHaveLength(2)

    act(() => commands[0].redo())
    expect(result.current.doc.edges.map((e) => e.id)).toEqual(['e-br1-option-o1-sc1'])
  })

  it('applyDataPatch 是纯写入：不进命令栈', () => {
    const { result, pushHistory } = setup()
    act(() =>
      result.current.patch.applyDataPatch('br1', {
        nodeType: 'branch',
        patch: { prompt: '静默' },
      }),
    )
    expect(branchData(result.current.doc.nodes[0]).prompt).toBe('静默')
    expect(pushHistory).not.toHaveBeenCalled()
  })
})
