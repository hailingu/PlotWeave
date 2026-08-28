// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSave, type EditorDocument } from './useDebouncedSave'
import { EMPTY_SETTINGS } from './settings'
import type { CanvasNode } from './nodes/types'

function mkDoc(name = '项目'): EditorDocument {
  return {
    name,
    nodes: [
      {
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        selected: true,
        className: 'pw-node-dim',
        data: { name: '场', sceneNo: 1 },
      } as unknown as CanvasNode,
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b', selected: true }],
    settings: EMPTY_SETTINGS,
    episodeTitles: { 1: '初遇' },
  }
}

describe('useDebouncedSave（防抖落盘 + 脏态卸载冲刷）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('首次渲染不保存；无变化的卸载也不冲刷', () => {
    const onSave = vi.fn()
    const { unmount } = renderHook(() => useDebouncedSave(mkDoc(), onSave))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    unmount()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('doc 变化后防抖落盘：剥离运行态字段（selected/className）', () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    // rerender 与前进分开 act：passive effect 在 act 退出时才冲刷，
    // 同一块内先 advance 会错过尚未调度的计时器。
    act(() => {
      rerender({ doc: mkDoc('改名') })
    })
    act(() => {
      vi.advanceTimersByTime(599)
    })
    expect(onSave).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as EditorDocument
    expect(saved.name).toBe('改名')
    expect(saved.nodes[0]).toEqual({
      id: 's1',
      type: 'scene',
      position: { x: 0, y: 0 },
      data: { name: '场', sceneNo: 1 },
    })
    expect(saved.edges[0]).toEqual({ id: 'e1', source: 'a', target: 'b' })
    expect(saved.episodeTitles).toEqual({ 1: '初遇' })
  })

  it('窗口内连续变化只落最后一次（防抖重置）', () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc('v0') },
    })
    act(() => {
      rerender({ doc: mkDoc('v1') })
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    act(() => {
      rerender({ doc: mkDoc('v2') })
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(onSave).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as EditorDocument).name).toBe('v2')
  })

  it('计时器未到时卸载：脏数据立即冲刷一次', () => {
    const onSave = vi.fn()
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({ doc: mkDoc('未落定') })
    })
    unmount()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as EditorDocument).name).toBe('未落定')
  })

  it('落盘后再卸载不重复冲刷（脏标记已清）', () => {
    const onSave = vi.fn()
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({ doc: mkDoc('已落定') })
      vi.advanceTimersByTime(600)
    })
    unmount()
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
