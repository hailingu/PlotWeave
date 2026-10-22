// @vitest-environment happy-dom
/**
 * 显式隔离演示页行为（docs/swiftui-react-flow-migration-plan.md
 * §4.1）：真实 React Flow 画布可渲染、带内存演示数据标记（不被
 * 误认成品），且挂载后向 WKWebView 宿主发送就绪握手——原生侧据此放行
 * M01 的「就绪前禁用编辑，失败显示诊断」状态机。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { NativeCanvasApp } from './NativeCanvasApp'
import { DEMO_GRAPH_LABEL } from './demoGraph'

/** happy-dom 无 ResizeObserver 时 React Flow v12 需要的最小桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** happy-dom 的 document 跨用例共享，宿主外观属性必须逐例清理。 */
function clearHostAppearanceState(): void {
  const dataset = document.documentElement.dataset
  delete dataset.hostColorScheme
  delete dataset.hostReduceTransparency
  delete dataset.hostIncreaseContrast
  delete dataset.hostReduceMotion
  delete (window as { __pwHostAppearance?: unknown }).__pwHostAppearance
}

describe('NativeCanvasApp 隔离演示夹具', () => {
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
    vi.stubGlobal('__pwNativeHost', {
      protocolVersion: 1,
      sessionId: 'demo-ready',
    })
    vi.stubGlobal('webkit', {
      messageHandlers: { canvasHost: { postMessage } },
    })
    const { unmount } = render(<NativeCanvasApp />)
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        event: 'ready',
        protocolVersion: 1,
        sessionId: 'demo-ready',
      }),
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

  it('挂载时应用宿主注入的初始外观语义（§2.2 宿主同步）', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    ;(window as { __pwHostAppearance?: unknown }).__pwHostAppearance = {
      colorScheme: 'dark',
      reduceTransparency: true,
      increaseContrast: false,
      reduceMotion: true,
    }
    const { unmount } = render(<NativeCanvasApp />)
    const dataset = document.documentElement.dataset
    await waitFor(() => expect(dataset.hostColorScheme).toBe('dark'))
    expect(dataset.hostReduceTransparency).toBe('true')
    expect(dataset.hostIncreaseContrast).toBe('false')
    expect(dataset.hostReduceMotion).toBe('true')
    unmount()
    clearHostAppearanceState()
    vi.unstubAllGlobals()
  })

  it('宿主推送变化后更新语义属性，无效推送保持原值', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    ;(window as { __pwHostAppearance?: unknown }).__pwHostAppearance = {
      colorScheme: 'light',
      reduceTransparency: false,
      increaseContrast: false,
      reduceMotion: false,
    }
    const { unmount } = render(<NativeCanvasApp />)
    await waitFor(() =>
      expect(document.documentElement.dataset.hostColorScheme).toBe('light'),
    )
    const push = (window as { __pwApplyHostAppearance?: unknown })
      .__pwApplyHostAppearance as (payload: unknown) => void
    push({
      colorScheme: 'dark',
      reduceTransparency: false,
      increaseContrast: false,
      reduceMotion: false,
    })
    expect(document.documentElement.dataset.hostColorScheme).toBe('dark')
    push({
      colorScheme: 'blue',
      reduceTransparency: false,
      increaseContrast: false,
      reduceMotion: false,
    })
    expect(document.documentElement.dataset.hostColorScheme).toBe('dark')
    unmount()
    clearHostAppearanceState()
    vi.unstubAllGlobals()
  })
})
