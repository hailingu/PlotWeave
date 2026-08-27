import { describe, expect, it } from 'vitest'
import { planSpliceIntoSpine } from './spine'

type E = { id: string; source: string; target: string }

/** 线性剧情流 S→A→B→C→E，外加游离对白 D（无 sequence 边）。 */
function chain(): E[] {
  return [
    { id: 'e1', source: 'S', target: 'A' },
    { id: 'e2', source: 'A', target: 'B' },
    { id: 'e3', source: 'B', target: 'C' },
    { id: 'e4', source: 'C', target: 'E' },
  ]
}

describe('planSpliceIntoSpine（§3.5 大纲拖拽 = 重排 sequence 边）', () => {
  it('后移语义精确：把 A 拖到 C 之后 = S→B 缝合缺口 + C→A→E 接回新位', () => {
    const plan = planSpliceIntoSpine(chain(), 'A', 'C', 'after')!
    expect(plan.removes.sort()).toEqual(['e1', 'e2'])
    const pairs = plan.adds.map((a) => `${a.source}->${a.target}`).sort()
    expect(pairs).toEqual(['A->E', 'C->A', 'S->B'])
  })

  it('前移：把 C 拖到 A 之前 = S→C→A，缺口缝合 B→E', () => {
    const plan = planSpliceIntoSpine(chain(), 'C', 'A', 'before')!
    expect(plan.removes.sort()).toEqual(['e3', 'e4'])
    const pairs = plan.adds.map((a) => `${a.source}->${a.target}`).sort()
    expect(pairs).toEqual(['B->E', 'C->A', 'S->C'])
  })

  it('拖到开头（before 首节点）与拖到游离节点接入', () => {
    const head = planSpliceIntoSpine(chain(), 'C', 'S', 'before')!
    expect(head.adds.some((a) => a.source === 'C' && a.target === 'S')).toBe(true)
    expect(head.adds.some((a) => a.source === 'B' && a.target === 'C')).toBe(false)

    // 游离节点 D 拖到 B 之后 = 纯接入，两条新边，不删任何边
    const join = planSpliceIntoSpine(chain(), 'D', 'B', 'after')!
    expect(join.removes).toEqual([])
    expect(join.adds).toEqual([
      { source: 'B', target: 'D' },
      { source: 'D', target: 'C' },
    ])
  })

  it('原位重放 = 无操作计划（空 removes/adds）', () => {
    const plan = planSpliceIntoSpine(chain(), 'B', 'A', 'after')!
    expect(plan.removes).toEqual([])
    expect(plan.adds).toEqual([])
  })

  it('拖到分镜（非剧情流锚点）与自身锚点返回 null', () => {
    const edges = [...chain(), { id: 'e9', source: 'C', target: 'SH', sourceHandle: 'shots' }]
    expect(planSpliceIntoSpine(edges, 'B', 'SH', 'after')).toBeNull()
    expect(planSpliceIntoSpine(edges, 'B', 'B', 'after')).toBeNull()
  })
})
