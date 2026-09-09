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

  it('保留执行前画布签名供恢复对账，剥离运行时未确认标注', () => {
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
            preSignature: 'sig-before',
            uncommitted: true,
            historical: true,
          },
        },
      ],
    })

    expect(result.session.entries[0].card).toEqual({
      v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
      status: 'pending',
      preSignature: 'sig-before',
    })
  })
})
