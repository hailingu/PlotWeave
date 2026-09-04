/**
 * 设定集桶的归一化测试（§6/§11.1 第 3 步）：实体形状校验与隔离、键控桶
 * 空记录键重发与同桶引用改写、设定文档 relatedIds 成员校验、空白 id 引用
 * 重发改写贯通、角色 id/token 安全子值域专项修复。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { NOW, mkContent } from './convertFixtures'

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

