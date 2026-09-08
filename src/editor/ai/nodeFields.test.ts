import { describe, expect, it } from 'vitest'
import { validateAiBatch, type AiGraphSnapshot } from './commands'
import { AI_FIELD_KEYS, AI_NODE_FIELDS, nodeFieldTableText } from './nodeFields'

/** 各类型「恰好填满白名单」的形状合法载荷：与 commands.ts 值形状校验
 * 同口径（正整数编号、非空白引用、列表成员结构）。 */
const VALID_DATA: Record<string, Record<string, unknown>> = {
  scene: {
    name: '场一', sceneNo: 1, interior: true, locationId: 'l1', time: '🌙 夜',
    weather: '雨', synopsis: '开局', characterIds: ['c1'], episodeNo: 1,
  },
  dialogue: { name: '对白一', lines: [{ text: '喂' }], episodeNo: 1 },
  beat: { name: '节拍一', tone: '紧张', episodeNo: 1 },
  branch: { prompt: '怎么办？', options: ['坦白', '隐瞒'], episodeNo: 1 },
  shot: { shotNo: 1, size: '特写', picture: '车窗', prompt: 'p', refs: [{ kind: 'character', label: '垫图' }] },
}

const EMPTY_SNAPSHOT: AiGraphSnapshot = { nodes: [], edges: [], assets: new Map() }

const createBatch = (nodeType: string, data: Record<string, unknown>) =>
  validateAiBatch([{ op: 'create_node', nodeType, data }], EMPTY_SNAPSHOT)

describe('AI_NODE_FIELDS（issue 41：节点字段协议单一来源）', () => {
  it('覆盖五类 AI 可写节点；图片节点不在协议内（§13 首版只读）', () => {
    expect(Object.keys(AI_NODE_FIELDS).sort()).toEqual(['beat', 'branch', 'dialogue', 'scene', 'shot'])
  })

  it('beat 的合法字段协议钉住为 name/tone/episodeNo', () => {
    expect(AI_FIELD_KEYS.beat).toEqual(['name', 'tone', 'episodeNo'])
    expect(AI_FIELD_KEYS.beat).not.toContain('label')
    expect(AI_FIELD_KEYS.beat).not.toContain('summary')
    expect(AI_FIELD_KEYS.beat).not.toContain('stakes')
  })

  it('每个类型的 spec 键与白名单视图一致', () => {
    for (const [type, fields] of Object.entries(AI_NODE_FIELDS)) {
      expect(fields.map((f) => f.key)).toEqual(AI_FIELD_KEYS[type])
      for (const f of fields) {
        expect(['string', 'integer', 'boolean', 'array']).toContain(f.type)
        expect(f.desc.trim()).not.toBe('')
      }
    }
  })

  it('字段表与校验白名单同源：按表填满即通过，表外字段被拒', () => {
    for (const [type, data] of Object.entries(VALID_DATA)) {
      expect([...AI_FIELD_KEYS[type]].sort()).toEqual(Object.keys(data).sort())
      expect(createBatch(type, data).ok, `${type} 按字段表构造的 data 应通过校验`).toBe(true)
    }
    const bad = createBatch('beat', { ...VALID_DATA.beat, label: '立足', summary: '小店开张' })
    expect(bad.ok).toBe(false)
    expect(bad.issues[0]?.message).toContain('label')
    expect(bad.issues[0]?.message).toContain('summary')
  })
})

describe('nodeFieldTableText（系统提示与工具描述共用的协议文本）', () => {
  it('逐类型列出全部合法字段键', () => {
    const text = nodeFieldTableText()
    for (const [type, fields] of Object.entries(AI_NODE_FIELDS)) {
      expect(text).toContain(type)
      for (const f of fields) expect(text).toContain(f.key)
    }
  })
})
