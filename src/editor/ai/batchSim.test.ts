import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { simulateBatch, type BatchOps } from './batchSim'
import type { ValidatedCommand } from './commands'
import { mergeNodeData } from '../nodes/patch'
import type { CanvasNode, SceneFlowNode, BranchFlowNode } from '../nodes/types'
import { EMPTY_SETTINGS, type ProjectSettings } from '../settings'

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

function dialogueNode(id: string): CanvasNode {
  return {
    id,
    type: 'dialogue',
    position: { x: 0, y: 0 },
    data: { name: '对质', lines: [{ id: 'line-1', kind: 'line', speaker: 'ch-1', text: '你来了。' }] },
  } as CanvasNode
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
function mkOps(initialNodes: CanvasNode[], initialEdges: Edge[] = [], initialSettings: ProjectSettings = EMPTY_SETTINGS) {
  const state = {
    nodes: [...initialNodes],
    edges: [...initialEdges],
    settings: initialSettings,
  }
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
    applyDataPatch: (id, cmd) => {
      state.nodes = state.nodes.map((n) => (n.id === id ? mergeNodeData(n, cmd.patch) : n))
    },
    setNodes: (up) => {
      state.nodes = up(state.nodes)
    },
    setEdges: (up) => {
      state.edges = up(state.edges)
    },
    setSettings: (up) => {
      state.settings = up(state.settings)
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
        { op: 'update_node', nodeId: 'new-scene', patch: { nodeType: 'scene', patch: { synopsis: '改写' } } },
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
      [{ op: 'update_node', nodeId: 's1', patch: { nodeType: 'scene', patch: { name: '改名', interior: false } } }],
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
      [{ op: 'update_node', nodeId: 'ghost', patch: { nodeType: 'scene', patch: { name: 'x' } } }],
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

  it('branch：选项出口边带 type=branch；胶囊文案由 BranchEdge 实时派生，不落 data 镜像', () => {
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
    })
    expect(state.edges[0].data).toBeUndefined()
  })

  it('branch 未给 optionIndex 时默认 0；非分支源节点回退首选项端口', () => {
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
    expect(state.edges[0]).toMatchObject({ sourceHandle: 'option-o-l', type: 'branch' })
    expect(state.edges[0].data).toBeUndefined()
    // 非分支源：端口回退下标句柄，仍不落镜像
    expect(state.edges[1]).toMatchObject({ sourceHandle: 'option-0', type: 'branch' })
    expect(state.edges[1].data).toBeUndefined()
  })

  it('update_node 替换分支选项删掉已连线选项：连带删边，undo 一并恢复（§8.2.2）', () => {
    const { state, ops } = mkOps([branchNode('b1'), sceneNode('s1')], [
      {
        id: 'e1',
        source: 'b1',
        sourceHandle: 'option-o-l',
        target: 's1',
        type: 'branch',
        data: { optionLabel: '左' },
      },
    ])
    const { forward, backward } = simulateBatch(
      [{ op: 'update_node', nodeId: 'b1', patch: { nodeType: 'branch', patch: { options: [{ id: 'o-r', label: '右' }] } } }],
      ops,
      state.nodes,
      state.edges,
    )
    forward.forEach((f) => f())
    // 被删选项的出口边级联移除，不留悬空连线
    expect(state.edges).toHaveLength(0)
    expect(state.nodes[0].data.options).toEqual([{ id: 'o-r', label: '右' }])
    backward.forEach((b) => b())
    expect(state.edges).toHaveLength(1)
    expect(state.nodes[0].data.options).toEqual([
      { id: 'o-l', label: '左' },
      { id: 'o-r', label: '右' },
    ])
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
    const batch: ValidatedCommand[] = [
      { op: 'create_node', nodeType: 'scene', ref: 'ns', data: { name: '新场' } },
      { op: 'update_node', nodeId: 's1', patch: { nodeType: 'scene', patch: { synopsis: '改了' } } },
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

describe('simulateBatch · 设定实体命令（issue 44：实体 + 绑定复合执行）', () => {
  it('新建角色/地点并按 ref 绑定场景与对白：落地真实 id，无临时 ref 残留；undo 整体回滚', () => {
    const ch = { id: 'ch-keep', name: '陈默', gradient: 'g0' }
    const { state, ops } = mkOps(
      [sceneNode('s1'), dialogueNode('d1')],
      [],
      { characters: [ch], locations: [] },
    )
    const batch: ValidatedCommand[] = [
      { op: 'upsert_character', ref: 'hero', fields: { name: '林一', bio: '侦探' } } as ValidatedCommand,
      { op: 'upsert_location', ref: 'home', fields: { name: '公寓' } } as ValidatedCommand,
      {
        op: 'update_node',
        nodeId: 's1',
        patch: { nodeType: 'scene', patch: { characterIds: ['hero', 'ch-keep'], locationId: 'home' } },
      },
      {
        op: 'update_node',
        nodeId: 'd1',
        patch: {
          nodeType: 'dialogue',
          patch: { lines: [{ id: 'line-1', kind: 'line', speaker: 'hero', text: '你来了。' }] },
        },
      },
    ]
    const { forward, backward } = simulateBatch(batch, ops, state.nodes, state.edges, state.settings)
    forward.forEach((f) => f())

    // 实体以应用分配的真实 id 落地（ch-/loc- 前缀），绑定处已解析、无 ref 残留
    expect(state.settings.characters).toHaveLength(2)
    const hero = state.settings.characters.find((c) => c.name === '林一')!
    expect(hero.id).toMatch(/^ch-/)
    expect(hero.bio).toBe('侦探')
    expect(state.settings.locations[0].id).toMatch(/^loc-/)
    expect(state.settings.locations[0].name).toBe('公寓')
    const s1 = state.nodes.find((n) => n.id === 's1')!
    expect(s1.type === 'scene' && s1.data.characterIds).toEqual([hero.id, 'ch-keep'])
    expect(s1.type === 'scene' && s1.data.locationId).toBe(state.settings.locations[0].id)
    const d1 = state.nodes.find((n) => n.id === 'd1')!
    expect(d1.type === 'dialogue' && d1.data.lines[0].speaker).toBe(hero.id)

    ;[...backward].reverse().forEach((f) => f())
    expect(state.settings.characters).toEqual([ch])
    expect(state.settings.locations).toEqual([])
    const s1r = state.nodes.find((n) => n.id === 's1')!
    expect(s1r.type === 'scene' && s1r.data.characterIds).toEqual([])
    const d1r = state.nodes.find((n) => n.id === 'd1')!
    expect(d1r.type === 'dialogue' && d1r.data.lines[0].speaker).toBe('ch-1')

    // redo 复用同一实体对象：撤销-重做往返不改变实体 id
    forward.forEach((f) => f())
    expect(state.settings.characters.find((c) => c.name === '林一')?.id).toBe(hero.id)
  })

  it('修改既有实体只覆盖写到的字段；undo 恢复原值；props/documents 透传保真', () => {
    const ch = { id: 'ch-1', name: '陈默', gradient: 'g1', bio: '旧小传' }
    const loc = { id: 'loc-1', name: '茶馆', note: '老城区' }
    const props = [{ id: 'prop-1', name: '怀表' }]
    const documents = [{ id: 'doc-1', title: '小传', body: '……', relatedIds: [] }]
    const { state, ops } = mkOps(
      [],
      [],
      { characters: [ch], locations: [loc], props, documents },
    )
    const batch: ValidatedCommand[] = [
      { op: 'upsert_character', entityId: 'ch-1', fields: { bio: '新小传' } } as ValidatedCommand,
      { op: 'upsert_location', entityId: 'loc-1', fields: { note: '拆迁前' } } as ValidatedCommand,
    ]
    const { forward, backward } = simulateBatch(batch, ops, state.nodes, state.edges, state.settings)
    forward.forEach((f) => f())
    const chAfter = state.settings.characters[0]
    expect(chAfter.id).toBe('ch-1')
    expect(chAfter.name).toBe('陈默')
    expect(chAfter.gradient).toBe('g1')
    expect(chAfter.bio).toBe('新小传')
    expect(state.settings.locations[0].note).toBe('拆迁前')
    // 未参与编辑的透传桶原样保真
    expect(state.settings.props).toEqual(props)
    expect(state.settings.documents).toEqual(documents)

    backward.forEach((f) => f())
    expect(state.settings.characters[0]).toEqual(ch)
    expect(state.settings.locations[0]).toEqual(loc)
  })

  it('同批先建后改（entityId 用 ref）：第二次修改不覆盖第一次的结果', () => {
    const { state, ops } = mkOps([], [])
    const batch: ValidatedCommand[] = [
      { op: 'upsert_character', ref: 'hero', fields: { name: '林一' } } as ValidatedCommand,
      { op: 'upsert_character', entityId: 'hero', fields: { bio: '侦探' } } as ValidatedCommand,
    ]
    const { forward, backward } = simulateBatch(batch, ops, state.nodes, state.edges, state.settings)
    forward.forEach((f) => f())
    const hero = state.settings.characters[0]
    expect(hero.name).toBe('林一')
    expect(hero.bio).toBe('侦探')

    backward.forEach((f) => f())
    expect(state.settings.characters).toEqual([])
  })

  it('update 挂 ref 别名既有实体后，绑定命令经别名解析', () => {
    const ch = { id: 'ch-1', name: '陈默', gradient: 'g1' }
    const { state, ops } = mkOps([sceneNode('s1')], [], { characters: [ch], locations: [] })
    const batch: ValidatedCommand[] = [
      { op: 'upsert_character', entityId: 'ch-1', ref: 'hero', fields: { bio: '补' } } as ValidatedCommand,
      { op: 'update_node', nodeId: 's1', patch: { nodeType: 'scene', patch: { characterIds: ['hero'] } } },
    ]
    const { forward } = simulateBatch(batch, ops, state.nodes, state.edges, state.settings)
    forward.forEach((f) => f())
    const s1 = state.nodes[0]
    expect(s1.type === 'scene' && s1.data.characterIds).toEqual(['ch-1'])
  })
})
