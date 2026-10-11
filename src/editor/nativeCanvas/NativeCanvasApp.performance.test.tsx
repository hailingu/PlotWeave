// @vitest-environment happy-dom
/** 演示入口也经真实 React Flow 手势采样，和生产入口使用相同诊断控件。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeCanvasApp } from './NativeCanvasApp'

/** 无布局 DOM 的 ResizeObserver 边界，不替换生产画布或诊断实现。 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('开启后从演示画布拖动生成脱敏性能报告', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  const { container } = render(<NativeCanvasApp />)
  fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
  fireEvent.click(screen.getByRole('button', { name: '绘制特效：标准' }))
  expect(
    container
      .querySelector('.canvas-root')
      ?.getAttribute('data-canvas-effects'),
  ).toBe('reduced-effects')
  const node = container.querySelector<HTMLElement>('.react-flow__node')!
  fireEvent.mouseDown(node, {
    clientX: 10,
    clientY: 10,
    button: 0,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 12,
    clientY: 12,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 49,
    clientY: 49,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseUp(window, {
    clientX: 49,
    clientY: 49,
    button: 0,
    view: window,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  const report = JSON.parse(screen.getByLabelText('拖动性能 JSON').textContent!)
  expect(report).toMatchObject({
    canvas: 'demo',
    renderingMode: 'reduced-effects',
    draggedNodeCount: 1,
    outcome: 'completed',
  })
  expect(report.nodeCount).toBeGreaterThan(1)
  expect(report.edgeCount).toBeGreaterThan(1)
  expect(report.changes.position).toBeGreaterThan(0)
  expect(report.input?.events).toBeGreaterThan(0)
  expect(report.dom?.updates).toBeGreaterThan(0)
  expect(report.version).toBe(5)
  expect(report.startup?.firstPositionMs).toBeGreaterThanOrEqual(0)
  expect(screen.getByText(/诊断初始化/)).toBeTruthy()
  expect(JSON.stringify(report)).not.toContain('demo-beat')
})
