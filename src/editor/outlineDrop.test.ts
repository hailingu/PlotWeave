import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import type { CanvasNode, SceneFlowNode, ShotFlowNode } from './nodes/types'

function sceneNode(id: string, episodeNo: number | undefined, x: number): SceneFlowNode {
  return {
    id,
    type: 'scene',
    position: { x, y: 0 },
    data: {
      name: id,
      sceneNo: 1,
      interior: true,
      time: '🌙 夜',
      synopsis: '…',
      characterIds: [],
      ...(episodeNo !== undefined ? { episodeNo } : {}),
    },
  }
}

function shotNodeOf(id: string, episodeNo: number, x: number): ShotFlowNode {
  return {
    id,
    type: 'shot',
    position: { x, y: 0 },
    data: { shotNo: 1, size: '中景', picture: '…', prompt: '', refs: [], episodeNo } as ShotFlowNode['data'],
  }
}

const seq = (id: string, source: string, target: string): Edge => ({
  id,
  source,
  target,
  className: 'pw-edge-sequence',
})

describe('outlineSplicePlan（§3.5 大纲拖拽落点 → 锚点换算）', () => {
  const nodes: CanvasNode[] = [
    sceneNode('s1', 1, 0),
    sceneNode('s2', 1, 100),
    sceneNode('x', 2, 300),
  ]
  const edges: Edge[] = [seq('e1', 's1', 's2')]

  it('行落点：锚点直通，返回 plan 与原 anchorId', () => {
    const got = outlineSplicePlan(nodes, edges, {}, 'x', {
      kind: 'row',
      anchorId: 's1',
      position: 'after',
    })
    expect(got?.anchorId).toBe('s1')
    expect(got?.plan.adds).toEqual([
      { source: 's1', target: 'x' },
      { source: 'x', target: 's2' },
    ])
  })

  it('行落点锚点即自身 / 非法（非剧情流成员）→ null', () => {
    expect(
      outlineSplicePlan(nodes, edges, {}, 'x', {
        kind: 'row',
        anchorId: 'x',
        position: 'after',
      }),
    ).toBeNull()
  })

  it('组尾落点：从该组最后一个剧情流行向上找可执行锚点', () => {
    const got = outlineSplicePlan(nodes, edges, {}, 'x', { kind: 'groupEnd', episode: 1 })
    // 组 1 最后一行是 s2（x 大者靠后），s2 是剧情流成员 → 锚 s2 之后
    expect(got?.anchorId).toBe('s2')
    expect(got?.plan.adds).toEqual([{ source: 's2', target: 'x' }])
  })

  it('组尾落点跳过不可锚行：末行是非剧情流成员时向上回退', () => {
    // s3 排在组尾但不在剧情流中；shot level 3 不参与锚定
    const withLoose: CanvasNode[] = [...nodes, sceneNode('s3', 1, 200), shotNodeOf('sh1', 1, 400)]
    const got = outlineSplicePlan(withLoose, edges, {}, 'x', { kind: 'groupEnd', episode: 1 })
    expect(got?.anchorId).toBe('s2')
  })

  it('组尾落点排除被拖节点自身；目标组不存在 → null', () => {
    const got = outlineSplicePlan(nodes, edges, {}, 'x', { kind: 'groupEnd', episode: 2 })
    // 组 2 只有 x 自己，被排除后无可锚行
    expect(got).toBeNull()
    expect(outlineSplicePlan(nodes, edges, {}, 'x', { kind: 'groupEnd', episode: 9 })).toBeNull()
  })
})

describe('spliceEdgesWith（大纲拖拽边重排的 redo/undo 变换）', () => {
  const base: Edge[] = [seq('e1', 'a', 'b'), seq('e2', 'b', 'c')]
  const removed: Edge[] = [seq('e1', 'a', 'b')]
  const added: Edge[] = [seq('n1', 'a', 'x'), seq('n2', 'x', 'b')]

  it('redo：去掉旧边、追加新边，其余保持', () => {
    expect(spliceEdgesWith(base, removed, added, true)).toEqual([
      seq('e2', 'b', 'c'),
      seq('n1', 'a', 'x'),
      seq('n2', 'x', 'b'),
    ])
  })

  it('undo：去掉新边、还原旧边', () => {
    const after = spliceEdgesWith(base, removed, added, true)
    expect(spliceEdgesWith(after, removed, added, false)).toEqual([
      seq('e2', 'b', 'c'),
      seq('e1', 'a', 'b'),
    ])
  })
})
