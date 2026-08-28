// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { nodeLabelOf, useAiBridge, type AiBridgeDeps } from './useAiBridge'
import type { AiCommand } from './ai/commands'
import type { HistoryCommand } from './history'
import { EMPTY_SETTINGS } from './settings'
import type { BranchFlowNode, CanvasNode, SceneFlowNode } from './nodes/types'

function sceneNode(id: string, sceneNo = 1): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: {
      name: `场${sceneNo}`,
      sceneNo,
      interior: true,
      time: '🌙 夜',
      synopsis: '…',
      characterIds: [],
    },
  }
}

function branchNode(id: string): BranchFlowNode {
  return {
    id,
    type: 'branch',
    position: { x: 0, y: 0 },
    data: { prompt: '去哪？', options: [{ id: 'o-l', label: '左' }, { id: 'o-r', label: '右' }] },
  }
}

describe('nodeLabelOf（节点人读标签）', () => {
  it('五类节点各有标签格式', () => {
    expect(nodeLabelOf(sceneNode('s1', 3))).toBe('场3·场3')
    expect(nodeLabelOf(branchNode('b1'))).toBe('分支·去哪？')
    expect(
      nodeLabelOf({
        id: 'd1',
        type: 'dialogue',
        position: { x: 0, y: 0 },
        data: { name: '争执', lines: [] },
      }),
    ).toBe('对白·争执')
    expect(
      nodeLabelOf({ id: 't1', type: 'beat', position: { x: 0, y: 0 }, data: { name: '转折', tone: '待定' } }),
    ).toBe('节拍·转折')
    expect(
      nodeLabelOf({
        id: 'sh1',
        type: 'shot',
        position: { x: 0, y: 0 },
        data: { shotNo: 2, size: '特写', picture: '', prompt: '', refs: [] },
      }),
    ).toBe('SHOT2·特写')
  })
})

/** 可变画布状态 + AI 桥依赖（模拟 EditorView 注入）。 */
function setup(initialNodes: CanvasNode[] = [sceneNode('s1')], initialEdges: Edge[] = []) {
  const state = { nodes: [...initialNodes], edges: [...initialEdges] }
  const commands: HistoryCommand[] = []
  const closeSettings = vi.fn()
  const deps: AiBridgeDeps = {
    nodes: state.nodes,
    edges: state.edges,
    settings: EMPTY_SETTINGS,
    nodesRef: { current: state.nodes },
    edgesRef: { current: state.edges },
    buildNewNode: (type, opts) =>
      ({
        id: `ai-${type}-${state.nodes.length}`,
        type,
        position: { x: 0, y: 0 },
        data: { ...(opts?.data ?? {}) },
      }) as CanvasNode,
    applyDataPatch: (id, patch) => {
      state.nodes = state.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n,
      )
    },
    setNodes: (up) => {
      state.nodes = up(state.nodes)
      deps.nodesRef.current = state.nodes
    },
    setEdges: (up) => {
      state.edges = up(state.edges)
      deps.edgesRef.current = state.edges
    },
    pushHistory: (cmd) => commands.push(cmd),
    closeSettings,
  }
  const { result } = renderHook(() => useAiBridge(deps))
  return { result, state, commands, closeSettings }
}

describe('useAiBridge（§6/§12 AI 桥回调族）', () => {
  it('canvasDigest：压缩快照包含节点行与设定集清单', () => {
    const { result } = setup([sceneNode('s1', 2)])
    expect(result.current.canvasDigest).toContain('场02')
    expect(result.current.canvasDigest).toContain('s1')
  })

  it('validateAiReply：纯讨论返回 null；围栏批次返回整批校验', () => {
    const { result } = setup()
    expect(result.current.validateAiReply('这段写得不错')).toBeNull()
    const fenced = [
      '好的，我来创建：',
      '```json',
      JSON.stringify({ commands: [{ op: 'create_node', nodeType: 'scene', ref: 'a', data: { name: '新场' } }] }),
      '```',
    ].join('\n')
    const v = result.current.validateAiReply(fenced)
    expect(v?.ok).toBe(true)
  })

  it('validateCommands：合法批次 ok；未知字段批次给出错误项', () => {
    const { result } = setup()
    const ok = result.current.validateCommands([
      { op: 'create_node', nodeType: 'beat', ref: 'b', data: { name: '节拍' } },
    ])
    expect(ok?.ok).toBe(true)
    const bad = result.current.validateCommands([
      { op: 'update_node', nodeId: 's1', patch: { hack: 1 } },
    ])
    expect(bad?.ok).toBe(false)
  })

  it('readNode：存在返回 JSON 片段；不存在返回 null', () => {
    const { result } = setup()
    const json = result.current.readNode('s1')
    expect(json).toContain('"id":"s1"')
    expect(json).toContain('"sceneNo":1')
    expect(result.current.readNode('ghost')).toBeNull()
  })

  it('applyAiBatch：空批次直接 null；非法批次返回错误文案且不改画布', () => {
    const { result, state, commands } = setup()
    expect(result.current.applyAiBatch([])).toBeNull()
    const err = result.current.applyAiBatch([{ op: 'update_node', nodeId: 's1', patch: { hack: 1 } }])
    expect(err).toContain('改动无法安全执行')
    expect(state.nodes).toHaveLength(1)
    expect(commands).toHaveLength(0)
  })

  it('applyAiBatch：合法批次整批落地为一条复合命令，undo 一步回滚', () => {
    const { result, state, commands, closeSettings } = setup([sceneNode('s1'), branchNode('b1')])
    const batch: AiCommand[] = [
      { op: 'create_node', nodeType: 'scene', ref: 'ns', data: { name: '新场' } },
      { op: 'connect_edge', sourceId: 's1', targetId: 'ns' },
      { op: 'update_node', nodeId: 'b1', patch: { prompt: '走哪边？' } },
    ]
    expect(result.current.applyAiBatch(batch)).toBeNull()
    expect(state.nodes).toHaveLength(3)
    expect(state.edges).toHaveLength(1)
    const b1 = state.nodes.find((n) => n.id === 'b1')!
    expect(b1.type === 'branch' && b1.data.prompt).toBe('走哪边？')
    expect(closeSettings).toHaveBeenCalledTimes(1)

    expect(commands).toHaveLength(1)
    commands[0].undo()
    expect(state.nodes).toHaveLength(2)
    expect(state.edges).toEqual([])
    const b1r = state.nodes.find((n) => n.id === 'b1')!
    expect(b1r.type === 'branch' && b1r.data.prompt).toBe('去哪？')
    commands[0].redo()
    expect(state.nodes).toHaveLength(3)
  })
})
