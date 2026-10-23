// @vitest-environment happy-dom
/**
 * 宿主外观语义桥（docs/swiftui-react-flow-migration-plan.md §2.2/§4.1）：
 * 原生侧把系统外观与辅助显示语义同步给 Web——初始快照经 userScript 注入
 * `window.__pwHostAppearance`，后续变化经 `window.__pwApplyHostAppearance`
 * 推送。桥接载荷必须经校验：无效载荷被拒绝，不得污染已应用的语义状态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notifyCanvasHostReady,
  readInitialHostAppearance,
  setHostAppearanceHandler,
  type HostAppearance,
} from './canvasHostBridge'

/** 合法外观快照的最小样例（每用例按需覆盖字段）。 */
const VALID_DARK: HostAppearance = {
  colorScheme: 'dark',
  reduceTransparency: true,
  increaseContrast: false,
  reduceMotion: false,
}

type HostAppearanceWindow = Window & {
  __pwHostAppearance?: unknown
  __pwApplyHostAppearance?: (payload: unknown) => void
}

/** happy-dom 的 document/window 跨用例共享，外观注入与属性必须逐例清理。 */
afterEach(() => {
  delete (window as HostAppearanceWindow).__pwHostAppearance
  setHostAppearanceHandler(null)
  vi.unstubAllGlobals()
})

describe('ready handshake ownership (migration plan §4.1, issue #764)', () => {
  it('carries the injected protocol and session with only the canvas channel', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('webkit', {
      messageHandlers: { canvasHost: { postMessage } },
    })
    vi.stubGlobal('__pwNativeHost', {
      kind: 'swift',
      protocolVersion: 1,
      sessionId: 'ready-session',
    })
    notifyCanvasHostReady()
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      event: 'ready',
      protocolVersion: 1,
      sessionId: 'ready-session',
    })
  })

  it.each([
    undefined,
    null,
    {},
    { protocolVersion: 2, sessionId: 'wrong-version' },
    { protocolVersion: 1, sessionId: '' },
    { protocolVersion: 1, sessionId: 42 },
  ])('does not report ready for invalid injected identity %j', (marker) => {
    const postMessage = vi.fn()
    vi.stubGlobal('webkit', {
      messageHandlers: { canvasHost: { postMessage } },
    })
    vi.stubGlobal('__pwNativeHost', marker)
    notifyCanvasHostReady()
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('readInitialHostAppearance 初始注入', () => {
  it('读取合法注入快照并原样返回语义结构', () => {
    ;(window as HostAppearanceWindow).__pwHostAppearance = { ...VALID_DARK }
    expect(readInitialHostAppearance()).toEqual(VALID_DARK)
  })

  it('拒绝非法 colorScheme、缺字段与非对象载荷', () => {
    ;(window as HostAppearanceWindow).__pwHostAppearance = {
      ...VALID_DARK,
      colorScheme: 'blue',
    }
    expect(readInitialHostAppearance()).toBeNull()

    const missingField: Record<string, unknown> = { ...VALID_DARK }
    delete missingField.reduceMotion
    ;(window as HostAppearanceWindow).__pwHostAppearance = missingField
    expect(readInitialHostAppearance()).toBeNull()

    ;(window as HostAppearanceWindow).__pwHostAppearance = 'dark'
    expect(readInitialHostAppearance()).toBeNull()
  })

  it('无注入时返回 null（浏览器开发环境）', () => {
    expect(readInitialHostAppearance()).toBeNull()
  })
})

describe('setHostAppearanceHandler 变化推送', () => {
  it('注册后经原生推送入口收到校验后的语义状态', () => {
    const apply = vi.fn()
    setHostAppearanceHandler(apply)
    ;(window as HostAppearanceWindow).__pwApplyHostAppearance?.({
      ...VALID_DARK,
      colorScheme: 'light',
      reduceTransparency: false,
    })
    expect(apply).toHaveBeenCalledWith({
      ...VALID_DARK,
      colorScheme: 'light',
      reduceTransparency: false,
    })
  })

  it('无效推送不触发回调（语义状态不被污染）', () => {
    const apply = vi.fn()
    setHostAppearanceHandler(apply)
    ;(window as HostAppearanceWindow).__pwApplyHostAppearance?.({
      ...VALID_DARK,
      increaseContrast: 'yes',
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('注销后移除推送入口，页面不再持有回调', () => {
    setHostAppearanceHandler(vi.fn())
    setHostAppearanceHandler(null)
    expect(
      (window as HostAppearanceWindow).__pwApplyHostAppearance,
    ).toBeUndefined()
  })
})
