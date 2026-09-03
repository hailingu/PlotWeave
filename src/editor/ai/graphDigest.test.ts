import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { buildGraphDigest } from './graphDigest'
import type { CanvasNode } from '../nodes/types'

/** 构造最小节点（只带被测字段）。 */
function node(partial: Record<string, unknown>): CanvasNode {
  return partial as unknown as CanvasNode
}

describe('buildGraphDigest（§6/§12.2 画布快照：id + 参数 + 连线语义 + 大纲投影）', () => {
  const nodes: CanvasNode[] = [
    node({
      id: 's1',
      type: 'scene',
      position: { x: 200, y: 0 },
      data: {
        name: '天台',
        sceneNo: 1,
        interior: false,
        locationId: 'l1',
        time: '🌙 夜',
        synopsis: '一场很长很长的梗概'.repeat(10),
        characterIds: ['c1', 'c2'],
        episodeNo: 1,
      },
    }),
    node({ id: 'b1', type: 'beat', position: { x: 0, y: 0 }, data: { name: '开端', tone: '压抑', episodeNo: 2 } }),
    node({
      id: 'd1',
      type: 'dialogue',
      position: { x: 400, y: 0 },
      data: {
        name: '摊牌',
        lines: [
          { kind: 'line', speaker: 'c1', side: 'left', text: '你走吧' },
          { kind: 'action', text: '沉默' },
          { kind: 'line', speaker: 'c2', side: 'right', text: '好' },
        ],
      },
    }),
    node({
      id: 'br1',
      type: 'branch',
      position: { x: 600, y: 0 },
      data: { prompt: '追或不追？', options: [{ id: 'o1', label: '追' }, { id: 'o2', label: '不追' }] },
    }),
    node({
      id: 'sh1',
      type: 'shot',
      position: { x: 200, y: 160 },
      data: { shotNo: 3, size: '特写', picture: '雨水', prompt: 'rain close-up', refs: [] },
    }),
  ]
  const edges: Edge[] = [
    { id: 'e1', source: 'b1', target: 's1', className: 'pw-edge-sequence' },
    {
      id: 'e2',
      source: 'br1',
      target: 'd1',
      type: 'branch',
      sourceHandle: 'option-o2',
      data: { optionLabel: '不追' },
    },
    { id: 'e3', source: 's1', target: 'sh1', className: 'pw-edge-attach', sourceHandle: 'shots' },
  ]

  const digest = buildGraphDigest(nodes, edges, {
    characters: [
      { id: 'c1', name: '林晚' },
      { id: 'c2', name: '阿豪' },
    ],
    locations: [{ id: 'l1', name: '屋顶' }],
    characterName: (id) => (id === 'c1' ? '林晚' : id === 'c2' ? '阿豪' : null),
    locationName: (id) => (id === 'l1' ? '屋顶' : null),
  })

  it('节点行含 id、类型标签与关键参数（地点/角色解析为名）', () => {
    expect(digest).toContain('- s1 集1 场01·天台')
    expect(digest).toContain('- b1 集2 节拍·开端')
    expect(digest).toContain('屋顶')
    expect(digest).toContain('林晚')
    expect(digest).toContain('压抑')
    expect(digest).toContain('- d1 对白·摊牌')
    expect(digest).toContain('2 人')
    expect(digest).toContain('2 句')
    expect(digest).toContain('- br1 分支·追或不追？')
    expect(digest).toContain('追/不追')
    expect(digest).toContain('- sh1 SHOT03·特写')
  })

  it('超长梗概截断，不整段灌入上下文', () => {
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(2000)
  })

  it('连线行区分 sequence / branch 选项 / attach 下挂', () => {
    expect(digest).toContain('sequence: b1 → s1')
    expect(digest).toContain('branch')
    expect(digest).toContain('branch(选项不追 · option-o2)')
    expect(digest).toContain('attach: s1 → sh1')
  })

  it('剧情流顺序 = sequence 子图的线性投影（大纲投影）', () => {
    const orderLine = digest.split('\n').findIndex((l) => l.includes('剧情流顺序'))
    const after = digest.split('\n').slice(orderLine)
    const b1Idx = after.findIndex((l) => l.includes('1. b1'))
    const s1Idx = after.findIndex((l) => l.includes('2. s1'))
    expect(b1Idx).toBeGreaterThan(-1)
    expect(s1Idx).toBeGreaterThan(b1Idx)
  })

  it('设定集段给出实体 id，供 AI 写回 characterIds / locationId', () => {
    expect(digest).toContain('c1 林晚')
    expect(digest).toContain('l1 屋顶')
  })

  it('空画布不抛错', () => {
    expect(
      buildGraphDigest([], [], {
        characters: [],
        locations: [],
        characterName: () => null,
        locationName: () => null,
      }),
    ).toBeTruthy()
  })
})
