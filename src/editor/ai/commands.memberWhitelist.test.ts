/**
 * AI 命令列表成员的未知自有键白名单（issue #140）：lines/options/refs/
 * relatedIds 成员与协议 schema 的 additionalProperties:false 同口径——
 * 未知自有键（含 JSON 自有 __proto__）按下标与键名点名、整批零变更；
 * 协议内全键成员不误拒。从 commands.test.ts 拆出（PR #188 评审：测试
 * 文件 1800 行与函数 80 行上限）。
 */
import { describe, expect, it } from 'vitest'
import { validateAiBatch } from './batchFold'
import type { AiGraphSnapshot } from './commands'
import { entSnap, richSnap, snap } from './testGraphs'

describe('列表成员未知自有键白名单（issue #140：lines/options/refs/relatedIds）', () => {
  // 四个成员族共用「协议外自有键 → 整批零变更 + 按下标与键名点名」模板，
  // 与协议 schema 的 additionalProperties:false 同口径（issue #291 参数化）。
  it.each<[string, unknown[], () => AiGraphSnapshot, string, string]>([
    [
      'lines 成员携带协议外自有键（evil）',
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '对白',
            lines: [
              { kind: 'line', text: '先来', speaker: 'ch-1' },
              {
                kind: 'line',
                text: '后到',
                speaker: 'ch-1',
                evil: { nested: true },
              },
            ],
          },
        },
      ],
      entSnap,
      'lines[1]',
      'evil',
    ],
    [
      'options 对象成员携带协议外自有键（extra）',
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: {
            options: [{ id: 'ob-a', label: '追', extra: 'x' }],
          },
        },
      ],
      richSnap,
      'options[0]',
      'extra',
    ],
    [
      'refs 引用位成员携带协议外自有键（note）',
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: {
            shotNo: 1,
            size: '特写',
            picture: '',
            prompt: '',
            refs: [{ kind: 'audio', assetId: 'a-aud', note: '自定义' }],
          },
        },
      ],
      richSnap,
      'refs[0]',
      'note',
    ],
    [
      'relatedIds 成员携带协议外自有键（tag；upsert_document 同一政策）',
      [
        {
          op: 'upsert_document',
          fields: {
            title: '世界观',
            relatedIds: [{ kind: 'character', id: 'ch-1', tag: '主角' }],
          },
        },
      ],
      entSnap,
      'relatedIds[0]',
      'tag',
    ],
  ])('%s：整批拒绝并点名', (_label, batch, snapshot, index, key) => {
    const bad = validateAiBatch(batch, snapshot())
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain(index)
    expect(msg).toContain(key)
  })

  it('成员携带自有 __proto__ 键（JSON 数据形态）：同样按未知键拒绝', () => {
    // JSON.parse 产生的 __proto__ 是自有可枚举键（非原型污染），
    // 成员白名单按未知键处理
    const line = JSON.parse(
      '{"kind":"action","text":"雨声","__proto__":{"x":1}}',
    )
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: { name: '对白', lines: [line] },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('lines[0]')
  })

  it('options 字符串与合法成员照常通过', () => {
    const good = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: { options: ['追', { id: 'ob-x', label: '新' }] },
        },
      ],
      richSnap(),
    )
    expect(good.ok).toBe(true)
  })
})

describe('成员白名单不误拒协议内全键成员（issue #140）', () => {
  it('lines 携带全部协议内键照常通过', () => {
    const good = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '对白',
            lines: [
              {
                id: 'l1',
                kind: 'line',
                text: '台词',
                speaker: 'ch-1',
                side: 'left',
                vo: true,
              },
              { id: 'l2', kind: 'action', text: '转身' },
            ],
          },
        },
      ],
      entSnap(),
    )
    expect(good.ok).toBe(true)
  })
})

/** Object.prototype 自有成员名：模型可产出的合法字符串，但不是注册表自有键。 */
const PROTO_MEMBER_NAMES = Object.getOwnPropertyNames(Object.prototype)

describe('op 注册表自有键白名单（issue #258）', () => {
  it.each(PROTO_MEMBER_NAMES)(
    'op=%s 按未知操作拒绝：不抛异常、ok=false、commands 空',
    (op) => {
      const res = validateAiBatch([{ op }], snap())
      expect(res.ok).toBe(false)
      expect(res.commands).toEqual([])
      expect(res.issues.map((i) => i.message).join('\n')).toContain('未知操作')
    },
  )

  it('原型名 op 与合法命令同批：整批拒绝且按下标点名', () => {
    const res = validateAiBatch(
      [
        { op: 'create_node', nodeType: 'scene', ref: 'a', data: { name: 'x' } },
        { op: 'constructor' },
      ],
      snap(),
    )
    expect(res.ok).toBe(false)
    expect(res.commands).toEqual([])
    expect(res.issues).toEqual([
      { index: 1, message: expect.stringContaining('未知操作') },
    ])
  })
})
