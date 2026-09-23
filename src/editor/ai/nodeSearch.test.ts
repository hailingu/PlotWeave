import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { GRAPH_DIGEST_MAX_CHARS } from './graphDigest'
import { findNodesText } from './nodeSearch'
import type { CanvasNode } from '../nodes/types'

/** 构造最小节点（只带被测字段）。 */
function node(partial: Record<string, unknown>): CanvasNode {
  return partial as unknown as CanvasNode
}

function fixture(): { nodes: CanvasNode[]; edges: Edge[] } {
  const nodes: CanvasNode[] = [
    node({
      id: 's1',
      type: 'scene',
      position: { x: 0, y: 0 },
      data: {
        name: '天台追凶',
        sceneNo: 1,
        interior: true,
        synopsis: '',
        characterIds: [],
        time: '',
      },
    }),
    node({
      id: 'br1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '追或不追',
        options: [
          { id: 'o1', label: '追凶' },
          { id: 'o2', label: '放弃' },
        ],
      },
    }),
    node({
      id: 'd1',
      type: 'dialogue',
      position: { x: 0, y: 0 },
      data: { name: '摊牌', lines: [] },
    }),
  ]
  const edges: Edge[] = [
    { id: 'e1', source: 's1', target: 'br1', className: 'pw-edge-sequence' },
    {
      id: 'e2',
      source: 'br1',
      target: 'd1',
      type: 'branch',
      sourceHandle: 'option-o1',
      data: { optionLabel: '追凶' },
    },
  ]
  return { nodes, edges }
}

describe('findNodesText（issue #275 评审：被节选条目的可发现读取路径）', () => {
  it('按名称/文案跨类型检索，大小写不敏感', () => {
    const { nodes, edges } = fixture()
    const text = findNodesText(nodes, edges, '追凶')
    expect(text).toContain('- s1 场01·天台追凶')
    expect(text).toContain('- br1 分支·追或不追')
    expect(text).not.toContain('- d1')
  })

  it('匹配节点携带其全部关联边（含作为目标端），被摘要节选隐藏的连线可发现', () => {
    const { nodes, edges } = fixture()
    const text = findNodesText(nodes, edges, 'br1')
    expect(text).toContain('sequence: s1 → br1')
    expect(text).toContain('branch(选项追凶): br1 → d1')
  })

  it('多命中按 offset 翻页：页大小上限 + 计数标记带下一页偏移（issue #275 评审）', () => {
    const nodes: CanvasNode[] = Array.from({ length: 30 }, (_, i) =>
      node({
        id: `n${i + 1}`,
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: `同名词${i + 1}`, tone: 'x' },
      }),
    )
    const edges: Edge[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      source: 'n1',
      target: `n${i + 2}`,
      className: 'pw-edge-sequence',
    }))
    const page1 = findNodesText(nodes, edges, '同名词')
    expect(page1).toMatch(/另有 6 个匹配未列出/)
    expect(page1).toContain('offset=24')
    expect(page1).toMatch(/另有 8 条连线未列出/)
    expect(page1).toContain('单查该节点 id')
    const page2 = findNodesText(nodes, edges, '同名词', 24)
    expect(page2).toContain('- n25')
    expect(page2).toContain('- n30')
  })

  it('单节点命中（按 id）时连线分页枚举：页 64 条 + 偏移续读（issue #275 评审）', () => {
    const hub: CanvasNode = node({
      id: 'hub',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '枢纽',
        options: Array.from({ length: 70 }, (_, i) => ({
          id: `o${i + 1}`,
          label: `出口${i + 1}`,
        })),
      },
    })
    const targets: CanvasNode[] = Array.from({ length: 70 }, (_, i) =>
      node({
        id: `t${i + 1}`,
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: `目的地${i + 1}`, tone: 'x' },
      }),
    )
    const edges: Edge[] = Array.from({ length: 70 }, (_, i) => ({
      id: `e${i + 1}`,
      source: 'hub',
      target: `t${i + 1}`,
      type: 'branch',
      sourceHandle: `option-o${i + 1}`,
    }))
    const page1 = findNodesText([hub, ...targets], edges, 'hub')
    expect(page1).toContain('branch(选项出口1): hub → t1')
    expect(page1).toContain('→ t64')
    expect(page1).not.toContain('→ t65')
    expect(page1).toMatch(/另有 6 条连线未列出/)
    expect(page1).toContain('offset=64')
    const page2 = findNodesText([hub, ...targets], edges, 'hub', 64)
    expect(page2).toContain('→ t65')
    expect(page2).toContain('→ t70')
    expect(page2).not.toMatch(/另有 \d+ 条连线未列出/)
  })

  it('行级截断：单命中 6.5 万字符名称不原样携带（issue #275 评审）', () => {
    const giant: CanvasNode = node({
      id: 'g1',
      type: 'scene',
      position: { x: 0, y: 0 },
      data: {
        name: '巨'.repeat(65_536),
        sceneNo: 1,
        interior: true,
        synopsis: '',
        characterIds: [],
        time: '',
      },
    })
    const text = findNodesText([giant], [], 'g1')
    expect(text.length).toBeLessThan(1000)
    expect(text).not.toContain('巨'.repeat(400))
    expect(text).toContain('…')
  })

  it('多命中拼接超预算时按字符硬上限截断并声明未发送量（issue #275 评审）', () => {
    const label = '长'.repeat(170)
    const nodes: CanvasNode[] = Array.from({ length: 24 }, (_, i) =>
      node({
        id: `b${i + 1}`,
        type: 'branch',
        position: { x: 0, y: 0 },
        data: {
          prompt: `枢纽${i + 1}`,
          options: Array.from({ length: 13 }, (_, j) => ({
            id: `o${j + 1}`,
            label: `${label}${j}`,
          })),
        },
      }),
    )
    const edges: Edge[] = nodes.flatMap((n) =>
      Array.from({ length: 13 }, (_, j) => ({
        id: `${n.id}-e${j}`,
        source: n.id,
        target: `t-${n.id}-${j}`,
        type: 'branch',
        sourceHandle: `option-o${j + 1}`,
      })),
    )
    const page1 = findNodesText(nodes, edges, '枢纽')
    expect(page1.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
    // 预算在整节点边界停止（不任意截断），游标 = 实际已列数
    expect(page1).toContain('已达字符预算')
    const cursor = Number(page1.match(/offset=(\d+)/)?.[1])
    expect(Number.isInteger(cursor)).toBe(true)
    expect(cursor).toBeGreaterThan(0)
    expect(cursor).toBeLessThan(24)
    // 续读页含第一页未出现的节点——offset=0 不再重复同一前缀
    const page2 = findNodesText(nodes, edges, '枢纽', cursor)
    const page1Node = page1.match(/- b(\d+) /)?.[1]
    const page2Nodes = [...page2.matchAll(/- b(\d+) /g)].map((m) => m[1])
    expect(page2Nodes.length).toBeGreaterThan(0)
    for (const n of page2Nodes) {
      expect(n).not.toBe(page1Node)
    }
  })

  it('精确 id 命中优先进入单节点视图：id 子串碰撞不阻连续线枚举（PR #294 评审）', () => {
    // 合法旧项目可同时存在 n1 与 n10：查询 n1 时 includes 也会命中 n10
    const hub: CanvasNode = node({
      id: 'n1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: {
        prompt: '枢纽',
        options: Array.from({ length: 14 }, (_, i) => ({
          id: `o${i + 1}`,
          label: `出口${i + 1}`,
        })),
      },
    })
    const colliding: CanvasNode = node({
      id: 'n10',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '旁支', tone: 'x' },
    })
    const edges: Edge[] = Array.from({ length: 14 }, (_, i) => ({
      id: `e${i + 1}`,
      source: 'n1',
      target: `t${i + 1}`,
      type: 'branch',
      sourceHandle: `option-o${i + 1}`,
    }))
    const text = findNodesText([hub, colliding], edges, 'n1')
    // 单节点视图：第 13/14 条出口仍在本页（64/页）可枚举，不再只有前 12 条
    expect(text).toContain('branch(选项出口13): n1 → t13')
    expect(text).toContain('branch(选项出口14): n1 → t14')
    expect(text).not.toContain('单查该节点 id')
  })

  it('无匹配与空关键词给出明确文案，不抛异常', () => {
    const { nodes, edges } = fixture()
    expect(findNodesText(nodes, edges, '不存在')).toContain('未找到匹配')
    expect(findNodesText(nodes, edges, '')).toContain('query')
  })
})
