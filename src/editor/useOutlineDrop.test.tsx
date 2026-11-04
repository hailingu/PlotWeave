// @vitest-environment happy-dom
/**
 * 大纲拖拽落点 hook 测试（issue #235）：真实文档状态 + 补丁写通道 +
 * 真实 CommandStack 的集成 harness（与 useEditorGraphActions 生产装配
 * 同构，撤销经栈的 LIFO 行使）。断言拖放后的完整图状态与历史操作结果：
 * 同集重排（缝合缺口）、跨集与未分集移动的 episodeNo 补丁、非编剧
 * 四类/不存在节点拒绝、无变化不入栈，以及边手术 + episodeNo 单命令
 * 一步 undo/redo——不以 mock 被调用代替图状态证据。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import {
  useEditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useNodePatch } from './useNodePatch'
import { useOutlineDrop } from './useOutlineDrop'
import { CommandStack, type HistoryCommand } from './history'
import { parseProject, serializeProject } from '../model/convert'
import type {
  BranchFlowNode,
  CanvasNode,
  ImageFlowNode,
  SceneFlowNode,
  ShotFlowNode,
} from './nodes/types'

/** 分支仅有选项 source 句柄，不能作为 sequence source。 */
const branchNode = (id: string, episodeNo = 1): BranchFlowNode => ({
  id,
  type: 'branch',
  position: { x: 500, y: 0 },
  data: {
    prompt: '选择？',
    options: [{ id: 'yes', label: '继续' }],
    episodeNo,
  },
})

function sceneNode(
  id: string,
  episodeNo: number | undefined,
  x: number,
): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '夜',
      synopsis: '…',
      characterIds: [],
      ...(episodeNo !== undefined ? { episodeNo } : {}),
    },
  }
}

function looseShotNode(id: string): ShotFlowNode {
  return {
    id,
    type: 'shot',
    position: { x: 0, y: 0 },
    data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [] },
  }
}

function looseImageNode(id: string): ImageFlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: { prompt: '', model: '', size: '1:1', outputs: {} },
  }
}

const seq = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  className: 'pw-edge-sequence',
})

/** 与 useEditorGraphActions 生产装配同构的集成 harness：真实文档状态、
 * 真实 applyDataPatch 写通道（纯状态写入），命令栈与拒绝提示通道以 spy
 * 记录。 */
function setup(nodes: CanvasNode[], edges: Edge[]) {
  const project: EditorProjectContent = {
    id: 'p1',
    name: '测试项目',
    nodes,
    edges,
    settings: { characters: [], locations: [] },
  }
  // 真实命令栈行使 LIFO 撤销（一步撤销在其持有边界验证），spy 记录入栈
  // 计数供拒绝/单命令断言
  const stack = new CommandStack()
  const pushHistory = vi.fn((cmd: HistoryCommand) => stack.push(cmd))
  const onError = vi.fn()
  const { result } = renderHook(() => {
    const doc = useEditorDocument(project)
    const patch = useNodePatch(doc, pushHistory)
    const outlineDrop = useOutlineDrop({
      nodesRef: doc.nodesRef,
      edgesRef: doc.edgesRef,
      episodeTitlesRef: doc.episodeTitlesRef,
      applyDataPatch: patch.applyDataPatch,
      setEdges: doc.setEdges,
      pushHistory,
      onError,
    })
    return { doc, outlineDrop }
  })
  return { result, stack, pushHistory, onError }
}

type Harness = ReturnType<typeof setup>

/** sequence 边的 source→target 对（新增边 id 含时间戳，断言用端点对）。 */
const seqPairs = (h: Harness) =>
  h.result.current.doc.edges.map((e) => `${e.source}->${e.target}`)

const episodeNoOf = (h: Harness, id: string) =>
  (
    h.result.current.doc.nodes.find((n) => n.id === id)?.data as {
      episodeNo?: number
    }
  )?.episodeNo

/** 行落点调用（单行形）：anchor 为锚点行，position 为相对锚点位置。 */
const dropRow = (
  h: Harness,
  dragged: string,
  anchor: string,
  position: 'before' | 'after',
) =>
  h.result.current.outlineDrop(dragged, {
    kind: 'row',
    anchorId: anchor,
    position,
  })

it('分支 after 落点拒绝且保存重开完整保留原图（#903）', () => {
  const nodes = [
    ...['p', 'x', 'n', 'a'].map((id, i) => sceneNode(id, 1, i * 100)),
    branchNode('br'),
  ]
  const edges = [seq('px', 'p', 'x'), seq('xn', 'x', 'n'), seq('ab', 'a', 'br')]
  const h = setup(nodes, edges)
  act(() => dropRow(h, 'x', 'br', 'after'))
  expect(h.result.current.doc.edges).toEqual(edges)
  expect(h.result.current.doc.nodes).toEqual(nodes)
  expect(h.pushHistory).not.toHaveBeenCalled()
  expect(h.onError).toHaveBeenCalledTimes(1)
  const saved = serializeProject(
    {
      name: '回归',
      nodes: h.result.current.doc.nodes,
      edges: h.result.current.doc.edges,
      settings: { characters: [], locations: [] },
    },
    'p1',
  )
  const reopened = parseProject(JSON.parse(JSON.stringify(saved)))
  expect(reopened.warnings).toEqual([])
  expect(reopened.content.edges.map((e) => [e.source, e.target])).toEqual(
    edges.map((e) => [e.source, e.target]),
  )
})

it('分支 before 合法，分支组尾回退合法锚点（#903）', () => {
  const nodes = [sceneNode('a', 1, 0), branchNode('br'), sceneNode('x', 2, 100)]
  const edges = [seq('ab', 'a', 'br')]
  for (const target of [
    { kind: 'row', anchorId: 'br', position: 'before' },
    { kind: 'groupEnd', episode: 1 },
  ] as const) {
    const h = setup(nodes, edges)
    act(() => h.result.current.outlineDrop('x', target))
    expect(seqPairs(h).sort()).toEqual(['a->x', 'x->br'])
    expect(h.onError).not.toHaveBeenCalled()
    act(() => h.stack.undo())
    expect(h.result.current.doc.edges).toEqual(edges)
    expect(episodeNoOf(h, 'x')).toBe(2)
  }
})

it('拖动分支不能创建 sequence source（#903）', () => {
  const h = setup(
    [sceneNode('a', 1, 0), sceneNode('b', 1, 100), branchNode('br')],
    [seq('ab', 'a', 'b')],
  )
  act(() => dropRow(h, 'br', 'b', 'before'))
  expect(seqPairs(h)).toEqual(['a->b'])
  expect(h.onError).toHaveBeenCalledTimes(1)
  expect(h.pushHistory).not.toHaveBeenCalled()
})

it.each([[['x']], [['x', 'y']]])(
  '全游离同组 %j 组尾静默无操作（#904）',
  (ids) => {
    const nodes = ids.map((id, i) => sceneNode(id, 2, i * 100))
    const h = setup(nodes, [])
    act(() =>
      h.result.current.outlineDrop('x', { kind: 'groupEnd', episode: 2 }),
    )
    expect(h.result.current.doc.nodes).toEqual(nodes)
    expect(h.result.current.doc.edges).toEqual([])
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.pushHistory).not.toHaveBeenCalled()
  },
)

it('跨集无锚点仍可见拒绝（#904）', () => {
  const h = setup([sceneNode('x', 1, 0), sceneNode('y', 2, 100)], [])
  act(() => h.result.current.outlineDrop('x', { kind: 'groupEnd', episode: 2 }))
  expect(episodeNoOf(h, 'x')).toBe(1)
  expect(h.onError).toHaveBeenCalledTimes(1)
  expect(h.pushHistory).not.toHaveBeenCalled()
})

describe('useOutlineDrop（§3.5 同集重排与拒绝路径）', () => {
  it('同集后移：缝合缺口重排 sequence 边，episodeNo 不动，单命令 undo/redo', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('s3', 1, 200)],
      [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')],
    )
    act(() => dropRow(h, 's2', 's3', 'after'))
    // s1→s2→s3 后移 s2 到组尾：缝合 s1→s3，接回 s3→s2
    expect(seqPairs(h)).toEqual(['s1->s3', 's3->s2'])
    expect(episodeNoOf(h, 's2')).toBe(1)
    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    const moved = h.result.current.doc.edges.find((e) => e.source === 's3')
    expect(moved?.className).toBe('pw-edge-sequence')

    act(() => h.stack.undo())
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->s3'])
    act(() => h.stack.redo())
    expect(seqPairs(h)).toEqual(['s1->s3', 's3->s2'])
  })

  it('拒绝分镜卡与图片节点：不入栈不写状态', () => {
    const h = setup(
      [
        sceneNode('s1', 1, 0),
        sceneNode('s2', 1, 100),
        looseShotNode('sh1'),
        looseImageNode('img1'),
      ],
      [seq('e1', 's1', 's2')],
    )
    // 锚点在真实无环剧情流中：若类型守卫失效，游离节点会被真实接入
    // （s1→sh1→s2）改写图——拒绝语义由本用例独立拥有，不被环检测代劳
    act(() => dropRow(h, 'sh1', 's1', 'after'))
    act(() => dropRow(h, 'img1', 's1', 'after'))
    expect(h.result.current.doc.nodes.map((n) => n.id)).toEqual([
      's1',
      's2',
      'sh1',
      'img1',
    ])
    expect(seqPairs(h)).toEqual(['s1->s2'])
    expect(h.pushHistory).not.toHaveBeenCalled()
  })
})

describe('useOutlineDrop（拒绝与历史不变量：不存在的节点 id）', () => {
  it('不存在的节点 id：不入栈不写状态', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100)],
      [seq('e1', 's1', 's2')],
    )
    // 锚点在真实剧情流中：若缺失守卫失效，幽灵 id 会经计划真实改写图
    act(() => dropRow(h, 'ghost', 's1', 'after'))
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.result.current.doc.nodes.map((n) => n.id)).toEqual(['s1', 's2'])
    expect(seqPairs(h)).toEqual(['s1->s2'])
  })
})

describe('useOutlineDrop（拒绝与历史不变量：原位重放）', () => {
  it('原位重放（无可执行变化）：不入栈不写状态', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('s3', 1, 200)],
      [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')],
    )
    // s2 拖回自身原位（锚 s1 之后）＝ 原位重放，计划为空且集归属不变
    act(() => dropRow(h, 's2', 's1', 'after'))
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->s3'])
    expect(episodeNoOf(h, 's2')).toBe(1)
    expect(h.pushHistory).not.toHaveBeenCalled()
  })
})

describe('useOutlineDrop（分叉汇合拒绝）', () => {
  it.each([
    ['分叉成员（多出边）', ['a->x', 'x->b', 'x->c'], 'x', 'a'],
    ['汇合成员（多入边）', ['p->x', 'q->x', 'x->r'], 'x', 'p'],
  ] as const)(
    '拒绝%s的大纲拖拽：零状态写入 + 可见提示一次（issue #589）',
    (_name, pairs, dragged, anchor) => {
      const nodes = [...new Set(pairs.flatMap((p) => p.split('->')))].map(
        (id, i) => sceneNode(id, 1, i * 100),
      )
      const edges = pairs.map((p, i) => {
        const [source, target] = p.split('->')
        return seq(`e${i}`, source, target)
      })
      const h = setup(nodes, edges)
      const nodesBefore = h.result.current.doc.nodes
      act(() => dropRow(h, dragged, anchor, 'after'))
      // 分叉/汇合重排无法安全补回全部关联边：拒绝而非静默删边——
      // 画布边集与保存载荷不变、无历史命令、集归属不动
      expect(seqPairs(h)).toEqual(pairs)
      expect(h.result.current.doc.nodes).toBe(nodesBefore)
      expect(h.pushHistory).not.toHaveBeenCalled()
      expect(h.stack.canUndo).toBe(false)
      expect(h.onError).toHaveBeenCalledTimes(1)
      act(() => h.stack.undo())
      expect(seqPairs(h)).toEqual(pairs)
    },
  )
})

describe('useOutlineDrop（拒绝与历史不变量：拒绝同样覆盖组尾）', () => {
  it('拒绝同样覆盖组尾落点：分叉成员拖入组尾不删边、给提示', () => {
    const h = setup(
      [
        sceneNode('a', 1, 0),
        sceneNode('x', 1, 100),
        sceneNode('b', 2, 200),
        sceneNode('c', 2, 300),
      ],
      [seq('e1', 'a', 'x'), seq('e2', 'x', 'b'), seq('e3', 'x', 'c')],
    )
    // x 分叉（x→b、x→c）：组尾落点会向上找锚点，任何锚点都必须拒绝
    act(() =>
      h.result.current.outlineDrop('x', { kind: 'groupEnd', episode: 2 }),
    )
    expect(seqPairs(h)).toEqual(['a->x', 'x->b', 'x->c'])
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalledTimes(1)
  })
})

describe('useOutlineDrop（拒绝与历史不变量：分叉目标的下游）', () => {
  it('分叉目标的下游行不受影响：线性成员仍可正常重排', () => {
    const h = setup(
      [
        sceneNode('a', 1, 0),
        sceneNode('x', 1, 100),
        sceneNode('b', 1, 200),
        sceneNode('c', 1, 300),
      ],
      [seq('e1', 'a', 'x'), seq('e2', 'x', 'b'), seq('e3', 'x', 'c')],
    )
    // b 一入一出（邻居 x 分叉与 b 无关）：正常重排，不触发拒绝提示
    act(() => dropRow(h, 'b', 'c', 'after'))
    expect(seqPairs(h)).toEqual(['a->x', 'x->c', 'c->b'])
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.pushHistory).toHaveBeenCalledTimes(1)
    act(() => h.stack.undo())
    // undo 恢复按 kept+removed 拼接，数组序与原序不同——按边集断言
    expect([...seqPairs(h)].sort()).toEqual(['a->x', 'x->b', 'x->c'])
  })
})

describe('useOutlineDrop（§3.5 跨集与未分集移动单命令）', () => {
  it('跨集行落点：边手术 + episodeNo 补丁同命令一步撤销', () => {
    const h = setup(
      [sceneNode('s1', 1, 0), sceneNode('s2', 1, 100), sceneNode('x', 2, 300)],
      [seq('e1', 's1', 's2')],
    )
    act(() => dropRow(h, 'x', 's2', 'after'))
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->x'])
    expect(episodeNoOf(h, 'x')).toBe(1)
    expect(h.pushHistory).toHaveBeenCalledTimes(1)

    act(() => h.stack.undo())
    expect(seqPairs(h)).toEqual(['s1->s2'])
    expect(episodeNoOf(h, 'x')).toBe(2)
    act(() => h.stack.redo())
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->x'])
    expect(episodeNoOf(h, 'x')).toBe(1)
  })

  it('未分集 → 组尾落点：进组写 episodeNo；undo 清回未分集', () => {
    const h = setup(
      [
        sceneNode('s1', 1, 0),
        sceneNode('s2', 1, 100),
        sceneNode('u', undefined, 300),
      ],
      [seq('e1', 's1', 's2')],
    )
    act(() =>
      h.result.current.outlineDrop('u', { kind: 'groupEnd', episode: 1 }),
    )
    expect(seqPairs(h)).toEqual(['s1->s2', 's2->u'])
    expect(episodeNoOf(h, 'u')).toBe(1)
    expect(h.pushHistory).toHaveBeenCalledTimes(1)

    act(() => h.stack.undo())
    expect(seqPairs(h)).toEqual(['s1->s2'])
    expect(episodeNoOf(h, 'u')).toBeUndefined()
  })

  it('集 → 未分集组尾：episodeNo 清除；undo 恢复集归属与原边', () => {
    const h = setup(
      [
        sceneNode('s1', 1, 0),
        sceneNode('u1', undefined, 100),
        sceneNode('u2', undefined, 200),
      ],
      [seq('e1', 's1', 'u1'), seq('e2', 'u1', 'u2')],
    )
    act(() =>
      h.result.current.outlineDrop('s1', { kind: 'groupEnd', episode: null }),
    )
    expect(seqPairs(h)).toEqual(['u1->u2', 'u2->s1'])
    expect(episodeNoOf(h, 's1')).toBeUndefined()
    expect(h.pushHistory).toHaveBeenCalledTimes(1)

    act(() => h.stack.undo())
    expect(seqPairs(h)).toEqual(['u1->u2', 's1->u1'])
    expect(episodeNoOf(h, 's1')).toBe(1)
  })
})

it('中段跨集接入完整替换接缝，重复移动邻居仍可一步 undo/redo（#879）', () => {
  const nodes = ['a', 'b', 'c', 'd', 'x'].map((id, i) =>
    sceneNode(id, id === 'x' ? 2 : 1, i * 100),
  )
  const original = [
    seq('ab', 'a', 'b'),
    seq('bc', 'b', 'c'),
    seq('cd', 'c', 'd'),
  ]
  const h = setup(nodes, original)
  act(() => dropRow(h, 'x', 'b', 'after'))
  const inserted = h.result.current.doc.edges
  expect([...seqPairs(h)].sort()).toEqual(['a->b', 'b->x', 'c->d', 'x->c'])
  expect(episodeNoOf(h, 'x')).toBe(1)
  expect(h.pushHistory).toHaveBeenCalledTimes(1)
  act(() => h.stack.undo())
  expect(
    [...h.result.current.doc.edges].sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual(original)
  expect(episodeNoOf(h, 'x')).toBe(2)
  act(() => h.stack.redo())
  expect(h.result.current.doc.edges).toEqual(inserted)
  expect(episodeNoOf(h, 'x')).toBe(1)
  act(() => dropRow(h, 'b', 'c', 'after'))
  expect([...seqPairs(h)].sort()).toEqual(['a->x', 'b->d', 'c->b', 'x->c'])
  expect(h.pushHistory).toHaveBeenCalledTimes(2)
  expect(h.onError).not.toHaveBeenCalled()
  act(() => h.stack.undo())
  expect(new Set(h.result.current.doc.edges)).toEqual(new Set(inserted))
  act(() => h.stack.redo())
  expect([...seqPairs(h)].sort()).toEqual(['a->x', 'b->d', 'c->b', 'x->c'])
  act(() => dropRow(h, 'c', 'a', 'before'))
  expect([...seqPairs(h)].sort()).toEqual(['a->x', 'b->d', 'c->a', 'x->b'])
  expect(h.onError).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)(
  '非剧情流行 %s 落点可见拒绝（#884，共享 web/native hook）',
  (position) => {
    const h = setup(
      ['a', 'b', 'x'].map((id, i) => sceneNode(id, 1, i * 100)),
      [seq('ab', 'a', 'b')],
    )
    act(() => dropRow(h, 'a', 'x', position))
    expect(seqPairs(h)).toEqual(['a->b'])
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalledTimes(1)
    expect(h.onError.mock.calls[0]?.[0]).toContain('未接入剧情流')
  },
)

it.each([
  ['after', ['a->b', 'b->c', 'b->q'], 'b'],
  ['before', ['a->c', 'b->c', 'c->d'], 'c'],
] as const)('多接缝 %s 锚点可见拒绝（#885）', (position, pairs, anchor) => {
  const nodes = ['a', 'b', 'c', 'd', 'q', 'x'].map((id, i) =>
    sceneNode(id, 1, i * 100),
  )
  const edges = pairs.map((p, i) => {
    const [source, target] = p.split('->')
    return seq(`e${i}`, source, target)
  })
  const h = setup(nodes, edges)
  act(() => dropRow(h, 'x', anchor, position))
  expect(h.result.current.doc.edges).toEqual(edges)
  expect(h.pushHistory).not.toHaveBeenCalled()
  expect(h.onError).toHaveBeenCalledTimes(1)
})

it.each([
  ['after', ['p->x', 'p->q'], 'p'],
  ['before', ['x->n', 'q->n'], 'n'],
  ['after', ['p->x', 'x->n', 'p->q'], 'p'],
  ['before', ['p->x', 'x->n', 'q->n'], 'n'],
] as const)(
  '分支邻接原位 %s 不写状态、不提示、不入栈（#894 review）',
  (position, pairs, anchor) => {
    const nodes = ['p', 'x', 'q', 'n'].map((id, i) => sceneNode(id, 1, i * 100))
    const edges = pairs.map((pair, i) => {
      const [source, target] = pair.split('->')
      return seq(`e${i}`, source, target)
    })
    const h = setup(nodes, edges)
    const beforeNodes = h.result.current.doc.nodes
    act(() => dropRow(h, 'x', anchor, position))
    expect(h.result.current.doc.edges).toEqual(edges)
    expect(h.result.current.doc.nodes).toBe(beforeNodes)
    expect(h.pushHistory).not.toHaveBeenCalled()
    expect(h.stack.canUndo).toBe(false)
    expect(h.onError).not.toHaveBeenCalled()
  },
)
