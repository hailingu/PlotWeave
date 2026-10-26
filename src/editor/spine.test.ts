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
    expect(plan.removes.sort()).toEqual(['e1', 'e2', 'e4'])
    const pairs = plan.adds.map((a) => `${a.source}->${a.target}`).sort()
    expect(pairs).toEqual(['A->E', 'C->A', 'S->B'])
  })

  it('前移：把 C 拖到 A 之前 = S→C→A，缺口缝合 B→E', () => {
    const plan = planSpliceIntoSpine(chain(), 'C', 'A', 'before')!
    expect(plan.removes.sort()).toEqual(['e1', 'e3', 'e4'])
    const pairs = plan.adds.map((a) => `${a.source}->${a.target}`).sort()
    expect(pairs).toEqual(['B->E', 'C->A', 'S->C'])
  })

  it('拖到开头（before 首节点）与拖到游离节点接入', () => {
    const head = planSpliceIntoSpine(chain(), 'C', 'S', 'before')!
    expect(head.adds.some((a) => a.source === 'C' && a.target === 'S')).toBe(
      true,
    )
    expect(head.adds.some((a) => a.source === 'B' && a.target === 'C')).toBe(
      false,
    )

    // 游离节点 D 拖到 B 之后 = 替换 B→C，两条新边
    const join = planSpliceIntoSpine(chain(), 'D', 'B', 'after')!
    expect(join.removes).toEqual(['e3'])
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
    const edges = [
      ...chain(),
      { id: 'e9', source: 'C', target: 'SH', sourceHandle: 'shots' },
    ]
    expect(planSpliceIntoSpine(edges, 'B', 'SH', 'after')).toBeNull()
    expect(planSpliceIntoSpine(edges, 'B', 'B', 'after')).toBeNull()
  })
})

describe('planSpliceIntoSpine（issue #589：分叉/汇合成员拒绝重排）', () => {
  it('分叉成员（多出边）返回 null：拔出语义会删除未被补回的分支边', () => {
    // A→X、X→B、X→C（X 分叉）；拖 X 到 A 之后不得产出删除 X→B/X→C 的计划
    const fork = [
      { id: 'a', source: 'A', target: 'X' },
      { id: 'b', source: 'X', target: 'B' },
      { id: 'c', source: 'X', target: 'C' },
    ]
    expect(planSpliceIntoSpine(fork, 'X', 'A', 'after')).toBeNull()
    expect(planSpliceIntoSpine(fork, 'X', 'A', 'before')).toBeNull()
  })

  it('汇合成员（多入边）返回 null：Q→X/X→R 不随重排被删', () => {
    // P→X、Q→X、X→R（X 汇合）；拖 X 到 P 之后不得产出删除 Q→X/X→R 的计划
    const merge = [
      { id: 'p', source: 'P', target: 'X' },
      { id: 'q', source: 'Q', target: 'X' },
      { id: 'r', source: 'X', target: 'R' },
    ]
    expect(planSpliceIntoSpine(merge, 'X', 'P', 'after')).toBeNull()
    expect(planSpliceIntoSpine(merge, 'X', 'Q', 'before')).toBeNull()
  })

  it('纯分叉源（无入边、多出边）与纯汇合尾（多入边、无出边）同样拒绝', () => {
    const source = [
      ...chain(),
      { id: 'f1', source: 'X', target: 'B' },
      { id: 'f2', source: 'X', target: 'C' },
    ]
    expect(planSpliceIntoSpine(source, 'X', 'A', 'after')).toBeNull()
    const sink = [
      ...chain(),
      { id: 'm1', source: 'A', target: 'X' },
      { id: 'm2', source: 'B', target: 'X' },
    ]
    expect(planSpliceIntoSpine(sink, 'X', 'C', 'after')).toBeNull()
  })

  it('分叉/汇合的下游目标仍是普通成员：线性语义不受关联方形态影响', () => {
    // X 分叉出 B/C，但 B 自身一入一出——B 可正常重排（既有线性语义）
    const fork = [
      { id: 'a', source: 'A', target: 'X' },
      { id: 'b', source: 'X', target: 'B' },
      { id: 'c', source: 'X', target: 'C' },
    ]
    const plan = planSpliceIntoSpine(fork, 'B', 'C', 'after')
    expect(plan).not.toBeNull()
    expect(plan!.removes).toEqual(['b'])
    expect(plan!.adds).toEqual([{ source: 'C', target: 'B' }])
  })
})
