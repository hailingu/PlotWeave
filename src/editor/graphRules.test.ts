import { describe, expect, it } from 'vitest'
import {
  connectEdgeExtras,
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  branchOptionHandle,
  branchOptionIdOf,
  connectionEndpointIssue,
  connectionKindOf,
  removedOptionHandles,
  edgeKindOf,
  hasAttachHost,
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

describe('connectionKindOf（拖线瞬间 Connection 的语义归类：Connection 无 type 字段）', () => {
  it('选项出口端口 → branch；下挂端口 → attach；其余 → sequence', () => {
    expect(connectionKindOf({ sourceHandle: 'option-1' })).toBe('branch')
    expect(connectionKindOf({ sourceHandle: SCENE_SHOT_HANDLE })).toBe('attach')
    expect(connectionKindOf({})).toBe('sequence')
    expect(connectionKindOf({ sourceHandle: null })).toBe('sequence')
    expect(connectionKindOf({ sourceHandle: 'whatever' })).toBe('sequence')
  })

  it('分支选项出口的连线经端口归类为 branch，不被端点校验拒绝（回归：误判 sequence 会拒绝全部交互分支连线）', () => {
    expect(connectionEndpointIssue('branch', 'scene', connectionKindOf({ sourceHandle: 'option-o1' }))).toBeNull()
  })
})

describe('branchOptionHandle（选项端口绑稳定 id，删选项不位移其他连线）', () => {
  it('端口名 = option-<选项 id>；branchOptionIdOf 可逆解析', () => {
    expect(branchOptionHandle('opt-x1')).toBe(`${BRANCH_OPTION_HANDLE_PREFIX}opt-x1`)
    expect(branchOptionIdOf('option-opt-x1')).toBe('opt-x1')
  })

  it('非选项端口/空值解析为 undefined', () => {
    expect(branchOptionIdOf('shots')).toBeUndefined()
    expect(branchOptionIdOf(null)).toBeUndefined()
    expect(branchOptionIdOf(undefined)).toBeUndefined()
  })

  it('JSON 边界擦除类型后的非字符串句柄（数字/对象）解析为 undefined 而非抛异常', () => {
    expect(branchOptionIdOf(42 as unknown as string)).toBeUndefined()
    expect(branchOptionIdOf({} as unknown as string)).toBeUndefined()
  })
})

describe('removedOptionHandles（§8.2.2 删选项连带删边的级联依据）', () => {
  it('返回被删除选项的出口句柄；保留项与重排不影响', () => {
    const prev = [
      { id: 'a', label: '甲' },
      { id: 'b', label: '乙' },
      { id: 'c', label: '丙' },
    ]
    expect(removedOptionHandles(prev, [prev[1], prev[2]])).toEqual(['option-a'])
    expect(removedOptionHandles(prev, [prev[2], prev[0], prev[1]])).toEqual([])
    expect(removedOptionHandles(prev, [])).toEqual([
      'option-a',
      'option-b',
      'option-c',
    ])
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

describe('connectionEndpointIssue（§5 端口归属：加载侧孤儿边规则的交互/AI 对等）', () => {
  it('剧情流端点为分镜卡：拒绝（保存也会在下次加载被静默删除）', () => {
    expect(connectionEndpointIssue('shot', 'scene', 'sequence')).toContain('分镜')
    expect(connectionEndpointIssue('scene', 'shot', 'sequence')).toContain('分镜')
    expect(connectionEndpointIssue('branch', 'shot', 'branch')).toContain('分镜')
  })
  it('sequence/attach 的 source 为分支：拒绝（分支只经选项出口）', () => {
    expect(connectionEndpointIssue('branch', 'scene', 'sequence')).toContain('分支')
    expect(connectionEndpointIssue('branch', 'shot', 'attach')).toContain('分支')
  })
  it('attach 端点类型不合法（须 scene → shot）：拒绝', () => {
    expect(connectionEndpointIssue('scene', 'scene', 'attach')).toContain('attach')
    expect(connectionEndpointIssue('scene', 'shot', 'attach')).toBeNull()
  })
  it('合法剧情流/分支出口连线放行', () => {
    expect(connectionEndpointIssue('scene', 'scene', 'sequence')).toBeNull()
    expect(connectionEndpointIssue('branch', 'scene', 'branch')).toBeNull()
    expect(connectionEndpointIssue('beat', 'scene', 'sequence')).toBeNull()
  })
})

describe('hasAttachHost（§5 attach 宿主唯一：加载侧 isolateExtraAttachHosts 的交互/AI 对等）', () => {
  it('目标已有入向 attach 边即报告（含 legacy className 形态）；出向或其他目标不算', () => {
    expect(hasAttachHost([{ source: 'a', target: 'sh1', sourceHandle: 'shots' }], 'sh1')).toBe(true)
    expect(hasAttachHost([{ source: 'a', target: 'sh1', className: 'pw-edge-attach' }], 'sh1')).toBe(true)
    expect(hasAttachHost([{ source: 'a', target: 'sh1' }], 'sh1')).toBe(false)
    expect(hasAttachHost([{ source: 'sh1', target: 'a', sourceHandle: 'shots' }], 'sh1')).toBe(false)
  })
})
