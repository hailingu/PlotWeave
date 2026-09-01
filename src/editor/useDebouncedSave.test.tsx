// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSave } from './useDebouncedSave'
import { EMPTY_SETTINGS } from './settings'
import type { ProjectContent } from '../model/content'
import type { CanvasNode } from './nodes/types'

function mkDoc(name = '项目'): ProjectContent {
  return {
    name,
    nodes: [
      {
        id: 's1',
        type: 'scene',
        position: { x: 0, y: 0 },
        selected: true,
        data: { name: '场', sceneNo: 1 },
      } as unknown as CanvasNode,
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b', selected: true }],
    settings: EMPTY_SETTINGS,
    episodeTitles: { 1: '初遇' },
    viewport: { x: 12, y: -8, zoom: 1.5 },
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

  it('doc 变化后防抖落盘：会话文档原样透传（序列化在模型层完成）', () => {
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
    const saved = onSave.mock.calls[0][0] as ProjectContent
    expect(saved.name).toBe('改名')
    expect(saved.nodes[0].id).toBe('s1')
    expect(saved.episodeTitles).toEqual({ 1: '初遇' })
    // 视口随内容落盘捎带（transient：本身不触发保存）
    expect(saved.viewport).toEqual({ x: 12, y: -8, zoom: 1.5 })
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
    expect((onSave.mock.calls[0][0] as ProjectContent).name).toBe('v2')
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
    expect((onSave.mock.calls[0][0] as ProjectContent).name).toBe('未落定')
  })

  it('markDirty 标脏并携带最新文档：纯视口移动（无重渲染）也会落盘', () => {
    const onSave = vi.fn()
    const { result } = renderHook(() => useDebouncedSave(mkDoc(), onSave))
    // 模拟 EditorView.onMoveEnd：ref 更新后显式标脏，文档带最新视口
    const moved: ProjectContent = { ...mkDoc(), viewport: { x: 500, y: 300, zoom: 0.8 } }
    act(() => {
      result.current(moved)
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as ProjectContent).viewport).toEqual({ x: 500, y: 300, zoom: 0.8 })
  })

  it('纯选择/运行态变化不置脏（§9.4：update_node_ui 不落盘、不刷新 updatedAt）', () => {
    const onSave = vi.fn()
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    // React Flow 选中/拖拽过程帧只翻转会话态字段，节点数组随之换新引用
    const base = mkDoc()
    const sessionOnly: ProjectContent = {
      ...base,
      nodes: [
        {
          ...base.nodes[0],
          selected: false,
          dragging: true,
          measured: { width: 200, height: 80 },
        } as unknown as CanvasNode,
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', selected: false }],
    }
    act(() => {
      rerender({ doc: sessionOnly })
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onSave).not.toHaveBeenCalled()
    // 卸载同样不冲刷（纯选择不刷新 updatedAt，不改变首页排序）
    unmount()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('会话态变化之后的真实内容变化仍正常落盘', () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({
        doc: {
          ...mkDoc(),
          nodes: [{ ...mkDoc().nodes[0], selected: false } as unknown as CanvasNode],
        },
      })
    })
    act(() => {
      rerender({ doc: mkDoc('真改动') })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as ProjectContent).name).toBe('真改动')
  })

  it('仅集标题变化（renameEpisode 的改名/清空）也置脏落盘，不静默丢失', () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    // 大纲行内改名：name/nodes/edges/settings 全不变，只有 episodeTitles 变
    act(() => {
      rerender({ doc: { ...mkDoc(), episodeTitles: { 1: '重逢' } } })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as ProjectContent).episodeTitles).toEqual({ 1: '重逢' })
    // 清空该集命名（applyEpisodeTitle 删除键）同样触发
    act(() => {
      rerender({ doc: { ...mkDoc(), episodeTitles: {} } })
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect((onSave.mock.calls[1][0] as ProjectContent).episodeTitles).toEqual({})
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
