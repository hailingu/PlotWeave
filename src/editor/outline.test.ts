import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { beatFulfillmentMap, buildOutlineGroups } from './outline'
import type { CanvasNode } from './nodes/types'

function node(partial: Record<string, unknown>): CanvasNode {
  return partial as unknown as CanvasNode
}

/** 两个集 + 未分集分镜的最小画布：场1、节拍 属集1；场2 属集2；场3 未分集。 */
function sampleNodes(): CanvasNode[] {
  return [
    node({ id: 's1', type: 'scene', position: { x: 10, y: 0 }, data: { name: '天台', sceneNo: 1, episodeNo: 1 } }),
    node({ id: 'b1', type: 'beat', position: { x: 0, y: 0 }, data: { name: '开端', tone: '压抑', episodeNo: 1 } }),
    node({ id: 's2', type: 'scene', position: { x: 20, y: 0 }, data: { name: '巷口', sceneNo: 2, episodeNo: 2 } }),
    node({ id: 's3', type: 'scene', position: { x: 30, y: 0 }, data: { name: '车站', sceneNo: 3 } }),
    node({ id: 'sh3', type: 'shot', position: { x: 32, y: 40 }, data: { shotNo: 1, size: '特写' } }),
  ]
}

const attachEdges: Edge[] = [{ id: 'e1', source: 's3', target: 'sh3', className: 'pw-edge-attach' }]

describe('buildOutlineGroups（§3.5 集 = 逻辑分类，大纲分组的唯一依据是 episodeNo）', () => {
  it('按集号分组升序排列，未分集殿底；标题取自 episodeTitles', () => {
    const groups = buildOutlineGroups(sampleNodes(), attachEdges, {
      1: '开端',
      2: '误会',
    })
    expect(groups.map((g) => g.episode)).toEqual([1, 2, null])
    expect(groups[0].title).toBe('开端')
    expect(groups[1].title).toBe('误会')
    expect(groups[2].title).toBe('')
    expect(groups[0].rows.map((r) => r.id)).toEqual(['b1', 's1']) // 组内仍按 x 排序
  })

  it('下挂分镜随宿主场景分集（attach 派生从属）', () => {
    const groups = buildOutlineGroups(sampleNodes(), attachEdges, {})
    const ungrouped = groups.find((g) => g.episode === null)
    expect(ungrouped?.rows.map((r) => r.id)).toContain('s3')
    expect(ungrouped?.rows.map((r) => r.id)).toContain('sh3')
  })

  it('完全没有 episodeNo 时只有一个未分集组（与旧大纲视图等价）', () => {
    const nodes = sampleNodes()
      .filter((n) => n.id !== 'sh3')
      .map((n) => ({ ...n, data: { ...n.data, episodeNo: undefined } })) as unknown as CanvasNode[]
    const groups = buildOutlineGroups(nodes, [], {})
    expect(groups).toHaveLength(1)
    expect(groups[0].episode).toBeNull()
    expect(groups[0].rows).toHaveLength(4)
  })

  it('行缩进层级与标签保持原大纲语义', () => {
    const groups = buildOutlineGroups(sampleNodes(), attachEdges, {})
    const all = groups.flatMap((g) => g.rows)
    const s1 = all.find((r) => r.id === 's1')
    const b1 = all.find((r) => r.id === 'b1')
    expect(s1?.level).toBe(1)
    expect(s1?.label).toBe('场 01 · 天台')
    expect(b1?.level).toBe(0)
  })
})

describe('beatFulfillmentMap（§3.5 节拍兑现：sequence 邻接派生，不落镜像字段）', () => {
  const n = (partial: Record<string, unknown>) => partial as unknown as CanvasNode
  const beat = (id: string) => n({ id, type: 'beat', position: { x: 0, y: 0 }, data: { name: id } })
  const scene = (id: string, sceneNo: number) =>
    n({ id, type: 'scene', position: { x: 0, y: 0 }, data: { name: `场景${id}`, sceneNo } })

  it('后邻场景承载 = 兑现', () => {
    const nodes = [beat('b'), scene('s', 3)]
    const edges: Edge[] = [{ id: 'e', source: 'b', target: 's', className: 'pw-edge-sequence' }]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toEqual({ status: 'fulfilled', sceneLabel: '场 03 · 场景s' })
  })

  it('前邻场景承载 = 兑现（出边优先于入边）', () => {
    const nodes = [scene('s1', 1), beat('b'), scene('s2', 2)]
    const edges: Edge[] = [
      { id: 'e1', source: 's1', target: 'b', className: 'pw-edge-sequence' },
      { id: 'e2', source: 'b', target: 's2', className: 'pw-edge-sequence' },
    ]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toMatchObject({ status: 'fulfilled', sceneLabel: '场 02 · 场景s2' })
  })

  it('邻接只有节拍 / 全无 sequence 边 = 待兑现；attach/branch 边不算', () => {
    const nodes = [beat('b'), beat('b2'), scene('s', 1)]
    const edges: Edge[] = [
      { id: 'e1', source: 'b', target: 'b2', className: 'pw-edge-sequence' },
      { id: 'e2', source: 's', target: 'b', sourceHandle: 'shots', className: 'pw-edge-attach' },
    ]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toEqual({ status: 'pending' })
    expect(map.get('b2')).toEqual({ status: 'pending' })
  })

  it('大纲行携带兑现徽标：待兑现行 pending，兑现行带场景标签', () => {
    const nodes = [beat('b1'), scene('s1', 1), beat('b2')]
    const edges: Edge[] = [{ id: 'e', source: 'b1', target: 's1', className: 'pw-edge-sequence' }]
    const groups = buildOutlineGroups(nodes, edges, {})
    const rows = groups.flatMap((g) => g.rows)
    expect(rows.find((r) => r.id === 'b1')?.beat).toMatchObject({
      pending: false,
      label: '场 01 · 场景s1',
    })
    expect(rows.find((r) => r.id === 'b2')?.beat).toEqual({ pending: true })
  })
})
