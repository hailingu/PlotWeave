/**
 * 资产索引与引用位测试（§7.1/§11.3）：assets.byId 完整 AssetRef 形状
 * 校验（Rust 保存边界的加载侧对等）、ShotRef 旧草案 targetId 的无歧义
 * 兼容与资产命名空间、实路径复验联动与设定文档形状隔离。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { NOW, mkContent } from './convertFixtures'

/** 形状合法的样例资产条目（用例只经展开拷贝改写，不就地变更）。 */
const goodAsset = {
  id: 'a-1',
  relPath: 'assets/lin.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-08-01T00:00:00.000Z',
}

/** 可改写的脏 v1 文档视图（资产索引 + 节点，targetId 用例共用）。 */
type RefDoc = {
  graph: { nodes: Record<string, unknown>[] }
  settings: Record<string, Record<string, Record<string, unknown>>>
  assets: { byId: Record<string, Record<string, unknown>> }
}

/** 构造指定 id/relPath/mime 的合法资产条目。 */
const mkAsset = (id: string, relPath: string, mime: string) => ({
  id,
  relPath,
  mime,
  source: 'upload',
  createdAt: '2026-08-01T00:00:00.000Z',
})

/** 就地改写 sh1 分镜节点的引用位列表。 */
const setRefs = (doc: RefDoc, refs: unknown[]) => {
  const shot = doc.graph.nodes.find((n) => n.id === 'sh1')!
  ;(shot.data as { spec: { refs: unknown[] } }).spec.refs = refs
}

/** 取解析结果中 sh1 分镜节点的引用位列表。 */
const refsOf = (round: ReturnType<typeof parseProject>) =>
  (round.content.nodes.find((n) => n.id === 'sh1')!.data as unknown as { refs: Record<string, unknown>[] }).refs

describe('归一化：assets.byId 完整 AssetRef 形状校验（§11.3，Rust 保存边界的加载侧对等）——条目形状与规范化', () => {
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

  it('合法大小写/首尾空白的 mime 与带时区的 createdAt：规范化为规范形式并警告（§7.1 统一落 UTC）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    doc.assets.byId['a-1'] = { ...goodAsset, mime: ' IMAGE/PNG ' }
    doc.assets.byId['a-2'] = { ...goodAsset, id: 'a-2', relPath: 'assets/a.wav', mime: 'audio/wav', createdAt: '2026-08-01T08:00:00+08:00' }
    const round = parseProject(doc)
    expect(round.content.assets?.byId['a-1']?.mime).toBe('image/png')
    // 红：偏移形式原样保留——同一瞬间存在多种持久化表示（§7.1 要求
    // 统一落为 UTC toISOString()）
    expect(round.content.assets?.byId['a-2']?.createdAt).toBe('2026-08-01T00:00:00.000Z')
    expect(round.warnings.some((w) => w.includes('createdAt'))).toBe(true)
  })

  it('资产 createdAt 规范化越出四位年份域：隔离并警告——规范形不可落，留存即令此后每次保存注定失败', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      assets: { byId: Record<string, Record<string, unknown>> }
    }
    // 合法的 -23:59 偏移使 UTC 换算越过 9999 年：toISOString 产出
    // +010000-… 无规范形可落，Rust 保存边界只收 24 字符规范 UTC
    doc.assets.byId['a-ext'] = {
      ...goodAsset, id: 'a-ext', createdAt: '9999-12-31T23:59:59-23:59',
    }
    const round = parseProject(doc)
    expect(round.content.assets?.byId['a-ext']).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('a-ext') && w.includes('四位年份'))).toBe(true)
  })
})

describe('归一化：时间戳可保存域与对白 @ 提及扫描（§11.1，年份域回退链）', () => {
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

  it('对白文本 @ 提及扫描（§11.1 第 5 步）：悬空 token 警告失效、畸形/未闭合片段警告并保留原文', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Array<{ type?: string; data: { spec: { lines?: Array<Record<string, unknown>> } } }> }
    }
    const dialogue = doc.graph.nodes.find((n) => n.type === 'dialogue')!
    const lines = dialogue.data.spec.lines!
    const line = lines.find((l) => l.kind === 'line') ?? lines[0]
    const original =
      '呼唤 @[character:ghost] 与畸形 @[character:bad id] 以及 @[character:未闭合 的混合'
    line.text = original
    const round = parseProject(doc)
    // 红：提及扫描缺失——悬空 token 与畸形片段无声进入活动文档
    expect(round.warnings.some((w) => w.includes('ghost') && w.includes('失效'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('非法') && w.includes('片段'))).toBe(true)
    expect(round.warnings.some((w) => w.includes('未闭合'))).toBe(true)
    // token 与片段一律保留原文（不改写、不删除）；有效 token（目标存在）不警告
    const out = round.content.nodes.find((n) => n.type === 'dialogue')!.data as unknown as {
      lines: Array<Record<string, unknown>>
    }
    expect(out.lines.some((l) => l.text === original)).toBe(true)
    expect(round.warnings.some((w) => w.includes('ch-1'))).toBe(false)
  })
})

describe('归一化：空白/异型引用值的加载侧收口（§8.1 共同值域之外不可恢复）', () => {
  it('角色 avatarAssetId 空白且无映射：移除并警告——不留每次加载都悬空警告的空白引用', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      settings: Record<string, Record<string, Record<string, unknown>>>
    }
    ;(doc.settings.characters['ch-1'] as Record<string, unknown>).avatarAssetId = '   '
    const round = parseProject(doc)
    // 红：字段只过字符串类型检查——空白引用原样保留并落盘，每次加载仅警告悬空
    expect((round.content.settings.characters[0] as unknown as Record<string, unknown>).avatarAssetId).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('avatarAssetId'))).toBe(true)
  })

  it('对白行 speaker 空白且无映射：移除并警告——与场景/分镜路径同口径收口', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Array<{ type?: string; data: { spec: { lines?: Array<Record<string, unknown>> } } }> }
    }
    const dialogue = doc.graph.nodes.find((n) => n.type === 'dialogue')!
    const lines = dialogue.data.spec.lines!
    const line = lines.find((l) => l.kind === 'line') ?? lines[0]
    line.speaker = '   '
    const round = parseProject(doc)
    const out = round.content.nodes.find((n) => n.type === 'dialogue')!.data as unknown as {
      lines: Array<Record<string, unknown>>
    }
    expect(out.lines[0].speaker).toBeUndefined()
    expect(round.warnings.some((w) => w.includes('speaker'))).toBe(true)
  })

  it('对白 action 行携带 speaker：归一化剥离并标记 repaired——隐藏引用不得存留（§4.2 只允许 line 行有说话人）', () => {
    const doc = serializeProject(mkContent(), 'p-1', NOW) as unknown as {
      graph: { nodes: Array<{ type?: string; data: { spec: { lines?: Array<Record<string, unknown>> } } }> }
    }
    const dialogue = doc.graph.nodes.find((n) => n.type === 'dialogue')!
    dialogue.data.spec.lines!.push({ id: 'line-act', kind: 'action', text: '雨声渐大', speaker: 'ch-1' })
    const round = parseProject(doc)
    const out = round.content.nodes.find((n) => n.type === 'dialogue')!.data as unknown as {
      lines: Array<Record<string, unknown>>
    }
    const action = out.lines.find((l) => l.kind === 'action')!
    expect('speaker' in action).toBe(false)
    expect(round.warnings.some((w) => w.includes('action') && w.includes('speaker'))).toBe(true)
    expect(round.repaired).toBe(true)
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

describe('归一化：ShotRef 旧草案 targetId 的无歧义兼容（§4.2/§8.1/§11.1 六十四轮）——旧值改名与歧义/异型隔离', () => {
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
})

describe('归一化：ShotRef 旧草案 targetId 的无歧义兼容（§4.2/§8.1/§11.1 六十四轮）——修复前身份快照与 MIME 用途匹配', () => {
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

