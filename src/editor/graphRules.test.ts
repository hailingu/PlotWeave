import { describe, expect, it } from 'vitest'
import {
  connectEdgeExtras,
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  branchOptionHandle,
  edgeKindOf,
  isDuplicateEdge,
  wouldCreateCycle,
} from './graphRules'

describe('edgeKindOf（§4.4 连线语义归类）', () => {
  it('type=branch 归 branch；shots 端口或 attach 类名归 attach；其余归 sequence', () => {
    expect(edgeKindOf({ type: 'branch' })).toBe('branch')
    expect(edgeKindOf({ sourceHandle: SCENE_SHOT_HANDLE })).toBe('attach')
    expect(edgeKindOf({ className: 'pw-edge-attach' })).toBe('attach')
    expect(edgeKindOf({})).toBe('sequence')
    expect(edgeKindOf({ sourceHandle: 'option-1' })).toBe('sequence')
  })

  it('branch 优先于端口形态（type 先判）', () => {
    expect(edgeKindOf({ type: 'branch', sourceHandle: SCENE_SHOT_HANDLE })).toBe('branch')
  })

  it('sourceHandle 为 null / 未知字符串均按剧情流处理', () => {
    expect(edgeKindOf({ sourceHandle: null })).toBe('sequence')
    expect(edgeKindOf({ sourceHandle: 'whatever' })).toBe('sequence')
  })
})

describe('branchOptionHandle', () => {
  it('0 基选项端口名：option-0、option-1…', () => {
    expect(branchOptionHandle(0)).toBe(`${BRANCH_OPTION_HANDLE_PREFIX}0`)
    expect(branchOptionHandle(3)).toBe('option-3')
  })
})

describe('wouldCreateCycle（从 target 沿边能否回到 source）', () => {
  const chain = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ]

  it('顺向延伸不成环；逆向（C→A 方向探测）成环', () => {
    expect(wouldCreateCycle(chain, 'A', 'B')).toBe(false)
    expect(wouldCreateCycle(chain, 'C', 'A')).toBe(true)
  })

  it('直接回到 source 的邻边也算环；游离点不参与', () => {
    expect(wouldCreateCycle(chain, 'B', 'A')).toBe(true)
    expect(wouldCreateCycle(chain, 'A', 'X')).toBe(false)
  })

  it('菱形汇聚（B←A→C→B）不因重复访问而死循环，且正确检出环', () => {
    const diamond = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'B', target: 'D' },
      { source: 'C', target: 'D' },
      { source: 'D', target: 'B' },
    ]
    expect(wouldCreateCycle(diamond, 'B', 'D')).toBe(true)
    expect(wouldCreateCycle(diamond, 'A', 'D')).toBe(false)
  })
})

describe('isDuplicateEdge（同端点同端口视为重复）', () => {
  it('端点与端口全同才重复；端口不同 = 不同边', () => {
    const edges = [{ source: 'S', target: 'T', sourceHandle: 'option-0' }]
    expect(isDuplicateEdge(edges, { source: 'S', target: 'T', sourceHandle: 'option-0' })).toBe(true)
    expect(isDuplicateEdge(edges, { source: 'S', target: 'T', sourceHandle: 'option-1' })).toBe(false)
    expect(isDuplicateEdge(edges, { source: 'S', target: 'T' })).toBe(false)
    expect(isDuplicateEdge(edges, { source: 'T', target: 'S' })).toBe(false)
  })

  it('null 与缺省端口等价（?? null 归一）', () => {
    const edges = [{ source: 'S', target: 'T', sourceHandle: null }]
    expect(isDuplicateEdge(edges, { source: 'S', target: 'T' })).toBe(true)
    expect(isDuplicateEdge(edges, { source: 'S', target: 'T', sourceHandle: null })).toBe(true)
  })
})

describe('connectEdgeExtras（§4.4 新连线差异化字段）', () => {
  it('分支选项出口 → type=branch + 选项胶囊文案', () => {
    expect(connectEdgeExtras(true, { optionLabel: '左' }, false)).toEqual({
      type: 'branch',
      data: { optionLabel: '左' },
    })
  })

  it('索引卡底端口 → attach 下挂样式类', () => {
    expect(connectEdgeExtras(false, undefined, true)).toEqual({ className: 'pw-edge-attach' })
  })

  it('默认 → sequence 剧情流样式类', () => {
    expect(connectEdgeExtras(false, undefined, false)).toEqual({ className: 'pw-edge-sequence' })
  })

  it('分支优先于 attach（同一连接只取一种形态）', () => {
    expect(connectEdgeExtras(true, { optionLabel: 'A' }, true)).toEqual({
      type: 'branch',
      data: { optionLabel: 'A' },
    })
  })
})
