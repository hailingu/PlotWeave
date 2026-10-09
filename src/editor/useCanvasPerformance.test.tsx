// @vitest-environment happy-dom
/** 真实 React 状态和浏览器生命周期事件验证开关、中断与恢复。 */
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useNodesState, type OnNodeDrag } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasPerformance } from './useCanvasPerformance'
import type { CanvasNode } from './nodes/types'
import { EditorPerformanceBoundary } from './EditorPerformanceBoundary'

const NODE: CanvasNode = {
  id: 'a',
  type: 'beat',
  position: { x: 0, y: 0 },
  data: { name: '节拍', tone: '' },
}
let pendingFrames: Map<number, FrameRequestCallback>

beforeEach(() => {
  pendingFrames = new Map()
  let nextId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) =>
    pendingFrames.delete(id),
  )
  vi.stubGlobal('PerformanceObserver', undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** useNodesState 是实际生产写通道，坐标结果用来检查诊断没有改写变更。 */
function mount(onNodeDrag?: OnNodeDrag<CanvasNode>) {
  return renderHook(
    () => {
      const [nodes, , onNodesChange] = useNodesState<CanvasNode>([NODE])
      return {
        nodes,
        original: onNodesChange,
        perf: useCanvasPerformance({
          canvas: 'editor',
          nodeCount: nodes.length,
          edgeCount: 0,
          onNodesChange,
          ...(onNodeDrag && { onNodeDrag }),
        }),
      }
    },
    { wrapper: Boundary },
  )
}

/** StrictMode 会重新注册监听；真实整体 Profiler 覆盖 hook 消费者的状态提交。 */
function Boundary({ children }: { readonly children: ReactNode }) {
  return (
    <StrictMode>
      <EditorPerformanceBoundary>{children}</EditorPerformanceBoundary>
    </StrictMode>
  )
}

/** hook 边界传入与框架一致的拖动参数，真实手势接线另由集成测试覆盖。 */
function start(perf: ReturnType<typeof useCanvasPerformance>) {
  perf.onNodeDragStart?.(new MouseEvent('mousedown'), NODE, [NODE])
}

describe('画布诊断生命周期', () => {
  it('位置更新保持各回调身份；关闭时原 drag 回调直通，开启时原异常仍传播', () => {
    const failure = new Error('业务失败')
    const original = () => {
      throw failure
    }
    const h = mount(original)
    expect(h.result.current.perf.onNodeDrag).toBe(original)
    act(() => h.result.current.perf.toggle())
    const callbacks = h.result.current.perf
    act(() => start(callbacks))
    act(() =>
      callbacks.onNodesChange([
        { id: 'a', type: 'position', position: { x: 10, y: 0 } },
      ]),
    )
    const current = h.result.current.perf
    expect(current.onNodeDragStart).toBe(callbacks.onNodeDragStart)
    expect(current.onNodeDragStop).toBe(callbacks.onNodeDragStop)
    expect(current.onNodeDrag).toBe(callbacks.onNodeDrag)
    act(() =>
      expect(() =>
        current.onNodeDrag?.(new MouseEvent('mousemove'), NODE, [NODE]),
      ).toThrow(failure),
    )
    expect(h.result.current.perf.report).toMatchObject({
      outcome: 'interrupted',
      input: { events: 1 },
    })
    expect(pendingFrames.size).toBe(0)
    expect(h.result.current.nodes[0]?.position).toEqual({ x: 10, y: 0 })
  })

  it.each([{ parentId: 'parent' }, { origin: [0.5, 0.5] as [number, number] }])(
    '不支持的节点坐标 %j 明确降级 DOM，仍输出输入数据',
    (attributes) => {
      const root = document.createElement('div')
      const element = document.createElement('div')
      element.className = 'react-flow__node'
      element.dataset.id = NODE.id
      element.style.transform = 'translate(0px,0px)'
      root.append(element)
      document.body.append(root)
      const node = { ...NODE, ...attributes }
      const h = renderHook(() =>
        useCanvasPerformance({
          canvas: 'editor',
          nodeCount: 1,
          edgeCount: 0,
          onNodesChange: () => undefined,
          canvasRef: { current: root },
        }),
      )
      act(() => h.result.current.toggle())
      act(() =>
        h.result.current.onNodeDragStart?.(new MouseEvent('mousedown'), node, [
          node,
        ]),
      )
      act(() =>
        h.result.current.onNodeDrag?.(new MouseEvent('mousemove'), node, [
          node,
        ]),
      )
      act(() =>
        h.result.current.onNodeDragStop?.(new MouseEvent('mouseup'), node, [
          node,
        ]),
      )
      expect(h.result.current.report).toMatchObject({
        input: { events: 1 },
        dom: null,
      })
      h.unmount()
      root.remove()
    },
  )

  it('活动段切换特效先以旧模式结束，关闭恢复标准且不能在关闭时启用', () => {
    const h = mount()
    act(() => h.result.current.perf.toggleEffects())
    expect(h.result.current.perf.renderingMode).toBe('standard')
    act(() => h.result.current.perf.toggle())
    act(() => start(h.result.current.perf))
    act(() => h.result.current.perf.toggleEffects())
    expect(h.result.current.perf.report).toMatchObject({
      outcome: 'interrupted',
      renderingMode: 'standard',
    })
    expect(h.result.current.perf.renderingMode).toBe('reduced-effects')
    expect(pendingFrames.size).toBe(0)
    act(() => start(h.result.current.perf))
    act(() => h.result.current.perf.toggle())
    expect(h.result.current.perf.report).toMatchObject({
      outcome: 'disabled',
      renderingMode: 'reduced-effects',
    })
    expect(h.result.current.perf.renderingMode).toBe('standard')
    act(() => h.result.current.perf.toggle())
    act(() => start(h.result.current.perf))
    act(() =>
      h.result.current.perf.onNodeDragStop?.(new MouseEvent('mouseup'), NODE, [
        NODE,
      ]),
    )
    expect(h.result.current.perf.report).toMatchObject({
      outcome: 'completed',
      renderingMode: 'standard',
    })
  })

  it('整体渲染只计活动段，StrictMode 与重新挂载不会混入旧报告', () => {
    const h = mount()
    act(() => h.result.current.perf.toggle())
    act(() => start(h.result.current.perf))
    act(() =>
      h.result.current.perf.onNodesChange([
        { id: 'a', type: 'position', position: { x: 20, y: 30 } },
      ]),
    )
    expect(h.result.current.perf.report).toBeNull()
    act(() =>
      h.result.current.perf.onNodeDragStop?.(new MouseEvent('mouseup'), NODE, [
        NODE,
      ]),
    )
    const first = h.result.current.perf.report
    expect(first?.reactEditor?.samples).toBe(1)
    expect(first?.react).toBeNull()
    const encoded = JSON.stringify(first)
    act(() =>
      h.result.current.perf.onNodesChange([
        { id: 'a', type: 'position', position: { x: 30, y: 40 } },
      ]),
    )
    expect(JSON.stringify(h.result.current.perf.report)).toBe(encoded)
    h.unmount()
    const next = mount()
    expect(next.result.current.perf.report).toBeNull()
    act(() => next.result.current.perf.toggle())
    act(() => start(next.result.current.perf))
    act(() =>
      next.result.current.perf.onNodeDragStop?.(
        new MouseEvent('mouseup'),
        NODE,
        [NODE],
      ),
    )
    expect(next.result.current.perf.report?.reactEditor).toBeNull()
  })

  it('默认关闭保持原回调引用，真实状态更新不产生报告或帧任务', () => {
    const h = mount()
    expect(h.result.current.perf.onNodesChange).toBe(h.result.current.original)
    act(() => {
      start(h.result.current.perf)
      h.result.current.perf.onNodesChange([
        { id: 'a', type: 'position', position: { x: 20, y: 30 } },
      ])
    })
    expect(h.result.current.nodes[0]?.position).toEqual({ x: 20, y: 30 })
    expect(h.result.current.perf.report).toBeNull()
    expect(pendingFrames.size).toBe(0)
  })

  it('拖动中关闭结束采样并释放任务，再次开启使用全新段', () => {
    const h = mount()
    act(() => h.result.current.perf.toggle())
    act(() => start(h.result.current.perf))
    expect(pendingFrames.size).toBe(1)
    act(() => h.result.current.perf.toggle())
    expect(h.result.current.perf.enabled).toBe(false)
    expect(h.result.current.perf.report?.outcome).toBe('disabled')
    expect(pendingFrames.size).toBe(0)
    act(() => h.result.current.perf.toggle())
    act(() => start(h.result.current.perf))
    act(() =>
      h.result.current.perf.onNodeDragStop?.(new MouseEvent('mouseup'), NODE, [
        NODE,
      ]),
    )
    expect(h.result.current.perf.report).toMatchObject({
      outcome: 'completed',
      handler: { samples: 0 },
    })
  })

  it.each(['blur', 'visibilitychange'])(
    '%s 中断后仍可继续编辑并开始新段',
    (event) => {
      const h = mount()
      act(() => h.result.current.perf.toggle())
      act(() => start(h.result.current.perf))
      if (event === 'visibilitychange')
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      act(() =>
        (event === 'blur' ? window : document).dispatchEvent(new Event(event)),
      )
      expect(h.result.current.perf.report?.outcome).toBe('interrupted')
      expect(pendingFrames.size).toBe(0)
      act(() =>
        h.result.current.perf.onNodesChange([
          { id: 'a', type: 'position', position: { x: 30, y: 40 } },
        ]),
      )
      expect(h.result.current.nodes[0]?.position).toEqual({ x: 30, y: 40 })
      act(() => start(h.result.current.perf))
      expect(pendingFrames.size).toBe(1)
      h.unmount()
      expect(pendingFrames.size).toBe(0)
    },
  )
})
