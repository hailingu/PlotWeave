import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
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

  it('匹配与单节点连线均有上限并带计数标记', () => {
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
    const text = findNodesText(nodes, edges, '同名词')
    expect(text).toMatch(/另有 \d+ 个匹配未列出/)
    expect(text).toMatch(/另有 \d+ 条连线未列出/)
  })

  it('无匹配与空关键词给出明确文案，不抛异常', () => {
    const { nodes, edges } = fixture()
    expect(findNodesText(nodes, edges, '不存在')).toContain('未找到匹配')
    expect(findNodesText(nodes, edges, '')).toContain('query')
  })
})
