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
