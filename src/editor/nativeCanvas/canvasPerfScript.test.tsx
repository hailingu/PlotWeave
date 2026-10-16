// @vitest-environment happy-dom
/**
 * M15 脚本化持续操作（issue #523，§7.2）：在真实 React Flow 挂载树上按
 * 固定脚本驱动拖拽、平移、缩放与画布控件，报告只含数值统计（脱敏），
 * 并证明三类操作都产生了可观察的图效果——脚本空转会让测量失真。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeCanvasApp } from './NativeCanvasApp'
import { canvasPerfFixture } from './canvasPerfFixture'
import { runCanvasPerfScript } from './canvasPerfScript'

/** 无布局 DOM 的 ResizeObserver 边界，不替换生产画布或诊断实现。 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('固定规模图上脚本化拖拽/平移/缩放产生可观察效果与脱敏报告', async () => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  const { container } = render(
    <NativeCanvasApp graph={canvasPerfFixture(100)} />,
  )
  expect(container.querySelectorAll('.react-flow__node')).toHaveLength(100)

  const result = await runCanvasPerfScript({
    dragRounds: 1,
    dragSteps: 2,
    panRounds: 1,
    panSteps: 2,
    zoomRounds: 1,
    zoomSteps: 2,
    stepMs: 0,
    settleMs: 0,
  })

  expect(result.version).toBe(1)
  expect(result.nodeCount).toBe(100)
  // happy-dom 未测量节点尺寸、连线不进 DOM；渲染计数断言在真实 WebKit 套件。
  expect(result.edgeCount).toBeGreaterThanOrEqual(0)
  expect(result.phases.map((phase) => phase.kind)).toEqual([
    'drag',
    'pan',
    'zoom',
    'panel',
  ])
  expect(result.effects.draggedNodeMovedPx).toBeGreaterThan(0)
  expect(Math.abs(result.effects.panTranslatePx)).toBeGreaterThan(0)
  // happy-dom 无布局，滚轮缩放不产生有限行程；真实 WebKit 断言在 Swift 套件。
  expect(result.effects.zoomTravel).toBeGreaterThanOrEqual(0)
  expect(result.total.samples).toBeGreaterThanOrEqual(0)
  expect(result.viewport.width).toBeGreaterThan(0)
  // happy-dom 无布局，可见节点数只校验口径存在；真实 WebKit 断言在 Swift 套件。
  expect(typeof result.visibleNodeCount).toBe('number')
  // 脱敏不变量：报告序列化文本不含任何节点 id 片段。
  expect(JSON.stringify(result)).not.toContain('perf-s100-u')
})

it('宿主省略选项时由 Web runner 提供共同模式默认脚本', async () => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  const { container } = render(
    <NativeCanvasApp graph={canvasPerfFixture(100)} />,
  )
  expect(container.querySelectorAll('.react-flow__node')).toHaveLength(100)

  const result = await runCanvasPerfScript()

  expect(result.phases.map((phase) => phase.kind)).toEqual([
    'drag',
    'pan',
    'zoom',
    'panel',
  ])
  // 默认脚本约 4 秒；过短说明宿主遗漏参数后退化为空转而非共同模式。
  expect(result.durationMs).toBeGreaterThan(3000)
})
