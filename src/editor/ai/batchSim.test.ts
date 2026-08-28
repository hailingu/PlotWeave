import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { simulateBatch, type BatchOps } from './batchSim'
import type { AiCommand } from './commands'
import type { CanvasNode, SceneFlowNode, BranchFlowNode } from '../nodes/types'

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

/** 可变状态 + 注入 ops：模拟 EditorView 的真实 setState 行为。 */
function mkOps(initialNodes: CanvasNode[], initialEdges: Edge[] = []) {
  const state = { nodes: [...initialNodes], edges: [...initialEdges] }
  let seq = 0
  const ops: BatchOps = {
    buildNewNode: (type, opts) =>
      ({
        id: `new-${type}-${++seq}`,
        type,
        position: { x: 0, y: 0 },
        selected: opts?.selected,
        data: { ...(opts?.data ?? {}) },
      }) as CanvasNode,
    applyDataPatch: (id, patch) => {
      state.nodes = state.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n,
      )
    },
    setNodes: (up) => {
      state.nodes = up(state.nodes)
    },
    setEdges: (up) => {
      state.edges = up(state.edges)
    },
  }
  return { state, ops }
}

describe('simulateBatch · create_node（虚拟终态建链 + 前进/回退闭包）', () => {
  it('forward 追加节点、backward 移除；ref 供后续命令解析', () => {
    const { state, ops } = mkOps([sceneNode('s1')])
    const { forward, backward } = simulateBatch(
      [
        { op: 'create_node', nodeType: 'scene', ref: 'new-scene', data: { name: '新场景' } },
        { op: 'update_node', nodeId: 'new-scene', patch: { synopsis: '改写' } },
      ],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.nodes).toHaveLength(2)
    const created = state.nodes[1]
    expect(created.data.name).toBe('新场景')
    expect(created.data.synopsis).toBe('改写')

    ;[...backward].reverse().forEach((f) => f())
    expect(state.nodes).toHaveLength(1)
  })

  it('update_node 捕获变更前字段值，undo 精确还原（未写字段不受影响）', () => {
    const { state, ops } = mkOps([sceneNode('s1', 3)])
    const { forward, backward } = simulateBatch(
      [{ op: 'update_node', nodeId: 's1', patch: { name: '改名', interior: false } }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.nodes[0].data.name).toBe('改名')
    expect(state.nodes[0].data.interior).toBe(false)
    backward.forEach((f) => f())
    expect(state.nodes[0].data.name).toBe('场3')
    expect(state.nodes[0].data.interior).toBe(true)
    expect(state.nodes[0].data.sceneNo).toBe(3)
  })

  it('update_node 目标不存在时不产生任何闭包', () => {
    const { state, ops } = mkOps([])
    const { forward, backward } = simulateBatch(
      [{ op: 'update_node', nodeId: 'ghost', patch: { name: 'x' } }],
      ops,
      state.nodes,
      state.edges,
    )
    expect(forward).toHaveLength(0)
    expect(backward).toHaveLength(0)
  })
})

describe('simulateBatch · delete_node（连带边清理 + 整体还原）', () => {
  it('forward 删节点与关联边；backward 还原两者', () => {
    const edges: Edge[] = [
      { id: 'e1', source: 's1', target: 's2' },
      { id: 'e2', source: 's2', target: 's3' },
    ]
    const { state, ops } = mkOps([sceneNode('s1'), sceneNode('s2'), sceneNode('s3')], edges)
    const { forward, backward } = simulateBatch(
      [{ op: 'delete_node', nodeId: 's2' }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.nodes.map((n) => n.id)).toEqual(['s1', 's3'])
    expect(state.edges).toEqual([])

    backward.forEach((f) => f())
    expect(state.nodes.map((n) => n.id)).toEqual(['s1', 's3', 's2'])
    expect(state.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
  })

  it('delete_node 目标不存在时不产生闭包', () => {
    const { state, ops } = mkOps([sceneNode('s1')])
    const { forward } = simulateBatch(
      [{ op: 'delete_node', nodeId: 'ghost' }],
      ops,
      state.nodes,
      state.edges,
    )
    expect(forward).toHaveLength(0)
    expect(state.nodes).toHaveLength(1)
  })
})

describe('simulateBatch · connect_edge（§4.4 三态边形态）', () => {
  it('默认 sequence：className pw-edge-sequence', () => {
    const { state, ops } = mkOps([sceneNode('s1'), sceneNode('s2')])
    const { forward } = simulateBatch(
      [{ op: 'connect_edge', sourceId: 's1', targetId: 's2' }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0]).toMatchObject({ source: 's1', target: 's2', className: 'pw-edge-sequence' })
  })

  it('attach：索引卡底端口下挂分镜（sourceHandle = shots）', () => {
    const { state, ops } = mkOps([sceneNode('s1')])
    const { forward } = simulateBatch(
      [
        { op: 'create_node', nodeType: 'shot', ref: 'shot-x', data: {} },
        { op: 'connect_edge', sourceId: 's1', targetId: 'shot-x', edgeKind: 'attach' },
      ],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0]).toMatchObject({
      source: 's1',
      sourceHandle: 'shots',
      className: 'pw-edge-attach',
    })
    // ref 解析：target 指向新建的 shot 节点 id
    expect(state.edges[0].target).toBe(state.nodes[1].id)
  })

  it('branch：选项出口边带 type=branch，胶囊文案取自分支选项（同源）', () => {
    const { state, ops } = mkOps([branchNode('b1'), sceneNode('s1')])
    const { forward } = simulateBatch(
      [{ op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch', optionIndex: 1 }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.edges[0]).toMatchObject({
      sourceHandle: 'option-o-r',
      type: 'branch',
      data: { optionLabel: '右' },
    })
  })

  it('branch 未给 optionIndex 时默认 0；非分支源节点回退空文案', () => {
    const { state, ops } = mkOps([branchNode('b1'), sceneNode('s1'), sceneNode('s2')])
    const { forward } = simulateBatch(
      [
        { op: 'connect_edge', sourceId: 'b1', targetId: 's1', edgeKind: 'branch' },
        { op: 'connect_edge', sourceId: 's2', targetId: 's1', edgeKind: 'branch', optionIndex: 0 },
      ],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.edges[0]).toMatchObject({ sourceHandle: 'option-o-l', data: { optionLabel: '左' } })
    expect(state.edges[1]).toMatchObject({ data: { optionLabel: '' } })
  })

  it('undo 移除已建边', () => {
    const { state, ops } = mkOps([sceneNode('s1'), sceneNode('s2')])
    const { forward, backward } = simulateBatch(
      [{ op: 'connect_edge', sourceId: 's1', targetId: 's2' }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    backward.forEach((f) => f())
    expect(state.edges).toEqual([])
  })
})

describe('simulateBatch · disconnect_edge', () => {
  it('forward 拆除匹配边；backward 重加；无匹配边时不产生闭包', () => {
    const edges: Edge[] = [{ id: 'e1', source: 's1', target: 's2', className: 'pw-edge-sequence' }]
    const { state, ops } = mkOps([sceneNode('s1'), sceneNode('s2')], edges)

    const miss = simulateBatch(
      [{ op: 'disconnect_edge', sourceId: 's2', targetId: 's1' }],
      ops,
      state.nodes,
      state.edges,
    )
    expect(miss.forward).toHaveLength(0)

    const { forward, backward } = simulateBatch(
      [{ op: 'disconnect_edge', sourceId: 's1', targetId: 's2' }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    expect(state.edges).toEqual([])
    backward.forEach((f) => f())
    expect(state.edges.map((e) => e.id)).toEqual(['e1'])
  })
})

describe('simulateBatch · 混合批次', () => {
  it('backward 反序回放 = 整批回滚到初始态', () => {
    const { state, ops } = mkOps([sceneNode('s1'), branchNode('b1')])
    const batch: AiCommand[] = [
      { op: 'create_node', nodeType: 'scene', ref: 'ns', data: { name: '新场' } },
      { op: 'update_node', nodeId: 's1', patch: { synopsis: '改了' } },
      { op: 'connect_edge', sourceId: 's1', targetId: 'ns' },
      { op: 'delete_node', nodeId: 'b1' },
    ]
    const { forward, backward } = simulateBatch(batch, ops, state.nodes, state.edges)
    forward.forEach((f) => f())
    expect(state.nodes).toHaveLength(2)
    expect(state.edges).toHaveLength(1)
    expect(state.nodes[0].data.synopsis).toBe('改了')

    ;[...backward].reverse().forEach((f) => f())
    expect(state.nodes.map((n) => n.id)).toEqual(['s1', 'b1'])
    expect(state.nodes[0].data.synopsis).toBe('…')
    expect(state.edges).toEqual([])
  })
})
