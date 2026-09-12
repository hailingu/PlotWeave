import { describe, expect, it } from 'vitest'
import { normalizeAiSession } from './session'

describe('normalizeAiSession', () => {
  it('保留可恢复的消息、预览卡状态与回执，并隔离损坏条目', () => {
    const result = normalizeAiSession({
      schemaVersion: 1,
      entries: [
        { id: 1, kind: 'msg', role: 'user', text: '给这场戏加冲突' },
        {
          id: 2,
          kind: 'msg',
          role: 'assistant',
          text: '可以先让两人的目标相反。',
          card: {
            v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
            status: 'executed',
          },
        },
        { id: 3, kind: 'note', text: '✓ 已执行 0 项改动，⌘Z 可整批撤销。' },
        { id: 'bad', kind: 'msg', role: 'assistant', text: '损坏' },
      ],
    })

    expect(result.session).toEqual({
      schemaVersion: 1,
      entries: [
        { id: 1, kind: 'msg', role: 'user', text: '给这场戏加冲突' },
        {
          id: 2,
          kind: 'msg',
          role: 'assistant',
          text: '可以先让两人的目标相反。',
          card: {
            v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
            status: 'executed',
          },
        },
        { id: 3, kind: 'note', text: '✓ 已执行 0 项改动，⌘Z 可整批撤销。' },
      ],
    })
    expect(result.repaired).toBe(true)
  })

  it('旧项目缺少会话文件时恢复为空历史', () => {
    expect(normalizeAiSession(undefined)).toEqual({
      session: { schemaVersion: 1, entries: [] },
      repaired: false,
    })
  })

  it('隔离无法安全重校验的待执行预览卡', () => {
    const result = normalizeAiSession({
      schemaVersion: 1,
      entries: [
        {
          id: 1,
          kind: 'msg',
          role: 'assistant',
          text: '这张卡已损坏。',
          card: {
            v: { ok: true, items: [], commands: [null], issues: [], hasDeletes: false },
            status: 'pending',
          },
        },
        { id: 2, kind: 'msg', role: 'user', text: '继续讨论人物动机。' },
      ],
    })

    expect(result).toEqual({
      session: {
        schemaVersion: 1,
        entries: [{ id: 2, kind: 'msg', role: 'user', text: '继续讨论人物动机。' }],
      },
      repaired: true,
    })
  })

})

describe('normalizeAiSession · 执行失败状态（issue 73）', () => {
  it.each([
    { status: 'pending', error: '目标已删除', expected: { executionError: '目标已删除' } },
    { status: 'pending', error: undefined, expected: {} },
    { status: 'pending', error: 1, expected: {} },
    { status: 'pending', error: ' ', expected: {} },
    { status: 'executed', error: '旧失败', expected: {} },
    { status: 'dismissed', error: '旧失败', expected: {} },
  ])('只为待执行卡保留非空失败诊断：$status / $error', ({ status, error, expected }) => {
    const v = { ok: true, items: [], commands: [], issues: [], hasDeletes: false }
    const result = normalizeAiSession({ schemaVersion: 1, entries: [{
      id: 1, kind: 'msg', role: 'assistant', text: '原批次',
      card: { v, status, executionError: error },
    }] })
    expect(result.session.entries[0].card).toEqual({ v, status, ...expected })
  })
})

describe('normalizeAiSession · 卡片运行时标注', () => {
  it('保留执行后批次计数供恢复对账，剥离运行时未确认标注', () => {
    const result = normalizeAiSession({
      schemaVersion: 1,
      entries: [
        {
          id: 1,
          kind: 'msg',
          role: 'assistant',
          text: '待对账的批次。',
          card: {
            v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
            status: 'pending',
            aiRevisionAfter: 5,
            uncommitted: true,
            historical: true,
          },
        },
      ],
    })

    expect(result.session.entries[0].card).toEqual({
      v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
      status: 'pending',
      aiRevisionAfter: 5,
    })
  })
})

describe('normalizeAiSession · 设定文档命令（issue 56）', () => {
  const docCard = (commands: unknown[]) => ({
    v: { ok: true, items: [], commands, issues: [], hasDeletes: false },
    status: 'pending' as const,
  })

  it('带 upsert_document 的待执行卡完整恢复，载荷不被归一化丢弃', () => {
    const commands = [
      { op: 'upsert_document', fields: { title: '小传', body: '正文', relatedIds: [{ kind: 'character', id: 'ch-1' }] } },
      { op: 'upsert_document', entityId: 'doc-1', fields: { body: '改写' } },
    ]
    const result = normalizeAiSession({
      schemaVersion: 1,
      entries: [
        { id: 1, kind: 'msg', role: 'assistant', text: '文档批次', card: docCard(commands) },
      ],
    })
    expect(result.repaired).toBe(false)
    expect(result.session.entries[0].card?.v.commands).toEqual(commands)
  })

  it('畸形文档命令（fields 非对象）仍按损坏隔离', () => {
    const result = normalizeAiSession({
      schemaVersion: 1,
      entries: [
        {
          id: 1,
          kind: 'msg',
          role: 'assistant',
          text: '坏卡',
          card: docCard([{ op: 'upsert_document', fields: 'nope' }]),
        },
      ],
    })
    expect(result.repaired).toBe(true)
    expect(result.session.entries).toHaveLength(0)
  })
})
