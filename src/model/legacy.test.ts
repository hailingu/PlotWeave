import { describe, expect, it } from 'vitest'
import { migrateProjectDocument } from './legacy'
import type { ProjectContent } from './content'
import type { CanvasNode } from '../editor/nodes/types'

const node = (n: CanvasNode): CanvasNode => n

/** 旧 schema 场景：characters 是头像对象数组、location 是字符串。 */
const legacyScene = node({
  id: 's1',
  type: 'scene',
  position: { x: 0, y: 0 },
  selected: false,
  data: {
    name: '天台',
    sceneNo: 1,
    interior: true,
    time: '🌙 夜',
    synopsis: '',
    characters: [
      { label: '林', gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)' },
      { label: '陈', gradient: 'g-chen' },
    ],
    location: '天台',
  },
} as unknown as CanvasNode)

const legacyDialogue = node({
  id: 'd1',
  type: 'dialogue',
  position: { x: 10, y: 0 },
  selected: false,
  data: {
    name: '对白',
    lines: [
      { kind: 'action', text: '雨停了', speaker: null, vo: false },
      { kind: 'line', speaker: { label: '林', gradient: 'g-lin' }, side: 'left', text: '别走', vo: false },
    ],
  },
} as unknown as CanvasNode)

describe('migrateProjectDocument（旧 schema → 引用 id 化）', () => {
  it('头像对象 → characterIds 并就地建实体；地点字符串 → locationId 并建地点实体', () => {
    const { doc, migrated } = migrateProjectDocument({
      name: 'x',
      nodes: [legacyScene],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    expect(migrated).toBe(true)
    const scene = doc.nodes[0].data as { characterIds: string[]; locationId?: string; characters?: unknown }
    expect(scene.characters).toBeUndefined()
    expect(scene.characterIds).toHaveLength(2)
    expect(scene.locationId).toBeDefined()
    expect(doc.settings.characters.map((c) => c.name)).toEqual(['林', '陈'])
    expect(doc.settings.locations.map((l) => l.name)).toEqual(['天台'])
    // 建出的 id 即引用 id，闭环一致
    expect(scene.characterIds).toEqual(doc.settings.characters.map((c) => c.id))
  })

  it('对白 speaker 对象 → 实体 id；同名/同渐变头像复用既有实体不重复建', () => {
    const existing = { id: 'ch-lin', name: '林晚', gradient: 'g-lin' }
    const { doc } = migrateProjectDocument({
      name: 'x',
      nodes: [legacyDialogue, legacyScene],
      edges: [],
      settings: { characters: [existing], locations: [] },
    })
    const lines = (doc.nodes[0].data as { lines: Array<{ kind: string; speaker: unknown }> }).lines
    expect(lines[1].speaker).toBe('ch-lin') // 渐变+名字前缀命中既有「林晚」
    const names = doc.settings.characters.map((c) => c.name)
    expect(names).toContain('林晚')
    expect(names.filter((n) => n === '林晚')).toHaveLength(1)
  })

  it('新 schema 文档不做任何迁移（migrated=false，字段原样）', () => {
    const modern = node({
      id: 's2',
      type: 'scene',
      position: { x: 0, y: 0 },
      selected: false,
      data: { name: '新场', sceneNo: 2, interior: false, time: '☀️ 日', synopsis: '', characterIds: ['ch1'] },
    } as unknown as CanvasNode)
    const { doc, migrated } = migrateProjectDocument({
      name: 'x',
      nodes: [modern],
      edges: [],
      settings: { characters: [{ id: 'ch1', name: '林晚', gradient: 'g' }], locations: [] },
    })
    expect(migrated).toBe(false)
    expect((doc.nodes[0].data as { characterIds: string[] }).characterIds).toEqual(['ch1'])
  })

  it('场景既无 characters 也无 characterIds：补空数组并标记迁移', () => {
    const bare = node({
      id: 's3',
      type: 'scene',
      position: { x: 0, y: 0 },
      selected: false,
      data: { name: '空场', sceneNo: 3, interior: true, time: '🌙 夜', synopsis: '' },
    } as unknown as CanvasNode)
    const { doc, migrated } = migrateProjectDocument({ name: 'x', nodes: [bare], edges: [], settings: undefined as unknown as ProjectContent['settings'] })
    expect(migrated).toBe(true)
    expect((doc.nodes[0].data as { characterIds: string[] }).characterIds).toEqual([])
    expect(doc.settings.characters).toEqual([])
  })
})

describe('migrateProjectDocument · v0 头像兼容子步骤（§11：合并去重与确定性匹配）', () => {
  const sceneWith = (extra: Record<string, unknown>) =>
    node({
      id: 's9',
      type: 'scene',
      position: { x: 0, y: 0 },
      selected: false,
      data: { name: '过渡场', sceneNo: 9, interior: true, time: '🌙 夜', synopsis: '', ...extra },
    } as unknown as CanvasNode)
  const run = (
    scene: CanvasNode,
    characters: ProjectContent['settings']['characters'],
  ) => migrateProjectDocument({ name: 'x', nodes: [scene], edges: [], settings: { characters, locations: [] } })
  const idsOf = (doc: ReturnType<typeof migrateProjectDocument>['doc']) =>
    (doc.nodes[0].data as { characterIds: string[] }).characterIds

  it('头像解析 id 与已有合法 characterIds 按原顺序合并去重，不整体覆盖', () => {
    const existing = { id: 'ch-keep', name: '陈总', gradient: 'g-chen' }
    const { doc } = run(
      sceneWith({
        characters: [{ label: '林', gradient: 'g-lin' }],
        characterIds: ['ch-keep', 'ch-keep'],
      }),
      [existing],
    )
    const scene = doc.nodes[0].data as { characterIds: string[]; characters?: unknown }
    expect(scene.characters).toBeUndefined()
    // 头像建出的新 id 在前，既有结构化引用保留，重复 ch-keep 去重
    expect(scene.characterIds).toHaveLength(2)
    expect(scene.characterIds[1]).toBe('ch-keep')
    expect(doc.settings.characters.some((c) => c.id === scene.characterIds[0])).toBe(true)
  })

  it('空头像数组不清空已有 characterIds（可恢复来源为零时保留结构化引用）', () => {
    const { doc } = run(sceneWith({ characters: [], characterIds: ['ch-1'] }), [
      { id: 'ch-1', name: '林晚', gradient: 'g' },
    ])
    expect(idsOf(doc)).toEqual(['ch-1'])
  })

  it('同名优先复用（gradient 不一致仍按完整名复用）；多字标签不做前缀匹配', () => {
    const { doc } = run(sceneWith({ characters: [{ label: '张三', gradient: 'g-y' }] }), [
      { id: 'ch-a', name: '张三', gradient: 'g-x' },
    ])
    expect(idsOf(doc)).toEqual(['ch-a'])
    expect(doc.settings.characters).toHaveLength(1)

    const { doc: doc2 } = run(sceneWith({ characters: [{ label: '张三', gradient: 'g-a' }] }), [
      { id: 'ch-b', name: '张三丰', gradient: 'g-a' },
    ])
    expect(idsOf(doc2)).not.toContain('ch-b')
    expect(doc2.settings.characters.map((c) => c.name)).toEqual(['张三丰', '张三'])
  })

  it('单字标签前缀歧义（张三/张四）→ 新建独立角色，不错绑首见项', () => {
    const { doc } = run(sceneWith({ characters: [{ label: '张', gradient: 'g-a' }] }), [
      { id: 'ch-a', name: '张三', gradient: 'g-a' },
      { id: 'ch-b', name: '张四', gradient: 'g-a' },
    ])
    const ids = idsOf(doc)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('ch-a')
    expect(ids[0]).not.toBe('ch-b')
    expect(doc.settings.characters.map((c) => c.name)).toEqual(['张三', '张四', '张'])
    expect(doc.settings.characters[2].id).toBe(ids[0])
  })

  it('label 与既有名称按 trim 规范化比较：空白差异不制造重复实体', () => {
    const { doc } = run(sceneWith({ characters: [{ label: ' 林晚 ' }] }), [
      { id: 'ch-lin', name: '林晚', gradient: 'g' },
    ])
    expect(idsOf(doc)).toEqual(['ch-lin'])
    expect(doc.settings.characters).toHaveLength(1)
  })

  it('location 按 trim 规范化：空白差异复用既有地点，不建重复实体', () => {
    const existing = { id: 'loc-1', name: '厨房' }
    const sceneAt = (location: string) =>
      node({
        id: 's-loc',
        type: 'scene',
        position: { x: 0, y: 0 },
        selected: false,
        data: { name: '厨房戏', sceneNo: 7, interior: true, time: '日', synopsis: '', location },
      } as unknown as CanvasNode)
    const { doc } = migrateProjectDocument({
      name: 'x',
      nodes: [sceneAt('  厨房 ')],
      edges: [],
      settings: { characters: [], locations: [existing] },
    })
    expect((doc.nodes[0].data as { locationId?: string }).locationId).toBe('loc-1')
    expect(doc.settings.locations).toHaveLength(1)
  })

  it('location 纯空白：删除镜像不建实体、留警告，不产生悬空 locationId', () => {
    const sceneAt = () =>
      node({
        id: 's-blank',
        type: 'scene',
        position: { x: 0, y: 0 },
        selected: false,
        data: { name: '空白地点场', sceneNo: 8, interior: true, time: '日', synopsis: '', location: '   ' },
      } as unknown as CanvasNode)
    const warnings: string[] = []
    const { doc } = migrateProjectDocument(
      { name: 'x', nodes: [sceneAt()], edges: [], settings: { characters: [], locations: [] } },
      warnings,
    )
    const scene = doc.nodes[0].data as { locationId?: string; location?: unknown }
    expect(scene.locationId).toBeUndefined()
    expect(scene.location).toBeUndefined()
    expect(doc.settings.locations).toEqual([])
    expect(warnings.some((w) => w.includes('空白'))).toBe(true)
  })
})

describe('migrateProjectDocument · 列表项稳定 id 回填（S6479）', () => {
  it('分支字符串选项升级为 {id,label}；缺 id 对象只补 id；已有 id 原样保留', () => {
    const branch = node({
      id: 'b1',
      type: 'branch',
      position: { x: 0, y: 0 },
      data: { prompt: '？', options: ['坦白', { label: '隐瞒' }, { id: 'opt-keep', label: '沉默' }] },
    } as unknown as CanvasNode)
    const { doc, migrated } = migrateProjectDocument({
      name: 'x',
      nodes: [branch],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    expect(migrated).toBe(true)
    const options = (doc.nodes[0].data as { options: Array<{ id: string; label: string }> }).options
    expect(options.map((o) => o.label)).toEqual(['坦白', '隐瞒', '沉默'])
    expect(options[0].id).toMatch(/^opt-/)
    expect(options[1].id).toMatch(/^opt-/)
    expect(options[2].id).toBe('opt-keep')
  })

  it('对白 lines / 分镜 refs 无 id 回填；迁移幂等（二刷 migrated=false）', () => {
    const dialogue = node({
      id: 'd1',
      type: 'dialogue',
      position: { x: 0, y: 0 },
      data: { name: '对白', lines: [{ kind: 'action', text: '雨停' }] },
    } as unknown as CanvasNode)
    const shot = node({
      id: 'sh1',
      type: 'shot',
      position: { x: 0, y: 0 },
      data: { shotNo: 1, size: '中景', picture: '', prompt: '', refs: [{ kind: 'audio', label: '雨声' }] },
    } as unknown as CanvasNode)
    const { doc, migrated } = migrateProjectDocument({
      name: 'x',
      nodes: [dialogue, shot],
      edges: [],
      settings: { characters: [], locations: [] },
    })
    expect(migrated).toBe(true)
    const lines = (doc.nodes[0].data as { lines: Array<{ id: string }> }).lines
    const refs = (doc.nodes[1].data as { refs: Array<{ id: string }> }).refs
    expect(lines[0].id).toMatch(/^line-/)
    expect(refs[0].id).toMatch(/^ref-/)

    const again = migrateProjectDocument({ name: 'x', nodes: doc.nodes, edges: [], settings: doc.settings })
    expect(again.migrated).toBe(false)
  })
})
