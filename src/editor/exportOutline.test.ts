import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { buildExportOutline, summariseExportOutline } from './exportOutline'
import { branchOptionHandle } from './graphRules'
import type { CanvasNode } from './nodes/types'

/**
 * 导出大纲投影测试（issue #48，docs/ui-design.md §3.5）。
 * 覆盖检查项：集归属与标题、情节流（sequence）顺序、分支问句与全部选项去向、
 * 未连线选项、失效目标、汇合节点、未接入剧情流节点、attach 边不参与。
 */

/** 画布节点夹具：数据字段按需给足，React Flow 必填项由 as 收口。 */
const mk = (n: unknown): CanvasNode => n as CanvasNode

const scene = (id: string, x: number, sceneNo: number, name: string, episodeNo?: number): CanvasNode =>
  mk({
    id,
    type: 'scene',
    position: { x, y: 0 },
    data: { name, sceneNo, interior: false, time: '🌙 夜', synopsis: '', characterIds: [], episodeNo },
  })

const dialogue = (id: string, x: number, name: string, episodeNo?: number): CanvasNode =>
  mk({ id, type: 'dialogue', position: { x, y: 0 }, data: { name, lines: [], episodeNo } })

const beat = (id: string, x: number, name: string, tone: string, episodeNo?: number): CanvasNode =>
  mk({ id, type: 'beat', position: { x, y: 0 }, data: { name, tone, episodeNo } })

const branch = (
  id: string,
  x: number,
  prompt: string,
  options: Array<{ id: string; label: string }>,
  episodeNo?: number,
): CanvasNode =>
  mk({ id, type: 'branch', position: { x, y: 0 }, data: { prompt, options, episodeNo } })

const shot = (id: string, x: number, episodeNo?: number): CanvasNode =>
  mk({
    id,
    type: 'shot',
    position: { x, y: 200 },
    data: { shotNo: 1, size: '全景', picture: '', prompt: '', refs: [], episodeNo },
  })

const image = (id: string, x: number): CanvasNode =>
  mk({ id, type: 'image', position: { x, y: 0 }, data: { prompt: '', model: '', size: '', outputs: {} } })

const seq = (id: string, source: string, target: string): Edge =>
  ({ id, source, target, className: 'pw-edge-sequence' }) as Edge

const branchEdge = (id: string, source: string, optionId: string, target: string): Edge =>
  ({ id, source, sourceHandle: branchOptionHandle(optionId), target, type: 'branch' }) as Edge

const attach = (id: string, source: string, target: string): Edge =>
  ({ id, source, sourceHandle: 'shots', target, className: 'pw-edge-attach' }) as Edge

/** 标签行文本（结构化行序），便于按语义断言。 */
const labels = (nodes: CanvasNode[], edges: Edge[]): string[] =>
  buildExportOutline(nodes, edges, {}).flatMap((g) => g.rows.map((r) => r.text))

describe('buildExportOutline（导出大纲投影）', () => {
  it('按剧情流（sequence 边）排序，不按画布 x 坐标推断', () => {
    // 对白卡在画布上位于最右，但剧情流把它排在两个场景之间
    const nodes = [scene('s1', 0, 1, '开场'), dialogue('d1', 9000, '对白一'), scene('s2', 200, 2, '收束')]
    const edges = [seq('e1', 's1', 'd1'), seq('e2', 'd1', 's2')]
    expect(labels(nodes, edges)).toEqual(['场 01 · 开场 · 入口', '对白 · 对白一', '场 02 · 收束'])
  })

  it('分支行列出问句与全部选项去向，未连线的选项显式标注', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      branch('b1', 100, '要不要坦白？', [
        { id: 'o1', label: '坦白' },
        { id: 'o2', label: '隐瞒' },
        { id: 'o3', label: '沉默' },
      ]),
      scene('s2', 200, 2, '天台对峙'),
    ]
    const edges = [seq('e1', 's1', 'b1'), branchEdge('b1-o1', 'b1', 'o1', 's2')]
    expect(labels(nodes, edges)).toEqual([
      '场 01 · 开场 · 入口',
      '分支 · 要不要坦白？',
      '坦白 → 场 02 · 天台对峙',
      '隐瞒 → （未连线）',
      '沉默 → （未连线）',
      '场 02 · 天台对峙',
    ])
  })

  it('选项目标已删除时标注失效，引用不静默丢失', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      branch('b1', 100, '往哪走？', [{ id: 'o1', label: '向左' }]),
    ]
    const edges = [seq('e1', 's1', 'b1'), branchEdge('b1-o1', 'b1', 'o1', 'ghost')]
    expect(labels(nodes, edges)).toContain('向左 → （目标已删除）')
  })

  it('多路径汇合：汇合节点只出现一次并标注汇入路径数，不重复平铺', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      branch('b1', 100, '分岔？', [
        { id: 'o1', label: '走 A' },
        { id: 'o2', label: '走 B' },
      ]),
      scene('s2', 200, 2, 'A 线'),
      scene('s3', 300, 3, 'B 线'),
      scene('s4', 400, 4, '汇合'),
    ]
    const edges = [
      seq('e1', 's1', 'b1'),
      branchEdge('b1-o1', 'b1', 'o1', 's2'),
      branchEdge('b1-o2', 'b1', 'o2', 's3'),
      seq('e4', 's2', 's4'),
      seq('e5', 's3', 's4'),
    ]
    const out = labels(nodes, edges)
    // 主线先展开 A 线：汇合点只出现一次并标注两条路径，B 线随后按 x 序展开
    expect(out).toEqual([
      '场 01 · 开场 · 入口',
      '分支 · 分岔？',
      '走 A → 场 02 · A 线',
      '走 B → 场 03 · B 线',
      '场 02 · A 线',
      '场 04 · 汇合 · 汇合 2 条路径',
      '场 03 · B 线',
    ])
  })

  it('无入边的多个入口按画布 x 序依次展开', () => {
    const nodes = [scene('s2', 300, 2, '第二条'), scene('s1', 100, 1, '第一条')]
    expect(labels(nodes, [])).toEqual(['场 01 · 第一条', '场 02 · 第二条'])
  })

  it('未接入剧情流的节点在组内末尾显式列出，不被静默丢弃', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      scene('s2', 100, 2, '接续'),
      scene('s9', 200, 9, '孤立场'),
    ]
    const out = labels(nodes, [seq('e1', 's1', 's2')])
    expect(out).toEqual(['场 01 · 开场 · 入口', '场 02 · 接续', '（未接入剧情流）', '场 09 · 孤立场'])
  })

  it('全部入口并列时仍按 x 序展开，与画布位置一致', () => {
    const nodes = [scene('s8', 500, 8, '后写'), scene('s1', 0, 1, '先写')]
    expect(labels(nodes, [])).toEqual(['场 01 · 先写', '场 08 · 后写'])
  })

  it('集按升序分组、未分集殿底，集标题与集号进入分组头', () => {
    const nodes = [
      scene('s2', 0, 2, '二集场', 2),
      scene('s1', 100, 1, '一集场', 1),
      scene('s0', 200, 3, '未分集场'),
    ]
    const groups = buildExportOutline(nodes, [seq('e1', 's1', 's2')], { 1: '立势', 2: '摊牌' })
    expect(groups.map((g) => [g.episode, g.title])).toEqual([
      [1, '立势'],
      [2, '摊牌'],
      [null, ''],
    ])
    expect(groups[0].rows.map((r) => r.text)).toEqual(['场 01 · 一集场'])
  })

  it('跨集选项目标仍出可读名称，选项只列在其所属分支下', () => {
    const nodes = [
      scene('s1', 0, 1, '开场', 1),
      branch(
        'b1',
        100,
        '要不要续下去？',
        [
          { id: 'o1', label: '续' },
          { id: 'o2', label: '停' },
        ],
        1,
      ),
      scene('s2', 200, 2, '二集开场', 2),
    ]
    const groups = buildExportOutline(nodes, [seq('e1', 's1', 'b1'), branchEdge('b1-o1', 'b1', 'o1', 's2')], {})
    expect(groups.map((g) => g.episode)).toEqual([1, 2])
    expect(groups[0].rows.map((r) => r.text)).toEqual([
      '场 01 · 开场 · 入口',
      '分支 · 要不要续下去？',
      '续 → 场 02 · 二集开场',
      '停 → （未连线）',
    ])
    // 二集组：目标节点只作本集入口出现一次，不因分支去向重复平铺
    expect(groups[1].rows.map((r) => r.text)).toEqual(['场 02 · 二集开场'])
  })

  it('同一选项连向多个目标时逐个列出，不静默丢弃（review #81）', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      branch('b1', 100, '往哪走？', [{ id: 'o1', label: '向左' }]),
      scene('s2', 200, 2, '左路'),
      scene('s3', 300, 3, '左路支线'),
    ]
    // 同一 option 句柄挂两条边：isDuplicateEdge 含 target，交互与落盘模型均允许
    const edges = [
      seq('e1', 's1', 'b1'),
      branchEdge('b1-o1a', 'b1', 'o1', 's2'),
      branchEdge('b1-o1b', 'b1', 'o1', 's3'),
    ]
    expect(labels(nodes, edges)).toContain('向左 → 场 02 · 左路 / 场 03 · 左路支线')
  })

  it('选项目标为节奏卡时沿用其兑现状态，同一导出内不自相矛盾（review #81）', () => {
    const nodes = [
      scene('s1', 0, 1, '开场'),
      branch('b1', 100, '停顿？', [{ id: 'o1', label: '停顿' }]),
      beat('bt1', 200, '留白', '舒缓'),
      scene('s2', 300, 2, '承载场'),
    ]
    const edges = [
      seq('e1', 's1', 'b1'),
      branchEdge('b1-o1', 'b1', 'o1', 'bt1'),
      seq('e2', 'bt1', 's2'),
    ]
    const out = labels(nodes, edges)
    expect(out).toContain('停顿 → 节拍 · 留白 · 舒缓 · ✓ 兑现于 场 02 · 承载场')
    expect(out).not.toContain('停顿 → 节拍 · 留白 · 舒缓 · 待兑现')
  })

  it('attach 下挂边不进入剧情流，分镜与图片节点不出现在大纲', () => {
    const nodes = [scene('s1', 0, 1, '开场'), scene('s2', 100, 2, '接续'), shot('sh1', 50), image('im1', 60)]
    const edges = [attach('a1', 's1', 'sh1'), seq('e1', 's1', 's2')]
    const out = labels(nodes, edges)
    expect(out).toEqual(['场 01 · 开场 · 入口', '场 02 · 接续'])
    expect(out.join()).not.toContain('SHOT')
  })

  it('节奏卡带基调；兑现状态沿用 sequence 邻接派生', () => {
    const nodes = [
      beat('bt1', 0, '立势', '压抑', 1),
      scene('s1', 100, 1, '天台夜话', 1),
      beat('bt2', 200, '反转', '', 1),
    ]
    const out = labels(nodes, [seq('e1', 'bt1', 's1')])
    expect(out).toContain('节拍 · 立势 · 压抑 · ✓ 兑现于 场 01 · 天台夜话 · 入口')
    expect(out).toContain('节拍 · 反转 · 待兑现')
  })

  it('只有节奏卡的集仍输出大纲行', () => {
    const nodes = [beat('bt1', 0, '留白', '舒缓', 3)]
    expect(labels(nodes, [])).toEqual(['节拍 · 留白 · 舒缓 · 待兑现'])
  })

  it('空画布返回空数组', () => {
    expect(buildExportOutline([], [], {})).toEqual([])
  })
})

describe('summariseExportOutline（导出范围概要）', () => {
  it('统计集/场/对白/节拍/分支与大纲可用性', () => {
    const nodes = [
      beat('bt1', 0, '立势', '压抑', 1),
      scene('s1', 100, 1, '开场', 1),
      dialogue('d1', 200, '对白', 1),
      branch('b1', 300, '分岔？', [{ id: 'o1', label: '走 A' }], 1),
      scene('s2', 400, 2, '未分集场'),
    ]
    expect(summariseExportOutline(nodes)).toEqual({
      episodes: [1],
      scenes: 2,
      dialogues: 1,
      beats: 1,
      branches: 1,
      hasOutline: true,
    })
  })

  it('只含场景与对白时 hasOutline 为 false；空画布亦然', () => {
    expect(summariseExportOutline([scene('s1', 0, 1, '开场')]).hasOutline).toBe(false)
    expect(summariseExportOutline([])).toEqual({
      episodes: [],
      scenes: 0,
      dialogues: 0,
      beats: 0,
      branches: 0,
      hasOutline: false,
    })
  })
})
