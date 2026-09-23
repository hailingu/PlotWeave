import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { GRAPH_DIGEST_MAX_CHARS, buildGraphDigest } from './graphDigest'
import type { CanvasNode, DialogueLine } from '../nodes/types'

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
    node({
      id: 'b1',
      type: 'beat',
      position: { x: 0, y: 0 },
      data: { name: '开端', tone: '压抑', episodeNo: 2 },
    }),
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
      data: {
        prompt: '追或不追？',
        options: [
          { id: 'o1', label: '追' },
          { id: 'o2', label: '不追' },
        ],
      },
    }),
    node({
      id: 'sh1',
      type: 'shot',
      position: { x: 200, y: 160 },
      data: {
        shotNo: 3,
        size: '特写',
        picture: '雨水',
        prompt: 'rain close-up',
        refs: [],
      },
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
    {
      id: 'e3',
      source: 's1',
      target: 'sh1',
      className: 'pw-edge-attach',
      sourceHandle: 'shots',
    },
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
    const orderLine = digest
      .split('\n')
      .findIndex((l) => l.includes('剧情流顺序'))
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

describe('buildGraphDigest 旁白/动作摘要（issue 73）', () => {
  it.each<{
    name: string
    lines: DialogueLine[]
    speech: number
    actions: number
  }>([
    { name: '空对白', lines: [], speech: 0, actions: 0 },
    {
      name: '仅旁白',
      lines: [{ id: 'a1', kind: 'action', text: '开场旁白' }],
      speech: 0,
      actions: 1,
    },
    {
      name: '混合对白',
      lines: [
        { id: 'l1', kind: 'line', speaker: 'c1', text: '别走', side: 'left' },
        { id: 'a1', kind: 'action', text: '动作与旁白' },
      ],
      speech: 1,
      actions: 1,
    },
  ])(
    '$name 分别统计台词与旁白/动作，全文仍按需读取',
    ({ lines, speech, actions }) => {
      const digest = buildGraphDigest(
        [
          {
            id: 'd1',
            type: 'dialogue',
            position: { x: 0, y: 0 },
            data: { name: '开场', lines },
          },
        ],
        [],
        {
          characters: [],
          locations: [],
          characterName: () => null,
          locationName: () => null,
        },
      )
      expect(digest).toContain(`${speech} 句`)
      expect(digest).toContain(`${actions} 条旁白/动作`)
      expect(digest).not.toContain('开场旁白')
      expect(digest).not.toContain('动作与旁白')
    },
  )
})

describe('buildGraphDigest 连线端点查找（issue #276：索引一次，随边数线性）', () => {
  const emptyResolvers = {
    characters: [],
    locations: [],
    characterName: () => null,
    locationName: () => null,
  }

  /** 场景链：N 个场景、N-1 条 sequence 边；节点 `id` 为计数访问器。 */
  function chain(n: number): {
    nodes: CanvasNode[]
    edges: Edge[]
    idReads: () => number
  } {
    let reads = 0
    const nodes = Array.from({ length: n }, (_, i) => {
      const id = `s${i}`
      return node({
        get id() {
          reads += 1
          return id
        },
        type: 'scene',
        position: { x: i, y: 0 },
        data: {
          name: `场${i}`,
          sceneNo: i + 1,
          interior: true,
          time: '日',
          synopsis: '',
          characterIds: [],
        },
      })
    })
    const edges: Edge[] = Array.from({ length: n - 1 }, (_, i) => ({
      id: `e${i}`,
      source: `s${i}`,
      target: `s${i + 1}`,
    }))
    return { nodes, edges, idReads: () => reads }
  }

  it('节点 id 访问量随 N+E 线性增长，不随 N×E 增长（确定性访问量）', () => {
    const small = chain(100)
    buildGraphDigest(small.nodes, small.edges, emptyResolvers)
    const large = chain(400)
    buildGraphDigest(large.nodes, large.edges, emptyResolvers)
    // 每节点固定次数（行文本 + 各索引构造）：O(N×E) 实现下 400 节点
    // 的读数量级为 8 万，线性实现为 N 的小常数倍
    expect(large.idReads()).toBeLessThanOrEqual(8 * 400)
    // 4 倍输入 → 读次数不超过约 4 倍（允许常数项）
    expect(large.idReads()).toBeLessThanOrEqual(4 * small.idReads() + 16)
  })

  it('重复 id：端点标签沿用首个匹配节点（既有 find 语义）', () => {
    const dup: CanvasNode[] = [
      node({
        id: 'x',
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: '先到', tone: '' },
      }),
      node({
        id: 'x',
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: '后到', tone: '' },
      }),
      node({
        id: 'y',
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: '终点', tone: '' },
      }),
    ]
    const digest = buildGraphDigest(
      dup,
      [{ id: 'e', source: 'x', target: 'y' }],
      emptyResolvers,
    )
    expect(digest).toContain('sequence: x → y（节拍·先到 → 节拍·终点）')
    expect(digest).not.toContain('节拍·后到 → ')
  })

  it('缺失端点：标签为 ?，不抛错', () => {
    const digest = buildGraphDigest(
      [],
      [{ id: 'e', source: 'ghost', target: 'nobody' }],
      emptyResolvers,
    )
    expect(digest).toContain('sequence: ghost → nobody（? → ?）')
  })
})

describe('摘要总量预算与节选降级（issue #275：每轮画布摘要不再无界）', () => {
  const resolvers = (
    characters = 0,
    locations = 0,
  ): Parameters<typeof buildGraphDigest>[2] => ({
    characters: Array.from({ length: characters }, (_, i) => ({
      id: `c${i + 1}`,
      name: `角色${i + 1}`,
    })),
    locations: Array.from({ length: locations }, (_, i) => ({
      id: `l${i + 1}`,
      name: `地点${i + 1}`,
    })),
    characterName: (id) => `角色${id.slice(1)}`,
    locationName: (id) => `地点${id.slice(1)}`,
  })

  /** issue #275 病态夹具：N 个 40 字梗概场景 + N-1 条剧情流边。 */
  function bigCanvas(n: number): { nodes: CanvasNode[]; edges: Edge[] } {
    const nodes: CanvasNode[] = Array.from({ length: n }, (_, i) =>
      node({
        id: `s${i + 1}`,
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name: `场${i + 1}`,
          sceneNo: i + 1,
          interior: true,
          time: '夜',
          synopsis: '雨'.repeat(40),
          characterIds: [],
        },
      }),
    )
    const edges: Edge[] = nodes.slice(1).map((target, i) => ({
      id: `e${i + 1}`,
      source: `s${i + 1}`,
      target: target.id,
      className: 'pw-edge-sequence',
    }))
    return { nodes, edges }
  }

  it('病态大画布（1200 节点/1199 边）被总量预算钉住，不再无界灌入上下文', () => {
    const { nodes, edges } = bigCanvas(1200)
    const digest = buildGraphDigest(nodes, edges, resolvers())
    expect(digest.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
  })

  it('数量超限的节选可识别：计数标记声明未列出量，已列条目保留稳定 id', () => {
    const { nodes, edges } = bigCanvas(1200)
    const digest = buildGraphDigest(nodes, edges, resolvers())
    // 首个节点完整在列（稳定 id 保留，get_node 可按 id 补读）
    expect(digest).toContain('- s1 场01·场1')
    // 未列出量有明确计数，不无提示删除
    expect(digest).toMatch(/另有 \d+ 个节点未列出/)
    expect(digest).toMatch(/另有 \d+ 条连线未列出/)
    expect(digest).toContain('get_node')
    // 被节选条目有可发现的补读路径（issue #275 评审）：标记指向 find_nodes
    expect(digest).toContain('find_nodes')
  })

  it('设定集清单同样按上限节选并带计数标记', () => {
    const digest = buildGraphDigest([], [], resolvers(300, 300))
    expect(digest).toContain('- 角色 c1 角色1')
    expect(digest).toMatch(/另有 \d+ 个角色未列出/)
    expect(digest).toMatch(/另有 \d+ 个地点未列出/)
    expect(digest).toContain('get_settings_snapshot')
  })

  it('预算内的画布不产生节选标记（既有行为不变）', () => {
    const { nodes, edges } = bigCanvas(8)
    const digest = buildGraphDigest(nodes, edges, resolvers(3, 3))
    expect(digest).not.toContain('未列出')
    expect(digest).not.toContain('已截断')
    expect(digest).toContain('- s8 场08·场8')
  })

  it('条数在上限内但拼接超总量时按字符硬上限截断并带截断标记', () => {
    const long: CanvasNode[] = Array.from({ length: 96 }, (_, i) =>
      node({
        id: `s${i + 1}`,
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name: `巨${'名'.repeat(500)}${i + 1}`,
          sceneNo: i + 1,
          interior: true,
          time: '',
          synopsis: '',
          characterIds: [],
        },
      }),
    )
    const digest = buildGraphDigest(long, [], resolvers())
    expect(digest.length).toBeLessThanOrEqual(GRAPH_DIGEST_MAX_CHARS)
    expect(digest).toMatch(/已截断约 \d+ 字符/)
    expect(digest).toContain('get_node')
  })
})
