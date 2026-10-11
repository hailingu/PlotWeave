// @vitest-environment happy-dom
/** 确定时钟分离首次拖动启动阶段，业务回调、失败传播与段间隔离保持。 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OnNodeDrag } from '@xyflow/react'
import { useCanvasPerformance } from './useCanvasPerformance'
import type { CanvasNode } from './nodes/types'

/** 简单真实节点用于穿过原拖动回调；数值报告不得保留这些标识或内容。 */
const NODE: CanvasNode = {
  id: 'private-startup-node',
  type: 'beat',
  position: { x: 0, y: 0 },
  data: { name: 'private-startup-content', tone: '' },
}
let time = 0

beforeEach(() => {
  time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('PerformanceObserver', undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 源事件的创建时间独立于收到回调的时钟；支持验证非法时间降级。 */
function event(at: number): MouseEvent {
  const value = new MouseEvent('mousemove')
  Object.defineProperty(value, 'timeStamp', { value: at })
  return value
}

/** 实际 hook 与 DOM 能力只由宿主注入，不替换 recorder 或业务动作。 */
function mount(start: OnNodeDrag<CanvasNode>) {
  const root = document.createElement('div')
  document.body.append(root)
  const h = renderHook(() =>
    useCanvasPerformance({
      canvas: 'editor',
      nodeCount: 1,
      edgeCount: 0,
      onNodesChange: () => undefined,
      onNodeDragStart: start,
      canvasRef: { current: root },
    }),
  )
  return { ...h, root }
}

/** 框架参数保持同一真实节点；业务状态仍由原 start／stop 通道处理。 */
function stop(perf: ReturnType<typeof useCanvasPerformance>): void {
  perf.onNodeDragStop?.(event(time), NODE, [NODE])
}

it('分离事件年龄、诊断初始化、业务 start 和首位置，后续位置不重写', () => {
  const original = vi.fn(() => {
    time = 42
  })
  const h = mount(original)
  act(() => h.result.current.toggle())
  const lookup = vi.spyOn(h.root, 'querySelectorAll').mockImplementation(() => {
    time = 35
    return document.querySelectorAll('.missing-startup-node')
  })
  time = 20
  const source = event(8)
  act(() => h.result.current.onNodeDragStart?.(source, NODE, [NODE]))
  expect(original).toHaveBeenCalledWith(source, NODE, [NODE])
  time = 55
  act(() => h.result.current.onNodeDrag?.(event(54), NODE, [NODE]))
  time = 58
  act(() => h.result.current.onNodeDrag?.(event(57), NODE, [NODE]))
  time = 60
  act(() => stop(h.result.current))
  expect(h.result.current.report).toMatchObject({
    version: 5,
    startup: {
      inputDelayMs: 12,
      diagnosticsMs: 15,
      handlerMs: 7,
      firstPositionMs: 35,
    },
  })
  expect(JSON.stringify(h.result.current.report)).not.toContain('private-')
  const first = h.result.current.report
  lookup.mockRestore()
  original.mockImplementation(() => {
    time += 7
  })
  time = 70
  act(() => h.result.current.onNodeDragStart?.(event(69), NODE, [NODE]))
  act(() => stop(h.result.current))
  expect(h.result.current.report).toMatchObject({
    startup: {
      inputDelayMs: 1,
      diagnosticsMs: 0,
      handlerMs: 7,
      firstPositionMs: null,
    },
  })
  expect(first?.startup?.firstPositionMs).toBe(35)
})

it.each([-1, 21])('事件时间 %s 不在有效区间时，启动年龄明确为 null', (at) => {
  const h = mount(() => undefined)
  act(() => h.result.current.toggle())
  time = 20
  act(() => h.result.current.onNodeDragStart?.(event(at), NODE, [NODE]))
  act(() => stop(h.result.current))
  expect(h.result.current.report).toMatchObject({
    startup: { inputDelayMs: null, firstPositionMs: null },
  })
})

it('关闭时保留原 start 身份，未调用测量入口', () => {
  const original = vi.fn()
  const h = mount(original)
  expect(h.result.current.onNodeDragStart).toBe(original)
  act(() => h.result.current.onNodeDragStart?.(event(0), NODE, [NODE]))
  expect(h.result.current.report).toBeNull()
  expect(requestAnimationFrame).not.toHaveBeenCalled()
  act(() => h.result.current.toggle())
  act(() => h.result.current.toggle())
  expect(h.result.current.onNodeDragStart).toBe(original)
})

it.each(['blur', 'visibilitychange', 'disable', 'unmount'])(
  '无位置时 %s 释放采样，不能发布虚构的首位置',
  (transition) => {
    const h = mount(() => undefined)
    act(() => h.result.current.toggle())
    time = 20
    act(() => h.result.current.onNodeDragStart?.(event(19), NODE, [NODE]))
    if (transition === 'visibilitychange')
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => {
      if (transition === 'unmount') h.unmount()
      else if (transition === 'disable') h.result.current.toggle()
      else
        (transition === 'blur' ? window : document).dispatchEvent(
          new Event(transition),
        )
    })
    expect(cancelAnimationFrame).toHaveBeenCalled()
    if (transition === 'unmount') expect(console.info).not.toHaveBeenCalled()
    else
      expect(h.result.current.report).toMatchObject({
        outcome: transition === 'disable' ? 'disabled' : 'interrupted',
        startup: { inputDelayMs: 1, firstPositionMs: null },
      })
  },
)

it('业务 start 失败仍记录其耗时并传播原异常，下一段清空首位置', () => {
  const failure = new Error('private-startup-error')
  let fail = true
  const h = mount(() => {
    time += 4
    if (fail) throw failure
  })
  act(() => h.result.current.toggle())
  time = 10
  act(() =>
    expect(() =>
      h.result.current.onNodeDragStart?.(event(9), NODE, [NODE]),
    ).toThrow(failure),
  )
  const failed = h.result.current.report
  expect(failed).toMatchObject({
    outcome: 'interrupted',
    startup: { inputDelayMs: 1, handlerMs: 4, firstPositionMs: null },
  })
  expect(cancelAnimationFrame).toHaveBeenCalled()
  fail = false
  time = 20
  act(() => h.result.current.onNodeDragStart?.(event(Number.NaN), NODE, [NODE]))
  act(() => stop(h.result.current))
  expect(h.result.current.report).toMatchObject({
    outcome: 'completed',
    startup: { inputDelayMs: null, handlerMs: 4, firstPositionMs: null },
  })
  expect(failed?.outcome).toBe('interrupted')
  expect(JSON.stringify(failed)).not.toContain(failure.message)
})
