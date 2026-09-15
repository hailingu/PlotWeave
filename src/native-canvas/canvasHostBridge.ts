/**
 * WKWebView 宿主握手桥（docs/swiftui-react-flow-migration-plan.md §4.1）：
 * 画布演示页挂载完成后向原生侧报告就绪，原生侧据此驱动 M01 的
 * 「就绪前禁用编辑 / 失败显示诊断」状态机。纯浏览器（vite dev）无
 * webkit 桥时静默跳过，同一页面可在浏览器中直接开发。
 */

/** 原生侧注册的消息处理器的最小形状（window.webkit.messageHandlers.canvasHost）。 */
interface CanvasHostBridge {
  postMessage(message: unknown): void
}

/** 携带 webkit 桥的宿主窗口（WKWebView 环境；浏览器环境无此字段）。 */
type CanvasHostWindow = Window & {
  webkit?: { messageHandlers?: { canvasHost?: CanvasHostBridge } }
}

/** 向原生宿主发送画布就绪握手；无宿主桥时为安全 no-op。 */
export function notifyCanvasHostReady(): void {
  const host = (window as CanvasHostWindow).webkit?.messageHandlers?.canvasHost
  host?.postMessage({ event: 'ready' })
}
