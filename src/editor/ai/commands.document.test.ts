import { describe, expect, it } from 'vitest'
import { validateAiBatch, type AiGraphSnapshot } from './commands'

/**
 * upsert_document 整批校验（issue 56，两阶段契约同 issue 44 实体通道）：
 * 阶段 A 上下文无关形状（fields 白名单/值形状/relatedIds 条目形状），
 * 阶段 B 折叠（entityId 解析、relatedIds 存在性与种类、批内 ref、
 * (kind,id) 重复）。无效整批拒绝，画布与设定集零副作用。
 */

function settingsSnap(): AiGraphSnapshot {
  return {
    nodes: [{ id: 'n1', type: 'scene', label: '场 01 · 天台' }],
    edges: [],
    assets: new Map(),
    settings: {
      characters: [{ id: 'ch-1', name: '陈默' }],
      locations: [{ id: 'loc-1', name: '茶馆' }],
      documents: [{ id: 'doc-1', title: '世界观' }],
    },
  }
}

describe('upsert_document · 阶段 A 形状校验', () => {
  it('新建：fields 只含 title/body/relatedIds，预览产出创建条目', () => {
    const v = validateAiBatch(
      [
        {
          op: 'upsert_document',
          ref: 'bio',
          fields: { title: '陈默小传', body: '沉默寡言的老刑警。', relatedIds: [{ kind: 'character', id: 'ch-1' }] },
        },
      ],
      settingsSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.items).toEqual([
      { kind: 'create_entity', danger: false, key: 'ed0', label: '创建 文档 · 陈默小传' },
    ])
    expect(v.commands[0]).toMatchObject({
      op: 'upsert_document',
      fields: {
        title: '陈默小传',
        body: '沉默寡言的老刑警。',
        relatedIds: [{ kind: 'character', id: 'ch-1' }],
      },
    })
  })

  it('修改：entityId 指向既有文档，fields 只写要改的字段', () => {
    const v = validateAiBatch(
      [{ op: 'upsert_document', entityId: 'doc-1', fields: { body: '新的世界观全文。' } }],
      settingsSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.items[0]).toMatchObject({ kind: 'update_entity', label: '修改 文档 · 世界观（body）' })
    expect(v.commands[0]).toMatchObject({ entityId: 'doc-1', fields: { body: '新的世界观全文。' } })
  })

  it('阶段 A 整批拒绝：fields 非对象、白名单外字段、title/body 非字符串', () => {
    for (const [label, cmd] of [
      ['fields 非对象', { op: 'upsert_document', fields: 'not-an-object' }],
      ['未知字段', { op: 'upsert_document', fields: { title: 't', gradient: 'red' } }],
      ['title 非字符串', { op: 'upsert_document', fields: { title: 42 } }],
      ['body 非字符串', { op: 'upsert_document', fields: { title: 't', body: [] } }],
      [
        'relatedIds 条目非对象',
        { op: 'upsert_document', fields: { title: 't', relatedIds: ['ch-1'] } },
      ],
      [
        'relatedIds 旧式字符串项/未知 kind/缺 id',
        {
          op: 'upsert_document',
          fields: {
            title: 't',
            relatedIds: [
              { kind: 'prop', id: 'p-1' },
              { kind: 'character' },
            ],
          },
        },
      ],
      [
        'relatedIds 非数组',
        { op: 'upsert_document', fields: { title: 't', relatedIds: { kind: 'character', id: 'ch-1' } } },
      ],
      ['entityId 在场但空白', { op: 'upsert_document', entityId: '  ', fields: { body: 'x' } }],
      ['entityId 非字符串', { op: 'upsert_document', entityId: 7, fields: { body: 'x' } }],
    ] as const) {
      const v = validateAiBatch([cmd as unknown as Record<string, unknown>], settingsSnap())
      expect(v.ok, label).toBe(false)
      expect(v.issues.length, label).toBeGreaterThanOrEqual(1)
      expect(v.commands, label).toEqual([])
    }
  })

  it('阶段 A 拒绝：创建缺 title（title 是文档在清单中的身份）', () => {
    const v = validateAiBatch(
      [{ op: 'upsert_document', fields: { body: '只有正文' } }],
      settingsSnap(),
    )
    expect(v.ok).toBe(false)
  })

  it('阶段 A 拒绝：修改 title 为空白（不许清空清单标题）', () => {
    const v = validateAiBatch(
      [{ op: 'upsert_document', entityId: 'doc-1', fields: { title: '   ' } }],
      settingsSnap(),
    )
    expect(v.ok).toBe(false)
  })

  it('未知操作名不被接受（upsert_documents 复数等）', () => {
    const v = validateAiBatch([{ op: 'upsert_documents', fields: { title: 't' } }], settingsSnap())
    expect(v.ok).toBe(false)
    expect(v.issues[0]?.message).toContain('未知操作')
  })
})

describe('upsert_document · 阶段 B 折叠校验', () => {
  it('relatedIds 指向不存在实体 → 整批拒绝；跨种类拒绝', () => {
    for (const [label, related] of [
      ['角色桶不存在', [{ kind: 'character', id: 'ch-404' }]],
      ['地点 id 填成 character 种类', [{ kind: 'character', id: 'loc-1' }]],
    ] as const) {
      const v = validateAiBatch(
        [{ op: 'upsert_document', fields: { title: 't', relatedIds: related } }],
        settingsSnap(),
      )
      expect(v.ok, label).toBe(false)
      expect(v.commands, label).toEqual([])
    }
  })

  it('relatedIds 合法混合角色与地点；执行命令保持原 token', () => {
    const v = validateAiBatch(
      [
        {
          op: 'upsert_document',
          fields: {
            title: '术语表',
            relatedIds: [
              { kind: 'character', id: 'ch-1' },
              { kind: 'location', id: 'loc-1' },
            ],
          },
        },
      ],
      settingsSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({
      fields: {
        relatedIds: [
          { kind: 'character', id: 'ch-1' },
          { kind: 'location', id: 'loc-1' },
        ],
      },
    })
  })

  it('批内 ref：先 upsert_character 再在 relatedIds 引用别名，折叠放行', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_character', ref: 'hero', fields: { name: '林晚' } },
        {
          op: 'upsert_document',
          fields: { title: '林晚小传', relatedIds: [{ kind: 'character', id: 'hero' }] },
        },
      ],
      settingsSnap(),
    )
    expect(v.ok).toBe(true)
    expect(v.commands[1]).toMatchObject({
      fields: { relatedIds: [{ kind: 'character', id: 'hero' }] },
    })
  })

  it('ref 指向地点别名但 kind 写 character → 整批拒绝', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_location', ref: 'shop', fields: { name: '当铺' } },
        {
          op: 'upsert_document',
          fields: { title: 't', relatedIds: [{ kind: 'character', id: 'shop' }] },
        },
      ],
      settingsSnap(),
    )
    expect(v.ok).toBe(false)
  })

  it('(kind,id) 重复拒绝：裸重复与「别名+显式 id 解析到同一实体」都拒绝', () => {
    const dupRaw = validateAiBatch(
      [
        {
          op: 'upsert_document',
          fields: {
            title: 't',
            relatedIds: [
              { kind: 'character', id: 'ch-1' },
              { kind: 'character', id: 'ch-1' },
            ],
          },
        },
      ],
      settingsSnap(),
    )
    expect(dupRaw.ok).toBe(false)

    // update 挂 ref 别名后，别名与显式 id 解析到同一既有角色 → 重复关联
    const dupViaRef = validateAiBatch(
      [
        { op: 'upsert_character', entityId: 'ch-1', ref: 'hero', fields: { bio: 'x' } },
        {
          op: 'upsert_document',
          fields: {
            title: 't',
            relatedIds: [
              { kind: 'character', id: 'hero' },
              { kind: 'character', id: 'ch-1' },
            ],
          },
        },
      ],
      settingsSnap(),
    )
    expect(dupViaRef.ok).toBe(false)
  })

  it('修改目标不存在 / 指向角色实体 → 整批拒绝', () => {
    const missing = validateAiBatch(
      [{ op: 'upsert_document', entityId: 'doc-404', fields: { body: 'x' } }],
      settingsSnap(),
    )
    expect(missing.ok).toBe(false)
    expect(missing.issues[0]?.message).toContain('文档')

    const cross = validateAiBatch(
      [{ op: 'upsert_document', entityId: 'ch-1', fields: { body: 'x' } }],
      settingsSnap(),
    )
    expect(cross.ok).toBe(false)
  })

  it('entityId 保留原始串做桶查找：带首尾空白的权威文档 id 不因 trim 查丢（PR #86 评审）', () => {
    // 加载归一化只重写纯空白记录键（reKeyBlankEntries），带首尾空白的键按
    // 「以记录键为准」保留为权威 id，get_settings_snapshot 原样下发
    const paddedSnap: AiGraphSnapshot = {
      nodes: [{ id: 'n1', type: 'scene', label: '场 01' }],
      edges: [],
      assets: new Map(),
      settings: {
        characters: [],
        locations: [],
        documents: [{ id: ' doc-1 ', title: '世界观' }],
      },
    }
    const v = validateAiBatch(
      [{ op: 'upsert_document', entityId: ' doc-1 ', fields: { body: '新全文' } }],
      paddedSnap,
    )
    expect(v.ok).toBe(true)
    expect(v.commands[0]).toMatchObject({ entityId: ' doc-1 ', fields: { body: '新全文' } })
  })

  it('首错即停：失败文档命令之后的命令不点名', () => {
    const v = validateAiBatch(
      [
        { op: 'upsert_document', entityId: 'doc-404', fields: { body: 'x' } },
        { op: 'upsert_document', entityId: 'also-404', fields: { body: 'y' } },
      ],
      settingsSnap(),
    )
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
  })
})
