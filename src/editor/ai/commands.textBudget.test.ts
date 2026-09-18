import { describe, expect, it } from 'vitest'
import { validateAiBatch } from './batchFold'
import type { AiGraphSnapshot } from './commands'
import { entSnap, snap } from './testGraphs'
import { DOCUMENT_BODY_MAX_CHARS, FREE_TEXT_MAX_CHARS } from './textBudget'
import { WRITE_PARAMETERS } from './toolSchemas'

/**
 * AI 自由文本字段的写入体积预算（issue #170）：普通自由文本字段
 * 65,536 字符、设定文档正文 1,048,576 字符，超限整批拒绝并回喂诊断
 * （不自行截断用户内容）；上限内内容原样保留。工具 schema 以
 * maxLength 向模型广告同一预算，校验边界仍是权威执行点。
 */

/** 恰好顶格 / 超一字符的文本对。 */
function around(max: number): { fit: string; over: string } {
  return { fit: '字'.repeat(max), over: '字'.repeat(max + 1) }
}

/** 含设定集的快照（实体/文档通道需要 entityScope 投影）。 */
function entGraph(): AiGraphSnapshot {
  return { ...entSnap(), edges: [] }
}

describe('issue #170 · 节点自由文本字段的体积预算', () => {
  it('synopsis 顶格通过且归一化原样保留（不截断）；超一字符整批拒绝', () => {
    const { fit, over } = around(FREE_TEXT_MAX_CHARS)
    const ok = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'scene',
          data: { name: '场', synopsis: fit },
        },
      ],
      snap(),
    )
    expect(ok.ok, JSON.stringify(ok.issues)).toBe(true)
    const data = ok.commands[0] as { data: { synopsis: string } }
    expect(data.data.synopsis).toHaveLength(FREE_TEXT_MAX_CHARS)

    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'scene',
          data: { name: '场', synopsis: over },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.commands).toEqual([])
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('synopsis')
    expect(bad.issues.map((i) => i.message).join('\n')).toContain(
      String(FREE_TEXT_MAX_CHARS),
    )
  })

  it('update_node 的 patch 同域：超长 picture 拒绝', () => {
    const { over } = around(FREE_TEXT_MAX_CHARS)
    const bad = validateAiBatch(
      [{ op: 'update_node', nodeId: 'sh1', patch: { picture: over } }],
      {
        nodes: [{ id: 'sh1', type: 'shot', label: 'SHOT01' }],
        edges: [],
        assets: new Map(),
      },
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('picture')
  })

  it('对白行 lines[].text 超限拒绝并点名行下标', () => {
    const { over } = around(FREE_TEXT_MAX_CHARS)
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '对白',
            lines: [
              { kind: 'line', text: '短句' },
              { kind: 'line', text: over },
            ],
          },
        },
      ],
      entGraph(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('lines[1]')
  })

  it('分支选项文案（字符串与对象两种形态）超限拒绝', () => {
    const { over } = around(FREE_TEXT_MAX_CHARS)
    for (const options of [[over], [{ label: over }]]) {
      const bad = validateAiBatch(
        [
          {
            op: 'create_node',
            nodeType: 'branch',
            data: { prompt: '？', options },
          },
        ],
        snap(),
      )
      expect(bad.ok).toBe(false)
      expect(bad.issues.map((i) => i.message).join('\n')).toContain('options')
    }
  })

  it('分镜引用位的自由文案 label 超限拒绝', () => {
    const { over } = around(FREE_TEXT_MAX_CHARS)
    const bad = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'shot',
          data: {
            shotNo: 1,
            refs: [{ kind: 'character', label: over }],
          },
        },
      ],
      snap(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('refs[0]')
  })
})

describe('issue #170 · 设定实体与文档的体积预算', () => {
  it('角色 bio 按普通自由文本预算拒绝', () => {
    const { over } = around(FREE_TEXT_MAX_CHARS)
    const bad = validateAiBatch(
      [{ op: 'upsert_character', fields: { name: '陈默', bio: over } }],
      entGraph(),
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.map((i) => i.message).join('\n')).toContain('bio')
  })

  it('文档 title 按普通预算拒绝；body 分级：超普通预算可写、超文档预算拒绝', () => {
    const { over: titleOver } = around(FREE_TEXT_MAX_CHARS)
    const badTitle = validateAiBatch(
      [{ op: 'upsert_document', fields: { title: titleOver } }],
      entGraph(),
    )
    expect(badTitle.ok).toBe(false)

    // 分级证明：body 在普通自由文本预算之上、文档预算之内仍合法
    const longBody = '字'.repeat(FREE_TEXT_MAX_CHARS * 2)
    const ok = validateAiBatch(
      [{ op: 'upsert_document', fields: { title: '世界观', body: longBody } }],
      entGraph(),
    )
    expect(ok.ok, JSON.stringify(ok.issues)).toBe(true)

    const { over: bodyOver } = around(DOCUMENT_BODY_MAX_CHARS)
    const badBody = validateAiBatch(
      [{ op: 'upsert_document', fields: { title: '世界观', body: bodyOver } }],
      entGraph(),
    )
    expect(badBody.ok).toBe(false)
    expect(badBody.issues.map((i) => i.message).join('\n')).toContain('body')
    expect(badBody.issues.map((i) => i.message).join('\n')).toContain(
      String(DOCUMENT_BODY_MAX_CHARS),
    )
  })
})

describe('issue #170 · 工具 schema 向模型广告同一预算', () => {
  it('场景 synopsis 与文档 body 的 maxLength 与校验预算一致', () => {
    const variants = WRITE_PARAMETERS.create_node.properties.data as {
      anyOf: Array<{ properties: Record<string, { maxLength?: number }> }>
    }
    const scene = variants.anyOf.find(
      (v) => v.properties.synopsis !== undefined,
    )
    expect(scene?.properties.synopsis.maxLength).toBe(FREE_TEXT_MAX_CHARS)

    const docFields = WRITE_PARAMETERS.upsert_document.properties.fields as {
      properties: Record<string, { maxLength?: number }>
    }
    expect(docFields.properties.body.maxLength).toBe(DOCUMENT_BODY_MAX_CHARS)
    expect(docFields.properties.title.maxLength).toBe(FREE_TEXT_MAX_CHARS)
  })
})
