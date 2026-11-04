/** #931：归集边界与冲突规则不依赖模型或界面。 */
import { expect, it } from 'vitest'
import { buildCanvasNode } from '../nodeFactory'
import { branchOptionHandle, SCENE_SHOT_HANDLE } from '../graphRules'
import { planEpisodeAssignments } from './episodeAssignment'
import { projectEpisodeGraph, episodeMembers } from './episodeAssignmentGraph'
import { validateAiBatch } from './batchFold'
import {
  toInboundCommands,
  type AiCommand,
  type BatchValidation,
} from './commands'
import type { CanvasNode } from '../nodes/types'
import type { Edge } from '@xyflow/react'

/** 合成节点使用生产工厂，只有稳定身份、名称和集号由场景指定。 */
function node(
  type: 'beat' | 'scene' | 'dialogue' | 'branch' | 'shot' | 'image',
  id: string,
  ep?: number,
): CanvasNode {
  const result = {
    ...buildCanvasNode(type, undefined, {
      against: [],
      characters: [],
      center: null,
    }),
    id,
  }
  return {
    ...result,
    data: {
      ...result.data,
      name: id,
      ...(ep === undefined ? {} : { episodeNo: ep }),
    },
  } as CanvasNode
}

/** 通过真实批次信任边界后才构建关联计划。 */
function plan(nodes: CanvasNode[], edges: Edge[], batch: AiCommand[]) {
  const v = validateAiBatch(batch, {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.id,
      ...(n.type === 'branch' ? { options: n.data.options } : {}),
    })),
    edges,
    assets: new Map(),
  })
  expect(v.ok, JSON.stringify(v.issues)).toBe(true)
  return planEpisodeAssignments(v, nodes, edges)
}

const assign: AiCommand = {
  op: 'update_node',
  nodeId: 'b',
  patch: { episodeNo: 2 },
}

it('沿出向剧情边到下一节拍停止，attach/反向/悬空/环和重复路径均不扩张归属', () => {
  const nodes = [
    node('beat', 'b'),
    node('scene', 's'),
    node('dialogue', 'd'),
    node('beat', 'next'),
    node('scene', 'after'),
    node('scene', 'before'),
    node('shot', 'shot'),
    node('image', 'image'),
  ]
  const pairs = [
    ['b', 's'],
    ['s', 'd'],
    ['d', 's'],
    ['d', 'next'],
    ['next', 'after'],
    ['before', 'b'],
    ['s', 'missing'],
    ['s', 'image'],
    ['s', 'd'],
  ]
  const edges: Edge[] = pairs.map(([source, target], i) => ({
    id: String(i),
    source: source!,
    target: target!,
  }))
  edges.push({
    id: 'attach',
    source: 's',
    target: 'shot',
    sourceHandle: SCENE_SHOT_HANDLE,
  })
  const graph = projectEpisodeGraph([], nodes, edges)
  expect([...episodeMembers(graph, 'b')].sort()).toEqual(['d', 's'])
})

it('当前同组且没有其他集关联时，已有归属随节拍改集', () => {
  const result = plan(
    [node('beat', 'b', 1), node('scene', 's', 1)],
    [{ id: 'bs', source: 'b', target: 's' }],
    [assign],
  )
  expect(result.validation.episodeAssignment?.conflicts).toEqual([])
  expect(toInboundCommands(result.commands)).toContainEqual({
    op: 'update_node',
    nodeId: 's',
    patch: { episodeNo: 2 },
  })
})

it('不参与批次的其他集节拍也参与共享判定，歧义保留未分集节点', () => {
  const result = plan(
    [node('beat', 'b'), node('beat', 'other', 3), node('scene', 's')],
    [
      { id: 'bs', source: 'b', target: 's' },
      { id: 'os', source: 'other', target: 's' },
    ],
    [assign],
  )
  expect(result.validation.episodeAssignment?.conflicts).toHaveLength(1)
  expect(result.commands).toHaveLength(1)
  expect(result.validation.items.map((item) => item.label).join()).toContain(
    '未分集 → 未分集（保留）',
  )
})

it('共享节点已明确指定单一目标时，保留该提案但仍要求冲突确认', () => {
  const result = plan(
    [node('beat', 'b'), node('beat', 'other', 3), node('scene', 's', 4)],
    [
      { id: 'bs', source: 'b', target: 's' },
      { id: 'os', source: 'other', target: 's' },
    ],
    [assign, { op: 'update_node', nodeId: 's', patch: { episodeNo: 2 } }],
  )
  expect(result.commands).toHaveLength(2)
  expect(result.validation.episodeAssignment?.conflicts.join()).toContain(
    '第 4 集 → 第 2 集',
  )
})

it('同集多节拍共享只归集一次，多次写节拍以批次最终集号为准', () => {
  const result = plan(
    [node('beat', 'b'), node('beat', 'other', 2), node('scene', 's')],
    [
      { id: 'bs', source: 'b', target: 's' },
      { id: 'os', source: 'other', target: 's' },
    ],
    [{ op: 'update_node', nodeId: 'b', patch: { episodeNo: 1 } }, assign],
  )
  expect(result.validation.episodeAssignment?.conflicts).toEqual([])
  expect(
    toInboundCommands(result.commands).filter(
      (cmd) => cmd.op === 'update_node' && cmd.nodeId === 's',
    ),
  ).toEqual([{ op: 'update_node', nodeId: 's', patch: { episodeNo: 2 } }])
})

it('投影先断开旧边、连入新建节点、删除原节点，临时 id 不进入执行命令', () => {
  const result = plan(
    [node('beat', 'b'), node('scene', 'old')],
    [{ id: 'old', source: 'b', target: 'old' }],
    [
      assign,
      { op: 'disconnect_edge', sourceId: 'b', targetId: 'old' },
      {
        op: 'create_node',
        nodeType: 'scene',
        ref: 'new',
        data: { name: '新场' },
      },
      { op: 'connect_edge', sourceId: 'b', targetId: 'new' },
      { op: 'delete_node', nodeId: 'old' },
    ],
  )
  expect(toInboundCommands(result.commands)[2]).toMatchObject({
    op: 'create_node',
    data: { episodeNo: 2 },
  })
  expect(result.commands).toHaveLength(5)
  expect(JSON.stringify(result.commands)).not.toContain('__episode_create')
})

it('新建分支连接后再删出口选项，不归集已经被级联断开的目标', () => {
  const result = plan(
    [node('beat', 'b'), node('scene', 's')],
    [],
    [
      assign,
      {
        op: 'create_node',
        nodeType: 'branch',
        ref: 'r',
        data: { prompt: '选择', options: [{ id: 'go', label: '继续' }] },
      },
      { op: 'connect_edge', sourceId: 'b', targetId: 'r' },
      {
        op: 'connect_edge',
        sourceId: 'r',
        targetId: 's',
        edgeKind: 'branch',
        optionIndex: 0,
      },
      { op: 'update_node', nodeId: 'r', patch: { options: [] } },
    ],
  )
  expect(
    toInboundCommands(result.commands).some(
      (cmd) => cmd.op === 'update_node' && cmd.nodeId === 's',
    ),
  ).toBe(false)
})

it('既有分支删选项同样按稳定选项句柄撤去关联', () => {
  const branch = node('branch', 'r')
  if (branch.type !== 'branch') throw new Error('fixture')
  const edges = [
    { id: 'br', source: 'b', target: 'r' },
    {
      id: 'rs',
      source: 'r',
      target: 's',
      type: 'branch',
      sourceHandle: branchOptionHandle(branch.data.options[0]!.id),
    },
  ]
  const result = plan([node('beat', 'b'), branch, node('scene', 's')], edges, [
    assign,
    { op: 'update_node', nodeId: 'r', patch: { options: [] } },
  ])
  expect(
    toInboundCommands(result.commands).some(
      (cmd) => cmd.op === 'update_node' && cmd.nodeId === 's',
    ),
  ).toBe(false)
})

it('无合法分集根时不额外写入，非法批次原子性不被计划器改变', () => {
  const v: BatchValidation = {
    ok: false,
    items: [],
    commands: [],
    issues: [{ index: -1, message: '拒绝' }],
    hasDeletes: false,
  }
  expect(planEpisodeAssignments(v, [], []).validation).toBe(v)
  expect(
    plan(
      [node('beat', 'b')],
      [],
      [{ op: 'update_node', nodeId: 'b', patch: { name: '改名' } }],
    ).validation.episodeAssignment,
  ).toBeUndefined()
})

it.each([
  [undefined, 9, 2, 9],
  [1, 1, 2, 3],
] as const)(
  '显式关联节点集号不能消除与节拍目标的冲突：%j',
  (beatBefore, sceneBefore, beatTarget, sceneTarget) => {
    const result = plan(
      [node('beat', 'b', beatBefore), node('scene', 's', sceneBefore)],
      [{ id: 'bs', source: 'b', target: 's' }],
      [
        { op: 'update_node', nodeId: 'b', patch: { episodeNo: beatTarget } },
        { op: 'update_node', nodeId: 's', patch: { episodeNo: sceneTarget } },
      ],
    )
    expect(result.validation.episodeAssignment?.conflicts).toHaveLength(1)
  },
)

it.each([false, true])(
  '其他集叙事节点的入向关联也提示冲突，不要求它先被节拍覆盖，间接=%s',
  (indirect) => {
    const nodes = [
      node('beat', 'b', 1),
      node('scene', 's', 1),
      node('scene', 'x', 3),
    ]
    const edges = [{ id: 'bs', source: 'b', target: 's' }]
    if (indirect) {
      nodes.push(node('dialogue', 'u'))
      edges.push(
        { id: 'xu', source: 'x', target: 'u' },
        { id: 'us', source: 'u', target: 's' },
      )
    } else edges.push({ id: 'xs', source: 'x', target: 's' })
    const result = plan(nodes, edges, [assign])
    expect(result.validation.episodeAssignment?.conflicts.join()).toContain(
      '第 3 集',
    )
    expect(
      toInboundCommands(result.commands).some(
        (cmd) =>
          cmd.op === 'update_node' && ['s', 'x', 'u'].includes(cmd.nodeId),
      ),
    ).toBe(false)
  },
)

it('本批断开其他集入向路径后可自动归集，正常的下一节拍边界不误报', () => {
  const nodes = [
    node('beat', 'b', 1),
    node('scene', 's', 1),
    node('scene', 'x', 3),
    node('beat', 'next', 3),
  ]
  const edges = [
    { id: 'bs', source: 'b', target: 's' },
    { id: 'xs', source: 'x', target: 's' },
    { id: 'boundary', source: 's', target: 'next' },
  ]
  const result = plan(nodes, edges, [
    assign,
    { op: 'disconnect_edge', sourceId: 'x', targetId: 's' },
  ])
  expect(result.validation.episodeAssignment?.conflicts).toEqual([])
  expect(toInboundCommands(result.commands)).toContainEqual({
    op: 'update_node',
    nodeId: 's',
    patch: { episodeNo: 2 },
  })
})
