/**
 * 节点与键控列表的判别联合测试（§4.1/§4.2，§11.1 第 3 步）：对白行判别
 * 与可选字段、节点 spec/meta 形状、键控列表 id 唯一性、非法节点 id 重发
 * 与空端点改写、成员类型字段校验、场景文本字段与身份修复先于形状隔离的
 * 顺序契约。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import type { ProjectDocument } from './document'
import { NOW, mkContent } from './convertFixtures'

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

