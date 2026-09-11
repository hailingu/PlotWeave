// @vitest-environment happy-dom
/**
 * 面板会话持久化 hook（issue #47）：编辑即保存、失败上浮与本地清除、
 * 挂载重试门槛（读取失败的空回退不可重试），以及项目级错误的双向同步
 * ——转空（后台重试补写成功的通知清除）也必须撤下横幅。
 * 落盘映射的条数上限（issue #64）：会话文件体积随历史有界。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { persistedEntries, useAiSessionPersistence } from './useAiSessionPersistence'
import type { AiSession, ThreadEntry } from './session'

const entry = (id: number, text: string): ThreadEntry => ({ id, kind: 'note', text })
const thread = [entry(1, '第一句')]
const saveFn = () => vi.fn<(session: AiSession) => Promise<void>>(async () => undefined)

describe('useAiSessionPersistence', () => {
  it('条目变更即经 onSaveSession 落盘（落盘映射后的会话）', async () => {
    const onSave = saveFn()
    const { rerender } = renderHook(
      ({ t }: { t: ThreadEntry[] }) => useAiSessionPersistence(t, null, onSave, undefined),
      { initialProps: { t: thread } },
    )
    // 挂载无错误不落盘（磁盘会话即当前内容）；条目变更后才保存
    expect(onSave).not.toHaveBeenCalled()
    const changed = [...thread, entry(2, '第二句')]
    rerender({ t: changed })
    await vi.waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    expect(onSave.mock.calls[0][0]).toEqual({ schemaVersion: 1, entries: changed })
  })

  it('保存失败上浮错误；后续变更保存成功即清除', async () => {
    const onSave = vi
      .fn<(session: AiSession) => Promise<void>>()
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValueOnce(undefined)
    const { result, rerender } = renderHook(
      ({ t }: { t: ThreadEntry[] }) => useAiSessionPersistence(t, null, onSave, undefined),
      { initialProps: { t: thread } },
    )
    rerender({ t: [...thread, entry(2, '第二句')] })
    // 等首帧保存失败落定
    await vi.waitFor(() => { expect(result.current).toBe('Error: 磁盘已满') })
    rerender({ t: [...thread, entry(2, '第二句'), entry(3, '第三句')] })
    await vi.waitFor(() => { expect(result.current).toBeNull() })
  })

  it('带错误挂载且不可重试：首帧不落盘（空回退不得覆盖原文件）', () => {
    const onSave = saveFn()
    const { result } = renderHook(() =>
      useAiSessionPersistence(thread, '读取失败', onSave, false),
    )
    expect(onSave).not.toHaveBeenCalled()
    expect(result.current).toBe('读取失败')
  })

  it('项目级错误转空（后台重试成功）随之清除面板错误', () => {
    const { result, rerender } = renderHook(
      ({ err }: { err: string | null }) =>
        useAiSessionPersistence(thread, err, undefined, false),
      { initialProps: { err: '磁盘已满' as string | null } },
    )
    expect(result.current).toBe('磁盘已满')
    rerender({ err: null })
    expect(result.current).toBeNull()
  })

  it('条目超过落盘上限时，保存会话只携带最新 200 条（issue #64）', async () => {
    const onSave = saveFn()
    const long = Array.from({ length: 202 }, (_, i) => entry(i + 1, `第${i + 1}句`))
    const { rerender } = renderHook(
      ({ t }: { t: ThreadEntry[] }) => useAiSessionPersistence(t, null, onSave, undefined),
      { initialProps: { t: thread } },
    )
    rerender({ t: long })
    await vi.waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const saved = onSave.mock.calls[0][0]
    expect(saved.entries).toHaveLength(200)
    expect(saved.entries[0]).toMatchObject({ id: 3, text: '第3句' })
    expect(saved.entries[199]).toMatchObject({ id: 202, text: '第202句' })
  })
})

describe('persistedEntries 条数上限（issue #64）', () => {
  const longThread = (count: number): ThreadEntry[] =>
    Array.from({ length: count }, (_, i) => entry(i + 1, `第${i + 1}句`))

  it('超过上限只落盘最新 200 条，顺序保留', () => {
    const persisted = persistedEntries(longThread(202))
    expect(persisted).toHaveLength(200)
    expect(persisted[0]).toMatchObject({ id: 3, text: '第3句' })
    expect(persisted[199]).toMatchObject({ id: 202, text: '第202句' })
  })

  it('恰在上限或以下不裁剪', () => {
    expect(persistedEntries(longThread(200))).toHaveLength(200)
    expect(persistedEntries(longThread(3)).map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('上限裁剪不影响未确认执行卡的降级映射：尾部卡保留对账计数，回执剔除', () => {
    const thread = [
      ...longThread(200),
      {
        id: 201,
        kind: 'msg' as const,
        role: 'assistant' as const,
        text: '带卡回复',
        card: {
          v: { ok: true, items: [], commands: [], issues: [], hasDeletes: false },
          status: 'executed' as const,
          uncommitted: true as const,
          aiRevisionAfter: 7,
        },
      },
      { id: 202, kind: 'note' as const, text: '✓ 已执行 0 项', cardReceiptFor: 201 },
    ]
    const persisted = persistedEntries(thread)
    expect(persisted).toHaveLength(200)
    // 回执剔除后剩 201 条，裁剪自最旧一条起：id 2..201
    expect(persisted[0]).toMatchObject({ id: 2 })
    const cardEntry = persisted[199]
    expect(cardEntry).toMatchObject({ id: 201 })
    expect(cardEntry.card).toMatchObject({ status: 'pending', aiRevisionAfter: 7 })
    expect(cardEntry.card).not.toHaveProperty('uncommitted')
    expect(persisted.every((e) => e.cardReceiptFor === undefined)).toBe(true)
  })
})
