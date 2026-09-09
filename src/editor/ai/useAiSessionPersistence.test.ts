// @vitest-environment happy-dom
/**
 * 面板会话持久化 hook（issue #47）：编辑即保存、失败上浮与本地清除、
 * 挂载重试门槛（读取失败的空回退不可重试），以及项目级错误的双向同步
 * ——转空（后台重试补写成功的通知清除）也必须撤下横幅。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAiSessionPersistence } from './useAiSessionPersistence'
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
})
