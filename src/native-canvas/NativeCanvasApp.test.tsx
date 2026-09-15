// @vitest-environment happy-dom
/**
 * P1 原生视觉首片的演示页行为（docs/swiftui-react-flow-migration-plan.md
 * §5 P1 / §4.1）：真实 React Flow 画布可渲染、带内存演示数据标记（不被
 * 误认成品），且挂载后向 WKWebView 宿主发送就绪握手——原生侧据此放行
 * M01 的「就绪前禁用编辑，失败显示诊断」状态机。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import NativeCanvasApp from './NativeCanvasApp'
import { DEMO_GRAPH_LABEL } from './demoGraph'

/** happy-dom 无 ResizeObserver 时 React Flow v12 需要的最小桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('NativeCanvasApp 演示页（P1 视觉首片）', () => {
  it('渲染画布容器与内存演示数据标记', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const { container, getByText, unmount } = render(<NativeCanvasApp />)
    expect(container.querySelector('.canvas-root')).not.toBeNull()
    expect(getByText(new RegExp(DEMO_GRAPH_LABEL))).toBeTruthy()
    unmount()
    vi.unstubAllGlobals()
  })

  it('挂载后向 WKWebView 宿主发送 ready 握手（浏览器环境静默跳过）', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const postMessage = vi.fn()
    vi.stubGlobal('webkit', {
      messageHandlers: { canvasHost: { postMessage } },
    })
    const { unmount } = render(<NativeCanvasApp />)
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ event: 'ready' }),
    )
    unmount()
    vi.unstubAllGlobals()
  })

  it('无 webkit 桥时不抛错（浏览器开发模式兼容）', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    expect(() => {
      const { unmount } = render(<NativeCanvasApp />)
      unmount()
    }).not.toThrow()
    vi.unstubAllGlobals()
  })
})
