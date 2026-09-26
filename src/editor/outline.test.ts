import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { beatFulfillmentMap, buildOutlineGroups } from './outline'
import { buildExportOutline } from './exportOutline'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import type { CanvasNode } from './nodes/types'

function node(partial: Record<string, unknown>): CanvasNode {
  return partial as unknown as CanvasNode
}

/** 两个集 + 未分集分镜的最小画布：场1、节拍 属集1；场2 属集2；场3 未分集。 */
function sampleNodes(): CanvasNode[] {
  return [
    node({
      id: 's1',
      type: 'scene',
      position: { x: 10, y: 0 },
      data: { name: '天台', sceneNo: 1, episodeNo: 1 },
    }),
    node({
      id: 'b1',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '开端', tone: '压抑', episodeNo: 1 },
    }),
    node({
      id: 's2',
      type: 'scene',
      position: { x: 20, y: 0 },
      data: { name: '巷口', sceneNo: 2, episodeNo: 2 },
    }),
    node({
      id: 's3',
      type: 'scene',
      position: { x: 30, y: 0 },
      data: { name: '车站', sceneNo: 3 },
    }),
    node({
      id: 'sh3',
      type: 'shot',
      position: { x: 32, y: 40 },
      data: { shotNo: 1, size: '特写' },
    }),
  ]
}

const attachEdges: Edge[] = [
  { id: 'e1', source: 's3', target: 'sh3', className: 'pw-edge-attach' },
]

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
      .map((n) => ({
        ...n,
        data: { ...n.data, episodeNo: undefined },
      })) as unknown as CanvasNode[]
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
  const n = (partial: Record<string, unknown>) =>
    partial as unknown as CanvasNode
  const beat = (id: string) =>
    n({ id, type: 'beat', position: { x: 0, y: 0 }, data: { name: id } })
  const scene = (id: string, sceneNo: number) =>
    n({
      id,
      type: 'scene',
      position: { x: 0, y: 0 },
      data: { name: `场景${id}`, sceneNo },
    })

  it('后邻场景承载 = 兑现', () => {
    const nodes = [beat('b'), scene('s', 3)]
    const edges: Edge[] = [
      { id: 'e', source: 'b', target: 's', className: 'pw-edge-sequence' },
    ]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toEqual({
      status: 'fulfilled',
      sceneLabel: '场 03 · 场景s',
    })
  })

  it('前邻场景承载 = 兑现（出边优先于入边）', () => {
    const nodes = [scene('s1', 1), beat('b'), scene('s2', 2)]
    const edges: Edge[] = [
      { id: 'e1', source: 's1', target: 'b', className: 'pw-edge-sequence' },
      { id: 'e2', source: 'b', target: 's2', className: 'pw-edge-sequence' },
    ]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toMatchObject({
      status: 'fulfilled',
      sceneLabel: '场 02 · 场景s2',
    })
  })

  it('邻接只有节拍 / 全无 sequence 边 = 待兑现；attach/branch 边不算', () => {
    const nodes = [beat('b'), beat('b2'), scene('s', 1)]
    const edges: Edge[] = [
      { id: 'e1', source: 'b', target: 'b2', className: 'pw-edge-sequence' },
      {
        id: 'e2',
        source: 's',
        target: 'b',
        sourceHandle: 'shots',
        className: 'pw-edge-attach',
      },
    ]
    const map = beatFulfillmentMap(nodes, edges)
    expect(map.get('b')).toEqual({ status: 'pending' })
    expect(map.get('b2')).toEqual({ status: 'pending' })
  })

  it('大纲行携带兑现徽标：待兑现行 pending，兑现行带场景标签', () => {
    const nodes = [beat('b1'), scene('s1', 1), beat('b2')]
    const edges: Edge[] = [
      { id: 'e', source: 'b1', target: 's1', className: 'pw-edge-sequence' },
    ]
    const groups = buildOutlineGroups(nodes, edges, {})
    const rows = groups.flatMap((g) => g.rows)
    expect(rows.find((r) => r.id === 'b1')?.beat).toMatchObject({
      pending: false,
      label: '场 01 · 场景s1',
    })
    expect(rows.find((r) => r.id === 'b2')?.beat).toEqual({ pending: true })
  })
})

describe('剧情流线性序（issue #340：拖拽重排连线后列表与导出一致）', () => {
  const scene = (id: string, x: number, sceneNo: number, episodeNo?: number) =>
    node({
      id,
      type: 'scene',
      position: { x, y: 0 },
      data: {
        name: id,
        sceneNo,
        ...(episodeNo !== undefined ? { episodeNo } : {}),
      },
    })
  const seq = (id: string, source: string, target: string): Edge => ({
    id,
    source,
    target,
    className: 'pw-edge-sequence',
  })
  const rowsOf = (nodes: CanvasNode[], edges: Edge[]) =>
    buildOutlineGroups(nodes, edges, {}).flatMap((g) => g.rows.map((r) => r.id))

  it('重排连线后列表按连线序输出（issue #340 三场景例）', () => {
    // x 序 s1(100)/s2(200)/s3(300)，拖 s3 到 s1 前后连线为 s3→s1→s2：
    // 左侧列表必须反映重排，不得沿用画布 x 序
    const nodes = [
      scene('s1', 100, 1),
      scene('s2', 200, 2),
      scene('s3', 300, 3),
    ]
    const edges = [seq('e1', 's3', 's1'), seq('e2', 's1', 's2')]
    expect(rowsOf(nodes, edges)).toEqual(['s3', 's1', 's2'])
  })

  it('未接入剧情流的节点分区殿后（与附录一致），分镜行随宿主场景', () => {
    // issue #340 评审：与创作大纲附录同分区——先剧情流路由序，
    // 未接入成员（无任何叙事边）殿后按 x/id 稳定回退，不按 x 交织
    const nodes: CanvasNode[] = [
      scene('s1', 100, 1),
      scene('s2', 200, 2),
      scene('s3', 300, 3),
      node({
        id: 'loose',
        type: 'scene',
        position: { x: 50, y: 0 },
        data: { name: '孤立', sceneNo: 9 },
      }),
      node({
        id: 'sh1',
        type: 'shot',
        position: { x: 105, y: 40 },
        data: { shotNo: 1, size: '特写' },
      }),
    ]
    const edges: Edge[] = [
      seq('e1', 's3', 's1'),
      seq('e2', 's1', 's2'),
      { id: 'a1', source: 's1', target: 'sh1', className: 'pw-edge-attach' },
    ]
    // attach 派生从属：sh1 被宿主 s1 约束，重排后仍紧随其后
    expect(rowsOf(nodes, edges)).toEqual(['s3', 's1', 'sh1', 's2', 'loose'])
  })

  it('分镜以宿主块插放：不与下一叙事节点竞争 x 序（issue #340 评审二轮）', () => {
    // s1→s2 且 s2.x=100、分镜 x=300：宿主解锁后分镜若参与就绪 x 竞争
    // 会被 s2 越过，level-3 行脱离宿主视觉归属——必须紧随宿主输出
    const nodes: CanvasNode[] = [
      node({
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        data: { name: 's1', sceneNo: 1 },
      }),
      node({
        id: 's2',
        type: 'scene',
        position: { x: 100, y: 0 },
        data: { name: 's2', sceneNo: 2 },
      }),
      node({
        id: 'sh1',
        type: 'shot',
        position: { x: 300, y: 40 },
        data: { shotNo: 1, size: '特写' },
      }),
    ]
    const edges: Edge[] = [
      seq('e1', 's1', 's2'),
      { id: 'a1', source: 's1', target: 'sh1', className: 'pw-edge-attach' },
    ]
    expect(rowsOf(nodes, edges)).toEqual(['s1', 'sh1', 's2'])
  })

  it('未接入宿主的分镜同样以宿主块插放，不按 x 独立排序（issue #340 评审二轮）', () => {
    const nodes: CanvasNode[] = [
      node({
        id: 'loose',
        type: 'scene',
        position: { x: 300, y: 0 },
        data: { name: '孤立', sceneNo: 9 },
      }),
      node({
        id: 'host2',
        type: 'scene',
        position: { x: 400, y: 0 },
        data: { name: '宿主2', sceneNo: 10 },
      }),
      node({
        id: 'sh2',
        type: 'shot',
        position: { x: 50, y: 40 },
        data: { shotNo: 1, size: '全景' },
      }),
    ]
    const edges: Edge[] = [
      { id: 'a2', source: 'host2', target: 'sh2', className: 'pw-edge-attach' },
    ]
    // detached 内 host2 的分镜若独立按 x 序会跑到最前——按宿主块插放
    expect(rowsOf(nodes, edges)).toEqual(['loose', 'host2', 'sh2'])
  })

  it('跨集路径不把依赖带入集内行序（附录同款集内边范围）', () => {
    // issue #340 评审：s1(ep1)→s2(ep2)→s3(ep1) 的路径端点跨集，集 1 组内
    // 无约束边——两成员按 x 序输出（s3 x100 先于 s1 x200），与附录一致
    const nodes = [
      scene('s3', 100, 3, 1),
      scene('s1', 200, 1, 1),
      scene('s2', 300, 2, 2),
    ]
    const edges = [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')]
    const groups = buildOutlineGroups(nodes, edges, {})
    expect(groups.find((g) => g.episode === 1)?.rows.map((r) => r.id)).toEqual([
      's3',
      's1',
    ])
    expect(groups.find((g) => g.episode === 2)?.rows.map((r) => r.id)).toEqual([
      's2',
    ])
  })

  it('部分接线画布：列表行序与创作大纲附录分区一致（issue #340 评审）', () => {
    const nodes: CanvasNode[] = [
      scene('s1', 100, 1),
      scene('s2', 200, 2),
      scene('s3', 300, 3),
      node({
        id: 'loose',
        type: 'scene',
        position: { x: 50, y: 0 },
        data: { name: '孤立', sceneNo: 9 },
      }),
    ]
    const edges = [seq('e1', 's3', 's1'), seq('e2', 's1', 's2')]
    // 列表：路由序在前、未接入殿后
    expect(rowsOf(nodes, edges)).toEqual(['s3', 's1', 's2', 'loose'])
    // 附录：同分区（标记行除外），行序一致（「入口」等后缀标注不影响序）
    const appendixRows = buildExportOutline(nodes, edges, {})
      .flatMap((g) => g.rows)
      .filter((r) => r.text.startsWith('场 '))
      .map((r) => r.text.split(' · ').slice(0, 2).join(' · '))
    expect(appendixRows).toEqual([
      '场 03 · s3',
      '场 01 · s1',
      '场 02 · s2',
      '场 09 · 孤立',
    ])
  })

  it('拖拽计划的 undo 恢复列表连线序（issue #340 验收：undo 一致）', () => {
    // 与 issue 复现同构：真实 outlineSplicePlan + spliceEdgesWith 应用重排
    const nodes = [
      scene('s1', 100, 1),
      scene('s2', 200, 2),
      scene('s3', 300, 3),
    ]
    const edges = [seq('e1', 's1', 's2'), seq('e2', 's2', 's3')]
    const planned = outlineSplicePlan(nodes, edges, {}, 's3', {
      kind: 'row',
      anchorId: 's1',
      position: 'before',
    })
    expect(planned).not.toBeNull()
    const removed = edges.filter((e) => planned!.plan.removes.includes(e.id))
    const redoEdges = spliceEdgesWith(
      edges,
      removed,
      planned!.plan.adds.map(({ source, target }) => ({
        ...seq(`new-${source}-${target}`, source, target),
      })),
      true,
    )
    expect(rowsOf(nodes, redoEdges)).toEqual(['s3', 's1', 's2'])
    // undo 还原旧边 → 列表回到原连线序
    const undoEdges = spliceEdgesWith(
      edges,
      removed,
      planned!.plan.adds.map(({ source, target }) => ({
        ...seq(`new-${source}-${target}`, source, target),
      })),
      false,
    )
    expect(rowsOf(nodes, undoEdges)).toEqual(['s1', 's2', 's3'])
  })
})
