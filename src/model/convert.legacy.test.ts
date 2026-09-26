/**
 * schemaVersion 0 迁移路径测试（§11.1 迁移链）：键控身份的数组语义保全、
 * v0 图形容器/成员异型预归一化、节点嵌套形状与基础布局预归一化、options
 * 槽位保序、v0 字段优先级与头像预过滤——损坏旧档按可修复数据对待。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { NOW } from './convertFixtures'

describe('schemaVersion 0 迁移：分支选项键控身份的数组语义保全（§11.1 迁移链，重复/空白 id 先于句柄改写修复）', () => {
  it('分支选项重复/空白 id 在迁移期重发，下标句柄仍绑定原数组位的选项', () => {
    const v0 = {
      schemaVersion: 0,
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: {
        nodes: [
          {
            id: 'br1',
            type: 'branch',
            position: { x: 0, y: 0 },
            data: {
              prompt: '去哪',
              options: [
                { id: 'opt-dup', label: '左' },
                { id: 'opt-dup', label: '右' }, // 与首见重复
                { id: '', label: '中' }, // 空白 id
              ],
            },
          },
          {
            id: 's1',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' },
          },
          {
            id: 's2',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: { name: '场二', sceneNo: 2, interior: true, synopsis: '' },
          },
          {
            id: 's3',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: { name: '场三', sceneNo: 3, interior: true, synopsis: '' },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'br1',
            target: 's1',
            sourceHandle: 'option-0',
            type: 'branch',
            data: { optionLabel: '左' },
          },
          {
            id: 'e2',
            source: 'br1',
            target: 's2',
            sourceHandle: 'option-1',
            type: 'branch',
            data: { optionLabel: '右' },
          },
          {
            id: 'e3',
            source: 'br1',
            target: 's3',
            sourceHandle: 'option-2',
            type: 'branch',
            data: { optionLabel: '中' },
          },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    const br = round.content.nodes.find((n) => n.id === 'br1')!
    const options = (br.data as { options: { id: string; label: string }[] })
      .options
    // 三个选项都保留，id 唯一且非空
    expect(options.map((o) => o.label)).toEqual(['左', '右', '中'])
    expect(new Set(options.map((o) => o.id)).size).toBe(3)
    // 下标句柄按原数组位绑定：e2 必须仍指向「右」（重发后的新 id），
    // 不得因 v1 归一化二次重发而滑向首见选项
    const e1 = round.content.edges.find((e) => e.id === 'e1')!
    const e2 = round.content.edges.find((e) => e.id === 'e2')!
    const e3 = round.content.edges.find((e) => e.id === 'e3')!
    expect(e1.sourceHandle).toBe(`option-${options[0].id}`)
    expect(e2.sourceHandle).toBe(`option-${options[1].id}`)
    expect(e3.sourceHandle).toBe(`option-${options[2].id}`)
    // 运行态 branch 边不落 optionLabel 镜像（issue #18）：胶囊文案由
    // BranchEdge 按 sourceHandle 实时派生，data 仅剩可选 order
    expect(e2.data).toBeUndefined()
    expect(e3.data).toBeUndefined()
  })
})

describe('schemaVersion 0 迁移：设定集数组键控身份的语义保全（§11.1 迁移链，重复/空白 id 保首见）', () => {
  it('设定集数组重复/空白 id 在迁移期重发（保首见）：实体不丢，引用仍指首见实体', () => {
    const v0 = {
      schemaVersion: 0,
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: {
        nodes: [
          {
            id: 's1',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: {
              name: '场一',
              sceneNo: 1,
              interior: true,
              synopsis: '',
              characterIds: ['ch-dup'],
              locationId: 'loc-dup',
            },
          },
        ],
        edges: [],
      },
      settings: {
        characters: [
          { id: 'ch-dup', name: '甲', gradient: 'g1' },
          { id: 'ch-dup', name: '乙', gradient: 'g2' }, // 与首见重复
          { id: '', name: '丙', gradient: 'g3' }, // 空白 id
        ],
        locations: [
          { id: 'loc-dup', name: '天台' },
          { id: 'loc-dup', name: '地下室' }, // 与首见重复
        ],
      },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    // 实体一个不丢，id 唯一；首见实体保留原 id
    const chars = round.content.settings.characters
    expect(chars.map((c) => c.name)).toEqual(['甲', '乙', '丙'])
    expect(new Set(chars.map((c) => c.id)).size).toBe(3)
    expect(chars[0].id).toBe('ch-dup')
    const locs = round.content.settings.locations
    expect(locs.map((l) => l.name)).toEqual(['天台', '地下室'])
    expect(locs[0].id).toBe('loc-dup')
    // 数组语义下引用命中首见实体：ch-dup/loc-dup 仍指 甲/天台，无悬空警告
    const s1 = round.content.nodes.find((n) => n.id === 's1')!
    const spec = s1.data as { characterIds: string[]; locationId?: string }
    expect(spec.characterIds).toEqual(['ch-dup'])
    expect(spec.locationId).toBe('loc-dup')
    expect(
      round.warnings.some(
        (w) => w.includes('不存在的角色') || w.includes('不存在的地点'),
      ),
    ).toBe(false)
  })
})

/** 容器/成员异型用例的场景节点（模块级供 GRAPH_CONTAINER_CASES 使用）。 */
const sceneNode = (id: string) => ({
  id,
  type: 'scene',
  position: { x: 0, y: 0 },
  data: { name: id, sceneNo: 1, interior: true, synopsis: '' },
})

// 容器/成员损坏家族共用「按损坏范围收敛 + 容器名警告 + 项目照常打开」
// 模板（issue #291 参数化；表置于模块级以符合套件回调 80 代码行上限）。
const GRAPH_CONTAINER_CASES: ReadonlyArray<
  [string, { nodes: unknown; edges: unknown }, string[], string[], string]
> = [
  [
    'graph.nodes 为字符串容器',
    { nodes: 'oops', edges: [] },
    [],
    [],
    'graph.nodes',
  ],
  [
    'graph.nodes 含 null 成员',
    { nodes: [null, sceneNode('s1')], edges: [] },
    ['s1'],
    [],
    'graph.nodes',
  ],
  [
    'graph.edges 为数字容器',
    { nodes: [sceneNode('s1')], edges: 42 },
    ['s1'],
    [],
    'graph.edges',
  ],
  [
    'graph.edges 含字符串成员',
    {
      nodes: [sceneNode('s1'), sceneNode('s2')],
      edges: [{ id: 'e1', source: 's1', target: 's2' }, 'garbage'],
    },
    ['s1', 's2'],
    ['e1'],
    'graph.edges',
  ],
]

describe('归一化：v0 图形容器/成员异型先修复再迁移（§11.1，损坏旧档仍可打开）', () => {
  const v0Base = (graph: unknown) => ({
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph,
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })

  it.each(GRAPH_CONTAINER_CASES)(
    '%s：按范围收敛并警告，项目照常打开',
    (_label, graph, nodeIds, edgeIds, warn) => {
      const round = parseProject(v0Base(graph))
      expect(round.migrated).toBe(true)
      expect(round.content.nodes.map((n) => n.id)).toEqual(nodeIds)
      expect(round.content.edges.map((e) => e.id)).toEqual(edgeIds)
      expect(round.warnings.some((w) => w.includes(warn))).toBe(true)
    },
  )
})

// 节点嵌套形状损坏家族共用「损坏按节点/字段点名 + 项目照常打开」模板，
// 行级 verify 保留各自的存活/成员保留断言（issue #291 参数化；表置于模块
// 级以符合套件回调 80 代码行上限）。
const NESTED_SHAPE_CASES: ReadonlyArray<
  [
    string,
    unknown[],
    string,
    string,
    string[],
    (round: ReturnType<typeof parseProject>) => void,
  ]
> = [
  [
    'dialogue 节点 data 为 null：重置为空对象、lines 置空',
    [
      { id: 'd1', type: 'dialogue', position: { x: 0, y: 0 }, data: null },
      {
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' },
      },
    ],
    'd1',
    'data',
    ['s1'],
    () => {},
  ],
  [
    'dialogue 的 lines 为字符串：重置为空数组，不因 map 崩溃',
    [
      {
        id: 'd1',
        type: 'dialogue',
        position: { x: 0, y: 0 },
        data: { lines: 'oops', name: '对白' },
      },
    ],
    'd1',
    'lines',
    ['d1'],
    () => {},
  ],
  [
    'branch 的 options 含 null 成员：丢弃，合法选项与下标句柄改写不受影响',
    [
      {
        id: 'br1',
        type: 'branch',
        position: { x: 0, y: 0 },
        data: {
          prompt: '去哪',
          options: [{ id: 'opt-a', label: '左' }, null],
        },
      },
    ],
    'br1',
    'options',
    ['br1'],
    (round) => {
      const br = round.content.nodes.find((n) => n.id === 'br1')
      const options = (
        br?.data as { options: Array<{ id: string; label: string }> }
      ).options
      expect(options.map((o) => o.id)).toEqual(['opt-a'])
    },
  ],
  [
    'shot 的 refs 含字符串成员：丢弃，对象成员保留',
    [
      {
        id: 'sh1',
        type: 'shot',
        position: { x: 0, y: 0 },
        data: {
          shotNo: 1,
          size: '特写',
          picture: '',
          prompt: '',
          refs: ['garbage', { kind: 'character' as const, label: '图' }],
        },
      },
    ],
    'sh1',
    'refs',
    ['sh1'],
    (round) => {
      const refs = (
        round.content.nodes.find((n) => n.id === 'sh1')?.data as {
          refs: unknown[]
        }
      ).refs
      expect(refs).toHaveLength(1)
    },
  ],
]

describe('归一化：v0 节点嵌套形状预归一化（迁移器解引用前置，损坏单节点不阻断整档）', () => {
  const v0Base = (nodes: unknown[]) => ({
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph: { nodes, edges: [] },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })

  it.each(NESTED_SHAPE_CASES)(
    '%s：损坏按节点/字段点名并警告，项目照常打开',
    (_label, nodes, id, field, survivors, verify) => {
      const round = parseProject(v0Base(nodes))
      const ids = round.content.nodes.map((n) => n.id)
      for (const survivor of survivors) {
        expect(ids).toContain(survivor)
      }
      expect(
        round.warnings.some((w) => w.includes(id) && w.includes(field)),
      ).toBe(true)
      verify(round)
    },
  )
})

describe('归一化：v0 options 槽位保序与设定集成员字段容错（§11.1 ①/迁移器解引用前置）', () => {
  const v0Doc = (nodes: unknown[], edges: unknown[]) => ({
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph: { nodes, edges },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })
  const scene = (id: string) => ({
    id,
    type: 'scene',
    position: { x: 0, y: 0 },
    data: { name: id, sceneNo: 1, interior: true, synopsis: '' },
  })

  it('options 含 null 槽位：指向该槽位的旧下标连线按孤儿边隔离，不滑向后一选项', () => {
    const round = parseProject(
      v0Doc(
        [
          {
            id: 'br1',
            type: 'branch',
            position: { x: 0, y: 0 },
            data: { prompt: '去哪', options: [null, { label: 'B' }] },
          },
          scene('s1'),
        ],
        [
          {
            id: 'e0',
            source: 'br1',
            target: 's1',
            sourceHandle: 'option-0',
            type: 'branch',
            data: { optionLabel: '已删' },
          },
          {
            id: 'e1',
            source: 'br1',
            target: 's1',
            sourceHandle: 'option-1',
            type: 'branch',
            data: { optionLabel: 'B' },
          },
        ],
      ),
    )
    const edges = round.content.edges
    // 指向已删槽位的连线：隔离并警告（§11.1 ②），绝不改接到 B
    expect(edges.find((e) => e.id === 'e0')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e0'))).toBe(true)
    // 槽位 1 的连线仍指向 B（稳定 id 句柄）
    const e1 = edges.find((e) => e.id === 'e1')!
    expect(e1.sourceHandle).toMatch(/^option-/)
    expect(e1.sourceHandle).not.toBe('option-1')
    // 最终选项只剩 B
    const br = round.content.nodes.find((n) => n.id === 'br1')!
    expect(
      (br.data as { options: Array<{ label: string }> }).options.map(
        (o) => o.label,
      ),
    ).toEqual(['B'])
  })

  it('设定集角色 name 非字符串：头像解析不崩溃，坏实体按 §11.3 隔离、新实体照常补建', () => {
    const again = parseProject({
      ...v0Doc(
        [
          {
            id: 's1',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: {
              name: '场一',
              sceneNo: 1,
              interior: true,
              synopsis: '',
              characters: [{ label: '林', gradient: 'g' }],
            },
          },
        ],
        [],
      ),
      settings: {
        characters: [{ id: 'ch-bad', name: 42, gradient: 'g' }],
        locations: [],
      },
    })
    expect(again.migrated).toBe(true)
    expect(again.content.nodes.map((n) => n.id)).toContain('s1')
    expect(again.warnings.some((w) => w.includes('ch-bad'))).toBe(true)
    // 头像「林」匹配不到坏实体，按迁移规则补建新实体
    const names = again.content.settings.characters.map((c) => c.name)
    expect(names).toContain('林')
  })
})

describe('归一化：v0 节点基础布局预归一化（toStoryNode 解引用前置）', () => {
  const v0Base = (nodes: unknown[]) => ({
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph: { nodes, edges: [] },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })
  const sceneData = (id: string) => ({
    name: id,
    sceneNo: 1,
    interior: true,
    synopsis: '',
  })

  it('position 缺失或为 null：补默认 (0,0) 并警告，不因 n.position.x 解引用崩溃', () => {
    const round = parseProject(
      v0Base([
        { id: 's1', type: 'scene', data: sceneData('场一') },
        { id: 's2', type: 'scene', position: null, data: sceneData('场二') },
        {
          id: 's3',
          type: 'scene',
          position: { x: 5, y: 5 },
          data: sceneData('场三'),
        },
      ]),
    )
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1', 's2', 's3'])
    expect(round.content.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(round.content.nodes[2].position).toEqual({ x: 5, y: 5 })
    expect(
      round.warnings.some((w) => w.includes('s1') && w.includes('position')),
    ).toBe(true)
    expect(
      round.warnings.some((w) => w.includes('s2') && w.includes('position')),
    ).toBe(true)
  })
})

describe('v0 迁移的字段优先级与头像预过滤（迁移链 ④ 前置）', () => {
  const v0Doc = (
    sceneData: Record<string, unknown>,
    characters: unknown[] = [],
    locations: unknown[] = [],
  ) => ({
    schemaVersion: 0,
    project: {
      id: 'p-old',
      name: '旧剧',
      createdAt: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    graph: {
      nodes: [
        { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: sceneData },
      ],
      edges: [],
    },
    settings: { characters, locations },
    episodeTitles: {},
    assets: { byId: {} },
  })

  it('合法 locationId 胜过过时的 location 字符串镜像：不补建实体、不改指向', () => {
    const round = parseProject(
      v0Doc(
        {
          name: '场一',
          sceneNo: 1,
          interior: true,
          synopsis: '',
          locationId: 'loc-1',
          location: '废弃地址',
        },
        [],
        [{ id: 'loc-1', name: '天台' }],
      ),
    )
    const spec = round.content.nodes[0].data as { locationId?: string }
    expect(spec.locationId).toBe('loc-1')
    expect(round.content.settings.locations.map((l) => l.name)).toEqual([
      '天台',
    ])
  })

  it('空 label 头像预过滤：不静默关联首角色、不补建空名实体', () => {
    const round = parseProject(
      v0Doc(
        {
          name: '场一',
          sceneNo: 1,
          interior: true,
          synopsis: '',
          characters: [
            { label: '', gradient: 'g' },
            { label: '林', gradient: 'g' },
          ],
        },
        [{ id: 'ch-1', name: '甲', gradient: 'g1' }],
      ),
    )
    const spec = round.content.nodes[0].data as { characterIds: string[] }
    // 空 label 头像不得命中首角色「甲」；「林」按规则补建
    expect(spec.characterIds).toHaveLength(1)
    const names = round.content.settings.characters.map((c) => c.name)
    expect(names).toContain('林')
    expect(names).not.toContain('')
    expect(
      round.warnings.some((w) => w.includes('s1') && w.includes('characters')),
    ).toBe(true)
  })

  it('对白 speaker 头像预过滤：空 label 不静默关联首角色（startsWith 空串恒真），异型 gradient 一并置空', () => {
    const round = parseProject({
      schemaVersion: 0,
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: {
        nodes: [
          {
            id: 'd1',
            type: 'dialogue',
            position: { x: 0, y: 0 },
            data: {
              name: '对白',
              lines: [
                {
                  id: 'l1',
                  kind: 'line',
                  text: '别走',
                  speaker: { label: '', gradient: 'g' },
                  side: 'left',
                  vo: false,
                },
                {
                  id: 'l2',
                  kind: 'line',
                  text: '嗯',
                  speaker: { label: '林', gradient: 1 },
                  side: 'left',
                  vo: false,
                },
                {
                  id: 'l3',
                  kind: 'line',
                  text: '好',
                  speaker: { label: '林' },
                  side: 'left',
                  vo: false,
                },
              ],
            },
          },
        ],
        edges: [],
      },
      settings: {
        characters: [{ id: 'ch-1', name: '甲', gradient: 'g1' }],
        locations: [],
      },
      episodeTitles: {},
      assets: { byId: {} },
    })
    const spec = round.content.nodes[0].data as {
      lines: Array<{ speaker: unknown }>
    }
    // 空 label / 异型 gradient 的 speaker 头像置空，不得命中首角色「甲」
    expect(spec.lines[0].speaker).toBeNull()
    expect(spec.lines[1].speaker).toBeNull()
    // 合法头像按规则补建实体
    const lin = round.content.settings.characters.find((c) => c.name === '林')
    expect(lin).toBeDefined()
    expect(spec.lines[2].speaker).toBe(lin?.id)
    expect(round.content.settings.characters.some((c) => c.name === '')).toBe(
      false,
    )
    expect(
      round.warnings.some((w) => w.includes('d1') && w.includes('speaker')),
    ).toBe(true)
  })
})

/** issue #334 复现信封：两个同 id 分支节点（选项集由调用方给定）+ 场景 +
 * 一条 option-0 旧下标句柄分支边（模块级夹具，使回归 describe 不超 80 行）。 */
const dupNodeEnvelope = (first: unknown[], second: unknown[]) => ({
  schemaVersion: 0,
  project: {
    id: 'p-old',
    name: 'probe',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  graph: {
    nodes: [
      {
        id: 'dup',
        type: 'branch',
        position: { x: 0, y: 0 },
        data: { prompt: 'choose', options: first },
      },
      {
        id: 'dup',
        type: 'branch',
        position: { x: 0, y: 0 },
        data: { prompt: 'choose', options: second },
      },
      {
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        data: {
          name: 's1',
          sceneNo: 1,
          interior: true,
          time: 'day',
          synopsis: '',
          characterIds: [],
        },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'dup',
        target: 's1',
        sourceHandle: 'option-0',
        type: 'branch',
      },
    ],
  },
  settings: { characters: [], locations: [] },
  assets: { byId: {} },
  episodeTitles: {},
})

describe('schemaVersion 0 迁移：重复节点 id 的旧下标句柄归属（issue #334，§11 首见身份）', () => {
  it('末见节点与首见共享选项 id：e1 绑定首见节点的 opt-a，不改接末见的同名选项', () => {
    const round = parseProject(
      dupNodeEnvelope(
        [
          { id: 'opt-a', label: 'first' },
          { id: 'opt-b', label: 'second' },
        ],
        [{ id: 'opt-b', label: 'later' }],
      ),
    )
    const e1 = round.content.edges.find((e) => e.id === 'e1')
    expect(e1).toBeDefined()
    expect(e1?.sourceHandle).toBe('option-opt-a')
    // 加载/保存边界（issue #334）：migrated/repaired 产物经 enqueueSave
    // 回写——保存载荷经 JSON 边界再解析后绑定不得回退
    const reloaded = parseProject(
      JSON.parse(JSON.stringify(serializeProject(round.content, 'p-old', NOW))),
    )
    expect(
      reloaded.content.edges.find((e) => e.id === 'e1')?.sourceHandle,
    ).toBe('option-opt-a')
  })

  it('末见节点选项集不同：e1 保留并绑定 opt-a，不因末见节点被错误隔离', () => {
    const round = parseProject(
      dupNodeEnvelope(
        [{ id: 'opt-a', label: 'first' }],
        [{ id: 'opt-z', label: 'later' }],
      ),
    )
    const e1 = round.content.edges.find((e) => e.id === 'e1')
    expect(e1).toBeDefined()
    expect(e1?.sourceHandle).toBe('option-opt-a')
    const reloaded = parseProject(
      JSON.parse(JSON.stringify(serializeProject(round.content, 'p-old', NOW))),
    )
    expect(
      reloaded.content.edges.find((e) => e.id === 'e1')?.sourceHandle,
    ).toBe('option-opt-a')
  })
})

/** issue #335 复现信封：单条 line 行携带调用方给定的 speaker（模块级夹具，
 * 使回归 describe 不超 80 行）。 */
const malformedSpeakerEnvelope = (speaker: unknown) => ({
  schemaVersion: 0,
  project: {
    id: 'p-old',
    name: 'probe',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  graph: {
    nodes: [
      {
        id: 'd1',
        type: 'dialogue',
        position: { x: 0, y: 0 },
        data: {
          name: '对白',
          lines: [{ id: 'l1', kind: 'line', speaker, text: 'hello' }],
        },
      },
    ],
    edges: [],
  },
  settings: { characters: [], locations: [] },
  episodeTitles: {},
  assets: { byId: {} },
})

describe('schemaVersion 0 迁移：异型对白 speaker 的安全预检（issue #335，§11 v0 兼容子步骤）', () => {
  const lineOf = (round: ReturnType<typeof parseProject>) =>
    (
      (round.content.nodes[0].data as { lines: unknown[] }).lines as Array<{
        id: string
        speaker: unknown
        text: string
      }>
    ).find((l) => l.id === 'l1')!

  it('数组型 speaker 置空并告警：text 保留，整档可解析，parseProject 不抛错', () => {
    const round = parseProject(malformedSpeakerEnvelope([]))
    expect(lineOf(round).speaker).toBeNull()
    expect(lineOf(round).text).toBe('hello')
    expect(
      round.warnings.some(
        (w) => w.includes('d1') && w.includes('speaker') && w.includes('异型'),
      ),
    ).toBe(true)
  })

  it('标量异型 speaker（数值/布尔）同样在 v0 预检置空并告警', () => {
    for (const speaker of [5, false]) {
      const round = parseProject(malformedSpeakerEnvelope(speaker))
      expect(lineOf(round).speaker).toBeNull()
      expect(lineOf(round).text).toBe('hello')
      expect(
        round.warnings.some(
          (w) =>
            w.includes('d1') && w.includes('speaker') && w.includes('异型'),
        ),
      ).toBe(true)
    }
  })

  it('合法形态对照：字符串引用、null 与缺失 speaker 不受预检影响', () => {
    const ref = parseProject(malformedSpeakerEnvelope('ch-1'))
    expect(lineOf(ref).speaker).toBe('ch-1')
    expect(lineOf(ref).text).toBe('hello')
    const none = parseProject(malformedSpeakerEnvelope(null))
    expect(lineOf(none).speaker ?? null).toBeNull()
    const absent = parseProject(malformedSpeakerEnvelope(undefined))
    expect(lineOf(absent).speaker ?? null).toBeNull()
    expect(lineOf(absent).text).toBe('hello')
  })
})

/** issue #336 复现信封：settings 由调用方给定（模块级夹具，使回归 describe
 * 不超 80 行）。 */
const legacySettingsEnvelope = (settings: unknown) => ({
  schemaVersion: 0,
  project: {
    id: 'p-old',
    name: 'probe',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  graph: { nodes: [], edges: [] },
  settings,
  episodeTitles: {},
  assets: { byId: {} },
})

describe('schemaVersion 0 迁移：异型设定桶的预检诊断（issue #336，§11 第 0 步）', () => {
  it('characters/locations 为 Record（非数组）：重置空数组并记录不可恢复警告', () => {
    const round = parseProject(
      legacySettingsEnvelope({
        characters: { c1: { id: 'c1', name: 'Alice', gradient: 'red' } },
        locations: { l1: { id: 'l1', name: 'room' } },
      }),
    )
    expect(round.content.settings.characters).toEqual([])
    expect(round.content.settings.locations).toEqual([])
    expect(round.repaired).toBe(true)
    expect(
      round.warnings.some(
        (w) => w.includes('settings.characters') && w.includes('非数组'),
      ),
    ).toBe(true)
    expect(
      round.warnings.some(
        (w) => w.includes('settings.locations') && w.includes('非数组'),
      ),
    ).toBe(true)
  })

  it('settings 非普通对象：重置空对象并记录不可恢复警告', () => {
    const round = parseProject(legacySettingsEnvelope('junk'))
    expect(round.content.settings.characters).toEqual([])
    expect(round.content.settings.locations).toEqual([])
    expect(
      round.warnings.some(
        (w) => w.includes('settings') && w.includes('非普通对象'),
      ),
    ).toBe(true)
  })

  it('设定桶缺失记录警告；合法旧数组保持且无设定桶诊断', () => {
    const missing = parseProject(legacySettingsEnvelope({ characters: [] }))
    expect(missing.content.settings.locations).toEqual([])
    expect(
      missing.warnings.some(
        (w) => w.includes('settings.locations') && w.includes('缺失'),
      ),
    ).toBe(true)
    const legal = parseProject(
      legacySettingsEnvelope({
        characters: [{ id: 'c1', name: 'Alice', gradient: 'red' }],
        locations: [{ id: 'l1', name: 'room' }],
      }),
    )
    expect(legal.content.settings.characters).toHaveLength(1)
    expect(legal.content.settings.characters[0]?.name).toBe('Alice')
    expect(legal.content.settings.locations).toHaveLength(1)
    expect(legal.warnings.some((w) => w.includes('settings.'))).toBe(false)
  })
})

/** issue #337 四状态信封：单场景（data 由调用方给定）+ 设定地点桶（模块级
 * 夹具，使回归 describe 不超 80 行）。 */
const legacySceneEnvelope = (
  sceneData: Record<string, unknown>,
  locations: unknown[] = [],
) => ({
  schemaVersion: 0,
  project: {
    id: 'p-old',
    name: 'probe',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  graph: {
    nodes: [
      { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: sceneData },
    ],
  },
  edges: undefined,
  settings: { characters: [], locations },
  episodeTitles: {},
  assets: { byId: {} },
})

const sceneBaseData = {
  name: 's1',
  sceneNo: 1,
  interior: true,
  time: 'day',
  synopsis: '',
  characterIds: [],
}

describe('schemaVersion 0 迁移：场景地点镜像的诊断一致性（issue #337，§11 v0 地点兼容）', () => {
  const specOf = (round: ReturnType<typeof parseProject>) =>
    round.content.nodes[0].data as { locationId?: unknown }
  const conflictWarningOf = (round: ReturnType<typeof parseProject>) =>
    round.warnings.some((w) => w.includes('s1') && w.includes('冲突'))

  it('缺失地点：不合成 locationId 键，无「非字符串」误报', () => {
    const round = parseProject(legacySceneEnvelope({ ...sceneBaseData }))
    expect('locationId' in specOf(round)).toBe(false)
    expect(
      round.warnings.some((w) => w.includes('s1') && w.includes('locationId')),
    ).toBe(false)
  })

  it('合法旧名称恢复：location 镜像复用既有实体写入 locationId（对照不变）', () => {
    const round = parseProject(
      legacySceneEnvelope({ ...sceneBaseData, location: 'Room' }, [
        { id: 'loc-1', name: 'Room' },
      ]),
    )
    expect(specOf(round).locationId).toBe('loc-1')
    expect(conflictWarningOf(round)).toBe(false)
  })

  it('相同镜像：location 命名 ID 指向的同一实体——按 ID 保留、镜像静默删除', () => {
    const round = parseProject(
      legacySceneEnvelope(
        { ...sceneBaseData, locationId: 'loc-1', location: 'Room' },
        [{ id: 'loc-1', name: 'Room' }],
      ),
    )
    expect(specOf(round).locationId).toBe('loc-1')
    expect(conflictWarningOf(round)).toBe(false)
  })

  it('冲突镜像：location 与 ID 指向实体不一致——按 ID 保留并记录冲突警告', () => {
    const round = parseProject(
      legacySceneEnvelope(
        { ...sceneBaseData, locationId: 'loc-1', location: 'Other' },
        [{ id: 'loc-1', name: 'Room' }],
      ),
    )
    expect(specOf(round).locationId).toBe('loc-1')
    expect(
      round.warnings.some(
        (w) => w.includes('s1') && w.includes('Other') && w.includes('冲突'),
      ),
    ).toBe(true)
  })
})
