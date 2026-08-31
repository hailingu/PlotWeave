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

  it('settings.documents 往返保留：解析进会话、保存原样回写（§3/§6）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.settings.documents = {
      // §6：relatedIds 为 { kind, id } 显式成对（两桶独立 id 空间）
      'doc-1': {
        id: 'doc-1',
        title: '林晚小传',
        body: '……',
        relatedIds: [{ kind: 'character', id: 'ch-1' }],
      },
    }
    const round = parseProject(doc)
    expect(round.content.settings.documents?.[0]).toEqual({
      id: 'doc-1',
      title: '林晚小传',
      body: '……',
      relatedIds: [{ kind: 'character', id: 'ch-1' }],
    })
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.settings.documents['doc-1']).toEqual({
      id: 'doc-1',
      title: '林晚小传',
      body: '……',
      relatedIds: [{ kind: 'character', id: 'ch-1' }],
    })
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

  it('透传字段往返保留：project.description / settings.props / edge data.order（§3/§5/§6）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.description = '午夜出租车故事板'
    doc.settings.props['pr-1'] = { id: 'pr-1', name: '怀表', description: '关键道具' }
    doc.graph.edges[0].data.order = 1
    doc.graph.edges[1].data.order = 2
    const round = parseProject(doc)
    // 会话态携带透传字段（含运行态边 data.order）
    expect(round.content.description).toBe('午夜出租车故事板')
    expect(round.content.settings.props?.map((p) => p.id)).toEqual(['pr-1'])
    expect(round.content.edges[0].data).toMatchObject({ order: 1 })
    expect(round.content.edges[1].data).toMatchObject({ optionLabel: '隐瞒', order: 2 })
    // 再次落盘不丢
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.project.description).toBe('午夜出租车故事板')
    expect(again.settings.props['pr-1']).toEqual({ id: 'pr-1', name: '怀表', description: '关键道具' })
    expect(again.graph.edges[0].data.order).toBe(1)
    expect(again.graph.edges[1].data.order).toBe(2)
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

  it('kind/句柄矛盾：sequence 携带任意句柄确定性剥离并保留；attach 携带非 shots 句柄无法修复，按孤儿边隔离（§5）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    // 故意构造非法边，验证归一化兜底
    const invalid = (e: unknown) => e as ProjectDocument['graph']['edges'][number]
    doc.graph.edges.push(
      invalid({ id: 'e-bad1', source: 's1', target: 'b1', sourceHandle: 'shots', data: { kind: 'sequence' } }),
      invalid({ id: 'e-bad2', source: 's1', target: 'd1', sourceHandle: 'option-opt-1', data: { kind: 'attach' } }),
      invalid({ id: 'e-bad3', source: 's1', target: 'b1', sourceHandle: 'option-opt-1', data: { kind: 'sequence' } }),
    )
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    // sequence 边携带任意 sourceHandle：端口匿名唯一，剥离不改变连接语义，保留并警告
    expect(edgeIds).toContain('e-bad1')
    expect(edgeIds).toContain('e-bad3')
    expect(round.content.edges.find((e) => e.id === 'e-bad1')!.sourceHandle).toBeUndefined()
    expect(round.content.edges.find((e) => e.id === 'e-bad3')!.sourceHandle).toBeUndefined()
    // attach 句柄必须是字面量 shots：非 shots 无法确定性修复，隔离
    expect(edgeIds).not.toContain('e-bad2')
    expect(round.warnings.some((w) => w.includes('e-bad1'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-bad2'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-bad3'))).toBe(true)
    // 合法边不受影响
    expect(round.content.edges.some((e) => e.id === 'e3' && e.sourceHandle === 'shots')).toBe(true)
  })

  it('attach 边端点类型不合法（非 scene → shot）按孤儿边隔离（§5 端点约束）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push(
      { id: 'e-att1', source: 'd1', target: 'sh1', sourceHandle: 'shots', data: { kind: 'attach' } },
      { id: 'e-att2', source: 's1', target: 'b1', sourceHandle: 'shots', data: { kind: 'attach' } },
    )
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-att1')
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-att2')
    expect(round.warnings.some((w) => w.includes('e-att1'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-att2'))).toBe(true)
    // 合法的 scene → shot 下挂不受影响
    expect(round.content.edges.some((e) => e.id === 'e3')).toBe(true)
  })

  it('剧情流边端点为 shot 的按孤儿边隔离（§4.2 分镜卡不参与横向剧情流）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push(
      { id: 'e-seq-shot', source: 's1', target: 'sh1', data: { kind: 'sequence' } },
      { id: 'e-br-shot', source: 'br1', target: 'sh1', sourceHandle: 'option-opt-1', data: { kind: 'branch' } },
    )
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-seq-shot')
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-br-shot')
    expect(round.warnings.some((w) => w.includes('e-seq-shot'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-br-shot'))).toBe(true)
  })

  it('悬空设定引用：标记警告但保留 id，不静默清除（§11.4 / §8.2.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    delete doc.settings.characters['ch-1']
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!
    expect((scene.data as { characterIds: string[] }).characterIds).toEqual(['ch-1'])
    expect(round.warnings.some((w) => w.includes('ch-1'))).toBe(true)
  })

  it('v1 信封缺设定集桶：悬空引用只警告，项目照常打开（§11 修复而非拒绝）', () => {
    // Rust ProjectFile 的兼容默认会把缺 settings 的文件解析为 {}（桶全缺）
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.settings = {} as unknown as ProjectDocument['settings']
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!
    expect((scene.data as { characterIds: string[] }).characterIds).toEqual(['ch-1'])
    expect(round.warnings.some((w) => w.includes('ch-1'))).toBe(true)
    // 会话设定集仍为合法空集合
    expect(round.content.settings.characters).toEqual([])
    expect(round.content.settings.locations).toEqual([])
  })

  it('悬空分镜引用：按 §11.4 标记警告（targetId 按类别解析设定集/资产索引）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data.spec as { refs: unknown[] }).refs = [
      { id: 'ref-1', kind: 'character', targetId: 'ch-gone' },
      { id: 'ref-2', kind: 'audio', targetId: 'a-gone' },
    ]
    const round = parseProject(doc)
    expect(round.warnings.some((w) => w.includes('ch-gone'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('a-gone'))).toBe(true)
  })

  it('角色实体头像资产悬空：按 §11.4 标记警告（avatarAssetId 在设定集实体上）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.settings.characters['ch-1'].avatarAssetId = 'a-gone'
    const round = parseProject(doc)
    expect(round.warnings.some((w) => w.includes('a-gone'))).toBe(true)
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

  it('schemaVersion 0 旧信封：边判别字段（type/className）归类为显式 data.kind', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          { id: 'br1', type: 'branch', position: { x: 0, y: 0 }, data: { prompt: '去哪', options: [{ id: 'opt-a', label: '左' }] } },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1 } },
          { id: 's2', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场二', sceneNo: 2 } },
          { id: 'sh1', type: 'shot', position: { x: 0, y: 0 }, data: { shotNo: 1, size: '特写', picture: '', prompt: '', refs: [] } },
        ],
        edges: [
          // 旧运行态判别：type=branch / className=attach / className=sequence
          { id: 'e1', source: 'br1', target: 's1', sourceHandle: 'option-0', type: 'branch', data: { optionLabel: '左' } },
          { id: 'e2', source: 's1', target: 'sh1', sourceHandle: 'shots', className: 'pw-edge-attach' },
          { id: 'e3', source: 's1', target: 's2', className: 'pw-edge-sequence' },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    // 会话态按归类结果恢复：branch 有 type，attach/sequence 有对应 className
    const e1 = round.content.edges.find((e) => e.id === 'e1')!
    const e2 = round.content.edges.find((e) => e.id === 'e2')!
    const e3 = round.content.edges.find((e) => e.id === 'e3')!
    expect(e1.type).toBe('branch')
    expect(e2.className).toBe('pw-edge-attach')
    expect(e3.className).toBe('pw-edge-sequence')
    // 再落盘：data.kind 显式化，无 type/className 残留
    const again = serializeProject(round.content, 'p-old', new Date('2026-08-29T00:00:00.000Z'))
    expect(again.graph.edges.map((e) => e.data.kind)).toEqual(['branch', 'attach', 'sequence'])
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

describe('归一化一期：容器级形状校验（§11.1 第 2 步）', () => {
  it('顶层容器异型：重置为可遍历空容器并记录警告，项目照常打开', () => {
    const round = parseProject({
      schemaVersion: 1,
      project: null,
      graph: 'oops',
      settings: [1, 2],
      episodeTitles: ['旁白'],
      assets: null,
    })
    expect(round.content.name).toBe('未命名项目')
    expect(round.content.nodes).toEqual([])
    expect(round.content.edges).toEqual([])
    expect(round.content.settings.characters).toEqual([])
    expect(round.content.episodeTitles).toEqual({})
    expect(round.content.assets).toEqual({ byId: {} })
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('子容器异型：graph.nodes/edges 非数组重置为空；settings 桶数组形态重置为空 Record（下标不被当成实体 id）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: unknown; edges: unknown }
      settings: { characters: unknown }
    }
    doc.graph.nodes = 'oops'
    doc.graph.edges = null
    doc.settings.characters = [{ id: 'ch-9', name: '不应以键 0 入桶' }]
    const round = parseProject(doc)
    expect(round.content.nodes).toEqual([])
    expect(round.content.edges).toEqual([])
    expect(round.content.settings.characters).toEqual([])
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('成员级异型过滤：节点/边数组中的非普通对象成员隔离，Record 桶中的异型值移除', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: unknown[]; edges: unknown[] }
      settings: { characters: Record<string, unknown> }
    }
    doc.graph.nodes.push(null, 42)
    doc.graph.edges.push(null, 'oops')
    doc.settings.characters['bad'] = null
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1', 'b1', 'd1', 'br1', 'sh1'])
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(round.content.settings.characters.map((c) => c.id)).toEqual(['ch-1'])
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('节点缺 data/spec/meta/layout 或边缺 data：无法机械修复，隔离节点（关联边随之成孤儿）/隔离该边', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
    }
    const scene = doc.graph.nodes.find((n) => n.id === 's1')!
    delete scene.data // s1 是 e1/e3 的端点
    const branch = doc.graph.edges.find((e) => e.id === 'e2')!
    delete branch.data
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).not.toContain('s1')
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).not.toContain('e1') // 端点节点已隔离 → 孤儿边
    expect(edgeIds).not.toContain('e3')
    expect(edgeIds).not.toContain('e2') // data 缺失的边直接隔离
    expect(round.warnings.some((w) => w.includes('s1'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e2'))).toBe(true)
  })

  it('节点 layout.position 坐标非有限数值：隔离该节点并警告（缺坐标会让画布渲染崩溃）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const beat = doc.graph.nodes.find((n) => n.id === 'b1')!
    beat.layout.position = { x: Number.NaN, y: 0 }
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).not.toContain('b1')
    expect(round.warnings.some((w) => w.includes('b1'))).toBe(true)
  })

  it('按类型的必填列表缺失/非数组：重置为空数组并警告，节点保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: { id: string; data: { spec: Record<string, unknown> } }[] }
    }
    for (const n of doc.graph.nodes) {
      if (n.id === 's1') delete n.data.spec.characterIds
      if (n.id === 'd1') n.data.spec.lines = 'oops'
      if (n.id === 'br1') delete n.data.spec.options
      if (n.id === 'sh1') n.data.spec.refs = null
    }
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1', 'b1', 'd1', 'br1', 'sh1'])
    const scene = round.content.nodes[0].data as { characterIds: string[] }
    expect(scene.characterIds).toEqual([])
    // branch 选项被清空后，绑定选项的 e2 边成为孤儿边被隔离
    expect(round.content.edges.map((e) => e.id)).not.toContain('e2')
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('列表成员过滤：characterIds 非字符串成员、lines/options 非普通对象成员移除并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: { id: string; data: { spec: Record<string, unknown> } }[] }
    }
    for (const n of doc.graph.nodes) {
      if (n.id === 's1') n.data.spec.characterIds = ['ch-1', 7, null]
      if (n.id === 'd1') n.data.spec.lines = [{ id: 'line-1', kind: 'line', text: '别走' }, null]
    }
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!.data as { characterIds: string[] }
    expect(scene.characterIds).toEqual(['ch-1'])
    const dialogue = round.content.nodes.find((n) => n.id === 'd1')!.data as { lines: unknown[] }
    expect(dialogue.lines).toHaveLength(1)
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('节点 ui 缺失/异型：重置默认值并警告，加载后 selected 恒为 false', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: { id: string; ui?: unknown }[] }
    }
    delete doc.graph.nodes.find((n) => n.id === 'b1')!.ui
    doc.graph.nodes.find((n) => n.id === 'd1')!.ui = { selected: 'yes' }
    const round = parseProject(doc)
    expect(round.content.nodes.every((n) => n.selected === false)).toBe(true)
    expect(round.warnings.length).toBeGreaterThan(0)
  })
})

describe('归一化一期：project 元数据修复（§11.1 第 2 步，受信 id / 索引名回退链）', () => {
  it('project.id 与受信 projectId 不一致：以受信 id 覆盖并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.id = 'p-alien'
    const round = parseProject(doc, { projectId: 'p-1' })
    expect(round.warnings.some((w) => w.includes('p-alien'))).toBe(true)
  })

  it('project.name 异型/空白/超长：回退索引名，再回退「未命名项目」并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      project: { name: unknown }
    }
    doc.project.name = '   '
    expect(parseProject(doc, { indexName: '索引名' }).content.name).toBe('索引名')
    expect(parseProject(doc).content.name).toBe('未命名项目')
    doc.project.name = 42
    expect(parseProject(doc, { indexName: '索引名' }).content.name).toBe('索引名')
    doc.project.name = '长'.repeat(65)
    expect(parseProject(doc).content.name).toBe('未命名项目')
    // 合法名称去首尾空白后采用
    doc.project.name = '  午夜出租车  '
    expect(parseProject(doc).content.name).toBe('午夜出租车')
  })

  it('createdAt/updatedAt 非可解析时间戳：修复为有效 ISO 并警告；description 非字符串剥离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.createdAt = 'not-a-date'
    doc.project.updatedAt = ''
    const round = parseProject(doc)
    expect(Number.isFinite(Date.parse(round.content.createdAt!))).toBe(true)
    expect(round.warnings.length).toBeGreaterThan(0)

    const doc2 = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      project: { description: unknown }
    }
    doc2.project.description = 7
    expect(parseProject(doc2).content.description).toBeUndefined()
  })
})

describe('归一化一期：episodeTitles 键值严格化（§11.1 键值域）', () => {
  it('非规范键（前导零/科学计数/空白/零/负/小数/超安全整数）与非字符串值删除并警告；合法值去空白', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      episodeTitles: unknown
    }
    doc.episodeTitles = {
      '2': ' 摊牌 ',
      '01': '前导零',
      '1e0': '科学计数',
      ' 1': '含空白',
      '0': '零',
      '-1': '负',
      '1.5': '小数',
      '9007199254740992': '超安全整数',
      abc: '非数字',
      '3': 42,
      '4': '   ',
    }
    const round = parseProject(doc)
    expect(round.content.episodeTitles).toEqual({ 2: '摊牌' })
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('episodeTitles 为数组形态：按非 Record 重置为空（数组下标不参与转换）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      episodeTitles: unknown
    }
    doc.episodeTitles = ['零', '一']
    const round = parseProject(doc)
    expect(round.content.episodeTitles).toEqual({})
  })
})

describe('归一化一期：视口形状校验（§11.1）', () => {
  it('viewport 非对象/坐标非有限/zoom 非正：删除字段并警告（回退打开时 fitView）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { viewport: unknown }
    }
    doc.graph.viewport = { x: Number.NaN, y: 0, zoom: 1 }
    expect(parseProject(doc).content.viewport).toBeUndefined()
    doc.graph.viewport = { x: 0, y: 0, zoom: 0 }
    expect(parseProject(doc).content.viewport).toBeUndefined()
    doc.graph.viewport = 'oops'
    expect(parseProject(doc).content.viewport).toBeUndefined()
    doc.graph.viewport = { x: 5, y: 6, zoom: 2 }
    expect(parseProject(doc).content.viewport).toEqual({ x: 5, y: 6, zoom: 2 })
  })
})

describe('边句柄规范（§5：匿名端口句柄必须省略）', () => {
  it('落盘剥离：sequence 边的 sourceHandle 与任意 targetHandle 不进入载荷', () => {
    const content = mkContent()
    content.edges[0] = {
      ...content.edges[0],
      sourceHandle: 'stale-option',
      targetHandle: 't-in',
    } as Edge
    content.edges[2] = { ...content.edges[2], targetHandle: 't-in' } as Edge
    const doc = serializeProject(content, 'p-1', NOW)
    expect(doc.graph.edges[0]).toEqual({
      id: 'e1',
      source: 's1',
      target: 'd1',
      data: { kind: 'sequence' },
    })
    expect(doc.graph.edges[2]).toEqual({
      id: 'e3',
      source: 's1',
      target: 'sh1',
      sourceHandle: 'shots',
      data: { kind: 'attach' },
    })
  })

  it('加载剥离：已知 kind 边携带 targetHandle 不隔离，剥离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { edges: Record<string, unknown>[] }
    }
    doc.graph.edges[0].targetHandle = 't-in' // sequence
    doc.graph.edges[1].targetHandle = 't-in' // branch
    doc.graph.edges[2].targetHandle = 't-in' // attach
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(round.content.edges.every((e) => e.targetHandle === undefined)).toBe(true)
    expect(round.warnings.length).toBeGreaterThan(0)
  })

  it('未知/非字符串 kind 的边隔离并警告（§5 判别联合边界，绝不为未知 kind 猜测变体）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-unknown',
      source: 's1',
      target: 'd1',
      data: { kind: 'teleport' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-unknown')
    expect(round.warnings.some((w) => w.includes('e-unknown'))).toBe(true)
  })
})
