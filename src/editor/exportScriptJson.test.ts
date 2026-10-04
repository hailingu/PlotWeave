/** JSON 生成器契约（#502）：直接验证保存同源投影、字段往返、顺序与输出字节。 */
import { expect, it } from 'vitest'
import { parseProject } from '../model/convert'
import { mkContent } from '../model/convertFixtures'
import type { ProjectDocument } from '../model/document'
import { buildScriptJson } from './exportScriptJson'
import type { EditorProject, SessionDocPart } from './sessionDoc'

/** 复用五类节点与三类边夹具；补齐可选布局、资产及容器扩展。 */
function input(): { project: EditorProject; current: SessionDocPart } {
  const content = mkContent()
  content.nodes[0] = {
    ...content.nodes[0],
    width: 340,
    height: 200,
    zIndex: 0,
  }
  return {
    project: {
      id: 'json-contract',
      name: '午夜出租车',
      description: '剧本简介',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      graphExtensions: { custom: { retained: true } },
      settingsExtensions: { custom: ['设定扩展'] },
      assetsExtensions: { custom: '资产扩展' },
    },
    current: {
      ...content,
      aiRevision: 2,
      assets: {
        byId: {
          image1: {
            id: 'image1',
            relPath: 'assets/image1.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        },
      },
    },
  }
}

// 删除任一可选字段应单独失败：parseProject 无警告不能证明这些字段仍存在。
it.each([
  ['weather', '0.data.spec.weather', '0.data.weather', '雨'],
  ['locationId', '0.data.spec.locationId', '0.data.locationId', 'loc-1'],
  ['side', '2.data.spec.lines.0.side', '2.data.lines.0.side', 'left'],
  ['vo', '2.data.spec.lines.0.vo', '2.data.lines.0.vo', false],
  ['layout.size.width', '0.layout.size.width', '0.width', 340],
  ['layout.size.height', '0.layout.size.height', '0.height', 200],
  ['zIndex', '0.layout.zIndex', '0.zIndex', 0],
] as const)(
  '可选字段 %s 在 JSON 与回读会话中保持保真',
  (_, stored, session, value) => {
    const { project, current } = input()
    const exported: ProjectDocument = JSON.parse(
      buildScriptJson(project, current),
    )
    expect(exported.graph.nodes).toHaveProperty(stored, value)
    const restored = parseProject(exported)
    expect(restored.warnings).toEqual([])
    expect(restored.content.nodes).toHaveProperty(session, value)
  },
)

// 把缺省可选字段伪造成空值/default，或用真值筛选漏掉 vo=true/false，会破坏此边界。
it('缺省可选字段不被伪造，显式 vo=true 保持存在', () => {
  const { project, current } = input()
  const scene = current.nodes.find((node) => node.type === 'scene')!
  delete scene.data.weather
  delete scene.data.locationId
  delete scene.width
  delete scene.height
  delete scene.zIndex
  const dialogue = current.nodes.find((node) => node.type === 'dialogue')!
  delete dialogue.data.lines[0].side
  dialogue.data.lines[0].vo = true
  const exported: ProjectDocument = JSON.parse(
    buildScriptJson(project, current),
  )
  expect(exported.graph.nodes[0]).not.toHaveProperty('data.spec.weather')
  expect(exported.graph.nodes[0]).not.toHaveProperty('data.spec.locationId')
  expect(exported.graph.nodes[0]).not.toHaveProperty('layout.size')
  expect(exported.graph.nodes[0]).not.toHaveProperty('layout.zIndex')
  expect(exported.graph.nodes[2]).not.toHaveProperty('data.spec.lines.0.side')
  expect(exported.graph.nodes[2]).toHaveProperty('data.spec.lines.0.vo', true)
  const restored = parseProject(exported)
  expect(restored.warnings).toEqual([])
  expect(restored.content.nodes[0]).not.toHaveProperty('data.weather')
  expect(restored.content.nodes[0]).not.toHaveProperty('data.locationId')
  expect(restored.content.nodes[0]).not.toHaveProperty('width')
  expect(restored.content.nodes[0]).not.toHaveProperty('height')
  expect(restored.content.nodes[0]).not.toHaveProperty('zIndex')
  expect(restored.content.nodes[2]).not.toHaveProperty('data.lines.0.side')
  expect(restored.content.nodes[2]).toHaveProperty('data.lines.0.vo', true)
})

// 漏转义会产生非法 JSON，或使解析后文本变化；不以生成器计算期望值。
it.each([
  ['引号', '前"对白"后'],
  ['反斜杠', '前\\剧本\\后'],
  ['换行', '前\n后'],
  ['制表', '前\t后'],
  ['控制字符', '前\u0000\u0001\u001f后'],
  ['星平面字符', '前😀𠮷后'],
])('%s 经 JSON → parseProject 往返保持原文', (_, text) => {
  const { project, current } = input()
  project.name = text
  project.description = text
  const dialogue = current.nodes.find((node) => node.type === 'dialogue')!
  dialogue.data.lines[0].text = text
  current.episodeTitles = { 2: text }
  const restored = parseProject(JSON.parse(buildScriptJson(project, current)))
  expect(restored.warnings).toEqual([])
  expect(restored.content.name).toBe(text)
  expect(restored.content.description).toBe(text)
  expect(restored.content.nodes).toHaveProperty('2.data.lines.0.text', text)
  expect(restored.content.episodeTitles).toEqual({ 2: text })
})

// 改用旧项目图、丢弃引用/扩展或重新盖时钟戳会破坏此公开文档契约。
it('保留项目元数据、设定、资产与会话扩展', () => {
  const { project, current } = input()
  const exported: ProjectDocument = JSON.parse(
    buildScriptJson(project, current),
  )
  expect(exported.schemaVersion).toBe(1)
  expect(exported.project).toEqual({
    id: 'json-contract',
    name: '午夜出租车',
    description: '剧本简介',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T12:00:00.000Z',
  })
  expect(exported.settings.characters['ch-1']).toEqual({
    id: 'ch-1',
    name: '林晚',
    gradient: 'g-lin',
    bio: '女主',
  })
  expect(exported.settings.locations['loc-1']).toEqual({
    id: 'loc-1',
    name: '天台',
    note: '雨夜',
  })
  expect(exported.assets.byId['image1']).toEqual({
    id: 'image1',
    relPath: 'assets/image1.png',
    mime: 'image/png',
    source: 'upload',
    createdAt: '2026-08-01T00:00:00.000Z',
  })
  expect(exported.episodeTitles).toEqual({ 2: '摊牌' })
  expect(exported.graph.viewport).toEqual({ x: 100, y: -40, zoom: 1.25 })
  expect(exported.graph.aiRevision).toBe(2)
  const restored = parseProject(exported)
  expect(restored.warnings).toEqual([])
  expect(restored.content.graphExtensions).toEqual({
    custom: { retained: true },
  })
  expect(restored.content.settingsExtensions).toEqual({ custom: ['设定扩展'] })
  expect(restored.content.assetsExtensions).toEqual({ custom: '资产扩展' })
})

// 裁剪线性正文会丢失分支/附件；漏掉必需场景字段也应在生成器层报错。
it('保留必需场景字段、完整分支与三种图引用', () => {
  const { project, current } = input()
  const exported: ProjectDocument = JSON.parse(
    buildScriptJson(project, current),
  )
  expect(exported.graph.nodes.map((node) => node.type)).toEqual([
    'scene',
    'beat',
    'dialogue',
    'branch',
    'shot',
  ])
  expect(exported.graph.nodes[0]).toMatchObject({
    id: 's1',
    type: 'scene',
    layout: { position: { x: 10, y: 20 } },
    data: {
      meta: { label: '天台夜话', episodeNo: 2 },
      spec: {
        sceneNo: 3,
        interior: false,
        time: '夜',
        synopsis: '摊牌',
        characterIds: ['ch-1'],
      },
    },
  })
  expect(exported.graph.edges).toEqual([
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
  expect(exported.graph.nodes).toHaveProperty('3.data.spec.options', [
    { id: 'opt-1', label: '坦白' },
    { id: 'opt-2', label: '隐瞒' },
  ])
  expect(parseProject(exported).warnings).toEqual([])
})

// JSON 保留会话数组顺序；叙事拓扑可从边推导，但不编码为重新排序的节点数组。
it('保留与叙事顺序不同的会话节点和边数组顺序', () => {
  const { project, current } = input()
  current.nodes.reverse()
  current.edges.reverse()
  const exported: ProjectDocument = JSON.parse(
    buildScriptJson(project, current),
  )
  expect(exported.graph.nodes.map((node) => node.id)).toEqual([
    'sh1',
    'br1',
    'd1',
    'b1',
    's1',
  ])
  expect(exported.graph.edges.map((edge) => edge.id)).toEqual([
    'e3',
    'e2',
    'e1',
  ])
  const restored = parseProject(exported)
  expect(restored.warnings).toEqual([])
  expect(restored.content.nodes.map((node) => node.id)).toEqual([
    'sh1',
    'br1',
    'd1',
    'b1',
    's1',
  ])
})

// 原地删除运行态字段、改写节点内容或元数据都会破坏只读投影。
it('生成时不修改项目或会话，运行态字段不会泄漏到文档', () => {
  const { project, current } = input()
  const original = structuredClone({ project, current })
  const exported: ProjectDocument = JSON.parse(
    buildScriptJson(project, current),
  )
  expect({ project, current }).toEqual(original)
  expect(exported.graph.nodes[0]).not.toHaveProperty('selected')
  expect(exported.graph.nodes[0]).not.toHaveProperty('className')
  expect(exported.graph.nodes[0].ui).toEqual({
    selected: false,
    expanded: true,
  })
})

// 文本形态本身是契约：docs/data-model/project-document.md §3.1（#502）。
// 只固定契约规定的缩进与尾部换行，不固定 JSON 对象键排列或使用快照。
it('空会话输出两空格缩进和恰好一个尾部换行', () => {
  const project = {
    id: 'empty-json',
    name: '空剧本',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T12:00:00.000Z',
  }
  const current: SessionDocPart = {
    nodes: [],
    edges: [],
    settings: { characters: [], locations: [] },
    assets: undefined,
  }
  const text = buildScriptJson(project, current)
  expect(text).toMatch(/^ {2}"project": \{$/m)
  expect(text).toMatch(/^ {4}"id": "empty-json",?$/m)
  expect(text).toMatch(/^ {2}"graph": \{$/m)
  expect(text).toMatch(/^ {4}"nodes": \[\],?$/m)
  expect(text.endsWith('\n')).toBe(true)
  expect(text.endsWith('\n\n')).toBe(false)
  expect(parseProject(JSON.parse(text)).warnings).toEqual([])
})
