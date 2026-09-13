/**
 * 自动排布纯函数测试（issue #94）：分层方向、分支同层展开、分镜宿主下挂、
 * 不连通分区、确定性、环安全与不重叠不变量。只断言布局语义（相对次序、
 * 包围盒不相交、节点全覆盖），不断言具体像素值。
 */
import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { computeAutoLayout } from './autoLayout'
import type { CanvasNode } from './nodes/types'

type Size = { width: number; height: number }

const node = (id: string, type: string, x: number, y: number, measured?: Size) =>
  ({
    id,
    type,
    position: { x, y },
    data: {},
    ...(measured ? { measured } : {}),
  }) as unknown as CanvasNode

type EdgeExtra = { type?: 'branch'; sourceHandle?: string; className?: string }
const edge = (id: string, source: string, target: string, extra: EdgeExtra = {}): Edge => ({
  id,
  source,
  target,
  ...extra,
})

const seq = (source: string, target: string) => edge(`e-${source}-${target}`, source, target)
const branchEdge = (source: string, target: string, optionId: string) =>
  edge(`e-${source}-${optionId}-${target}`, source, target, {
    type: 'branch',
    sourceHandle: `option-${optionId}`,
  })
const attach = (source: string, target: string) =>
  edge(`e-${source}-shots-${target}`, source, target, { sourceHandle: 'shots' })

/** 包围盒相交判定：重叠面积在两轴均超过 1px 视为碰撞（边界相切允许）。 */
function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return dx > 1 && dy > 1
}

function assertNoOverlap(
  nodes: CanvasNode[],
  positions: Map<string, { x: number; y: number }>,
  fallback: Size,
) {
  const boxes = nodes.map((n) => {
    const p = positions.get(n.id)
    if (!p) throw new Error(`节点 ${n.id} 缺少布局结果`)
    const m = (n as { measured?: Size }).measured ?? fallback
    return { id: n.id, x: p.x, y: p.y, w: m.width, h: m.height }
  })
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(overlaps(boxes[i], boxes[j]), `节点 ${boxes[i].id} 与 ${boxes[j].id} 重叠`).toBe(false)
    }
  }
}

const SIZE: Size = { width: 340, height: 200 }

describe('computeAutoLayout（issue #94 自动排布）', () => {
  it('空画布返回空结果', () => {
    expect(computeAutoLayout([], [])).toEqual(new Map())
  })

  it('线性剧情按连线方向从左至右分层，且全覆盖原节点 id', () => {
    const nodes = [node('s3', 'scene', 1000, 0, SIZE), node('s1', 'scene', 0, 0, SIZE), node('s2', 'scene', 500, 500, SIZE)]
    const positions = computeAutoLayout(nodes, [seq('s1', 's2'), seq('s2', 's3')])
    expect([...positions.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(positions.get('s1')!.x).toBeLessThan(positions.get('s2')!.x)
    expect(positions.get('s2')!.x).toBeLessThan(positions.get('s3')!.x)
  })

  it('分支两选项同层纵向展开，汇合节点在其后一层', () => {
    const nodes = [
      node('br1', 'branch', 0, 0, SIZE),
      node('sa', 'scene', 600, -200, SIZE),
      node('sb', 'scene', 600, 300, SIZE),
      node('sc', 'scene', 1200, 0, SIZE),
    ]
    const edges = [branchEdge('br1', 'sa', 'o1'), branchEdge('br1', 'sb', 'o2'), seq('sa', 'sc'), seq('sb', 'sc')]
    const positions = computeAutoLayout(nodes, edges)
    const a = positions.get('sa')!
    const b = positions.get('sb')!
    expect(a.x).toBe(b.x)
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(SIZE.height)
    expect(positions.get('br1')!.x).toBeLessThan(a.x)
    expect(positions.get('sc')!.x).toBeGreaterThan(a.x)
    assertNoOverlap(nodes, positions, SIZE)
  })

  it('分镜卡下挂在宿主场景下方，不与宿主重叠', () => {
    const shotSize: Size = { width: 300, height: 260 }
    const nodes = [
      node('sc1', 'scene', 0, 0, SIZE),
      node('sh1', 'shot', 900, 900, shotSize),
      node('sh2', 'shot', 1300, 900, shotSize),
    ]
    const positions = computeAutoLayout(nodes, [attach('sc1', 'sh1'), attach('sc1', 'sh2')])
    const host = positions.get('sc1')!
    for (const id of ['sh1', 'sh2']) {
      const p = positions.get(id)!
      expect(p.y).toBeGreaterThanOrEqual(host.y + SIZE.height)
      expect(p.x).toBeGreaterThanOrEqual(host.x)
    }
    assertNoOverlap(nodes, positions, SIZE)
  })

  it('不连通子图与独立节点分区放置，互不重叠', () => {
    const nodes = [
      node('s1', 'scene', 0, 0, SIZE),
      node('s2', 'scene', 500, 0, SIZE),
      node('img1', 'image', 2000, 2000),
      node('bt1', 'beat', 2500, -500),
    ]
    const positions = computeAutoLayout(nodes, [seq('s1', 's2')])
    expect(positions.get('s1')!.x).toBeLessThan(positions.get('s2')!.x)
    assertNoOverlap(nodes, positions, { width: 300, height: 200 })
  })

  it('混合尺寸（长对白、图片等）整图不重叠', () => {
    const dlg: Size = { width: 360, height: 800 }
    const img: Size = { width: 300, height: 420 }
    const nodes = [
      node('s1', 'scene', 0, 0, SIZE),
      node('d1', 'dialogue', 500, 0, dlg),
      node('d2', 'dialogue', 500, 900, dlg),
      node('s2', 'scene', 1000, 0, SIZE),
      node('img1', 'image', 1500, 0, img),
    ]
    const positions = computeAutoLayout(nodes, [seq('s1', 'd1'), seq('s1', 'd2'), seq('d1', 's2')])
    assertNoOverlap(nodes, positions, SIZE)
  })

  it('相同图不同数组顺序得到相同布局（确定性）', () => {
    const nodes = [
      node('s1', 'scene', 0, 0, SIZE),
      node('s2', 'scene', 500, 0, SIZE),
      node('s3', 'scene', 1000, 0, SIZE),
      node('bt1', 'beat', 2000, 0),
    ]
    const edges = [seq('s1', 's2'), seq('s2', 's3')]
    const a = computeAutoLayout(nodes, edges)
    const b = computeAutoLayout([...nodes].reverse(), [...edges].reverse())
    expect(b).toEqual(a)
  })

  it('脏数据成环时安全终止，全部节点有位置且不重叠', () => {
    const nodes = [node('a', 'scene', 0, 0, SIZE), node('b', 'scene', 500, 0, SIZE), node('c', 'scene', 1000, 0, SIZE)]
    const edges = [seq('a', 'b'), seq('b', 'c'), seq('c', 'a')]
    const positions = computeAutoLayout(nodes, edges)
    expect([...positions.keys()].sort()).toEqual(['a', 'b', 'c'])
    assertNoOverlap(nodes, positions, SIZE)
  })

  it('节点缺 measured 时用回退尺寸完成整图计算', () => {
    const nodes = [node('s1', 'scene', 0, 0), node('d1', 'dialogue', 400, 400), node('sh1', 'shot', 800, 800)]
    const positions = computeAutoLayout(nodes, [seq('s1', 'd1')])
    expect([...positions.keys()].sort()).toEqual(['d1', 's1', 'sh1'])
    assertNoOverlap(nodes, positions, { width: 340, height: 220 })
  })

  it('第二个下挂宿主（脏数据）不产生重复布局目标', () => {
    const nodes = [
      node('sc1', 'scene', 0, 0, SIZE),
      node('sc2', 'scene', 500, 500, SIZE),
      node('sh1', 'shot', 900, 900, { width: 300, height: 260 }),
    ]
    const positions = computeAutoLayout(nodes, [attach('sc1', 'sh1'), attach('sc2', 'sh1')])
    expect([...positions.keys()].sort()).toEqual(['sc1', 'sc2', 'sh1'])
    assertNoOverlap(nodes, positions, SIZE)
  })
})
