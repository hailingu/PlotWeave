import { describe, expect, it } from 'vitest'
import { extractBatchJson } from './batchText'

/** 回复文本批次提取的契约（§12.2 围栏回退通道）：围栏优先、取最后一个、
 * 大小写不敏感；无法解析返回 undefined（纯讨论回复）。 */
describe('extractBatchJson', () => {
  it('从散文与 json 围栏中取最后一个批次', () => {
    const text = '先解释……\n```json\n{"commands":[{"op":"create_node","nodeType":"beat"}]}\n```\n再补充一句。'
    const parsed = extractBatchJson(text)
    expect(parsed).toEqual({ commands: [{ op: 'create_node', nodeType: 'beat' }] })
  })
  it('无围栏时直接识别裸批次对象', () => {
    expect(extractBatchJson('{"commands":[]}')).toEqual({ commands: [] })
  })
  it('没有可解析的批次返回 undefined', () => {
    expect(extractBatchJson('纯文本回复，不改动画布')).toBeUndefined()
    expect(extractBatchJson('```json\nnot-json\n```')).toBeUndefined()
  })
  it('多个围栏只取最后一个；最后一个非法时不回退到前面的合法围栏', () => {
    expect(extractBatchJson('```json\nnot-json\n```\n```json\n{"commands":[]}\n```')).toEqual({
      commands: [],
    })
    expect(extractBatchJson('```json\n{"commands":[]}\n```\n```json\nnot-json\n```')).toBeUndefined()
  })
  it('围栏标记大小写不敏感（```JSON 亦可）', () => {
    expect(extractBatchJson('```JSON\n{"commands":[]}\n```')).toEqual({ commands: [] })
  })
  it('非 json 围栏（如 ```ts）不参与提取', () => {
    expect(extractBatchJson('```ts\nconst x = 1\n```\n```json\n{"commands":[]}\n```')).toEqual({
      commands: [],
    })
  })
  it('未闭合的围栏不产出候选；裸批次须为完整文本，混入围栏杂讯则拒绝', () => {
    expect(extractBatchJson('```json\n{"commands":[]}')).toBeUndefined()
    expect(extractBatchJson('{"commands":[]}\n```json\nnot-closed')).toBeUndefined()
  })
})
