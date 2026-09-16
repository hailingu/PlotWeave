/**
 * AI 命令列表成员的未知自有键白名单（issue #140）：lines/options/refs/
 * relatedIds 成员与协议 schema 的 additionalProperties:false 同口径——
 * 未知自有键（含 JSON 自有 __proto__）按下标与键名点名、整批零变更；
 * 协议内全键成员不误拒。从 commands.test.ts 拆出（PR #188 评审：测试
 * 文件 1800 行与函数 80 行上限）。
 */
import { describe, expect, it } from 'vitest'
import { validateAiBatch } from './batchFold'
import { entSnap, richSnap, snap } from './testGraphs'

describe('lines 成员未知自有键白名单（issue #140）', () => {
  it('成员携带协议外自有键（evil）：整批拒绝，按下标与键名点名，命令零产出', () => {
    const bad = validateAiBatch(
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
      entSnap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('lines[1]')
    expect(msg).toContain('evil')
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
})

describe('options 成员未知自有键白名单（issue #140）', () => {
  it('对象成员携带协议外自有键：整批拒绝并点名；字符串与合法成员照常通过', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'update_node',
          nodeId: 'b1',
          patch: {
            options: [{ id: 'ob-a', label: '追', extra: 'x' }],
          },
        },
      ],
      richSnap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('options[0]')
    expect(msg).toContain('extra')

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

describe('refs 成员未知自有键白名单（issue #140）', () => {
  it('引用位成员携带协议外自有键：整批拒绝并点名', () => {
    const bad = validateAiBatch(
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
      richSnap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('refs[0]')
    expect(msg).toContain('note')
  })
})

describe('relatedIds 成员未知自有键白名单（issue #140）', () => {
  it('成员携带协议外自有键：整批拒绝并点名（upsert_document 同一政策）', () => {
    const bad = validateAiBatch(
      [
        {
          op: 'upsert_document',
          fields: {
            title: '世界观',
            relatedIds: [{ kind: 'character', id: 'ch-1', tag: '主角' }],
          },
        },
      ],
      entSnap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    const msg = bad.issues.map((i) => i.message).join('\n')
    expect(msg).toContain('relatedIds[0]')
    expect(msg).toContain('tag')
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
