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
    // 干净 v1：归一化零改写，repaired=false（打开不应触发回写刷 updatedAt）
    expect(round.repaired).toBe(false)
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
    expect(round.content.edges.find((e) => e.id === 'e-bad1')!.sourceHandle).toBeUndefined()
    // attach 句柄必须是字面量 shots：非 shots 无法确定性修复，隔离
    expect(edgeIds).not.toContain('e-bad2')
    expect(round.warnings.some((w) => w.includes('e-bad1'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-bad2'))).toBe(true)
    // e-bad3 剥离句柄后与 e-bad1 同为 (s1→b1, 匿名端口)：逻辑重复，保留文档序首条
    expect(edgeIds).not.toContain('e-bad3')
    expect(round.warnings.some((w) => w.includes('e-bad3') && w.includes('重复'))).toBe(true)
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

  it('悬空分镜引用：assetId 只按 assets.byId 解析，缺失按 §11.4 标记警告并保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data.spec as { refs: unknown[] }).refs = [
      { id: 'ref-1', kind: 'character', assetId: 'a-gone' },
      { id: 'ref-2', kind: 'audio', assetId: 'a-gone2' },
    ]
    const round = parseProject(doc)
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')!.data as {
      refs: { assetId?: string }[]
    }).refs
    // 悬空引用保留（§8.2.3 不删除用户选择）
    expect(refs.map((r) => r.assetId)).toEqual(['a-gone', 'a-gone2'])
    expect(round.warnings.some((w) => w.includes('a-gone'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('a-gone2'))).toBe(true)
  })

  it('原型链键名（constructor）的 assetId：不误命中 Object.prototype 成员，按悬空引用警告且不抛异常', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data.spec as { refs: unknown[] }).refs = [
      { id: 'ref-1', kind: 'character', assetId: 'constructor' },
      { id: 'ref-2', kind: 'audio', assetId: 'toString' },
    ]
    // 红：byId 是普通对象，'constructor'/'toString' 经原型链解析出
    // Object.prototype 成员（函数对象），asset.mime 为 undefined →
    // shotRefMimeMatches 的 mime.startsWith 抛 TypeError
    const round = parseProject(doc)
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')!.data as {
      refs: { assetId?: string }[]
    }).refs
    expect(refs.map((r) => r.assetId)).toEqual(['constructor', 'toString'])
    expect(round.warnings.some((w) => w.includes('constructor'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('toString'))).toBe(true)
  })

  it('空白 assetId 的分镜引用：按异型成员移除（空串是 string 但不可解析，保留即永久悬空引用）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data.spec as { refs: unknown[] }).refs = [
      { id: 'ref-1', kind: 'audio', assetId: '' },
      { id: 'ref-2', kind: 'audio', assetId: '  ' },
      { id: 'ref-3', kind: 'audio', assetId: 'a-ok' },
    ]
    const round = parseProject(doc)
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')!.data as {
      refs: { assetId?: string }[]
    }).refs
    // 红：isShotRefShape 只验类型不验空白，空串 assetId 被保留
    expect(refs.map((r) => r.assetId)).toEqual(['a-ok'])
    expect(round.warnings.some((w) => w.includes('assetId'))).toBe(true)
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

  it('schemaVersion 0 旧信封：props/documents 数组的重复/空 id 在键化前重发——不因 Object.fromEntries 折叠丢条目', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: { nodes: [], edges: [] },
      settings: {
        characters: [],
        locations: [],
        props: [
          { id: 'prop-1', name: '怀表', description: '' },
          { id: 'prop-1', name: '同 id 道具', description: '' },
          { id: '', name: '空 id 道具', description: '' },
        ],
        documents: [
          { id: 'doc-1', title: '设定', body: '一', relatedIds: [] },
          { id: 'doc-1', title: '同 id 文档', body: '二', relatedIds: [] },
        ],
      },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    // 红：toDocSettings 的 Object.fromEntries 在归一化重发前按键折叠，
    // 除末见外全部条目被迁移回写永久丢弃（角色/地点已有数组期重发）
    const propIds = round.content.settings.props?.map((p) => p.id) ?? []
    expect(propIds).toHaveLength(3)
    expect(new Set(propIds).size).toBe(3)
    expect(round.content.settings.documents).toHaveLength(2)
    expect(new Set(round.content.settings.documents?.map((d) => d.id)).size).toBe(2)
  })

  it('逻辑重复边的元组键不可因 id 含 \\u0000 而碰撞：不同端点的两条边都保留', () => {
    // id 是不可信输入，JSON 字符串可含 \u0000——拼接键会让
    // (a → b\0c) 与 (a\0b → c) 折叠成同键，第二条被误判重复并随修复回写移除
    const beat = (id: string) =>
      ({
        id,
        type: 'beat',
        position: { x: 0, y: 0 },
        selected: false,
        data: { name: `节拍 ${id}`, tone: 't' },
      }) as unknown as CanvasNode
    const content: ProjectContent = {
      name: 'x',
      nodes: [beat('a'), beat('a\u0000b'), beat('b\u0000c'), beat('c')],
      edges: [
        { id: 'e1', source: 'a', target: 'b\u0000c' },
        { id: 'e2', source: 'a\u0000b', target: 'c' },
      ],
      settings: { characters: [], locations: [] },
    }
    const round = parseProject(serializeProject(content, 'p-1', NOW))
    expect(round.content.edges).toHaveLength(2)
    expect(round.warnings.some((w) => w.includes('逻辑重复'))).toBe(false)
    // 控制组：真正同端点同句柄的重复边仍被隔离
    const dupContent: ProjectContent = {
      ...content,
      edges: [
        { id: 'e1', source: 'a', target: 'b\u0000c' },
        { id: 'e1b', source: 'a', target: 'b\u0000c' },
      ],
    }
    const dupRound = parseProject(serializeProject(dupContent, 'p-1', NOW))
    expect(dupRound.content.edges).toHaveLength(1)
  })

  it('schemaVersion 0 节点 data 容器异型（null/字符串）：隔离节点与关联边，不制造空白合法节点被回写固化', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          // data 非普通对象：预检若重置为 {}，迁移会造出 lines:[] + 空 label
          // 的"合法"空白对白——修复回写把损坏节点永久固化成空白节点
          { id: 'd1', type: 'dialogue', position: { x: 0, y: 0 }, data: null },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
        ],
        edges: [{ id: 'e1', source: 's1', target: 'd1', className: 'pw-edge-sequence' }],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.content.nodes.some((n) => n.id === 'd1')).toBe(false)
    // 关联边随孤儿边规则隔离
    expect(round.content.edges).toHaveLength(0)
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('隔离'))).toBe(true)
  })

  it('schemaVersion 0 旧信封：边判别字段（type/className）归类为显式 data.kind', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          { id: 'br1', type: 'branch', position: { x: 0, y: 0 }, data: { prompt: '去哪', options: [{ id: 'opt-a', label: '左' }] } },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
          { id: 's2', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场二', sceneNo: 2, interior: true, synopsis: '' } },
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
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
          { id: 's2', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场二', sceneNo: 2, interior: true, synopsis: '' } },
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

  it('data.order 异型（非有限数）：确定性剥离并警告，边本身保留不隔离（§5 存在时须为有限数）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { edges: Record<string, unknown>[] }
    }
    ;(doc.graph.edges[0].data as Record<string, unknown>).order = 'first' // 字符串
    ;(doc.graph.edges[1].data as Record<string, unknown>).order = { seq: 1 } // 对象
    ;(doc.graph.edges[2].data as Record<string, unknown>).order = Number.NaN // 非有限
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(round.content.edges.every((e) => (e.data as { order?: unknown } | undefined)?.order === undefined)).toBe(
      true,
    )
    expect(round.warnings.filter((w) => w.includes('order'))).toHaveLength(3)
  })
})

describe('归一化：§11.1 第 3 步 id 重发 / 成环 / attach 宿主唯一', () => {
  it('重复节点 id：保留文档序首个，后续重发本域未占用新 id（按 id 的引用仍解析到首见节点）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const dup = structuredClone(doc.graph.nodes.find((n) => n.id === 'd1')!)
    doc.graph.nodes.push(dup) // 文档序末尾再放一份 d1
    const round = parseProject(doc)
    const ids = round.content.nodes.map((n) => n.id)
    expect(ids).toHaveLength(6)
    expect(ids.filter((i) => i === 'd1')).toHaveLength(1)
    expect(ids[2]).toBe('d1') // 首见节点保留原 id 与位置
    const reissued = ids[5]
    expect(reissued).not.toBe('d1')
    expect(new Set(ids).size).toBe(6) // 重发 id 不与任何既有 id 碰撞
    // 重发节点内容保留（无连线孤儿，由用户处置）
    const orphan = round.content.nodes[5].data as { name?: string; lines?: unknown[] }
    expect(orphan.name).toBe('对白')
    expect(orphan.lines).toHaveLength(1)
    // 指向 d1 的边仍解析到首见节点，不产生改接
    expect(round.content.edges.map((e) => e.id)).toContain('e1')
    expect(round.warnings.some((w) => w.includes('重复') && w.includes('d1'))).toBe(true)
  })

  it('自环边（source === target）隔离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-self',
      source: 'b1',
      target: 'b1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-self')
    expect(round.warnings.some((w) => w.includes('e-self') && w.includes('自环'))).toBe(true)
  })

  it('成环边：按文档序重建剧情流图，加入即闭合回路的 sequence 边隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-back',
      source: 'd1',
      target: 's1', // 与既有 e1（s1→d1）闭合回路
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e1') // 文档序首条保留
    expect(edgeIds).not.toContain('e-back')
    expect(round.warnings.some((w) => w.includes('e-back') && w.includes('环'))).toBe(true)
  })

  it('成环边：branch 边同样参与环检测（传递闭包）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    // 既有 e2 = br1→d1（option-opt-2）；再加 d1→br1 即闭合 br1→d1→br1
    doc.graph.edges.push({
      id: 'e-cycle',
      source: 'd1',
      target: 'br1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e2')
    expect(edgeIds).not.toContain('e-cycle')
    expect(round.warnings.some((w) => w.includes('e-cycle') && w.includes('环'))).toBe(true)
  })

  it('attach 边不参与环检测：scene↔shot 垂直从属照常保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).toContain('e3')
  })

  it('同一 shot 的多条入向 attach 边：保留文档序首条，其余按孤儿边隔离并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const secondScene = structuredClone(doc.graph.nodes.find((n) => n.id === 's1')!)
    secondScene.id = 's2'
    doc.graph.nodes.push(secondScene)
    doc.graph.edges.push({
      id: 'e-attach2',
      source: 's2',
      target: 'sh1', // sh1 已有 e3（s1→sh1）宿主
      sourceHandle: 'shots',
      data: { kind: 'attach' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e3') // 文档序首条保留
    expect(edgeIds).not.toContain('e-attach2')
    expect(round.warnings.some((w) => w.includes('e-attach2') && w.includes('宿主'))).toBe(true)
  })

  it('sequence 边 source 为 branch 节点：按孤儿边隔离并警告（§5 端口归属反向约束）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-seq-from-branch',
      source: 'br1', // branch 无匿名输出端口，不能引出 sequence 边
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-seq-from-branch')
    expect(round.warnings.some((w) => w.includes('e-seq-from-branch'))).toBe(true)
    // branch 经选项端口引出的 branch 边不受影响
    expect(round.content.edges.map((e) => e.id)).toContain('e2')
  })

  it('同 source/target/sourceHandle 的逻辑重复边：保留文档序首条，其余隔离并警告（§11.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push(
      { id: 'e-dup-seq', source: 's1', target: 'd1', data: { kind: 'sequence' } },
      { id: 'e-dup-opt', source: 'br1', target: 'd1', sourceHandle: 'option-opt-2', data: { kind: 'branch' } },
    ) as unknown as ProjectDocument['graph']['edges'][number][]
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    expect(edgeIds).toContain('e1') // 文档序首条 sequence 保留
    expect(edgeIds).toContain('e2') // 文档序首条 branch（option-opt-2）保留
    expect(edgeIds).not.toContain('e-dup-seq')
    expect(edgeIds).not.toContain('e-dup-opt')
    expect(round.warnings.some((w) => w.includes('e-dup-seq') && w.includes('重复'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-dup-opt') && w.includes('重复'))).toBe(true)
  })

  it('重复边 id：保留文档序首条原 id，后续同 id 边重发新 id 并警告（§11.1 第 3 步）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e1', // 与首条 sequence 边撞 id，但端点不同（非逻辑重复）
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const withE1 = round.content.edges.filter((e) => e.id === 'e1')
    expect(withE1).toHaveLength(1)
    expect(withE1[0].source).toBe('s1') // 文档序首条保留原 id
    // 后续同 id 边以新 id 存活：React Flow 身份唯一，选中/删除不再歧义
    const reissued = round.content.edges.find((e) => e.source === 'b1')!
    expect(reissued.id).not.toBe('e1')
    expect(round.warnings.some((w) => w.includes('重复') && w.includes('e1'))).toBe(true)
  })

  it('空白边 id：非空串同款按 §8.1 trim 口径重发新 id 并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: '   ', // 真值非空但 trim 后为空：React Flow 身份（选中/删除/撤销）不可靠
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    const round = parseProject(doc)
    const reissued = round.content.edges.find((e) => e.source === 'b1' && e.target === 'd1')!
    expect(reissued.id).toMatch(/^edge-/)
    expect(round.warnings.some((w) => w.includes('边 id 缺失或非法'))).toBe(true)
  })

  it('v1 可修复脏数据 repaired=true（回写依据）——修复不得只留内存、每次打开重造"稳定" id', () => {
    // 空白边 id（就地重发）与标题去空白（值改写）两类修复都要能被察觉：
    // normalizeDocument 就地改写传入对象，比较必须对原始克隆进行
    const dirty = serializeProject(mkContent(), 'p-1', NOW)
    dirty.graph.edges.push({
      id: '   ',
      source: 'b1',
      target: 'd1',
      data: { kind: 'sequence' },
    } as unknown as ProjectDocument['graph']['edges'][number])
    dirty.episodeTitles = { 1: ' 开局 ' }
    expect(parseProject(dirty).repaired).toBe(true)

    // 只读警告（悬空引用标记，§11.4）不改写内容：不触发回写
    const danglingOnly = serializeProject(mkContent(), 'p-1', NOW)
    danglingOnly.graph.nodes.push({
      id: 'ghost-ref',
      type: 'scene',
      layout: { position: { x: 0, y: 0 } },
      ui: { selected: false, expanded: true },
      data: { spec: { characterIds: ['ch-none'], interior: true, sceneNo: 9, synopsis: '', time: '' }, meta: { label: '悬空' } },
    } as unknown as ProjectDocument['graph']['nodes'][number])
    const round = parseProject(danglingOnly)
    expect(round.warnings.some((w) => w.includes('ch-none'))).toBe(true)
    expect(round.repaired).toBe(false)
  })
})

describe('归一化：设定集实体形状校验（§11.3，与 §9.3 upsert 边界同域）', () => {
  it('name 非字符串/空白或角色缺 gradient：条目从桶中隔离并警告（头像渲染 trim 不再崩溃）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: Record<string, Record<string, unknown>>
    }
    doc.settings.characters['ch-bad'] = { id: 'ch-bad', name: null, gradient: 'g' }
    doc.settings.characters['ch-blank'] = { id: 'ch-blank', name: '   ', gradient: 'g' }
    doc.settings.characters['ch-nog'] = { id: 'ch-nog', name: '无渐变' }
    doc.settings.locations['loc-bad'] = { id: 'loc-bad', name: 42 }
    const round = parseProject(doc)
    expect(round.content.settings.characters.map((c) => c.id)).toEqual(['ch-1'])
    expect(round.content.settings.locations.map((l) => l.id)).toEqual(['loc-1'])
    expect(round.warnings.some((w) => w.includes('ch-bad'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('ch-blank'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('ch-nog'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('loc-bad'))).toBe(true)
    // 被隔离条目的既有引用按 §8.2.3 悬空标记，不清除 id
    const scene = round.content.nodes.find((n) => n.id === 's1')!.data as { characterIds: string[] }
    expect(scene.characterIds).toEqual(['ch-1'])
  })

  it('桶键与内嵌 id 漂移：以记录键为权威改写内嵌 id 并警告（引用按键解析不误标悬空）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: Record<string, Record<string, Record<string, unknown>>>
    }
    doc.settings.characters['ch-1'].id = 'ch-drift'
    doc.settings.locations['loc-1'].id = 'loc-drift'
    delete doc.settings.props
    const round = parseProject(doc)
    expect(round.content.settings.characters[0].id).toBe('ch-1')
    expect(round.content.settings.locations[0].id).toBe('loc-1')
    // 场景对 ch-1/loc-1 的引用按键解析，漂移修复后不得误报悬空
    expect(round.warnings.some((w) => w.includes('不存在的角色 ch-1'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('不存在的地点 loc-1'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('ch-1') && w.includes('内嵌 id'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('loc-1') && w.includes('内嵌 id'))).toBe(true)
  })

  it('可选字段（bio/note/description/avatarAssetId）类型错误：剥离该字段并警告，条目保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: Record<string, Record<string, Record<string, unknown>>>
    }
    doc.settings.characters['ch-1'].bio = 7
    doc.settings.characters['ch-1'].avatarAssetId = { nope: true }
    doc.settings.locations['loc-1'].note = []
    doc.settings.props['pr-1'] = { id: 'pr-1', name: '怀表', description: 42 }
    const round = parseProject(doc)
    expect(round.content.settings.characters[0]).toEqual({ id: 'ch-1', name: '林晚', gradient: 'g-lin' })
    expect(round.content.settings.locations[0]).toEqual({ id: 'loc-1', name: '天台' })
    expect(round.content.settings.props?.[0]).toEqual({ id: 'pr-1', name: '怀表' })
    expect(round.warnings.length).toBeGreaterThan(0)
  })
})

describe('归一化：对白行判别与必填字段（§4.2 DialogueLine，§11.3）', () => {
  it('kind 非法或 text 非字符串的行隔离并警告，合法行保留——坏行不阻挡画布打开', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    const dlg = doc.graph.nodes.find((n) => n.id === 'd1')!
    const spec = (dlg.data as { spec: { lines: unknown[] } }).spec
    spec.lines = [
      { id: 'l1', kind: 'line', text: '别走', speaker: 'ch-1' },
      { id: 'l2', kind: 'line', text: { broken: true } }, // text 异型：DialogueNode 渲染崩溃源
      { id: 'l3', kind: 'narration', text: '画外' }, // 非法判别值
      { id: 'l4', kind: 'action', text: '雨更大了' },
      'not-an-object',
    ]
    const round = parseProject(doc)
    const lines = (round.content.nodes.find((n) => n.id === 'd1')!.data as { lines: { id: string }[] })
      .lines
    expect(lines.map((l) => l.id)).toEqual(['l1', 'l4'])
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('spec.lines'))).toBe(true)
    // 合法行的 speaker 引用照常解析，不误报悬空
    expect(round.warnings.some((w) => w.includes('不存在的角色 ch-1'))).toBe(false)
  })

  it('可选字段异型（speaker 对象 / side 非左右值 / vo 非布尔）：逐字段剥离并警告，行与合法字段保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Record<string, unknown>[] }
    }
    const dlg = doc.graph.nodes.find((n) => n.id === 'd1')!
    ;((dlg.data as { spec: { lines: unknown[] } }).spec).lines = [
      // 三个可选字段全异型：对象 speaker 会进到 <select>，'false' 字符串真值渲染 VO 徽标
      { id: 'l1', kind: 'line', text: '别走', speaker: { id: 'ch-1' }, side: 'up', vo: 'false' },
      { id: 'l2', kind: 'action', text: '雨停了', speaker: null }, // null speaker：v0 兼容链产物的合法形态
      { id: 'l3', kind: 'line', text: '嗯', speaker: 'ch-1', side: 'right', vo: true }, // 全合法原样保留
    ]
    const round = parseProject(doc)
    const lines = (round.content.nodes.find((n) => n.id === 'd1')!.data as unknown as {
      lines: Record<string, unknown>[]
    }).lines
    expect(lines).toEqual([
      { id: 'l1', kind: 'line', text: '别走' },
      { id: 'l2', kind: 'action', text: '雨停了', speaker: null },
      { id: 'l3', kind: 'line', text: '嗯', speaker: 'ch-1', side: 'right', vo: true },
    ])
    for (const f of ['speaker', 'side', 'vo']) {
      expect(round.warnings.some((w) => w.includes('d1') && w.includes('l1') && w.includes(f))).toBe(true)
    }
  })
})

describe('归一化：节点判别联合形状校验（§4.1/§11.1 第 3 步，§9.3 create_node 的加载侧对等）', () => {
  const specOf = (doc: ProjectDocument, id: string) =>
    (doc.graph.nodes.find((n) => n.id === id)!.data as unknown as { spec: Record<string, unknown> }).spec
  const metaOf = (doc: ProjectDocument, id: string) =>
    (doc.graph.nodes.find((n) => n.id === id)!.data as unknown as { meta: Record<string, unknown> }).meta

  it('spec 必填标量异型（beat.tone 为对象）：节点隔离并警告——渲染 React 子节点的崩溃源', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    specOf(doc, 'b1').tone = { broken: true }
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).not.toContain('b1')
    expect(round.warnings.some((w) => w.includes('b1') && w.includes('tone'))).toBe(true)
  })

  it('spec 必填标量缺失（synopsis/prompt/size）与未知节点类型：隔离并警告，关联边随孤儿规则隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    delete specOf(doc, 's1').synopsis
    delete specOf(doc, 'br1').prompt
    delete specOf(doc, 'sh1').size
    ;(doc.graph.nodes.find((n) => n.id === 'd1')! as { type: string }).type = 'montage'
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).toEqual(['b1'])
    // 指向已隔离节点的边不残留
    expect(round.content.edges).toEqual([])
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('synopsis'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('br1') && w.includes('prompt'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('sh1') && w.includes('size'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('类型'))).toBe(true)
  })

  it('名称型节点缺必填 meta.label：隔离并警告（§4.1 LabeledMeta）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    delete metaOf(doc, 'b1').label
    const round = parseProject(doc)
    expect(round.content.nodes.map((n) => n.id)).not.toContain('b1')
    expect(round.warnings.some((w) => w.includes('b1') && w.includes('label'))).toBe(true)
  })

  it('never 禁写字段：branch/shot 的 meta.label 与 shot 的 meta.episodeNo 剥离并警告，节点保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    metaOf(doc, 'br1').label = '镜像标题'
    metaOf(doc, 'sh1').label = '分镜名'
    metaOf(doc, 'sh1').episodeNo = 3
    const round = parseProject(doc)
    const branch = round.content.nodes.find((n) => n.id === 'br1')!
    const shot = round.content.nodes.find((n) => n.id === 'sh1')!
    expect('name' in branch.data).toBe(false)
    expect('name' in shot.data).toBe(false)
    expect('episodeNo' in shot.data).toBe(false)
    expect(round.warnings.filter((w) => w.includes('禁写'))).toHaveLength(3)
  })

  it('episodeNo 非法（零/负/小数/超安全整数）：删除字段回退未分集并警告，节点保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    metaOf(doc, 's1').episodeNo = 0
    metaOf(doc, 'b1').episodeNo = -1
    metaOf(doc, 'd1').episodeNo = 1.5
    metaOf(doc, 'br1').episodeNo = 2 ** 53
    const round = parseProject(doc)
    for (const id of ['s1', 'b1', 'd1', 'br1']) {
      expect('episodeNo' in round.content.nodes.find((n) => n.id === id)!.data).toBe(false)
    }
    expect(round.warnings.filter((w) => w.includes('episodeNo'))).toHaveLength(4)
  })

  it('非法 sceneNo/shotNo：按文档序顺位重发为正整数并警告（场号/镜号可在面板修正）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    specOf(doc, 's1').sceneNo = '3' // 非数值
    specOf(doc, 'sh1').shotNo = 0 // 非正整数
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!.data as { sceneNo: number }
    const shot = round.content.nodes.find((n) => n.id === 'sh1')!.data as { shotNo: number }
    expect(scene.sceneNo).toBe(1)
    expect(shot.shotNo).toBe(1)
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('sceneNo'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('sh1') && w.includes('shotNo'))).toBe(true)
  })
})

describe('归一化：键控列表 id 非空且数组内唯一（§4.2/§11.1 第 3 步）', () => {
  type RawOptionsDoc = {
    graph: {
      nodes: {
        id: string
        data: { spec: { options?: { id: string; label: string }[] } }
      }[]
      edges: Record<string, unknown>[]
    }
  }
  const optionsOf = (doc: RawOptionsDoc, id: string) =>
    doc.graph.nodes.find((n) => n.id === id)!.data.spec.options!

  it('branch 选项重复 id：保留首见项、后续重发新 id；绑定既有选项的连线不改接', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RawOptionsDoc
    optionsOf(doc, 'br1').push({ id: 'opt-1', label: '重复项' })
    const round = parseProject(doc)
    const options = (round.content.nodes.find((n) => n.id === 'br1')!.data as {
      options: { id: string; label: string }[]
    }).options
    expect(options).toHaveLength(3)
    expect(new Set(options.map((o) => o.id)).size).toBe(3)
    expect(options[0]).toEqual({ id: 'opt-1', label: '坦白' }) // 首见项保留
    expect(options[2].label).toBe('重复项')
    expect(options[2].id).not.toBe('opt-1')
    // e2 绑定 opt-2 不受影响
    expect(round.content.edges.find((e) => e.id === 'e2')!.sourceHandle).toBe('option-opt-2')
    expect(round.warnings.some((w) => w.includes('br1') && w.includes('重复'))).toBe(true)
  })

  it('唯一空选项 id：重发新 id 并同步改写该 branch 引出边的 option- 句柄（连线保留）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RawOptionsDoc
    optionsOf(doc, 'br1').push({ id: '', label: '丙' })
    doc.graph.edges.push({
      id: 'e-empty',
      source: 'br1',
      target: 's1',
      sourceHandle: 'option-', // 空 id 选项的句柄
      data: { kind: 'branch' },
    })
    const round = parseProject(doc)
    const third = (round.content.nodes.find((n) => n.id === 'br1')!.data as {
      options: { id: string; label: string }[]
    }).options.find((o) => o.label === '丙')!
    expect(third.id).not.toBe('')
    const edge = round.content.edges.find((e) => e.id === 'e-empty')!
    expect(edge.sourceHandle).toBe(`option-${third.id}`)
    expect(round.warnings.some((w) => w.includes('e-empty') && w.includes('改写'))).toBe(true)
  })

  it('同 branch 多个空选项 id：映射歧义不改写，指向空句柄的连线按孤儿边隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RawOptionsDoc
    doc.graph.nodes.push({
      id: 'br2',
      type: 'branch',
      layout: { position: { x: 0, y: 0 } },
      ui: { selected: false, expanded: true },
      data: {
        spec: {
          prompt: '选',
          options: [
            { id: '', label: '甲' },
            { id: '', label: '乙' },
          ],
        },
        meta: {},
      },
    } as unknown as RawOptionsDoc['graph']['nodes'][number])
    doc.graph.edges.push({
      id: 'e-amb',
      source: 'br2',
      target: 'd1',
      sourceHandle: 'option-',
      data: { kind: 'branch' },
    })
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-amb')
    expect(round.warnings.some((w) => w.includes('e-amb'))).toBe(true)
    // 两个空 id 选项均已重发为唯一非空 id
    const options = (round.content.nodes.find((n) => n.id === 'br2')!.data as {
      options: { id: string }[]
    }).options
    expect(new Set(options.map((o) => o.id)).size).toBe(2)
    expect(options.every((o) => o.id !== '')).toBe(true)
  })

  it('dialogue lines / shot refs 的重复与空 id：重发去歧（不被边引用，纯列表 key）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: {
        nodes: {
          id: string
          data: { spec: { lines?: Record<string, unknown>[]; refs?: Record<string, unknown>[] } }
        }[]
      }
    }
    const spec = (id: string) => doc.graph.nodes.find((n) => n.id === id)!.data.spec
    spec('d1').lines!.push({ id: 'line-1', kind: 'line', text: '重复 id' }, { kind: 'action', text: '无 id' })
    spec('sh1').refs!.push(
      { id: 'ref-1', kind: 'character', label: '重复' },
      { id: '', kind: 'location', label: '空 id' },
    )
    const round = parseProject(doc)
    const lines = (round.content.nodes.find((n) => n.id === 'd1')!.data as { lines: { id: string }[] })
      .lines
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')!.data as { refs: { id: string }[] })
      .refs
    expect(new Set(lines.map((l) => l.id)).size).toBe(3)
    expect(lines.every((l) => l.id !== '')).toBe(true)
    expect(new Set(refs.map((r) => r.id)).size).toBe(3)
    expect(refs.every((r) => r.id !== '')).toBe(true)
    expect(round.warnings.filter((w) => w.includes('重发')).length).toBeGreaterThanOrEqual(4)
  })
})

describe('归一化：assets.byId 完整 AssetRef 形状校验（§11.3，Rust 保存边界的加载侧对等）', () => {
  const goodAsset = {
    id: 'a-1',
    relPath: 'assets/lin.png',
    mime: 'image/png',
    source: 'upload',
    createdAt: '2026-08-01T00:00:00.000Z',
  }

  it('内嵌 id 缺失或与记录键漂移：以记录键为准改写并警告（条目保留）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    doc.assets.byId['a-1'] = { ...goodAsset, id: 'a-other' }
    const noId: Record<string, unknown> = { ...goodAsset, relPath: 'assets/two.png' }
    delete noId.id
    doc.assets.byId['a-2'] = noId
    const round = parseProject(doc)
    expect(round.content.assets?.byId['a-1']?.id).toBe('a-1')
    expect(round.content.assets?.byId['a-2']?.id).toBe('a-2')
    expect(round.warnings.some((w) => w.includes('a-other') || w.includes('a-1'))).toBe(true)
    // 合法条目原样透传
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.assets.byId['a-1'].relPath).toBe('assets/lin.png')
  })

  it('relPath 越界 / source 非法 / createdAt 非严格 ISO / mime 无法规范化 / 空条目：隔离并警告（下次保存不再整份被拒）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    doc.assets.byId['a-path'] = { ...goodAsset, id: 'a-path', relPath: 'assets/../secret' }
    doc.assets.byId['a-src'] = { ...goodAsset, id: 'a-src', source: 'unknown' }
    doc.assets.byId['a-time'] = { ...goodAsset, id: 'a-time', createdAt: '2026-08-01' }
    doc.assets.byId['a-mime'] = { ...goodAsset, id: 'a-mime', mime: 'image' }
    doc.assets.byId['a-empty'] = {}
    const round = parseProject(doc)
    expect(round.content.assets).toEqual({ byId: {} })
    for (const key of ['a-path', 'a-src', 'a-time', 'a-mime', 'a-empty']) {
      expect(round.warnings.some((w) => w.includes(key))).toBe(true)
    }
  })

  it('通配 mime（image/*）：与 Rust 保存边界同域隔离——放行会让项目打得开但编辑永不落盘', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    doc.assets.byId['a-wild'] = { ...goodAsset, id: 'a-wild', mime: 'image/*' }
    doc.assets.byId['a-keep'] = { ...goodAsset, id: 'a-keep' }
    const round = parseProject(doc)
    // 红：RFC 7230 允许 *，加载侧放行通配 mime——而 Rust is_mime_token 刻意
    // 排除 *，此后每次 save_project 整份被拒（防抖吞错，编辑永不落盘）
    expect(round.content.assets?.byId['a-wild']).toBeUndefined()
    expect(round.content.assets?.byId['a-keep']).toBeDefined()
    expect(round.warnings.some((w) => w.includes('a-wild'))).toBe(true)
  })

  it('合法大小写/首尾空白的 mime：规范化后保留并警告（时区形式不同的合法时间戳保留）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    doc.assets.byId['a-1'] = { ...goodAsset, mime: ' IMAGE/PNG ' }
    doc.assets.byId['a-2'] = { ...goodAsset, id: 'a-2', relPath: 'assets/a.wav', mime: 'audio/wav', createdAt: '2026-08-01T08:00:00+08:00' }
    const round = parseProject(doc)
    expect(round.content.assets?.byId['a-1']?.mime).toBe('image/png')
    expect(round.content.assets?.byId['a-2']?.createdAt).toBe('2026-08-01T08:00:00+08:00')
  })

  it('时间戳规范化结果须仍在可保存域：越出四位年份（+010000）的合法输入按回退链修复，项目不得永久不可保存', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      project: Record<string, unknown>
    }
    // 合法的 -23:59 偏移使 UTC 换算越过 9999 年：toISOString 产出
    // +010000-…——前端严格谓词与 Rust 保存边界都不再接受，修复回写与
    // 此后每次自动保存全被拒收
    doc.project.updatedAt = '9999-12-31T23:59:59-23:59'
    doc.project.createdAt = '9999-12-31T23:59:59-23:59'
    const round = parseProject(doc)
    // 会话不携带 updatedAt（保存时重新盖戳），修复结果经 createdAt 观察：
    // 回退链产出四位年份域内的时间戳
    expect(round.content.createdAt).toMatch(/^\d{4}-/)
    // 再落盘可过保存边界（四位年份域内）
    const again = serializeProject(round.content, 'p-1', new Date(round.content.createdAt!))
    expect(again.project.updatedAt).toMatch(/^\d{4}-/)
    expect(again.project.createdAt).toBe(round.content.createdAt)
  })

  it('空键重发改写后仍空白且无映射的场景引用：移除并警告——不留虚构的"已删除引用"原样落盘', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Array<{ data: { spec: Record<string, unknown> } }> }
    }
    // 空白 id 在 §8.1 共同值域之外；无空键实体可重发改写时不可恢复
    doc.graph.nodes[0].data.spec.characterIds = ['ch-1', '   ']
    doc.graph.nodes[0].data.spec.locationId = '   '
    const round = parseProject(doc)
    const scene = round.content.nodes[0].data as { characterIds: string[]; locationId?: string }
    expect(scene.characterIds).toEqual(['ch-1'])
    expect(scene.locationId).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('characterIds'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('locationId'))).toBe(true)
  })

  it('scene 的 locationId 非字符串：加载边界剥离并警告——不得直达设置面板 select 并原样落盘', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Array<{ data: { spec: Record<string, unknown> } }> }
    }
    doc.graph.nodes[0].data.spec.locationId = {}
    const round = parseProject(doc)
    const scene = round.content.nodes[0].data as { locationId?: unknown }
    expect(scene.locationId).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('locationId'))).toBe(true)
  })
})

describe('归一化：非法节点 id 重发与空端点改写（§8.1/§11.1 第 3 步）', () => {
  /** 可改写的脏 v1 文档视图。 */
  type DirtyDoc = {
    graph: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
  }

  it('缺失/非字符串/空白节点 id：一律重发本域未占用新 id 并警告（不交付非法身份给画布）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    const beat = doc.graph.nodes.find((n) => n.id === 'b1')!
    delete beat.id
    const branch = doc.graph.nodes.find((n) => n.id === 'br1')!
    branch.id = ''
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    shot.id = '   '
    const round = parseProject(doc)
    const ids = round.content.nodes.map((n) => n.id)
    expect(ids).toHaveLength(5)
    expect(ids.every((id) => id.trim().length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toContain('s1')
    expect(ids).toContain('d1')
    expect(round.warnings.filter((w) => w.includes('重发')).length).toBeGreaterThanOrEqual(3)
  })

  it('唯一空 id 节点：建立「空 id → 新 id」映射，指向空串的边端点同步改写、连线保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    const beat = doc.graph.nodes.find((n) => n.id === 'b1')!
    beat.id = ''
    doc.graph.edges.push({ id: 'e-b', source: '', target: 'd1', data: { kind: 'sequence' } })
    const round = parseProject(doc)
    const newBeatId = round.content.nodes.find(
      (n) => (n.data as { tone?: string }).tone === '压抑',
    )!.id
    expect(newBeatId.trim().length).toBeGreaterThan(0)
    const eb = round.content.edges.find((e) => e.id === 'e-b')!
    expect(eb.source).toBe(newBeatId)
    expect(round.warnings.some((w) => w.includes('e-b') && w.includes('改写'))).toBe(true)
  })

  it('多个空 id 节点：映射歧义不建映射，指向空串的边按孤儿边隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    doc.graph.nodes.find((n) => n.id === 'b1')!.id = ''
    doc.graph.nodes.find((n) => n.id === 'br1')!.id = ''
    doc.graph.edges.push({ id: 'e-x', source: '', target: 'd1', data: { kind: 'sequence' } })
    const round = parseProject(doc)
    const ids = round.content.nodes.map((n) => n.id)
    expect(ids.every((id) => id.trim().length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(5)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-x')
    expect(round.warnings.some((w) => w.includes('e-x'))).toBe(true)
  })
})

describe('归一化：键控桶空记录键重发与同桶引用改写（§11.1 第 3 步）', () => {
  /** 可改写的脏 v1 文档视图（设定桶 + 资产索引 + 节点）。 */
  type DirtyDoc = {
    graph: { nodes: Record<string, unknown>[] }
    settings: Record<string, Record<string, Record<string, unknown>>>
    assets: { byId: Record<string, Record<string, unknown>> }
  }

  it('characters 空键：确定性重发新键（值内 id 随键同步），场景 characterIds 与对白 speaker 的空串引用随重发改写', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    doc.settings.characters[''] = { id: '', name: '幽灵', gradient: 'g-ghost' }
    const scene = doc.graph.nodes.find((n) => n.id === 's1')!
    ;(scene.data as { spec: { characterIds: string[] } }).spec.characterIds.push('')
    const dlg = doc.graph.nodes.find((n) => n.id === 'd1')!
    ;(dlg.data as { spec: { lines: { speaker?: string }[] } }).spec.lines[0].speaker = ''
    const round = parseProject(doc)
    const ghost = round.content.settings.characters.find((c) => c.name === '幽灵')!
    expect(ghost.id.trim().length).toBeGreaterThan(0)
    const sceneData = round.content.nodes.find((n) => n.id === 's1')!.data as {
      characterIds: string[]
    }
    expect(sceneData.characterIds).toContain(ghost.id)
    const lines = (round.content.nodes.find((n) => n.id === 'd1')!.data as {
      lines: { speaker?: string }[]
    }).lines
    expect(lines[0].speaker).toBe(ghost.id)
    // 改写后引用解析到新实体，不误报悬空
    expect(round.warnings.some((w) => w.includes('不存在的角色'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('重发'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('改写'))).toBe(true)
  })

  it('locations 空白键：重发新键，场景 locationId 的空串引用随重发改写', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    doc.settings.locations['  '] = { id: '  ', name: '废墟' }
    const scene = doc.graph.nodes.find((n) => n.id === 's1')!
    ;(scene.data as { spec: { locationId?: string } }).spec.locationId = '  '
    const round = parseProject(doc)
    const ruin = round.content.settings.locations.find((l) => l.name === '废墟')!
    expect(ruin.id.trim().length).toBeGreaterThan(0)
    const sceneData = round.content.nodes.find((n) => n.id === 's1')!.data as {
      locationId?: string
    }
    expect(sceneData.locationId).toBe(ruin.id)
    expect(round.warnings.some((w) => w.includes('不存在的地点'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('重发'))).toBe(true)
  })

  it('assets.byId 空键：重发新键，角色 avatarAssetId 与分镜音频引用的空串 assetId 随重发改写', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as DirtyDoc
    doc.assets.byId[''] = {
      id: '',
      relPath: 'assets/ghost.wav',
      mime: 'audio/wav',
      source: 'upload',
      createdAt: '2026-08-01T00:00:00.000Z',
    }
    doc.settings.characters['ch-1'].avatarAssetId = ''
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data as { spec: { refs: unknown[] } }).spec.refs = [
      { id: 'ref-1', kind: 'audio', assetId: '' },
    ]
    const round = parseProject(doc)
    const byId = round.content.assets?.byId ?? {}
    const assetId = Object.keys(byId).find((k) => byId[k].relPath === 'assets/ghost.wav')!
    expect(assetId.trim().length).toBeGreaterThan(0)
    const ch = round.content.settings.characters.find((c) => c.id === 'ch-1')!
    expect((ch as { avatarAssetId?: string }).avatarAssetId).toBe(assetId)
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')!.data as {
      refs: { assetId?: string }[]
    }).refs
    expect(refs[0].assetId).toBe(assetId)
    expect(round.warnings.some((w) => w.includes('不存在的目标'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('重发'))).toBe(true)
  })
})

describe('归一化：设定文档 relatedIds 成员校验（§6/§11.1 第 3 步，§9.3 upsert_document 的加载侧对等）', () => {
  it('未知 kind / 非字符串或空白 id / 重复 (kind,id) 对：删除并警告，合法关联保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: { documents: Record<string, Record<string, unknown>> }
    }
    doc.settings.documents = {
      'doc-1': {
        id: 'doc-1',
        title: '人物小传',
        body: '女主角的背景设定。',
        relatedIds: [
          { kind: 'character', id: 'ch-1' },
          { kind: 'prop', id: 7 }, // 未知 kind 且 id 非字符串
          { kind: 'location', id: '  ' }, // 空白 id
          { kind: 'character', id: 'ch-1' }, // 重复 (kind,id) 对：保留首见
          { kind: 'location', id: 'loc-1' },
          'not-an-object',
        ],
      },
    }
    const round = parseProject(doc)
    const d = (round.content.settings.documents ?? []).find((x) => x.id === 'doc-1')!
    expect(d.relatedIds).toEqual([
      { kind: 'character', id: 'ch-1' },
      { kind: 'location', id: 'loc-1' },
    ])
    expect(round.warnings.filter((w) => w.includes('doc-1')).length).toBeGreaterThanOrEqual(4)
  })
})

describe('schemaVersion 0 迁移：键控身份的数组语义保全（§11.1 迁移链，重复/空白 id 先于键控与句柄改写修复）', () => {
  it('分支选项重复/空白 id 在迁移期重发，下标句柄仍绑定原数组位的选项', () => {
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
                { id: 'opt-dup', label: '左' },
                { id: 'opt-dup', label: '右' }, // 与首见重复
                { id: '', label: '中' }, // 空白 id
              ],
            },
          },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
          { id: 's2', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场二', sceneNo: 2, interior: true, synopsis: '' } },
          { id: 's3', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场三', sceneNo: 3, interior: true, synopsis: '' } },
        ],
        edges: [
          { id: 'e1', source: 'br1', target: 's1', sourceHandle: 'option-0', type: 'branch', data: { optionLabel: '左' } },
          { id: 'e2', source: 'br1', target: 's2', sourceHandle: 'option-1', type: 'branch', data: { optionLabel: '右' } },
          { id: 'e3', source: 'br1', target: 's3', sourceHandle: 'option-2', type: 'branch', data: { optionLabel: '中' } },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    const br = round.content.nodes.find((n) => n.id === 'br1')!
    const options = (br.data as { options: { id: string; label: string }[] }).options
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
    expect(e2.data).toEqual({ optionLabel: '右' })
    expect(e3.data).toEqual({ optionLabel: '中' })
  })

  it('设定集数组重复/空白 id 在迁移期重发（保首见）：实体不丢，引用仍指首见实体', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 's1',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: { name: '场一', sceneNo: 1, interior: true, synopsis: '', characterIds: ['ch-dup'], locationId: 'loc-dup' },
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
    expect(round.warnings.some((w) => w.includes('不存在的角色') || w.includes('不存在的地点'))).toBe(false)
  })
})

describe('归一化：键控列表成员的类型字段校验（§4.2 BranchOption/ShotRef 完整判别联合，§9.3 加载侧对等）', () => {
  it('选项 label 非字符串/缺失、引用位 kind 未知/label 异型/assetId 与 label 两落或两缺：成员移除并警告，合法成员保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: { id: string; data: { spec: Record<string, unknown> } }[] }
    }
    const br = doc.graph.nodes.find((n) => n.id === 'br1')!
    br.data.spec.options = [
      { id: 'opt-1', label: '坦白' }, // 合法保留
      { id: 'opt-bad', label: {} }, // label 对象：BranchNode 当 React 子节点渲染即崩溃
      { id: 'opt-missing' }, // label 缺失
      'plain-string',
    ]
    const sh = doc.graph.nodes.find((n) => n.id === 'sh1')!
    sh.data.spec.refs = [
      { id: 'ref-1', kind: 'character', label: '林晚' }, // 合法自由位保留
      { id: 'ref-2', kind: 'audio', assetId: 'a-1' }, // 合法引用位保留
      { id: 'ref-3', kind: 'prop', assetId: 'a-1' }, // kind 未知
      { id: 'ref-4', kind: 'audio', label: {} }, // label 异型
      { id: 'ref-5', kind: 'audio', assetId: 'a-1', label: '旁白' }, // 镜像两落（§4.2 禁止）
      { id: 'ref-6', kind: 'location' }, // 两缺
    ]
    const round = parseProject(doc)
    const brData = round.content.nodes.find((n) => n.id === 'br1')!.data as {
      options: { id: string; label: string }[]
    }
    expect(brData.options).toEqual([{ id: 'opt-1', label: '坦白' }])
    const shData = round.content.nodes.find((n) => n.id === 'sh1')!.data as { refs: unknown[] }
    expect(shData.refs).toEqual([
      { id: 'ref-1', kind: 'character', label: '林晚' },
      { id: 'ref-2', kind: 'audio', assetId: 'a-1' },
    ])
    expect(round.warnings.filter((w) => w.includes('异型成员'))).toHaveLength(7)
  })

  it('指向被移除选项的连线按孤儿边隔离，绑定幸存选项的连线保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: {
        nodes: { id: string; data: { spec: Record<string, unknown> } }[]
        edges: Record<string, unknown>[]
      }
    }
    const br = doc.graph.nodes.find((n) => n.id === 'br1')!
    br.data.spec.options = [
      { id: 'opt-1', label: '坦白' },
      { id: 'opt-2', label: {} }, // e2 绑定的选项被移除
    ]
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e2')
    expect(round.warnings.some((w) => w.includes('e2'))).toBe(true)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e3'])
  })
})

describe('layout.size / layout.zIndex 往返（§4.1 可选布局字段，§9.3 命令边界同域）', () => {
  it('合法 size 与 zIndex：会话 ⇄ 落盘双向保留；未携带的节点不落可选字段', () => {
    const content = mkContent()
    const s1 = content.nodes.find((n) => n.id === 's1')!
    s1.width = 320
    s1.height = 200
    s1.zIndex = 3
    const doc = serializeProject(content, 'p-1', NOW)
    const sc = doc.graph.nodes.find((n) => n.id === 's1')!
    expect(sc.layout.size).toEqual({ width: 320, height: 200 })
    expect(sc.layout.zIndex).toBe(3)
    const b1 = doc.graph.nodes.find((n) => n.id === 'b1')!
    expect('size' in b1.layout).toBe(false)
    expect('zIndex' in b1.layout).toBe(false)
    const round = parseProject(doc)
    const r1 = round.content.nodes.find((n) => n.id === 's1')!
    expect(r1.width).toBe(320)
    expect(r1.height).toBe(200)
    expect(r1.zIndex).toBe(3)
    const again = serializeProject(round.content, 'p-1', NOW)
    const sc2 = again.graph.nodes.find((n) => n.id === 's1')!
    expect(sc2.layout.size).toEqual({ width: 320, height: 200 })
    expect(sc2.layout.zIndex).toBe(3)
  })

  it('非法 size（非对象/字段异型/非正数）与非法 zIndex：剥离字段并警告，节点本体保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const layoutOf = (id: string) =>
      (doc.graph.nodes.find((n) => n.id === id) as unknown as { layout: Record<string, unknown> }).layout
    layoutOf('s1').size = { width: 0, height: 200 } // 非正
    layoutOf('s1').zIndex = 'top'
    layoutOf('b1').size = { width: 'wide', height: 100 } // 字段异型
    layoutOf('b1').zIndex = Number.POSITIVE_INFINITY
    layoutOf('d1').size = 'big' // 非普通对象
    const round = parseProject(doc)
    expect(round.content.nodes.find((n) => n.id === 's1')).toBeDefined()
    expect(round.content.nodes.find((n) => n.id === 'b1')).toBeDefined()
    expect(round.content.nodes.find((n) => n.id === 'd1')).toBeDefined()
    const r1 = round.content.nodes.find((n) => n.id === 's1')!
    expect(r1.width).toBeUndefined()
    expect(r1.height).toBeUndefined()
    expect(r1.zIndex).toBeUndefined()
    expect(round.warnings.filter((w) => w.includes('layout.size'))).toHaveLength(3)
    expect(round.warnings.filter((w) => w.includes('layout.zIndex'))).toHaveLength(2)
  })
})

describe('归一化：ShotRef 旧草案 targetId 的无歧义兼容与资产命名空间（§4.2/§8.1/§11.1 六十四轮）', () => {
  /** 可改写的脏 v1 文档视图（资产索引 + 节点）。 */
  type RefDoc = {
    graph: { nodes: Record<string, unknown>[] }
    settings: Record<string, Record<string, Record<string, unknown>>>
    assets: { byId: Record<string, Record<string, unknown>> }
  }
  const mkAsset = (id: string, relPath: string, mime: string) => ({
    id,
    relPath,
    mime,
    source: 'upload',
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  const setRefs = (doc: RefDoc, refs: unknown[]) => {
    const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
    ;(shot.data as { spec: { refs: unknown[] } }).spec.refs = refs
  }
  const refsOf = (round: ReturnType<typeof parseProject>) =>
    (round.content.nodes.find((n) => n.id === 'sh1')!.data as unknown as { refs: Record<string, unknown>[] }).refs

  it('audio 旧 targetId 视为项目资产 id：改名 assetId；目标缺失保留为悬空引用并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    doc.assets.byId['a-wav'] = mkAsset('a-wav', 'assets/rain.wav', 'audio/wav')
    setRefs(doc, [
      { id: 'r1', kind: 'audio', targetId: 'a-wav' },
      { id: 'r2', kind: 'audio', targetId: 'a-gone' },
    ])
    const round = parseProject(doc)
    expect(refsOf(round)).toEqual([
      { id: 'r1', kind: 'audio', assetId: 'a-wav' },
      { id: 'r2', kind: 'audio', assetId: 'a-gone' },
    ])
    expect(round.warnings.some((w) => w.includes('a-gone'))).toBe(true)
  })

  it('character/location 旧 targetId：唯一命中活动 image/* 资产且未命中对应设定桶实体才改名，否则隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    doc.assets.byId['a-img'] = mkAsset('a-img', 'assets/portrait.png', 'image/png')
    doc.assets.byId['a-wav'] = mkAsset('a-wav', 'assets/rain.wav', 'audio/wav')
    setRefs(doc, [
      { id: 'r1', kind: 'character', targetId: 'a-img' }, // 唯一命中 image 资产、未命中实体 → 改名
      { id: 'r2', kind: 'character', targetId: 'ch-1' }, // 命中角色实体 → 禁止实体 id 当资产 id，隔离
      { id: 'r3', kind: 'character', targetId: 'a-wav' }, // 命中资产但 MIME 家族不符 → 隔离
      { id: 'r4', kind: 'location', targetId: 'loc-gone' }, // 资产与实体两不沾 → 隔离
    ])
    const round = parseProject(doc)
    expect(refsOf(round)).toEqual([{ id: 'r1', kind: 'character', assetId: 'a-img' }])
    expect(round.warnings.filter((w) => w.includes('targetId')).length).toBeGreaterThanOrEqual(3)
  })

  it('旧 targetId 与 assetId/label 并存、空白或非字符串：按歧义/异型隔离该 ref', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    doc.assets.byId['a-wav'] = mkAsset('a-wav', 'assets/rain.wav', 'audio/wav')
    setRefs(doc, [
      { id: 'r1', kind: 'audio', targetId: 'a-wav', assetId: 'a-wav' }, // 并存 assetId
      { id: 'r2', kind: 'audio', targetId: 'a-wav', label: '旁白' }, // 并存 label
      { id: 'r3', kind: 'audio', targetId: '' }, // 空白旧值
      { id: 'r4', kind: 'audio', targetId: 7 }, // 非字符串旧值
      { id: 'r5', kind: 'audio', targetId: 'a-wav' }, // 正常改名保留
    ])
    const round = parseProject(doc)
    expect(refsOf(round)).toEqual([{ id: 'r5', kind: 'audio', assetId: 'a-wav' }])
    expect(round.warnings.filter((w) => w.includes('targetId'))).toHaveLength(4)
  })

  it('角色键被安全子值域重发：旧 targetId 仍按修复前身份命中角色，歧义引用隔离而非误转同名资产（§11.1）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    // 角色原始键/内嵌 id 均为 bad]id（不满足安全字符集 [A-Za-z0-9_-]，将被重发）；
    // 同名 image 资产并存 → 旧 targetId 同时命中修复前角色身份与资产，须隔离
    doc.settings.characters['bad]id'] = { id: 'bad]id', name: '阿灿', gradient: 'g' }
    doc.assets.byId['bad]id'] = mkAsset('bad]id', 'assets/portrait.png', 'image/png')
    setRefs(doc, [{ id: 'r1', kind: 'character', targetId: 'bad]id' }])
    const round = parseProject(doc)
    // 红：快照在重发后捕获，查无 bad]id 身份 → 误转 assetId
    expect(refsOf(round)).toEqual([])
    expect(round.warnings.some((w) => w.includes('targetId') && w.includes('隔离'))).toBe(true)
  })

  it('资产空键被重发：旧 targetId 按修复前身份仍唯一命中该资产并改名（身份捕获先于一切键/id 改写）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    // 空键资产的原始内嵌 id 为 a-old；空键重发换键并同步内嵌 id
    doc.assets.byId[''] = mkAsset('a-old', 'assets/portrait.png', 'image/png')
    setRefs(doc, [{ id: 'r1', kind: 'character', targetId: 'a-old' }])
    const round = parseProject(doc)
    const refs = refsOf(round)
    // 红：快照丢失修复前身份 a-old → 零命中被隔离；修复后改名 assetId 为重发新键
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('character')
    expect(typeof refs[0].assetId).toBe('string')
    expect(refs[0].assetId).not.toBe('a-old')
  })

  it('assetId 的 MIME 家族与 kind 用途不匹配：保留为不可用引用并警告，不改按其他命名空间解释', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as RefDoc
    doc.assets.byId['a-img'] = mkAsset('a-img', 'assets/portrait.png', 'image/png')
    doc.assets.byId['a-wav'] = mkAsset('a-wav', 'assets/rain.wav', 'audio/wav')
    setRefs(doc, [
      { id: 'r1', kind: 'character', assetId: 'a-wav' }, // audio 资产作角色垫图
      { id: 'r2', kind: 'audio', assetId: 'a-img' }, // image 资产作音频
      { id: 'r3', kind: 'location', assetId: 'a-img' }, // 匹配，无警告
    ])
    const round = parseProject(doc)
    expect(refsOf(round)).toHaveLength(3)
    expect(round.warnings.filter((w) => w.includes('MIME'))).toHaveLength(2)
  })
})

describe('归一化：project 时间戳严格校验与规范化（§11.1，与 Rust 保存边界 is_valid_iso8601 同域）', () => {
  it('严格且已规范的 UTC 时间戳原样保留，无警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    const round = parseProject(doc)
    expect(round.content.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(round.warnings.some((w) => w.includes('createdAt'))).toBe(false)
    expect(round.warnings.some((w) => w.includes('updatedAt'))).toBe(false)
  })

  it('带偏移/无小数秒的严格合法表示确定性规范化为 UTC toISOString 并警告', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.createdAt = '2026-08-01T02:00:00+02:00'
    doc.project.updatedAt = '2026-08-02T12:30:00.5+08:00'
    const round = parseProject(doc)
    expect(round.content.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(round.warnings.some((w) => w.includes('createdAt') && w.includes('规范化'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('updatedAt') && w.includes('规范化'))).toBe(true)
  })

  it('Date.parse 的宽松超集（纯日期/无显式时区）不放行：修复并警告，再保存不被 Rust 边界拒绝', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.createdAt = '2026-08-01'
    doc.project.updatedAt = '2026-08-02T12:30:00'
    const round = parseProject(doc)
    expect(round.warnings.some((w) => w.includes('createdAt'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('updatedAt'))).toBe(true)
    // createdAt 回退到修复后的 updatedAt；两者均为带显式 Z 的严格形式
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(round.content.createdAt ?? '')).toBe(true)
    // 修复后的值随 serializeProject 原样回写，下一次 save_project 不再被整份拒绝
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(again.project.createdAt)).toBe(true)
  })
})

describe('归一化：场景 time/weather 文本字段校验（§11.1 节点校验细则，SceneNode 渲染安全）', () => {
  /** 可改写的脏 v1 文档视图（仅节点数组）。 */
  type SceneDoc = { graph: { nodes: Record<string, unknown>[] } }
  const sceneSpec = (doc: SceneDoc): Record<string, unknown> => {
    const s = doc.graph.nodes.find((n) => n.id === 's1')!
    return (s.data as { spec: Record<string, unknown> }).spec
  }

  it('场景 time 缺失（§4.2 可选缺省）：确定性置空串并警告，节点保留', () => {
    const missing = serializeProject(mkContent(), 'p-1', NOW) as unknown as SceneDoc
    delete sceneSpec(missing).time
    const round = parseProject(missing)
    const scene = round.content.nodes.find((n) => n.id === 's1')
    expect(scene).toBeDefined()
    expect((scene!.data as { time: string }).time).toBe('')
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('time') && w.includes('置空串'))).toBe(true)
  })

  it('场景 time 非字符串（形态错位，如 time: {}）：节点隔离并警告——对象进会话会被 SceneNode 当 React 子节点渲染', () => {
    const badType = serializeProject(mkContent(), 'p-1', NOW) as unknown as SceneDoc
    sceneSpec(badType).time = {}
    const round = parseProject(badType)
    expect(round.content.nodes.find((n) => n.id === 's1')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('time') && w.includes('隔离'))).toBe(true)
  })

  it('场景 weather 非字符串：剥离该可选字段并警告，节点保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as SceneDoc
    sceneSpec(doc).weather = { text: '雨' }
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')
    expect(scene).toBeDefined()
    expect('weather' in (scene!.data as Record<string, unknown>)).toBe(false)
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('weather') && w.includes('剥离'))).toBe(true)
  })
})

describe('归一化：边句柄的运行时类型校验（§11.1，JSON 边界类型擦除）', () => {
  /** 可改写的脏 v1 文档视图（仅边数组）。 */
  type EdgeDoc = { graph: { edges: Record<string, unknown>[] } }

  it('branch 边 sourceHandle 非字符串：隔离该边并警告，其余边保留、项目照常打开', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as EdgeDoc
    doc.graph.edges.find((e) => e.id === 'e2')!.sourceHandle = 42
    const round = parseProject(doc)
    expect(round.content.edges.find((e) => e.id === 'e2')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e2') && w.includes('sourceHandle'))).toBe(true)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e3'])
  })

  it('attach 边 sourceHandle 为对象：隔离该边并警告，不触发 startsWith 类型异常', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as EdgeDoc
    doc.graph.edges.find((e) => e.id === 'e3')!.sourceHandle = { handle: 'shots' }
    const round = parseProject(doc)
    expect(round.content.edges.find((e) => e.id === 'e3')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e3') && w.includes('sourceHandle'))).toBe(true)
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1', 'e2'])
  })
})

describe('归一化：v0 图形容器/成员异型先修复再迁移（§11.1，损坏旧档仍可打开）', () => {
  const v0Base = (graph: unknown) => ({
    schemaVersion: 0,
    project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    graph,
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

  it('graph.nodes 为字符串容器：重置为空数组并警告，项目照常打开', () => {
    const round = parseProject(v0Base({ nodes: 'oops', edges: [] }))
    expect(round.migrated).toBe(true)
    expect(round.content.nodes).toEqual([])
    expect(round.warnings.some((w) => w.includes('graph.nodes'))).toBe(true)
  })

  it('graph.nodes 含 null 成员：丢弃该成员并警告，合法节点保留', () => {
    const round = parseProject(v0Base({ nodes: [null, scene('s1')], edges: [] }))
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1'])
    expect(round.warnings.some((w) => w.includes('graph.nodes'))).toBe(true)
  })

  it('graph.edges 为数字容器：重置为空数组并警告', () => {
    const round = parseProject(v0Base({ nodes: [scene('s1')], edges: 42 }))
    expect(round.content.edges).toEqual([])
    expect(round.warnings.some((w) => w.includes('graph.edges'))).toBe(true)
  })

  it('graph.edges 含字符串成员：丢弃并警告，合法边保留', () => {
    const round = parseProject(
      v0Base({
        nodes: [scene('s1'), scene('s2')],
        edges: [{ id: 'e1', source: 's1', target: 's2' }, 'garbage'],
      }),
    )
    expect(round.content.edges.map((e) => e.id)).toEqual(['e1'])
    expect(round.warnings.some((w) => w.includes('graph.edges'))).toBe(true)
  })
})

describe('归一化：不可验证资产与设定文档形状（§7.1/§6/§11.3，加载侧实路径复验联动）', () => {
  const docWithAsset = () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.assets.byId['a-1'] = {
      id: 'a-1',
      relPath: 'assets/lin.png',
      mime: 'image/png',
      source: 'upload',
      createdAt: '2026-08-01T00:00:00.000Z',
    }
    return doc
  }

  it('invalidAssetKeys：实路径复验未过的资产从索引隔离并警告，引用位按悬空标记', () => {
    const doc = docWithAsset()
    doc.settings.characters['ch-1'].avatarAssetId = 'a-1'
    const round = parseProject(doc, { invalidAssetKeys: ['a-1'] })
    expect(round.content.assets?.byId['a-1']).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('a-1'))).toBe(true)
    // 引用该资产的角色头像现按悬空标记（§11.4 既有警告语义）
    expect(round.warnings.some((w) => w.includes('不存在的资产 a-1'))).toBe(true)
    // 再落盘：索引不再含不可验证条目，保存可过实路径复验
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.assets.byId['a-1']).toBeUndefined()
  })

  it('设定文档 title/body 非字符串：条目隔离并警告；合法条目保留', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: { documents: Record<string, Record<string, unknown>> }
    }
    doc.settings.documents = {
      'doc-bad-title': { id: 'doc-bad-title', title: {}, body: '正文', relatedIds: [] },
      'doc-bad-body': { id: 'doc-bad-body', title: '小传', relatedIds: [] },
      'doc-ok': { id: 'doc-ok', title: '世界观', body: '设定', relatedIds: [{ kind: 'ghost' }] },
    }
    const round = parseProject(doc)
    const docs = round.content.settings.documents ?? []
    expect(docs.map((d) => d.id)).toEqual(['doc-ok'])
    expect(round.warnings.some((w) => w.includes('doc-bad-title'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('doc-bad-body'))).toBe(true)
    // 合法条目的 relatedIds 修复照旧（未知 kind 删除）
    expect(docs.find((d) => d.id === 'doc-ok')?.relatedIds).toEqual([])
  })
})

describe('归一化：v0 节点嵌套形状预归一化（迁移器解引用前置，损坏单节点不阻断整档）', () => {
  const v0Base = (nodes: unknown[]) => ({
    schemaVersion: 0,
    project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    graph: { nodes, edges: [] },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })

  it('dialogue 节点 data 为 null：重置为空对象、lines 置空，项目照常打开', () => {
    const round = parseProject(v0Base([
      { id: 'd1', type: 'dialogue', position: { x: 0, y: 0 }, data: null },
      { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
    ]))
    expect(round.migrated).toBe(true)
    expect(round.content.nodes.map((n) => n.id)).toContain('s1')
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('data'))).toBe(true)
  })

  it('dialogue 的 lines 为字符串：重置为空数组并警告，不因 map 崩溃', () => {
    const round = parseProject(v0Base([
      { id: 'd1', type: 'dialogue', position: { x: 0, y: 0 }, data: { lines: 'oops', name: '对白' } },
    ]))
    expect(round.content.nodes.map((n) => n.id)).toContain('d1')
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('lines'))).toBe(true)
  })

  it('branch 的 options 含 null 成员：丢弃并警告，合法选项与下标句柄改写不受影响', () => {
    const round = parseProject(v0Base([
      { id: 'br1', type: 'branch', position: { x: 0, y: 0 }, data: { prompt: '去哪', options: [{ id: 'opt-a', label: '左' }, null] } },
    ]))
    const br = round.content.nodes.find((n) => n.id === 'br1')
    const options = (br?.data as { options: Array<{ id: string; label: string }> }).options
    expect(options.map((o) => o.id)).toEqual(['opt-a'])
    expect(round.warnings.some((w) => w.includes('br1') && w.includes('options'))).toBe(true)
  })

  it('shot 的 refs 含字符串成员：丢弃并警告，对象成员保留', () => {
    const round = parseProject(v0Base([
      { id: 'sh1', type: 'shot', position: { x: 0, y: 0 }, data: { shotNo: 1, size: '特写', picture: '', prompt: '', refs: ['garbage', { kind: 'character' as const, label: '图' }] } },
    ]))
    const refs = (round.content.nodes.find((n) => n.id === 'sh1')?.data as { refs: unknown[] }).refs
    expect(refs).toHaveLength(1)
    expect(round.warnings.some((w) => w.includes('sh1') && w.includes('refs'))).toBe(true)
  })
})

describe('归一化：设定文档的键修复与 v0 时间戳保真（§6/§11.1 第 3 步/迁移链 ⑤）', () => {
  it('documents 空键重发新键，值内 id 随键；非空键与漂移内嵌 id 以记录键为准改写', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: { documents: Record<string, Record<string, unknown>> }
    }
    doc.settings.documents = {
      '': { id: '', title: '空白键', body: '正文', relatedIds: [] },
      'doc-x': { id: 'other', title: '漂移', body: '正文', relatedIds: [] },
    }
    const round = parseProject(doc)
    const docs = round.content.settings.documents ?? []
    const blank = docs.find((d) => d.title === '空白键')!
    expect(blank.id.startsWith('doc-')).toBe(true)
    expect(blank.id).not.toBe('')
    const drifted = docs.find((d) => d.title === '漂移')!
    expect(drifted.id).toBe('doc-x')
    expect(round.warnings.some((w) => w.includes('doc-x'))).toBe(true)
    // 再落盘：Record 键与内嵌 id 一致
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.settings.documents['doc-x'].id).toBe('doc-x')
  })

  it('v0 迁移保留旧档 updatedAt 瞬间：createdAt 缺省与之同刻（⑤），不用迁移时刻', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2025-12-31T23:59:59.000Z' },
      graph: { nodes: [], edges: [] },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.content.createdAt).toBe('2025-12-31T23:59:59.000Z')
    // 信封 updatedAt 同为旧档瞬间（而非本次转换时刻）
    const envelope = serializeProject(round.content, 'p-old', new Date('2026-09-01T00:00:00.000Z'))
    expect(envelope.project.createdAt).toBe('2025-12-31T23:59:59.000Z')
  })
})

describe('归一化：v0 options 槽位保序与设定集成员字段容错（§11.1 ①/迁移器解引用前置）', () => {
  const v0Doc = (nodes: unknown[], edges: unknown[]) => ({
    schemaVersion: 0,
    project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    graph: { nodes, edges },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })
  const scene = (id: string) => ({
    id, type: 'scene', position: { x: 0, y: 0 },
    data: { name: id, sceneNo: 1, interior: true, synopsis: '' },
  })

  it('options 含 null 槽位：指向该槽位的旧下标连线按孤儿边隔离，不滑向后一选项', () => {
    const round = parseProject(v0Doc(
      [
        { id: 'br1', type: 'branch', position: { x: 0, y: 0 }, data: { prompt: '去哪', options: [null, { label: 'B' }] } },
        scene('s1'),
      ],
      [
        { id: 'e0', source: 'br1', target: 's1', sourceHandle: 'option-0', type: 'branch', data: { optionLabel: '已删' } },
        { id: 'e1', source: 'br1', target: 's1', sourceHandle: 'option-1', type: 'branch', data: { optionLabel: 'B' } },
      ],
    ))
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
    expect((br.data as { options: Array<{ label: string }> }).options.map((o) => o.label)).toEqual(['B'])
  })

  it('设定集角色 name 非字符串：头像解析不崩溃，坏实体按 §11.3 隔离、新实体照常补建', () => {
    const again = parseProject({
      ...v0Doc([{
        id: 's1', type: 'scene', position: { x: 0, y: 0 },
        data: { name: '场一', sceneNo: 1, interior: true, synopsis: '', characters: [{ label: '林', gradient: 'g' }] },
      }], []),
      settings: { characters: [{ id: 'ch-bad', name: 42, gradient: 'g' }], locations: [] },
    })
    expect(again.migrated).toBe(true)
    expect(again.content.nodes.map((n) => n.id)).toContain('s1')
    expect(again.warnings.some((w) => w.includes('ch-bad'))).toBe(true)
    // 头像「林」匹配不到坏实体，按迁移规则补建新实体
    const names = again.content.settings.characters.map((c) => c.name)
    expect(names).toContain('林')
  })
})

describe('归一化：空白 id 引用的重发改写贯通与节点时间戳透传（§6/§11.1 第 3 步/迁移链 ⑤/§4.1）', () => {
  it('v1 relatedIds 指向空白键实体：随空键重发改写到新 id，不再提前删除', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: { characters: Record<string, Record<string, unknown>>; documents: Record<string, Record<string, unknown>> }
    }
    doc.settings.characters = { '': { id: '', name: '林', gradient: 'g' } }
    doc.settings.documents = {
      'doc-1': { id: 'doc-1', title: '小传', body: '正文', relatedIds: [{ kind: 'character', id: '' }] },
    }
    const round = parseProject(doc)
    const ch = round.content.settings.characters.find((c) => c.name === '林')!
    expect(ch.id.startsWith('ch-')).toBe(true)
    const rel = (round.content.settings.documents ?? []).find((d) => d.id === 'doc-1')!.relatedIds
    expect(rel).toEqual([{ kind: 'character', id: ch.id }])
  })

  it('v0 空白实体 id 重发时改写节点引用：characterIds/speaker/locationId 不悬空', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 's1', type: 'scene', position: { x: 0, y: 0 },
            data: { name: '场一', sceneNo: 1, interior: true, synopsis: '', characterIds: [''], locationId: '' },
          },
          {
            id: 'd1', type: 'dialogue', position: { x: 0, y: 0 },
            data: { name: '对白', lines: [{ kind: 'line' as const, speaker: '', text: '台词' }] },
          },
        ],
        edges: [],
      },
      settings: {
        characters: [{ id: '', name: '林', gradient: 'g' }],
        locations: [{ id: '', name: '天台' }],
      },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    const spec = round.content.nodes.find((n) => n.id === 's1')!.data as {
      characterIds: string[]; locationId?: string
    }
    expect(spec.characterIds).toHaveLength(1)
    expect(spec.characterIds[0].startsWith('ch-')).toBe(true)
    expect(spec.locationId?.startsWith('loc-')).toBe(true)
    const d1 = round.content.nodes.find((n) => n.id === 'd1')!.data as {
      lines: Array<{ speaker: string }>
    }
    expect(d1.lines[0].speaker.startsWith('ch-')).toBe(true)
  })

  it('节点 meta.createdAt/updatedAt 经会话模型往返保留，打开→保存不静默删除', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.nodes[0].data.meta.createdAt = '2026-01-02T03:04:05.000Z'
    doc.graph.nodes[0].data.meta.updatedAt = '2026-02-03T04:05:06.000Z'
    const round = parseProject(doc)
    const node = round.content.nodes[0] as { meta?: { createdAt?: string; updatedAt?: string } }
    expect(node.meta?.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(node.meta?.updatedAt).toBe('2026-02-03T04:05:06.000Z')
    const again = serializeProject(round.content, 'p-1', NOW)
    const persisted = again.graph.nodes[0].data.meta
    expect(persisted.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(persisted.updatedAt).toBe('2026-02-03T04:05:06.000Z')
  })
})

describe('归一化：数值型稳定 id 与越界旧下标句柄的歧义隔离（§11.1 迁移链 ②）', () => {
  it('选项稳定 id 为数字串时，越界的 option-N 旧句柄不得被解释为该稳定 id', () => {
    const v0 = {
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 'br1', type: 'branch', position: { x: 0, y: 0 },
            data: { prompt: '去哪', options: [{ id: '9', label: 'A' }] },
          },
          { id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' } },
        ],
        edges: [
          // 旧下标 9 越界（仅下标 0 存在）：不得碰巧解析为稳定 id "9" 而接给 A
          { id: 'e-bad', source: 'br1', target: 's1', sourceHandle: 'option-9', type: 'branch', data: { optionLabel: '越界' } },
          // 下标 0 正常改写到稳定 id "9"
          { id: 'e-ok', source: 'br1', target: 's1', sourceHandle: 'option-0', type: 'branch', data: { optionLabel: 'A' } },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    const ids = round.content.edges.map((e) => e.id)
    expect(ids).toContain('e-ok')
    expect(ids).not.toContain('e-bad')
    expect(round.warnings.some((w) => w.includes('e-bad'))).toBe(true)
    // e-ok 确实指向选项 9（label A）
    const eOk = round.content.edges.find((e) => e.id === 'e-ok')!
    expect(eOk.sourceHandle).toBe('option-9')
  })
})

describe('归一化：v0 节点基础布局预归一化（toStoryNode 解引用前置）', () => {
  const v0Base = (nodes: unknown[]) => ({
    schemaVersion: 0,
    project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    graph: { nodes, edges: [] },
    settings: { characters: [], locations: [] },
    episodeTitles: {},
    assets: { byId: {} },
  })
  const sceneData = (id: string) => ({ name: id, sceneNo: 1, interior: true, synopsis: '' })

  it('position 缺失或为 null：补默认 (0,0) 并警告，不因 n.position.x 解引用崩溃', () => {
    const round = parseProject(v0Base([
      { id: 's1', type: 'scene', data: sceneData('场一') },
      { id: 's2', type: 'scene', position: null, data: sceneData('场二') },
      { id: 's3', type: 'scene', position: { x: 5, y: 5 }, data: sceneData('场三') },
    ]))
    expect(round.content.nodes.map((n) => n.id)).toEqual(['s1', 's2', 's3'])
    expect(round.content.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(round.content.nodes[2].position).toEqual({ x: 5, y: 5 })
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('position'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('s2') && w.includes('position'))).toBe(true)
  })
})

describe('归一化：角色 id/token 专项修复（§6 子值域 [A-Za-z0-9_-]{1,64}，五十九轮）', () => {
  it('非法字符集/超长角色键：重发安全键，characterIds/speaker/文本 token 同步改写', () => {
    const content = mkContent()
    content.settings.characters = [
      { id: 'bad]id', name: '林', gradient: 'g' },
      { id: 'x'.repeat(65), name: '陈', gradient: 'g' },
    ] as never
    ;(content.nodes.find((n) => n.id === 's1')!.data as Record<string, unknown>).characterIds = [
      'bad]id',
      'x'.repeat(65),
    ]
    const dialogue = content.nodes.find((n) => n.id === 'd1')!.data as {
      lines: Array<{ id: string; kind: string; text: string; speaker: string; side: string; vo: boolean }>
    }
    dialogue.lines = [
      { id: 'line-1', kind: 'line', speaker: 'bad]id', text: '喂 @[character:bad]id] 看这里', side: 'left', vo: false },
    ]
    const round = parseProject(serializeProject(content, 'p-1', NOW))
    const chars = round.content.settings.characters
    const lin = chars.find((c) => c.name === '林')!
    const chen = chars.find((c) => c.name === '陈')!
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(lin.id)).toBe(true)
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(chen.id)).toBe(true)
    const sceneData = round.content.nodes.find((n) => n.id === 's1')!.data as {
      characterIds: string[]
    }
    expect(sceneData.characterIds).toEqual([lin.id, chen.id])
    const d1 = round.content.nodes.find((n) => n.id === 'd1')!.data as {
      lines: Array<{ speaker: string; text: string }>
    }
    expect(d1.lines[0].speaker).toBe(lin.id)
    // 文本 token 字面量替换（旧 id 含 ]，只能按完整字面量匹配）
    expect(d1.lines[0].text).toBe(`喂 @[character:${lin.id}] 看这里`)
    expect(round.warnings.some((w) => w.includes('bad]id'))).toBe(true)
  })

  it('__proto__ 是合法 id（安全字符集允许下划线）：桶条目按 own 属性保留，解析与回存均不丢', () => {
    const content = mkContent()
    content.settings.characters = [
      ...content.settings.characters,
      { id: '__proto__', name: '原型', gradient: 'g' },
    ]
    const round = parseProject(serializeProject(content, 'p-1', NOW))
    // 红：普通 {} 赋值触发原型 setter，条目不进 Object.entries/Object.values 而丢失
    expect(round.content.settings.characters.map((c) => c.name)).toContain('原型')
    // 回存也不得丢（漏带即下次保存永久删除该实体）
    const out = serializeProject(round.content, 'p-1', NOW)
    expect(Object.keys(out.settings.characters)).toContain('__proto__')
  })
})

describe('v0 迁移的字段优先级与头像预过滤（迁移链 ④ 前置）', () => {
  const v0Doc = (sceneData: Record<string, unknown>, characters: unknown[] = [], locations: unknown[] = []) => ({
    schemaVersion: 0,
    project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    graph: {
      nodes: [{ id: 's1', type: 'scene', position: { x: 0, y: 0 }, data: sceneData }],
      edges: [],
    },
    settings: { characters, locations },
    episodeTitles: {},
    assets: { byId: {} },
  })

  it('合法 locationId 胜过过时的 location 字符串镜像：不补建实体、不改指向', () => {
    const round = parseProject(v0Doc(
      { name: '场一', sceneNo: 1, interior: true, synopsis: '', locationId: 'loc-1', location: '废弃地址' },
      [],
      [{ id: 'loc-1', name: '天台' }],
    ))
    const spec = round.content.nodes[0].data as { locationId?: string }
    expect(spec.locationId).toBe('loc-1')
    expect(round.content.settings.locations.map((l) => l.name)).toEqual(['天台'])
  })

  it('空 label 头像预过滤：不静默关联首角色、不补建空名实体', () => {
    const round = parseProject(v0Doc(
      { name: '场一', sceneNo: 1, interior: true, synopsis: '', characters: [{ label: '', gradient: 'g' }, { label: '林', gradient: 'g' }] },
      [{ id: 'ch-1', name: '甲', gradient: 'g1' }],
    ))
    const spec = round.content.nodes[0].data as { characterIds: string[] }
    // 空 label 头像不得命中首角色「甲」；「林」按规则补建
    expect(spec.characterIds).toHaveLength(1)
    const names = round.content.settings.characters.map((c) => c.name)
    expect(names).toContain('林')
    expect(names).not.toContain('')
    expect(round.warnings.some((w) => w.includes('s1') && w.includes('characters'))).toBe(true)
  })

  it('对白 speaker 头像预过滤：空 label 不静默关联首角色（startsWith 空串恒真），异型 gradient 一并置空', () => {
    const round = parseProject({
      schemaVersion: 0,
      project: { id: 'p-old', name: '旧剧', createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      graph: {
        nodes: [
          {
            id: 'd1',
            type: 'dialogue',
            position: { x: 0, y: 0 },
            data: {
              name: '对白',
              lines: [
                { id: 'l1', kind: 'line', text: '别走', speaker: { label: '', gradient: 'g' }, side: 'left', vo: false },
                { id: 'l2', kind: 'line', text: '嗯', speaker: { label: '林', gradient: 1 }, side: 'left', vo: false },
                { id: 'l3', kind: 'line', text: '好', speaker: { label: '林' }, side: 'left', vo: false },
              ],
            },
          },
        ],
        edges: [],
      },
      settings: { characters: [{ id: 'ch-1', name: '甲', gradient: 'g1' }], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    })
    const spec = round.content.nodes[0].data as { lines: Array<{ speaker: unknown }> }
    // 空 label / 异型 gradient 的 speaker 头像置空，不得命中首角色「甲」
    expect(spec.lines[0].speaker).toBeNull()
    expect(spec.lines[1].speaker).toBeNull()
    // 合法头像按规则补建实体
    const lin = round.content.settings.characters.find((c) => c.name === '林')
    expect(lin).toBeDefined()
    expect(spec.lines[2].speaker).toBe(lin?.id)
    expect(round.content.settings.characters.some((c) => c.name === '')).toBe(false)
    expect(round.warnings.some((w) => w.includes('d1') && w.includes('speaker'))).toBe(true)
  })
})

describe('§11.1 第 3 步顺序：身份修复先于形状隔离（重复 id 不改接语义）', () => {
  const sceneSpec = (over: Record<string, unknown> = {}) => ({
    sceneNo: 1, interior: true, time: '', synopsis: '', characterIds: [], ...over,
  })

  it('重复节点 id：首见（异型被隔离）占据 id，后见节点重发新 id，指向原 id 的边按孤儿隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    ;(doc.graph.nodes as unknown as Record<string, unknown>[]).splice(0, doc.graph.nodes.length,
      { id: 's0', type: 'scene', layout: { position: { x: 0, y: 0 } }, data: { spec: sceneSpec(), meta: { label: '源头' } } },
      // 首见 n1：spec 缺 synopsis（REQUIRED_SCALARS）→ 形状隔离
      { id: 'n1', type: 'scene', layout: { position: { x: 1, y: 0 } }, data: { spec: { sceneNo: 2, interior: true, time: '', characterIds: [] }, meta: { label: '坏节点' } } },
      // 后见 n1：合法
      { id: 'n1', type: 'scene', layout: { position: { x: 2, y: 0 } }, data: { spec: sceneSpec({ sceneNo: 3 }), meta: { label: '好节点' } } },
    )
    ;(doc.graph.edges as unknown as unknown[]).splice(0, doc.graph.edges.length,
      { id: 'e1', source: 's0', target: 'n1', data: { kind: 'sequence' } },
    )
    const round = parseProject(doc)
    // 后见节点持新 id（不再是 n1）
    const labels = round.content.nodes.map((n) => (n.data as { name?: string }).name)
    expect(labels).toContain('源头')
    expect(labels).toContain('好节点')
    const good = round.content.nodes.find((n) => (n.data as { name?: string }).name === '好节点')!
    expect(good.id).not.toBe('n1')
    // 指向原 id 的边：孤儿隔离（首见节点已被隔离），不得改接到好节点
    expect(round.content.edges.find((e) => e.id === 'e1')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e1'))).toBe(true)
  })

  it('重复选项 id：首见（异型被过滤）占据 id，后见选项重发新 id，option-x 连线按孤儿隔离', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    ;(doc.graph.nodes as unknown as Record<string, unknown>[]).splice(0, doc.graph.nodes.length,
      { id: 's0', type: 'scene', layout: { position: { x: 0, y: 0 } }, data: { spec: sceneSpec(), meta: { label: '靶' } } },
      {
        id: 'br1', type: 'branch', layout: { position: { x: 1, y: 0 } },
        data: {
          spec: { prompt: '去哪', options: [
            { id: 'x', label: 5 },
            { id: 'x', label: 'B' },
          ] },
          meta: {},
        },
      },
    )
    ;(doc.graph.edges as unknown as unknown[]).splice(0, doc.graph.edges.length,
      { id: 'e1', source: 'br1', target: 's0', sourceHandle: 'option-x', data: { kind: 'branch' } },
    )
    const round = parseProject(doc)
    const br = round.content.nodes.find((n) => n.id === 'br1')!
    const options = (br.data as { options: Array<{ id: string; label: string }> }).options
    expect(options).toHaveLength(1)
    expect(options[0].label).toBe('B')
    expect(options[0].id).not.toBe('x') // 后见选项持新 id，不继承首见的 x
    expect(round.content.edges.find((e) => e.id === 'e1')).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('e1'))).toBe(true)
  })
})
