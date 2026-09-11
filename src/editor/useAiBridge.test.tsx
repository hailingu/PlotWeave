// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import { nodeLabelOf, useAiBridge, type AiBridgeDeps } from './useAiBridge'
import type { AiCommand, ValidatedCommand } from './ai/commands'
import type { HistoryCommand } from './history'
import { EMPTY_SETTINGS, type ProjectSettings } from './settings'
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

/** 可变画布/设定集状态 + AI 桥依赖（模拟 EditorView 注入）。 */
function setup(
  initialNodes: CanvasNode[] = [sceneNode('s1')],
  initialEdges: Edge[] = [],
  initialSettings: ProjectSettings = EMPTY_SETTINGS,
) {
  const state = { nodes: [...initialNodes], edges: [...initialEdges], settings: initialSettings, aiRevision: 0 }
  const commands: HistoryCommand[] = []
  const closeSettings = vi.fn()
  const deps: AiBridgeDeps = {
    nodes: state.nodes,
    edges: state.edges,
    settings: state.settings,
    nodesRef: { current: state.nodes },
    edgesRef: { current: state.edges },
    settingsRef: { current: state.settings },
    assetsRef: {
      current: {
        byId: {
          'a-img': { id: 'a-img', relPath: 'assets/a-img.png', mime: 'image/png', source: 'upload', createdAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    },
    buildNewNode: (type, opts) =>
      ({
        id: `ai-${type}-${state.nodes.length}`,
        type,
        position: { x: 0, y: 0 },
        data: { ...(opts?.data ?? {}) },
      }) as CanvasNode,
    applyDataPatch: (id, cmd) => {
      state.nodes = state.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...cmd.patch } } as CanvasNode) : n,
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
    setSettings: (up) => {
      state.settings = up(state.settings)
      deps.settingsRef.current = state.settings
    },
    setAiRevision: (up) => {
      state.aiRevision = up(state.aiRevision)
    },
    pushHistory: (cmd) => commands.push(cmd),
    closeSettings,
  }
  const { result } = renderHook(() => useAiBridge(deps))
  return { result, state, commands, closeSettings, deps }
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

  it('快照携带资产索引：shot refs 的 assetId 按项目资产校验存在性与用途', () => {
    const { result } = setup()
    const good = result.current.validateCommands([
      {
        op: 'create_node',
        nodeType: 'shot',
        data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [{ kind: 'character', assetId: 'a-img' }] },
      },
    ])
    expect(good?.ok).toBe(true)
    const ghost = result.current.validateCommands([
      {
        op: 'create_node',
        nodeType: 'shot',
        data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [{ kind: 'audio', assetId: 'a-img' }] },
      },
    ])
    expect(ghost?.ok).toBe(false)
    expect(ghost?.issues[0].message).toContain('用途不匹配')
  })

  it('readNode：存在返回 JSON 片段；不存在返回 null', () => {
    const { result } = setup()
    const json = result.current.readNode('s1')
    expect(json).toContain('"id":"s1"')
    expect(json).toContain('"sceneNo":1')
    expect(result.current.readNode('ghost')).toBeNull()
  })

  it('applyAiBatch：合法批次整批落地为一条复合命令，undo 一步回滚', () => {
    const { result, state, commands, closeSettings } = setup([sceneNode('s1'), branchNode('b1')])
    const batch: ValidatedCommand[] = [
      { op: 'create_node', nodeType: 'scene', ref: 'ns', data: { name: '新场' } },
      { op: 'connect_edge', sourceId: 's1', targetId: 'ns' },
      { op: 'update_node', nodeId: 'b1', patch: { nodeType: 'branch', patch: { prompt: '走哪边？' } } },
    ]
    expect(result.current.applyAiBatch(batch)).toBeNull()
    expect(state.nodes).toHaveLength(3)
    expect(state.edges).toHaveLength(1)
    // 提交身份（§12.2）：成功落地一批即自增一次
    expect(state.aiRevision).toBe(1)
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
    // 撤销不回退提交身份：它是提交计数，不是可撤销的文档内容
    expect(state.aiRevision).toBe(1)
  })
})

describe('useAiBridge · applyAiBatch 执行边界', () => {
  it('applyAiBatch：空批次直接 null；非法批次返回错误文案且不改画布', () => {
    const { result, state, commands } = setup()
    expect(result.current.applyAiBatch([])).toBeNull()
    // 判别化执行通道在编译期已拒绝宽补丁；此处的敌意输入只能经 cast 伪造，
    // 用于锁定运行时重校验仍整批拒绝（纵深防御，issue 16）
    const hostile = { op: 'update_node', nodeId: 's1', patch: { hack: 1 } } as unknown as ValidatedCommand
    const err = result.current.applyAiBatch([hostile])
    expect(err).toContain('改动无法安全执行')
    expect(state.nodes).toHaveLength(1)
    expect(commands).toHaveLength(0)
    // 未落地的批次不消耗提交身份
    expect(state.aiRevision).toBe(0)
  })

  it('applyAiBatch：恢复的待执行卡使用重校验后的规范化命令', () => {
    const { result, state } = setup()
    // 会话文件是本地 JSON；恢复层可遇到带空格的旧/损坏 nodeType。执行边界
    // 必须采用重校验产物，不能把原始载荷交给节点工厂。
    const restored = {
      op: 'create_node',
      nodeType: ' scene ',
      data: { name: '恢复场景' },
    } as unknown as ValidatedCommand

    expect(result.current.applyAiBatch([restored])).toBeNull()
    expect(state.nodes[state.nodes.length - 1]?.type).toBe('scene')
  })
})

describe('useAiBridge · 原型属性类型的入站与执行边界（issue 49）', () => {
  it('tool 与 JSON 围栏入口均返回可读类型问题，不抛异常', () => {
    const { result } = setup([sceneNode('s1'), sceneNode('s2')])
    const batch: AiCommand[] = [
      { op: 'create_node', nodeType: 'toString', data: { name: 'x' } },
      { op: 'connect_edge', sourceId: 's1', targetId: 's2', edgeKind: 'constructor' },
    ]
    const fenced = ['```json', JSON.stringify({ commands: batch }), '```'].join('\n')
    for (const validation of [result.current.validateCommands(batch), result.current.validateAiReply(fenced)]) {
      expect(validation?.ok).toBe(false)
      expect(validation?.commands).toEqual([])
      expect(validation?.issues).toEqual([
        { index: 0, message: expect.stringContaining('未知节点类型') },
        { index: 1, message: expect.stringContaining('未知连线类型') },
      ])
    }
  })

  it.each<ValidatedCommand>([
    { op: 'create_node', nodeType: 'toString', data: {} },
    { op: 'create_node', nodeType: '__proto__', data: { name: 'x' } },
    { op: 'connect_edge', sourceId: 's1', targetId: 's2', edgeKind: 'constructor' },
  ])('历史卡 $op 重校验拒绝非法类型，整批无写入且允许纠正重试', (invalid) => {
    const { result, state, commands } = setup([sceneNode('s1'), sceneNode('s2')])
    const before = structuredClone(state)
    const valid: ValidatedCommand = { op: 'create_node', nodeType: 'beat', data: { name: '新节拍' } }
    expect(result.current.applyAiBatch([valid, invalid])).toContain('改动无法安全执行')
    expect(state).toEqual(before)
    expect(commands).toHaveLength(0)

    expect(result.current.applyAiBatch([valid])).toBeNull()
    expect(state.nodes).toHaveLength(3)
    expect(state.nodes[2]).toMatchObject({ type: 'beat', data: { name: '新节拍' } })
    expect(state.aiRevision).toBe(1)
    expect(commands).toHaveLength(1)
    commands[0].undo()
    expect(state.nodes).toEqual(before.nodes)
    expect(state.edges).toEqual(before.edges)
    expect(state.settings).toEqual(before.settings)
  })
})

describe('useAiBridge · 实体校验与实体+绑定复合执行（issue 44）', () => {
  it('validateCommands：快照带设定集时校验实体存在性与引用类型', () => {
    const { result } = setup(
      [sceneNode('s1')],
      [],
      { characters: [{ id: 'ch-1', name: '陈默', gradient: 'g' }], locations: [] },
    )
    const ok = result.current.validateCommands([
      { op: 'update_node', nodeId: 's1', patch: { characterIds: ['ch-1'] } },
    ])
    expect(ok?.ok).toBe(true)

    const bad = result.current.validateCommands([
      { op: 'update_node', nodeId: 's1', patch: { characterIds: ['loc-404'] } },
    ])
    expect(bad?.ok).toBe(false)
    expect(bad?.issues[0].message).toContain('角色实体不存在')
  })

  it('applyAiBatch：新建实体 + 场景绑定为一条复合命令，undo/redo 同时恢复两侧', () => {
    const { result, state, commands } = setup([sceneNode('s1')])
    const batch: ValidatedCommand[] = [
      { op: 'upsert_character', ref: 'hero', fields: { name: '林一', bio: '侦探' } },
      {
        op: 'update_node',
        nodeId: 's1',
        patch: { nodeType: 'scene', patch: { characterIds: ['hero'] } },
      },
    ]
    expect(result.current.applyAiBatch(batch)).toBeNull()

    const hero = state.settings.characters.find((c) => c.name === '林一')!
    expect(hero.id).toMatch(/^ch-/)
    const s1 = state.nodes.find((n) => n.id === 's1')!
    expect(s1.type === 'scene' && s1.data.characterIds).toEqual([hero.id])

    commands[0].undo()
    expect(state.settings.characters).toEqual([])
    const s1r = state.nodes.find((n) => n.id === 's1')!
    expect(s1r.type === 'scene' && s1r.data.characterIds).toEqual([])

    commands[0].redo()
    expect(state.settings.characters[0]?.id).toBe(hero.id)
    const s1rr = state.nodes.find((n) => n.id === 's1')!
    expect(s1rr.type === 'scene' && s1rr.data.characterIds).toEqual([hero.id])
  })
})

describe('useAiBridge · 执行期重校验与读工具（issue 44）', () => {
  it('applyAiBatch：预览后实体被用户删除，执行重校验整体拒绝、无部分写入', () => {
    const { result, state, commands, deps } = setup(
      [sceneNode('s1')],
      [],
      { characters: [{ id: 'ch-1', name: '陈默', gradient: 'g' }], locations: [] },
    )
    const staleBatch = [
      { op: 'upsert_character', entityId: 'ch-1', fields: { bio: 'x' } },
    ] as ValidatedCommand[]
    // 预览后用户删除了该实体（经真实 setSettings 通道，settingsRef 同步变化）
    deps.setSettings(() => ({ characters: [], locations: [] }))
    expect(result.current.applyAiBatch(staleBatch)).toContain('无法安全执行')
    expect(commands).toHaveLength(0)
    expect(state.settings.characters).toEqual([])
  })

  it('applyAiBatch：修改实体只写 bio 时 name 保持不变（归一化不注入空名）', () => {
    const { result, state } = setup([sceneNode('s1')], [], {
      characters: [{ id: 'ch-1', name: '陈默', gradient: 'g', bio: '旧' }],
      locations: [],
    })
    // 走真实链路：validateCommands 折叠产出的执行命令（非手工构造）再落地
    const preview = result.current.validateCommands([
      { op: 'upsert_character', entityId: 'ch-1', fields: { bio: '新小传' } },
    ])
    expect(preview?.ok).toBe(true)
    expect(result.current.applyAiBatch(preview!.commands)).toBeNull()
    const ch = state.settings.characters[0]
    expect(ch.name).toBe('陈默')
    expect(ch.bio).toBe('新小传')
  })

  it('readSettings：返回设定集 JSON 摘要（读工具回喂用）', () => {
    const { result } = setup([], [], {
      characters: [{ id: 'ch-1', name: '陈默', gradient: 'g', bio: '侦探' }],
      locations: [],
    })
    const text = result.current.readSettings()
    const parsed = JSON.parse(text) as { characters: Array<{ id: string; name: string; bio?: string }> }
    expect(parsed.characters[0]).toEqual({ id: 'ch-1', name: '陈默', bio: '侦探' })
  })
})
