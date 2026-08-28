import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import { parseProject, serializeProject } from './convert'
import type { ProjectContent } from './content'
import { CURRENT_SCHEMA_VERSION, type ProjectDocument } from './document'
import type { CanvasNode } from '../editor/nodes/types'

const NOW = new Date('2026-08-28T12:00:00.000Z')

/** 覆盖五类节点 + 三种边 + 设定集 + 视口的完整会话文档。 */
function mkContent(): ProjectContent {
  return {
    name: '午夜出租车',
    createdAt: '2026-08-01T00:00:00.000Z',
    nodes: [
      {
        id: 's1',
        type: 'scene',
        position: { x: 10, y: 20 },
        selected: true,
        className: 'pw-node-dim',
        data: {
          name: '天台夜话',
          sceneNo: 3,
          interior: false,
          locationId: 'loc-1',
          time: '夜',
          weather: '雨',
          synopsis: '摊牌',
          characterIds: ['ch-1'],
          episodeNo: 2,
        },
      } as unknown as CanvasNode,
      {
        id: 'b1',
        type: 'beat',
        position: { x: 0, y: 0 },
        data: { name: '转折', tone: '压抑', episodeNo: 2 },
      } as unknown as CanvasNode,
      {
        id: 'd1',
        type: 'dialogue',
        position: { x: 0, y: 0 },
        data: {
          name: '对白',
          lines: [{ id: 'line-1', kind: 'line', text: '别走', speaker: 'ch-1', side: 'left', vo: false }],
        },
      } as unknown as CanvasNode,
      {
        id: 'br1',
        type: 'branch',
        position: { x: 0, y: 0 },
        data: {
          prompt: '女主是否发现真相',
          options: [
            { id: 'opt-1', label: '坦白' },
            { id: 'opt-2', label: '隐瞒' },
          ],
          episodeNo: 2,
        },
      } as unknown as CanvasNode,
      {
        id: 'sh1',
        type: 'shot',
        position: { x: 0, y: 0 },
        data: {
          shotNo: 1,
          size: '特写',
          picture: '雨夜车窗',
          prompt: ' cinematic rain ',
          refs: [{ id: 'ref-1', kind: 'character', label: '林晚' }],
        },
      } as unknown as CanvasNode,
    ],
    edges: [
      { id: 'e1', source: 's1', target: 'd1', className: 'pw-edge-sequence', selected: true } as Edge,
      {
        id: 'e2',
        source: 'br1',
        sourceHandle: 'option-opt-2',
        target: 'd1',
        type: 'branch',
        data: { optionLabel: '隐瞒' },
      } as Edge,
      { id: 'e3', source: 's1', sourceHandle: 'shots', target: 'sh1', className: 'pw-edge-attach' } as Edge,
    ],
    settings: {
      characters: [{ id: 'ch-1', name: '林晚', gradient: 'g-lin', bio: '女主' }],
      locations: [{ id: 'loc-1', name: '天台', note: '雨夜' }],
    },
    episodeTitles: { 2: '摊牌' },
    viewport: { x: 100, y: -40, zoom: 1.25 },
  }
}

describe('serializeProject（会话文档 → ProjectDocument 落盘格式）', () => {
  it('信封：schemaVersion / project 元信息 / 视口 / 资产桶', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(doc.project).toEqual({
      id: 'p-1',
      name: '午夜出租车',
      createdAt: '2026-08-01T00:00:00.000Z', // 保留创建时间
      updatedAt: NOW.toISOString(), // 保存时盖更新时间
    })
    expect(doc.graph.viewport).toEqual({ x: 100, y: -40, zoom: 1.25 })
    expect(doc.assets).toEqual({ byId: {} })
    expect(doc.episodeTitles).toEqual({ 2: '摊牌' })
  })

  it('节点拆四分区：layout/ui/spec/meta；运行态字段（selected/className）剥离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const scene = doc.graph.nodes.find((n) => n.id === 's1')!
    expect(scene).toEqual({
      id: 's1',
      type: 'scene',
      layout: { position: { x: 10, y: 20 } },
      ui: { selected: false, expanded: true },
      data: {
        spec: {
          sceneNo: 3,
          interior: false,
          locationId: 'loc-1',
          time: '夜',
          weather: '雨',
          synopsis: '摊牌',
          characterIds: ['ch-1'],
        },
        meta: { label: '天台夜话', episodeNo: 2 },
      },
    })
    expect(JSON.stringify(scene)).not.toContain('pw-node-dim')
  })

  it('分支/分镜卡不落 meta.label（标题由 prompt/shotNo 派生，禁止镜像字段）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const branch = doc.graph.nodes.find((n) => n.id === 'br1')!
    expect(branch.data.spec).toEqual({
      prompt: '女主是否发现真相',
      options: [
        { id: 'opt-1', label: '坦白' },
        { id: 'opt-2', label: '隐瞒' },
      ],
    })
    expect(branch.data.meta).toEqual({ episodeNo: 2 })
    expect('label' in branch.data.meta).toBe(false)
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    expect('label' in shot.data.meta).toBe(false)
    expect(shot.data.spec).toMatchObject({ shotNo: 1, size: '特写' })
  })

  it('边只存语义：kind 显式化；branch 边不落 optionLabel 拷贝；className 剥离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(doc.graph.edges).toEqual([
      { id: 'e1', source: 's1', target: 'd1', data: { kind: 'sequence' } },
      { id: 'e2', source: 'br1', target: 'd1', sourceHandle: 'option-opt-2', data: { kind: 'branch' } },
      { id: 'e3', source: 's1', target: 'sh1', sourceHandle: 'shots', data: { kind: 'attach' } },
    ])
  })

  it('设定集数组 → Record<id, 实体>，补空 props 桶', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(doc.settings.characters['ch-1']).toEqual({ id: 'ch-1', name: '林晚', gradient: 'g-lin', bio: '女主' })
    expect(doc.settings.locations['loc-1']).toEqual({ id: 'loc-1', name: '天台', note: '雨夜' })
    expect(doc.settings.props).toEqual({})
  })

  it('缺 createdAt 时补盖；视口缺省不伪造（留给打开时 fitView）', () => {
    const bare = { ...mkContent(), createdAt: undefined, viewport: undefined }
    const doc = serializeProject(bare, 'p-1', NOW)
    expect(doc.project.createdAt).toBe(NOW.toISOString())
    expect(doc.graph.viewport).toBeUndefined()
  })

  it('assets.byId 透传：解析进会话、保存原样保留，不被清空（§7.1）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.assets.byId['a-1'] = {
      id: 'a-1',
      relPath: 'assets/lin.png',
      mime: 'image/png',
      source: 'upload',
      createdAt: '2026-08-01T00:00:00.000Z',
    }
    const round = parseProject(doc)
    expect(round.content.assets?.byId['a-1']).toEqual(doc.assets.byId['a-1'])
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.assets.byId['a-1']).toEqual(doc.assets.byId['a-1'])
  })
})

describe('parseProject（ProjectDocument → 会话文档，§11 归一化）', () => {
  it('往返一致：节点/边/设定集/视口/集标题还原；branch 边胶囊文案按 sourceHandle 派生', () => {
    const content = mkContent()
    const round = parseProject(serializeProject(content, 'p-1', NOW))
    expect(round.migrated).toBe(false)
    expect(round.warnings).toEqual([])
    expect(round.content.name).toBe('午夜出租车')
    expect(round.content.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(round.content.viewport).toEqual({ x: 100, y: -40, zoom: 1.25 })
    expect(round.content.episodeTitles).toEqual({ 2: '摊牌' })
    // 节点：运行态干净（无 className、selected=false），data 字段与原文档一致
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1', 'b1', 'd1', 'br1', 'sh1'])
    const scene = round.content.nodes[0]
    expect(scene.selected).toBe(false)
    expect((scene as { className?: string }).className).toBeUndefined()
    expect(scene.data).toEqual({
      name: '天台夜话',
      sceneNo: 3,
      interior: false,
      locationId: 'loc-1',
      time: '夜',
      weather: '雨',
      synopsis: '摊牌',
      characterIds: ['ch-1'],
      episodeNo: 2,
    })
    // branch 边恢复 type/胶囊文案（由分支节点中 id = opt-2 的选项派生）
    const branchEdge = round.content.edges.find((e) => e.id === 'e2')!
    expect(branchEdge.type).toBe('branch')
    expect(branchEdge.data).toEqual({ optionLabel: '隐瞒' })
    expect(branchEdge.sourceHandle).toBe('option-opt-2')
    // sequence/attach 恢复 className
    expect(round.content.edges.find((e) => e.id === 'e1')!.className).toBe('pw-edge-sequence')
    expect(round.content.edges.find((e) => e.id === 'e3')!.className).toBe('pw-edge-attach')
    // 设定集还原为数组
    expect(round.content.settings.characters).toEqual([
      { id: 'ch-1', name: '林晚', gradient: 'g-lin', bio: '女主' },
    ])
  })

  it('schemaVersion 高于当前版本：拒绝并提示升级应用', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(() =>
      parseProject({ ...doc, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    ).toThrow(/升级应用/)
  })

  it('孤儿边隔离并记录警告，不阻断加载（§11.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({ id: 'e-ghost', source: 's1', target: 'ghost', data: { kind: 'sequence' } })
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-ghost')
    expect(round.warnings.some((w) => w.includes('e-ghost'))).toBe(true)
  })

  it('悬空设定引用：标记警告但保留 id，不静默清除（§11.4 / §8.2.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    delete doc.settings.characters['ch-1']
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!
    expect((scene.data as { characterIds: string[] }).characterIds).toEqual(['ch-1'])
    expect(round.warnings.some((w) => w.includes('ch-1'))).toBe(true)
  })

  it('存储文档中的 ui.selected 一律重置（§11.2）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as ProjectDocument
    doc.graph.nodes[0].ui.selected = true
    const round = parseProject(doc)
    expect(round.content.nodes[0].selected).toBe(false)
  })

  it('branch 边胶囊文案按稳定选项 id 派生，与数组顺序无关（§8.1.1）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const branch = doc.graph.nodes.find((n) => n.id === 'br1')!
    branch.data.spec = {
      prompt: '去哪',
      options: [
        { id: 'opt-9', label: '甲' },
        { id: 'opt-1', label: '乙' },
      ],
    }
    doc.graph.edges = [
      { id: 'e-x', source: 'br1', target: 'd1', sourceHandle: 'option-opt-1', data: { kind: 'branch' } },
    ]
    const round = parseProject(doc)
    expect(round.content.edges[0].data).toEqual({ optionLabel: '乙' })
  })

  it('branch 边指向已删除的选项：按孤儿边隔离并记录警告（§11.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-dead',
      source: 'br1',
      target: 'd1',
      sourceHandle: 'option-opt-gone',
      data: { kind: 'branch' },
    })
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-dead')
    expect(round.warnings.some((w) => w.includes('e-dead'))).toBe(true)
  })

  it('schemaVersion 0 旧信封：数组下标句柄改写为稳定选项 id；越界句柄按孤儿边隔离', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 'br1',
            type: 'branch',
            position: { x: 0, y: 0 },
            data: {
              prompt: '去哪',
              options: [
                { id: 'opt-a', label: '左' },
                { id: 'opt-b', label: '右' },
              ],
            },
          },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1 } },
          { id: 's2', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场二', sceneNo: 2 } },
        ],
        edges: [
          { id: 'e1', source: 'br1', target: 's1', sourceHandle: 'option-1', type: 'branch', data: { optionLabel: '右' } },
          { id: 'e2', source: 'br1', target: 's2', sourceHandle: 'option-9', type: 'branch', data: { optionLabel: '越界' } },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    const e1 = round.content.edges.find((e) => e.id === 'e1')!
    expect(e1.sourceHandle).toBe('option-opt-b')
    expect(e1.data).toEqual({ optionLabel: '右' })
    // 越界下标无法改写，归一化按孤儿边隔离（§11.3）
    expect(round.content.edges.map((e) => e.id)).not.toContain('e2')
    expect(round.warnings.some((w) => w.includes('e2'))).toBe(true)
  })

  it('schemaVersion 0 旧信封：节点字段迁移（头像对象 → characterIds）后按 v1 进入会话；旧格式无视口，迁移不伪造', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
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
              time: '夜',
              synopsis: '',
              characters: [{ label: '林', gradient: 'g-lin' }],
              location: '天台',
            },
          },
        ],
        edges: [],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    const scene = round.content.nodes[0].data as { characterIds: string[]; locationId?: string }
    expect(scene.characterIds).toHaveLength(1)
    expect(scene.locationId).toBeDefined()
    expect(round.content.settings.characters.map((c) => c.name)).toEqual(['林'])
    expect(round.content.settings.locations.map((l) => l.name)).toEqual(['天台'])
    // 旧格式从未持久化视口：保持缺省，打开时 fitView（不伪造原点视口）
    expect(round.content.viewport).toBeUndefined()
  })
})
