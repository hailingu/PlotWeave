/**
 * WKWebView 宿主握手桥（docs/swiftui-react-flow-migration-plan.md §4.1）：
 * 画布演示页挂载完成后向原生侧报告就绪，原生侧据此驱动 M01 的
 * 「就绪前禁用编辑 / 失败显示诊断」状态机。纯浏览器（vite dev）无
 * webkit 桥时静默跳过，同一页面可在浏览器中直接开发。
 *
 * 外观语义同步（§2.2）：原生侧显式读取系统外观与辅助显示设置并同步
 * 语义状态，不依赖目标 WebKit 的媒体查询全部生效——初始快照由宿主
 * userScript 注入 `window.__pwHostAppearance`，后续变化经
 * `window.__pwApplyHostAppearance` 推送；载荷在桥边界校验（§4.1）。
 */

/** 原生侧注册的消息处理器的最小形状（window.webkit.messageHandlers.canvasHost）。 */
interface CanvasHostBridge {
  postMessage(message: unknown): void
}

/** 携带 webkit 桥的宿主窗口（WKWebView 环境；浏览器环境无此字段）。 */
type CanvasHostWindow = Window & {
  webkit?: { messageHandlers?: { canvasHost?: CanvasHostBridge } }
  __pwNativeHost?: { protocolVersion?: unknown; sessionId?: unknown }
}

/** 宿主同步的外观语义状态：浅深外观与三项辅助显示偏好。 */
export interface HostAppearance {
  colorScheme: 'light' | 'dark'
  reduceTransparency: boolean
  increaseContrast: boolean
  reduceMotion: boolean
}

/** 携带宿主外观注入与推送入口的窗口形状。 */
type HostAppearanceWindow = Window & {
  __pwHostAppearance?: unknown
  __pwApplyHostAppearance?: (payload: unknown) => void
}

/** 校验宿主外观载荷；任一字段缺失或类型非法即拒绝（返回 null）。 */
function parseHostAppearance(value: unknown): HostAppearance | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const colorScheme = candidate.colorScheme
  if (colorScheme !== 'light' && colorScheme !== 'dark') return null
  const booleans = [
    candidate.reduceTransparency,
    candidate.increaseContrast,
    candidate.reduceMotion,
  ]
  if (booleans.some((field) => typeof field !== 'boolean')) return null
  return {
    colorScheme,
    reduceTransparency: candidate.reduceTransparency as boolean,
    increaseContrast: candidate.increaseContrast as boolean,
    reduceMotion: candidate.reduceMotion as boolean,
  }
}

/** 读取宿主 userScript 注入的初始外观快照；无注入或无效时返回 null。 */
export function readInitialHostAppearance(): HostAppearance | null {
  const injected = (window as HostAppearanceWindow).__pwHostAppearance
  return parseHostAppearance(injected)
}

/**
 * 注册/注销宿主外观变化入口：原生推送经校验后转发给 `apply`；传 null
 * 移除入口。无效载荷被丢弃，不触达已应用的语义状态。
 */
export function setHostAppearanceHandler(
  apply: ((appearance: HostAppearance) => void) | null,
): void {
  const hostWindow = window as HostAppearanceWindow
  if (!apply) {
    delete hostWindow.__pwApplyHostAppearance
    return
  }
  hostWindow.__pwApplyHostAppearance = (payload: unknown) => {
    const appearance = parseHostAppearance(payload)
    if (appearance) apply(appearance)
  }
}

/** 报告当前注入会话的就绪；无有效会话或宿主桥时为安全 no-op（§4.1）。 */
export function notifyCanvasHostReady(): void {
  const hostWindow = window as CanvasHostWindow
  const marker = hostWindow.__pwNativeHost
  if (
    marker?.protocolVersion !== 1 ||
    typeof marker.sessionId !== 'string' ||
    marker.sessionId === ''
  )
    return
  hostWindow.webkit?.messageHandlers?.canvasHost?.postMessage({
    event: 'ready',
    protocolVersion: 1,
    sessionId: marker.sessionId,
  })
}
