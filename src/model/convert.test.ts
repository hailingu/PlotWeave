/**
 * 会话文档 ⇄ ProjectDocument 入口契约测试：serializeProject 落盘形态
 * （四分区拆分、运行态剥离、设定集键化、缺省字段处理）与 parseProject
 * 往返一致/拒绝边界（版本判型、孤儿边隔离、悬空引用标记）及输入所有权
 * 契约（归一化就地改写输入对象，issue #102），以及
 * layout.size/zIndex 的双向往返。各归一化阶段的专项用例见
 * convert.{containers,nodes,edges,settings,assets,legacy}.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import type { ProjectContent } from './content'
import { CURRENT_SCHEMA_VERSION, type ProjectDocument } from './document'
import type { SessionNode } from './session'
import { NOW, mkContent } from './convertFixtures'

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
      {
        id: 'e2',
        source: 'br1',
        target: 'd1',
        sourceHandle: 'option-opt-2',
        data: { kind: 'branch' },
      },
      {
        id: 'e3',
        source: 's1',
        target: 'sh1',
        sourceHandle: 'shots',
        data: { kind: 'attach' },
      },
    ])
  })

  it('设定集数组 → Record<id, 实体>，补空 props 桶', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(doc.settings.characters['ch-1']).toEqual({
      id: 'ch-1',
      name: '林晚',
      gradient: 'g-lin',
      bio: '女主',
    })
    expect(doc.settings.locations['loc-1']).toEqual({
      id: 'loc-1',
      name: '天台',
      note: '雨夜',
    })
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
    expect(round.content.nodes.map((n) => n.id)).toEqual([
      's1',
      'b1',
      'd1',
      'br1',
      'sh1',
    ])
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
    // branch 边恢复 type；胶囊文案由 BranchEdge 按 sourceHandle 实时派生，
    // 运行态不落 optionLabel 镜像（issue #18）
    const branchEdge = round.content.edges.find((e) => e.id === 'e2')!
    expect(branchEdge.type).toBe('branch')
    expect(branchEdge.data).toBeUndefined()
    expect(branchEdge.sourceHandle).toBe('option-opt-2')
    // sequence/attach 恢复 className
    expect(round.content.edges.find((e) => e.id === 'e1')!.className).toBe(
      'pw-edge-sequence',
    )
    expect(round.content.edges.find((e) => e.id === 'e3')!.className).toBe(
      'pw-edge-attach',
    )
    // 设定集还原为数组
    expect(round.content.settings.characters).toEqual([
      { id: 'ch-1', name: '林晚', gradient: 'g-lin', bio: '女主' },
    ])
  })

  it('透传字段往返保留：project.description / settings.props / edge data.order（§3/§5/§6）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.project.description = '午夜出租车故事板'
    doc.settings.props['pr-1'] = {
      id: 'pr-1',
      name: '怀表',
      description: '关键道具',
    }
    doc.graph.edges[0].data.order = 1
    doc.graph.edges[1].data.order = 2
    const round = parseProject(doc)
    // 会话态携带透传字段（含运行态边 data.order）
    expect(round.content.description).toBe('午夜出租车故事板')
    expect(round.content.settings.props?.map((p) => p.id)).toEqual(['pr-1'])
    expect(round.content.edges[0].data).toMatchObject({ order: 1 })
    expect(round.content.edges[1].data).toEqual({ order: 2 })
    // 再次落盘不丢
    const again = serializeProject(round.content, 'p-1', NOW)
    expect(again.project.description).toBe('午夜出租车故事板')
    expect(again.settings.props['pr-1']).toEqual({
      id: 'pr-1',
      name: '怀表',
      description: '关键道具',
    })
    expect(again.graph.edges[0].data.order).toBe(1)
    expect(again.graph.edges[1].data.order).toBe(2)
  })

  it('IPC 载荷 description 非字符串：剥离并警告、repaired 落定（原始值透传自 Rust）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      project: Record<string, unknown>
    }
    doc.project.description = 42
    const round = parseProject(doc)
    expect(round.content.description).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('description'))).toBe(true)
    expect(round.repaired).toBe(true)
  })

  it('IPC 载荷缺桶以 null 透传：容器修复标记 repaired——缺桶信封随回写收敛', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as Record<
      string,
      unknown
    >
    doc.episodeTitles = null
    doc.assets = null
    const round = parseProject(doc)
    expect(round.repaired).toBe(true)
    expect(round.content.episodeTitles).toEqual({})
    expect(round.content.assets).toEqual({ byId: {} })
  })

  it('schemaVersion 高于当前版本：拒绝并提示升级应用', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    expect(() =>
      parseProject({ ...doc, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    ).toThrow(/升级应用/)
  })

  it('schemaVersion 负数/小数/NaN/非有限值：按损坏拒绝，不得按形状降级当 v1 归一化（§11.1 第 0 步）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    for (const bad of [-1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => parseProject({ ...doc, schemaVersion: bad }),
        `schemaVersion ${String(bad)}`,
      ).toThrow(TypeError)
    }
  })

  it('孤儿边隔离并记录警告，不阻断加载（§11.3）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push({
      id: 'e-ghost',
      source: 's1',
      target: 'ghost',
      data: { kind: 'sequence' },
    })
    const round = parseProject(doc)
    expect(round.content.edges.map((e) => e.id)).not.toContain('e-ghost')
    expect(round.warnings.some((w) => w.includes('e-ghost'))).toBe(true)
  })

  it('kind/句柄矛盾：sequence 携带任意句柄确定性剥离并保留；attach 携带非 shots 句柄无法修复，按孤儿边隔离（§5）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    // 故意构造非法边，验证归一化兜底
    const invalid = (e: unknown) =>
      e as ProjectDocument['graph']['edges'][number]
    doc.graph.edges.push(
      invalid({
        id: 'e-bad1',
        source: 's1',
        target: 'b1',
        sourceHandle: 'shots',
        data: { kind: 'sequence' },
      }),
      invalid({
        id: 'e-bad2',
        source: 's1',
        target: 'd1',
        sourceHandle: 'option-opt-1',
        data: { kind: 'attach' },
      }),
      invalid({
        id: 'e-bad3',
        source: 's1',
        target: 'b1',
        sourceHandle: 'option-opt-1',
        data: { kind: 'sequence' },
      }),
    )
    const round = parseProject(doc)
    const edgeIds = round.content.edges.map((e) => e.id)
    // sequence 边携带任意 sourceHandle：端口匿名唯一，剥离不改变连接语义，保留并警告
    expect(edgeIds).toContain('e-bad1')
    expect(
      round.content.edges.find((e) => e.id === 'e-bad1')!.sourceHandle,
    ).toBeUndefined()
    // attach 句柄必须是字面量 shots：非 shots 无法确定性修复，隔离
    expect(edgeIds).not.toContain('e-bad2')
    expect(round.warnings.some((w) => w.includes('e-bad1'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('e-bad2'))).toBe(true)
    // e-bad3 剥离句柄后与 e-bad1 同为 (s1→b1, 匿名端口)：逻辑重复，保留文档序首条
    expect(edgeIds).not.toContain('e-bad3')
    expect(
      round.warnings.some((w) => w.includes('e-bad3') && w.includes('重复')),
    ).toBe(true)
    // 合法边不受影响
    expect(
      round.content.edges.some(
        (e) => e.id === 'e3' && e.sourceHandle === 'shots',
      ),
    ).toBe(true)
  })

  it('attach 边端点类型不合法（非 scene → shot）按孤儿边隔离（§5 端点约束）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.graph.edges.push(
      {
        id: 'e-att1',
        source: 'd1',
        target: 'sh1',
        sourceHandle: 'shots',
        data: { kind: 'attach' },
      },
      {
        id: 'e-att2',
        source: 's1',
        target: 'b1',
        sourceHandle: 'shots',
        data: { kind: 'attach' },
      },
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
      {
        id: 'e-seq-shot',
        source: 's1',
        target: 'sh1',
        data: { kind: 'sequence' },
      },
      {
        id: 'e-br-shot',
        source: 'br1',
        target: 'sh1',
        sourceHandle: 'option-opt-1',
        data: { kind: 'branch' },
      },
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
    expect((scene.data as { characterIds: string[] }).characterIds).toEqual([
      'ch-1',
    ])
    expect(round.warnings.some((w) => w.includes('ch-1'))).toBe(true)
  })

  it('v1 信封缺设定集桶：悬空引用只警告，项目照常打开（§11 修复而非拒绝）', () => {
    // Rust ProjectFile 的兼容默认会把缺 settings 的文件解析为 {}（桶全缺）
    const doc = serializeProject(mkContent(), 'p-1', NOW)
    doc.settings = {} as unknown as ProjectDocument['settings']
    const round = parseProject(doc)
    const scene = round.content.nodes.find((n) => n.id === 's1')!
    expect((scene.data as { characterIds: string[] }).characterIds).toEqual([
      'ch-1',
    ])
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
    const refs = (
      round.content.nodes.find((n) => n.id === 'sh1')!.data as {
        refs: { assetId?: string }[]
      }
    ).refs
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
    const refs = (
      round.content.nodes.find((n) => n.id === 'sh1')!.data as {
        refs: { assetId?: string }[]
      }
    ).refs
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
    const refs = (
      round.content.nodes.find((n) => n.id === 'sh1')!.data as {
        refs: { assetId?: string }[]
      }
    ).refs
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
      {
        id: 'e-x',
        source: 'br1',
        target: 'd1',
        sourceHandle: 'option-opt-1',
        data: { kind: 'branch' },
      },
    ]
    const round = parseProject(doc)
    expect(round.content.edges[0].data).toBeUndefined()
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
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
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
    expect(
      new Set(round.content.settings.documents?.map((d) => d.id)).size,
    ).toBe(2)
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
      }) as unknown as SessionNode
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
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: {
        nodes: [
          // data 非普通对象：预检若重置为 {}，迁移会造出 lines:[] + 空 label
          // 的"合法"空白对白——修复回写把损坏节点永久固化成空白节点
          { id: 'd1', type: 'dialogue', position: { x: 0, y: 0 }, data: null },
          {
            id: 's1',
            type: 'scene',
            position: { x: 0, y: 0 },
            data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 's1',
            target: 'd1',
            className: 'pw-edge-sequence',
          },
        ],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.content.nodes.some((n) => n.id === 'd1')).toBe(false)
    // 关联边随孤儿边规则隔离
    expect(round.content.edges).toHaveLength(0)
    expect(
      round.warnings.some((w) => w.includes('d1') && w.includes('隔离')),
    ).toBe(true)
  })

  it('schemaVersion 0 旧信封：边判别字段（type/className）归类为显式 data.kind', () => {
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
            data: { prompt: '去哪', options: [{ id: 'opt-a', label: '左' }] },
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
            id: 'sh1',
            type: 'shot',
            position: { x: 0, y: 0 },
            data: {
              shotNo: 1,
              size: '特写',
              picture: '',
              prompt: '',
              refs: [],
            },
          },
        ],
        edges: [
          // 旧运行态判别：type=branch / className=attach / className=sequence
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
            source: 's1',
            target: 'sh1',
            sourceHandle: 'shots',
            className: 'pw-edge-attach',
          },
          {
            id: 'e3',
            source: 's1',
            target: 's2',
            className: 'pw-edge-sequence',
          },
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
    const again = serializeProject(
      round.content,
      'p-old',
      new Date('2026-08-29T00:00:00.000Z'),
    )
    expect(again.graph.edges.map((e) => e.data.kind)).toEqual([
      'branch',
      'attach',
      'sequence',
    ])
  })

  it('schemaVersion 0 旧信封：数组下标句柄改写为稳定选项 id；越界句柄按孤儿边隔离', () => {
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
                { id: 'opt-a', label: '左' },
                { id: 'opt-b', label: '右' },
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
        ],
        edges: [
          {
            id: 'e1',
            source: 'br1',
            target: 's1',
            sourceHandle: 'option-1',
            type: 'branch',
            data: { optionLabel: '右' },
          },
          {
            id: 'e2',
            source: 'br1',
            target: 's2',
            sourceHandle: 'option-9',
            type: 'branch',
            data: { optionLabel: '越界' },
          },
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
    expect(e1.data).toBeUndefined()
    // 越界下标无法改写，归一化按孤儿边隔离（§11.3）
    expect(round.content.edges.map((e) => e.id)).not.toContain('e2')
    expect(round.warnings.some((w) => w.includes('e2'))).toBe(true)
  })

  it('schemaVersion 0 旧信封：节点字段迁移（头像对象 → characterIds）后按 v1 进入会话；旧格式无视口，迁移不伪造', () => {
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
    const scene = round.content.nodes[0].data as {
      characterIds: string[]
      locationId?: string
    }
    expect(scene.characterIds).toHaveLength(1)
    expect(scene.locationId).toBeDefined()
    expect(round.content.settings.characters.map((c) => c.name)).toEqual(['林'])
    expect(round.content.settings.locations.map((l) => l.name)).toEqual([
      '天台',
    ])
    // 旧格式从未持久化视口：保持缺省，打开时 fitView（不伪造原点视口）
    expect(round.content.viewport).toBeUndefined()
  })
})

/** v1 键 id 漂移夹具（issue #102 行为审计同款）：settings.characters 键
 * c1 的内嵌 id 为 wrong，返回调用方持有的嵌套成员引用，供就地改写断言。 */
function docWithDriftedCharacterId(): {
  doc: Record<string, unknown>
  member: Record<string, unknown>
} {
  const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as Record<
    string,
    unknown
  >
  const characters = (doc.settings as Record<string, unknown>)
    .characters as Record<string, Record<string, unknown>>
  const member: Record<string, unknown> = {
    id: 'wrong',
    name: '角色',
    gradient: 'linear-gradient(red, blue)',
  }
  characters.c1 = member
  return { doc, member }
}

describe('parseProject 输入所有权契约（issue #102：归一化就地改写输入）', () => {
  it('v1：键 id 漂移修复就地改写调用方嵌套对象；repaired 仍按未改动原始快照判定', () => {
    const { doc, member } = docWithDriftedCharacterId()
    const before = structuredClone(doc)
    const round = parseProject(doc)
    // 嵌套引用的内嵌 id 以记录键为准就地改写：调用方持有的对象不再保持原样
    expect(member.id).toBe('c1')
    expect(doc).not.toEqual(before)
    // repaired 的比较基准是入口内部的调用前快照，不因输入被就地改写而失真
    expect(round.repaired).toBe(true)
    // 警告按语义断言：须引用受影响的记录键（夹具数据标识符，非措辞）
    expect(round.warnings.some((w) => w.includes('c1'))).toBe(true)
    // 归一化结果不回归：会话设定集含改写后的条目
    expect(round.content.settings.characters.map((c) => c.id)).toContain('c1')
  })

  it('v0：迁移前预归一化同样就地改写——调用方持有的节点引用被补默认 position', () => {
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
          // position 缺失：预归一化就地补 (0,0)，否则迁移器解引用
          // n.position.x 时单个损坏旧节点令整档迁移崩溃
          {
            id: 's1',
            type: 'scene',
            data: { name: '场一', sceneNo: 1, interior: true, synopsis: '' },
          },
        ],
        edges: [],
      },
      settings: { characters: [], locations: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const node = v0.graph.nodes[0] as Record<string, unknown>
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    expect(node.position).toEqual({ x: 0, y: 0 })
    expect(round.warnings.some((w) => w.includes('position'))).toBe(true)
    expect(round.content.nodes.some((n) => n.id === 's1')).toBe(true)
  })

  it('契约补救路径：克隆后传入则原始档保持未改动，解析结果不受影响', () => {
    const { doc } = docWithDriftedCharacterId()
    const before = structuredClone(doc)
    const round = parseProject(structuredClone(doc))
    expect(doc).toEqual(before)
    expect(round.repaired).toBe(true)
    expect(round.content.settings.characters.map((c) => c.id)).toContain('c1')
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
      (
        doc.graph.nodes.find((n) => n.id === id) as unknown as {
          layout: Record<string, unknown>
        }
      ).layout
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
    expect(
      round.warnings.filter((w) => w.includes('layout.size')),
    ).toHaveLength(3)
    expect(
      round.warnings.filter((w) => w.includes('layout.zIndex')),
    ).toHaveLength(2)
  })
})

/** 净本 + graph/settings/assets 容器各注入一个构造的未来字段（模拟同
 * schemaVersion 的字段增补）。顶层与 project 层不在此列：Rust 信封在
 * IPC 前剥离（issue #100 修正段），前端仅对透传容器执行保留策略。 */
function docWithExtensions(): Record<string, unknown> {
  const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as Record<
    string,
    unknown
  >
  ;(doc.graph as Record<string, unknown>).futureGraphNote = {
    nested: '构造未来字段',
  }
  ;(doc.settings as Record<string, unknown>).futureBucket = {
    'ch-x': { id: 'ch-x', name: '未来实体' },
  }
  ;(doc.assets as Record<string, unknown>).futureIndex = ['a-1']
  return doc
}

describe('同版本文档扩展字段的保留与往返（issue #100，§11 字段演进）', () => {
  it('graph/settings/assets 扩展键：归一化原样保留，净本零修复零警告（打开不回写）', () => {
    const round = parseProject(docWithExtensions())
    expect(round.repaired).toBe(false)
    expect(round.warnings).toEqual([])
    expect(round.content.graphExtensions).toEqual({
      futureGraphNote: { nested: '构造未来字段' },
    })
    expect(round.content.settingsExtensions).toEqual({
      futureBucket: { 'ch-x': { id: 'ch-x', name: '未来实体' } },
    })
    expect(round.content.assetsExtensions).toEqual({ futureIndex: ['a-1'] })
  })

  it('扩展键随会话往返：serializeProject 原样写回，再次解析幂等（保存不销毁）', () => {
    const round = parseProject(docWithExtensions())
    const again = serializeProject(
      round.content,
      'p-1',
      NOW,
    ) as unknown as Record<string, unknown>
    expect((again.graph as Record<string, unknown>).futureGraphNote).toEqual({
      nested: '构造未来字段',
    })
    expect((again.settings as Record<string, unknown>).futureBucket).toEqual({
      'ch-x': { id: 'ch-x', name: '未来实体' },
    })
    expect((again.assets as Record<string, unknown>).futureIndex).toEqual([
      'a-1',
    ])
    // 往返产物是净本：不再触发修复回写
    expect(parseProject(again).repaired).toBe(false)
  })

  it('扩展键与已知坏字段并存：修复语义保留（repaired=true），修复不殃及扩展键', () => {
    const doc = docWithExtensions()
    ;(doc.graph as Record<string, unknown>).viewport = {
      x: 'bad',
      y: 0,
      zoom: 1,
    }
    const round = parseProject(doc)
    expect(round.repaired).toBe(true)
    expect(round.warnings.some((w) => w.includes('viewport'))).toBe(true)
    expect(round.content.viewport).toBeUndefined()
    expect(round.content.graphExtensions).toEqual({
      futureGraphNote: { nested: '构造未来字段' },
    })
    const again = serializeProject(
      round.content,
      'p-1',
      NOW,
    ) as unknown as Record<string, unknown>
    expect((again.graph as Record<string, unknown>).futureGraphNote).toEqual({
      nested: '构造未来字段',
    })
    expect((again.graph as Record<string, unknown>).viewport).toBeUndefined()
  })
})

describe('同版本文档扩展字段的分层边界（issue #100，§11）', () => {
  it('顶层未知键仍按修复处理（repaired=true）：顶层信封是封闭契约，versionless 补盖依赖此语义', () => {
    const doc = {
      ...serializeProject(mkContent(), 'p-1', NOW),
      versionless: true,
    }
    const round = parseProject(doc)
    expect(round.repaired).toBe(true)
    expect(
      (round.content as unknown as Record<string, unknown>).versionless,
    ).toBeUndefined()
  })

  it('扩展键 __proto__（自有属性）：空原型承接不丢失、不触发修复（评审 P2）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as Record<
      string,
      unknown
    >
    // JSON.parse 对 "__proto__" 产出自有属性；对象字面量赋值会触发原型
    // setter，测试以 defineProperty 复刻该自有属性形态
    Object.defineProperty(doc.graph, '__proto__', {
      value: { legacy: '构造原型键' },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const round = parseProject(doc)
    expect(round.repaired).toBe(false)
    expect(round.warnings).toEqual([])
    const extensions = round.content.graphExtensions as Record<string, unknown>
    expect(
      Object.getOwnPropertyDescriptor(extensions, '__proto__')?.value,
    ).toEqual({
      legacy: '构造原型键',
    })
    // 写回的 graph 仍带自有 __proto__ 键（自有数据属性，非原型变更），往返收敛
    const again = serializeProject(
      round.content,
      'p-1',
      NOW,
    ) as unknown as Record<string, unknown>
    expect(
      Object.getOwnPropertyDescriptor(again.graph, '__proto__')?.value,
    ).toEqual({
      legacy: '构造原型键',
    })
    expect(parseProject(again).repaired).toBe(false)
  })

  it('扩展值含超安全整数域的整数：域约束诊断警告，不修复不回写（评审 P2，§11 传输边界）', () => {
    const doc = docWithExtensions()
    // JS 数字面量写不出 9007199254740993（解析即舍入,与 IPC 行为一致）——
    // 经字符串构造得到 IPC 舍入后的形态（=== 9007199254740992）
    const ipcRounded = Number('9007199254740993')
    ;(doc.graph as Record<string, unknown>).futureGraphNote = ipcRounded
    const round = parseProject(doc)
    // 诊断不是修复：打开仍零回写，仅警告值无法无损表示
    expect(round.repaired).toBe(false)
    expect(round.warnings.some((w) => w.includes('安全整数'))).toBe(true)
    expect(round.content.graphExtensions).toEqual({
      futureGraphNote: ipcRounded,
    })
    // 保存固化当前加载值——文件原值已在 IPC 边界丢失，前端无从恢复
    const again = serializeProject(
      round.content,
      'p-1',
      NOW,
    ) as unknown as Record<string, unknown>
    expect((again.graph as Record<string, unknown>).futureGraphNote).toBe(
      ipcRounded,
    )
  })

  it('扩展值含高精度小数：上游解析侧即舍入且 webview 不可检测，按传输边界固化（评审 P2）', () => {
    const doc = docWithExtensions()
    // 1.0000000000000001 的最近 f64 是 1.0——Rust serde_json 解析侧（早于
    // IPC）即舍入，webview 收到的 1 与真实 1 不可区分，诊断无从施策；
    // JS 面量同样写不出该值，经字符串构造复刻舍入形态
    const upstreamRounded = Number('1.0000000000000001')
    expect(upstreamRounded).toBe(1)
    ;(doc.graph as Record<string, unknown>).futureGraphNote = upstreamRounded
    const round = parseProject(doc)
    expect(round.repaired).toBe(false)
    expect(round.warnings).toEqual([])
    expect(round.content.graphExtensions).toEqual({ futureGraphNote: 1 })
    const again = serializeProject(
      round.content,
      'p-1',
      NOW,
    ) as unknown as Record<string, unknown>
    expect((again.graph as Record<string, unknown>).futureGraphNote).toBe(1)
  })
})

describe('信封形状判型警告（issue #338 评审，§11 第 0 步「均记录警告」）', () => {
  const shapeWarning = (warnings: string[]) =>
    warnings.some((w) => w.includes('信封形状判型'))

  it('v1 形状判型（versionless 标记）：交付会话前记录判型警告', () => {
    // Rust 判型在异型版本键/缺失版本号时按 v1 形状交付并打 versionless
    // 标记（IPC 顶层额外键）——修复不得静默，警告须解释保存时的补盖
    const doc = {
      ...serializeProject(mkContent(), 'p-1', NOW),
      versionless: true,
    }
    const round = parseProject(doc)
    expect(shapeWarning(round.warnings)).toBe(true)
  })

  it('v0 形状判型（versionless 标记）：迁移交付同样记录判型警告', () => {
    const v0 = {
      versionless: true,
      schemaVersion: 0,
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: { nodes: [], edges: [] },
      settings: { characters: [], locations: [], props: [], documents: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0)
    expect(round.migrated).toBe(true)
    expect(shapeWarning(round.warnings)).toBe(true)
  })

  it('显式版本号（无标记）：不产生判型警告', () => {
    expect(
      shapeWarning(
        parseProject(serializeProject(mkContent(), 'p-1', NOW)).warnings,
      ),
    ).toBe(false)
    const v0Explicit = {
      schemaVersion: 0,
      project: {
        id: 'p-old',
        name: '旧剧',
        createdAt: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      graph: { nodes: [], edges: [] },
      settings: { characters: [], locations: [], props: [], documents: [] },
      episodeTitles: {},
      assets: { byId: {} },
    }
    const round = parseProject(v0Explicit)
    expect(round.migrated).toBe(true)
    expect(shapeWarning(round.warnings)).toBe(false)
  })
})
