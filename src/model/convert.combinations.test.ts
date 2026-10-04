/**
 * #232 收窄后的 v1 组合回归：合法内容保全、局部坏成员隔离、修复后往返稳定。
 * 复用既有夹具与真实 JSON 边界；不枚举全部字段/图规则，不引入随机生成器。
 * 状态与不变量矩阵：https://github.com/hailingu/PlotWeave/issues/232
 */
import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from './convert'
import type { ProjectContent } from './content'
import type { ProjectDocument } from './document'
import { mkContent, NOW } from './convertFixtures'

/** 夹具变化只选择记录顺序与容器扩展是否存在，均不改变合法性。 */
function fixture(extensions: boolean, reversed = false): ProjectContent {
  const content = mkContent()
  if (reversed) {
    content.nodes.reverse()
    content.edges.reverse()
  }
  if (extensions) {
    content.graphExtensions = { futureGraph: { note: '保留剧情备注' } }
    content.settingsExtensions = { futureSettings: ['保留设定'] }
    content.assetsExtensions = { futureAssets: { revision: 1 } }
  }
  return content
}

/** JSON 编解码隔开夹具与归一化的可变输入，模拟真实文档边界的值语义。 */
function parseJsonDocument(doc: unknown): ReturnType<typeof parseProject> {
  return parseProject(JSON.parse(JSON.stringify(doc)))
}

/** 以输入夹具独立验证所有现有记录；只忽略契约允许变化的运行态展示字段。 */
function expectPreserved(actual: ProjectContent, expected: ProjectContent) {
  expect(actual.nodes).toEqual(
    expected.nodes.map((node) => {
      const persisted = { ...node, selected: false }
      delete persisted.className
      return persisted
    }),
  )
  expect(actual.edges).toHaveLength(expected.edges.length)
  for (const [index, edge] of expected.edges.entries()) {
    const persisted = { ...edge }
    delete persisted.selected
    expect(actual.edges[index]).toMatchObject(persisted)
  }
  expect(actual.settings).toEqual({
    props: [],
    documents: [],
    ...expected.settings,
  })
  expect(actual).toMatchObject({
    name: expected.name,
    createdAt: expected.createdAt,
    viewport: expected.viewport,
    episodeTitles: expected.episodeTitles,
  })
  expect(actual.graphExtensions).toEqual(expected.graphExtensions)
  expect(actual.settingsExtensions).toEqual(expected.settingsExtensions)
  expect(actual.assetsExtensions).toEqual(expected.assetsExtensions)
}

/** 损坏类别限定为三个已有隔离契约及其一次组合，不生成任意脏数据。 */
type Damage = '坏节点及关联边' | '孤儿边' | '坏设定成员' | '三类并存'

/** 在合法子图之外注入局部损坏；返回 unknown，因为这些形态故意违反 schema。 */
function withDamage(doc: ProjectDocument, damage: Damage): unknown {
  const brokenNode = damage === '坏节点及关联边' || damage === '三类并存'
  const orphan = damage === '孤儿边' || damage === '三类并存'
  const brokenSetting = damage === '坏设定成员' || damage === '三类并存'
  return {
    ...doc,
    graph: {
      ...doc.graph,
      nodes: [
        ...doc.graph.nodes,
        ...(brokenNode
          ? [{ id: 'broken-node', type: 'scene', data: null }]
          : []),
      ],
      edges: [
        ...doc.graph.edges,
        ...(brokenNode
          ? [
              {
                id: 'broken-edge',
                source: 's1',
                target: 'broken-node',
                data: { kind: 'sequence' },
              },
            ]
          : []),
        ...(orphan
          ? [
              {
                id: 'orphan',
                source: 's1',
                target: 'missing',
                data: { kind: 'sequence' },
              },
            ]
          : []),
      ],
    },
    settings: {
      ...doc.settings,
      characters: {
        ...doc.settings.characters,
        ...(brokenSetting
          ? { broken: { id: 'broken', name: null, gradient: 'g' } }
          : {}),
      },
    },
  }
}

const damageCases: Damage[] = [
  '坏节点及关联边',
  '孤儿边',
  '坏设定成员',
  '三类并存',
]

describe.each([false, true])(
  'v1 组合回归：容器扩展=%s（#232）',
  (extensions) => {
    // 捕获首轮序列化/加载就丢记录、错接边或清空扩展字段的回归。
    it.each([false, true])(
      '合法记录倒序=%s：往返保全且无需修复',
      (reversed) => {
        const expected = fixture(extensions, reversed)
        const first = parseJsonDocument(serializeProject(expected, 'p-1', NOW))
        expect(first.repaired).toBe(false)
        expect(first.migrated).toBe(false)
        expect(first.warnings).toEqual([])
        expectPreserved(first.content, expected)
        const next = parseJsonDocument(
          serializeProject(first.content, 'p-1', NOW),
        )
        expectPreserved(next.content, expected)
        expect(next.content).toEqual(first.content)
        expect(next.repaired).toBe(false)
        expect(next.migrated).toBe(false)
      },
    )

    // 捕获局部异常让整档失败、误删无关合法记录或遗漏修复回写信号的回归。
    it.each(damageCases)('%s：隔离损坏，合法子图及设定保持原样', (damage) => {
      const expected = fixture(extensions)
      const raw = withDamage(serializeProject(expected, 'p-1', NOW), damage)
      const result = parseJsonDocument(raw)
      expect(result.repaired).toBe(true)
      expect(result.migrated).toBe(false)
      expect(result.warnings.length).toBeGreaterThan(0)
      expectPreserved(result.content, expected)
    })

    // 捕获修复产物下次保存再丢内容、每次加载继续修复的回归。
    it.each(damageCases)('%s：修复产物再次往返不变且不再修复', (damage) => {
      const expected = fixture(extensions)
      const raw = withDamage(serializeProject(expected, 'p-1', NOW), damage)
      const repaired = parseJsonDocument(raw)
      expectPreserved(repaired.content, expected)
      const next = parseJsonDocument(
        serializeProject(repaired.content, 'p-1', NOW),
      )
      expect(next.content).toEqual(repaired.content)
      expectPreserved(next.content, expected)
      expect(next.repaired).toBe(false)
      expect(next.migrated).toBe(false)
      expect(next.warnings).toEqual([])
    })
  },
)
