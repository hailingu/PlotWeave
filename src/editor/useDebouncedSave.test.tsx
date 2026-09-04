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

  it('className 运行态样式变化不置脏（集聚焦 pw-node-dim 等纯 UI 变化不刷新 updatedAt）', () => {
    const onSave = vi.fn()
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    // 运行态样式类注入/剥离（displayNodes 投影、fromStoryEdge 派生重建等
    // 带来的 className 差异）不是持久化内容——签名须与序列化同口径剥离
    const base = mkDoc()
    const styleOnly: ProjectContent = {
      ...base,
      nodes: [{ ...base.nodes[0], className: 'pw-node-dim' } as unknown as CanvasNode],
      edges: [{ id: 'e1', source: 'a', target: 'b', className: 'pw-edge-sequence' }],
    }
    act(() => {
      rerender({ doc: styleOnly })
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onSave).not.toHaveBeenCalled()
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

  it('资产索引变化（§7.3 会话内导入新增条目）也置脏落盘', async () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    const withAsset: ProjectContent = {
      ...mkDoc(),
      assets: {
        byId: {
          'pa-1': {
            id: 'pa-1',
            relPath: 'assets/pa-1.png',
            mime: 'image/png',
            source: 'upload',
            createdAt: '2026-09-04T08:00:00.000Z',
          },
        },
      },
    }
    act(() => {
      rerender({ doc: withAsset })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as ProjectContent).assets?.byId['pa-1']).toBeDefined()
  })

  it('仅集标题变化（renameEpisode 的改名/清空）也置脏落盘，不静默丢失', async () => {
    const onSave = vi.fn()
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave), {
      initialProps: { doc: mkDoc() },
    })
    // 大纲行内改名：name/nodes/edges/settings 全不变，只有 episodeTitles 变。
    // 异步 advance：串行化下在途保存的完成续体需微任务冲刷后才释放在途标记
    act(() => {
      rerender({ doc: { ...mkDoc(), episodeTitles: { 1: '重逢' } } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect((onSave.mock.calls[0][0] as ProjectContent).episodeTitles).toEqual({ 1: '重逢' })
    // 清空该集命名（applyEpisodeTitle 删除键）同样触发
    act(() => {
      rerender({ doc: { ...mkDoc(), episodeTitles: {} } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
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

describe('useDebouncedSave（保存失败上浮与防抖重试）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('保存失败：重新置脏、防抖自动重试，失败经 onResult 上报', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error('磁盘已满'))
      .mockResolvedValue(undefined)
    const onResult = vi.fn()
    const { rerender } = renderHook(
      ({ doc }) => useDebouncedSave(doc, onSave, 600, onResult),
      { initialProps: { doc: mkDoc() } },
    )
    act(() => {
      rerender({ doc: mkDoc('改而未落') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ message: '磁盘已满' }))
    // 失败重新置脏 → 防抖到点自动重试
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledWith(null)
  })

  it('失败后未到重试时间卸载：冲刷仍发起保存，失败不产生未处理拒绝', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('只读'))
    const onResult = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ doc }) => useDebouncedSave(doc, onSave, 600, onResult),
      { initialProps: { doc: mkDoc() } },
    )
    act(() => {
      rerender({ doc: mkDoc('卸载前') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    unmount()
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ message: '只读' }))
  })
})

describe('useDebouncedSave（卸载后终止失败重试）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('卸载后才失败的保存不得复活重试循环（不留后台循环覆盖新会话编辑）', async () => {
    let rejectSave: ((e: Error) => void) | null = null
    const onSave = vi.fn(
      () => new Promise<void>((_, rej) => { rejectSave = rej }),
    )
    const onResult = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ doc }) => useDebouncedSave(doc, onSave, 600, onResult),
      { initialProps: { doc: mkDoc() } },
    )
    act(() => {
      rerender({ doc: mkDoc('改') })
    })
    // 防抖到点：保存挂起中（Promise 未决），随后立即卸载
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => {
      rejectSave?.(new Error('卸载后才失败'))
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})

describe('useDebouncedSave（保存串行化：在途保存期间的新编辑合并进后续保存）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('保存 A 在途时新编辑 B 不得并发起存；A 完成后接力保存最新文档', async () => {
    const savedNames: string[] = []
    let releaseA: (() => void) | null = null
    const onSave = vi.fn(
      (doc: ProjectContent) =>
        new Promise<void>((resolve) => {
          if (releaseA === null) {
            releaseA = () => {
              savedNames.push(doc.name)
              resolve()
            }
            return
          }
          savedNames.push(doc.name)
          resolve()
        }),
    )
    const { rerender } = renderHook(({ doc }) => useDebouncedSave(doc, onSave, 600), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({ doc: mkDoc('A') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1) // A 在途（挂起）
    // A 在途时编辑 B → 防抖到点：不得并发发起第二次保存
    act(() => {
      rerender({ doc: mkDoc('B') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    // A 完成后接力：用最新文档（B）补一次保存
    await act(async () => {
      releaseA?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(savedNames).toEqual(['A', 'B'])
  })
})

describe('useDebouncedSave（在途保存期间卸载：待冲刷编辑不丢）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('保存 A 在途时卸载：新编辑 B 由在途完成后的最后一次合并冲刷落盘', async () => {
    const names: string[] = []
    let releaseA: (() => void) | null = null
    const onSave = vi.fn(
      (doc: ProjectContent) =>
        new Promise<void>((resolve) => {
          if (releaseA === null) {
            releaseA = () => {
              names.push(doc.name)
              resolve()
            }
            return
          }
          names.push(doc.name)
          resolve()
        }),
    )
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave, 600), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({ doc: mkDoc('A') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1) // A 在途
    act(() => {
      rerender({ doc: mkDoc('B') })
    }) // B 置脏（防抖计时器未到）
    unmount() // 卸载冲刷被在途挡回：B 不得丢
    await act(async () => {
      releaseA?.()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(names).toEqual(['A', 'B'])
  })

  it('A 在途、B 置脏后卸载，A 失败：最新文档 B 仍补交一次（项目级重试只持有 A，否则 B 静默丢失）', async () => {
    const names: string[] = []
    let rejectA: ((e: Error) => void) | null = null
    const onSave = vi.fn(
      (doc: ProjectContent) =>
        new Promise<void>((resolve, rej) => {
          if (rejectA === null) {
            rejectA = rej // 首次保存（A）挂起，稍后失败
            return
          }
          names.push(doc.name)
          resolve()
        }),
    )
    const { rerender, unmount } = renderHook(({ doc }) => useDebouncedSave(doc, onSave, 600), {
      initialProps: { doc: mkDoc() },
    })
    act(() => {
      rerender({ doc: mkDoc('A') })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(onSave).toHaveBeenCalledTimes(1) // A 在途
    act(() => {
      rerender({ doc: mkDoc('B') })
    }) // B 置脏（防抖计时器未到）
    unmount() // 卸载冲刷被在途挡回
    await act(async () => {
      rejectA?.(new Error('磁盘满'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })
    // 红：catch 见 unmounted 直接 return，B 从未交付 onSave，既没落盘也无重试登记
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(names).toEqual(['B'])
  })
})
