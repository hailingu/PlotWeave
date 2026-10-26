import { expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import { isForkOrMergeMember } from './spine'
import { isolateDuplicateEdges } from '../model/normalizeEdges'

/** 固定边身份使 undo 同时验证完整连线数据，而非仅比新增计划。 */
const edge = (source: string, target: string, extra = {}): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
  className: 'pw-edge-sequence',
  ...extra,
})
const base = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')]
const pairs = (edges: Edge[]) =>
  edges.map((e) => `${e.source}->${e.target}`).sort()

/** 使用生产计划器与应用器，保留两向历史需要的确切边对象。 */
function move(
  edges: Edge[],
  dragged: string,
  anchor: string,
  position: 'before' | 'after',
) {
  const result = outlineSplicePlan([], edges, {}, dragged, {
    kind: 'row',
    anchorId: anchor,
    position,
  })
  expect(result).not.toBeNull()
  const plan = result!.plan
  const removed = edges.filter((e) => plan.removes.includes(e.id))
  const added = plan.adds.map((e, i) => ({
    ...edge(e.source, e.target),
    id: `new-${i}`,
  }))
  return {
    plan,
    removed,
    added,
    after: spliceEdgesWith(edges, removed, added, true),
  }
}

it.each([
  ['X', 'B', 'after', ['A->B', 'B->X', 'X->C', 'C->D']],
  ['X', 'C', 'before', ['A->B', 'B->X', 'X->C', 'C->D']],
  ['A', 'C', 'after', ['B->C', 'C->A', 'A->D']],
  ['D', 'B', 'before', ['A->D', 'D->B', 'B->C']],
  ['B', 'C', 'after', ['A->C', 'C->B', 'B->D']],
  ['C', 'B', 'before', ['A->C', 'C->B', 'B->D']],
  ['D', 'A', 'before', ['D->A', 'A->B', 'B->C']],
  ['A', 'D', 'after', ['B->C', 'C->D', 'D->A']],
] as const)(
  '完整链：%s %s %s，undo/redo 无捷径',
  (dragged, anchor, position, expected) => {
    const { after, removed, added } = move(base, dragged, anchor, position)
    expect(pairs(after)).toEqual([...expected].sort())
    for (const id of ['A', 'B', 'C', 'D', 'X'])
      expect(isForkOrMergeMember(after, id)).toBe(false)
    const undone = spliceEdgesWith(after, removed, added, false)
    expect([...undone].sort((a, b) => a.id.localeCompare(b.id))).toEqual(base)
    expect(spliceEdgesWith(undone, removed, added, true)).toEqual(after)
  },
)

it.each([
  ['B', 'A', 'after'],
  ['B', 'C', 'before'],
  ['A', 'B', 'before'],
  ['D', 'C', 'after'],
] as const)('原位重放 %s %s %s 保持边身份', (dragged, anchor, position) => {
  const result = move(base, dragged, anchor, position)
  expect(result.plan).toEqual({ removes: [], adds: [] })
  expect(result.after).toEqual(base)
})

it.each(['before', 'after'] as const)(
  '仅替换选定接缝 %s：保留其他合法 sequence 分支、branch 与 attach 对象',
  (position) => {
    const kept = [
      position === 'after' ? edge('R', 'C') : edge('B', 'Q'),
      edge('choice', 'option', {
        sourceHandle: 'option-yes',
        className: 'pw-edge-branch',
      }),
      edge('B', 'shot', { sourceHandle: 'shots', className: 'pw-edge-attach' }),
    ]
    const edges = [...base, ...kept]
    const result = move(edges, 'X', position === 'after' ? 'B' : 'C', position)
    expect(pairs(result.after)).toEqual(
      pairs([base[0]!, base[2]!, edge('B', 'X'), edge('X', 'C'), ...kept]),
    )
    for (const original of kept) expect(result.after).toContain(original)
    const undo = spliceEdgesWith(
      result.after,
      result.removed,
      result.added,
      false,
    )
    expect(new Set(undo)).toEqual(new Set(edges))
  },
)

it('接缝移除后仍拒绝会闭合现有路径的新增边', () => {
  const cycle = [edge('C', 'D'), edge('D', 'E'), edge('E', 'C')]
  expect(
    outlineSplicePlan([], cycle, {}, 'X', {
      kind: 'row',
      anchorId: 'C',
      position: 'after',
    }),
  ).toBeNull()
  expect(pairs(cycle)).toEqual(['C->D', 'D->E', 'E->C'])
})

it.each(['before', 'after'] as const)(
  '既有拔出直连保持唯一，%s 移动后 undo/redo 保留全部边身份（#882）',
  (position) => {
    const shortcut = edge('P', 'N')
    const original = [edge('P', 'X'), edge('X', 'N'), shortcut, edge('Q', 'M')]
    const result = move(original, 'X', 'M', position)
    expect(pairs(result.after)).toEqual(
      (position === 'after'
        ? ['M->X', 'P->N', 'Q->M']
        : ['P->N', 'Q->X', 'X->M']
      ).sort(),
    )
    const warnings: string[] = []
    const saved = JSON.parse(JSON.stringify(result.after)).map((e: Edge) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      data: { kind: 'sequence' as const },
    }))
    expect(isolateDuplicateEdges(saved, warnings)).toEqual(saved)
    expect(warnings).toEqual([])
    expect(result.after).toContain(shortcut)
    expect(new Set(pairs(result.after)).size).toBe(result.after.length)
    const undo = spliceEdgesWith(
      result.after,
      result.removed,
      result.added,
      false,
    )
    expect(new Set(undo)).toEqual(new Set(original))
    expect(spliceEdgesWith(undo, result.removed, result.added, true)).toEqual(
      result.after,
    )
  },
)

it('旧 #879 捷径项目重排不新增重复边（#882）', () => {
  const shortcut = edge('B', 'C')
  const original = [...base, edge('B', 'X'), edge('X', 'C')]
  const result = move(original, 'X', 'C', 'after')
  expect(pairs(result.after)).toEqual(['A->B', 'B->C', 'C->X', 'X->D'])
  expect(result.after.find((e) => e.id === shortcut.id)).toBe(original[1])
})

it.each([
  ['after', [edge('A', 'B'), edge('B', 'C'), edge('B', 'Q')], 'B'],
  ['before', [edge('A', 'C'), edge('B', 'C'), edge('C', 'D')], 'C'],
] as const)(
  '拒绝 %s 多接缝锚点，不按边数组序选取（#885）',
  (position, edges, anchorId) => {
    for (const ordered of [edges, [...edges].reverse()]) {
      expect(
        outlineSplicePlan([], [...ordered], {}, 'X', {
          kind: 'row',
          anchorId,
          position,
        }),
      ).toBeNull()
    }
  },
)

it.each([
  ['after', [edge('P', 'X'), edge('P', 'Q')], 'P'],
  ['before', [edge('X', 'N'), edge('Q', 'N')], 'N'],
  ['after', [edge('P', 'X'), edge('X', 'N'), edge('P', 'Q')], 'P'],
  ['before', [edge('P', 'X'), edge('X', 'N'), edge('Q', 'N')], 'N'],
] as const)(
  '相邻原位 %s 重放不改合法分叉/汇合（#894 review）',
  (position, edges, anchor) => {
    for (const ordered of [[...edges], [...edges].reverse()]) {
      const result = move(ordered, 'X', anchor, position)
      expect(result.plan).toEqual({ removes: [], adds: [] })
      expect(result.after).toEqual(ordered)
    }
  },
)
