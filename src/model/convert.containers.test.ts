/**
 * §11.1 第 2 步容器级形状校验与信封元数据测试：容器/成员异型重置、
 * project 元数据回退链（受信 id / 索引名）、episodeTitles 键值域严格化、
 * 视口形状与 project 时间戳严格校验（与 Rust 保存边界同域）。
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import { NOW, mkContent } from './convertFixtures'

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

