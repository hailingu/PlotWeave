import { describe, expect, it } from 'vitest'
import { validateAiBatch } from './batchFold'
import type { AiGraphSnapshot } from './commands'
import { entSnap, snap } from './testGraphs'
import { DOCUMENT_BODY_MAX_CHARS, FREE_TEXT_MAX_CHARS } from './textBudget'
import { WRITE_PARAMETERS, BATCH_PARAMETERS } from './toolSchemas'

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

// 同构「超一字符 → 整批拒绝并点名」家族参数化（issue #291 精简重复用例）；
// 表置于模块级以符合套件回调 80 代码行上限。synopsis 的顶格通过与归一化
// 原样保留正向断言保留在 describe 内。
const FIELD_BUDGET_CASES: ReadonlyArray<
  [string, unknown[], AiGraphSnapshot, string]
> = [
  [
    'update_node 的 patch 同域：超长 picture',
    [
      {
        op: 'update_node',
        nodeId: 'sh1',
        patch: { picture: '字'.repeat(FREE_TEXT_MAX_CHARS + 1) },
      },
    ],
    {
      nodes: [{ id: 'sh1', type: 'shot', label: 'SHOT01' }],
      edges: [],
      assets: new Map(),
    },
    'picture',
  ],
  [
    '对白行 lines[].text 超限（点名行下标）',
    [
      {
        op: 'create_node',
        nodeType: 'dialogue',
        data: {
          name: '对白',
          lines: [
            { kind: 'line', text: '短句' },
            { kind: 'line', text: '字'.repeat(FREE_TEXT_MAX_CHARS + 1) },
          ],
        },
      },
    ],
    entGraph(),
    'lines[1]',
  ],
  [
    '分支选项文案（字符串形态）超限',
    [
      {
        op: 'create_node',
        nodeType: 'branch',
        data: {
          prompt: '？',
          options: ['字'.repeat(FREE_TEXT_MAX_CHARS + 1)],
        },
      },
    ],
    snap(),
    'options',
  ],
  [
    '分支选项文案（对象形态）超限',
    [
      {
        op: 'create_node',
        nodeType: 'branch',
        data: {
          prompt: '？',
          options: [{ label: '字'.repeat(FREE_TEXT_MAX_CHARS + 1) }],
        },
      },
    ],
    snap(),
    'options',
  ],
  [
    '分镜引用位的自由文案 label 超限',
    [
      {
        op: 'create_node',
        nodeType: 'shot',
        data: {
          shotNo: 1,
          refs: [
            {
              kind: 'character',
              label: '字'.repeat(FREE_TEXT_MAX_CHARS + 1),
            },
          ],
        },
      },
    ],
    snap(),
    'refs[0]',
  ],
]

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

  it.each(FIELD_BUDGET_CASES)(
    '%s：整批拒绝并点名',
    (_label, batch, snapshot, field) => {
      const bad = validateAiBatch(batch, snapshot)
      expect(bad.ok).toBe(false)
      expect(bad.issues.map((i) => i.message).join('\n')).toContain(field)
    },
  )
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

  it('实体 name 的通道化重建保留 maxLength（单写与批次新建两入口）', () => {
    // toolSchemas 为实体名称叠加非空白 pattern 与通道文案时不得丢掉协议表
    // 广告的体积预算——替换式重建会让模型可见协议与校验边界漂移（评审）
    const single = WRITE_PARAMETERS.upsert_character.properties.fields as {
      properties: Record<string, { maxLength?: number }>
    }
    expect(single.properties.name.maxLength).toBe(FREE_TEXT_MAX_CHARS)

    type Variant = {
      properties: {
        op: { enum: string[] }
        fields: {
          required?: string[]
          properties: Record<string, { maxLength?: number }>
        }
      }
    }
    const batchVariants = (
      BATCH_PARAMETERS.properties.commands as { items: { anyOf: Variant[] } }
    ).items.anyOf
    const createCharacter = batchVariants.find(
      (v) =>
        v.properties.op.enum[0] === 'upsert_character' &&
        v.properties.fields.required?.includes('name'),
    )
    expect(createCharacter?.properties.fields.properties.name.maxLength).toBe(
      FREE_TEXT_MAX_CHARS,
    )
  })

  it('字符数按 Unicode 码点计（与 JSON Schema maxLength 同口径）', () => {
    // 星号平面字符（emoji）占两个 UTF-16 码元：按 length 会把 65,536 个
    // 码点误计为 131,072——广告契约放行而校验边界拒绝，诊断字数同样错
    const fit = '😀'.repeat(FREE_TEXT_MAX_CHARS)
    const over = '😀'.repeat(FREE_TEXT_MAX_CHARS + 1)
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
    expect(bad.issues.map((i) => i.message).join('\n')).toContain(
      `实际 ${FREE_TEXT_MAX_CHARS + 1} 字符`,
    )
  })

  it('成员 id 不广告体积预算：schema 无 maxLength，运行态保留超长既有 id', () => {
    // 脏/导入数据的既有成员 id 可能超预算长度——运行态按「非空白唯一」
    // 原样保留（normalizeNodeFields），schema 不得广告边界没有的约束，
    // 否则模型无法忠实重述既有条目（PR #204 评审）
    const longId = 'i'.repeat(FREE_TEXT_MAX_CHARS + 1)
    const ok = validateAiBatch(
      [
        {
          op: 'create_node',
          nodeType: 'dialogue',
          data: {
            name: '对白',
            lines: [{ kind: 'line', text: '短句', id: longId }],
          },
        },
      ],
      entGraph(),
    )
    expect(ok.ok, JSON.stringify(ok.issues)).toBe(true)
    const data = ok.commands[0] as { data: { lines: Array<{ id: string }> } }
    expect(data.data.lines[0].id).toBe(longId)

    const variants = WRITE_PARAMETERS.create_node.properties.data as {
      anyOf: Array<{
        properties: Record<
          string,
          {
            items?: {
              anyOf: Array<{
                properties: Record<string, { maxLength?: number }>
              }>
            }
          }
        >
      }>
    }
    const dialogue = variants.anyOf.find(
      (v) => v.properties.lines !== undefined,
    )
    const lineItems = dialogue?.properties.lines.items?.anyOf ?? []
    expect(lineItems.length).toBeGreaterThan(0)
    for (const item of lineItems) {
      expect(item.properties.text.maxLength).toBe(FREE_TEXT_MAX_CHARS)
      expect(item.properties.id.maxLength).toBeUndefined()
    }
  })
})
