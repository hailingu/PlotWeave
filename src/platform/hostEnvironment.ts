/**
 * 前端宿主环境识别（P2 宿主接口收敛；docs/swiftui-react-flow-migration-plan.md
 * §2.3/§3，矩阵 M16/M17）：取代各 store 自带的 isTauri 判定，作为唯一探测
 * 来源。优先级 tauri > swift > browser：
 * - tauri：Tauri webview 的 IPC 桥 `__TAURI_INTERNALS__`（沿用 main.tsx 与
 *   各 store 的既有探测口径）。
 * - swift：原生外壳在文档开始前经 userScript 注入
 *   `window.__pwNativeHost = { kind: 'swift', protocolVersion: 1, sessionId }`。
 *   仅 kind 的旧标记也识别为 Swift，传输另行拒绝不完整协议。标记形状非法
 *   不识别为 swift——注入契约由原生侧测试钉住，垃圾标记按纯浏览器对待。
 * - browser：纯浏览器预览（vite dev），唯一允许内存回退的宿主。
 * 关键不变量：Swift 宿主绝不落入内存模式，未接通的能力必须可见失败。
 * 探测读调用时刻的全局 window、不缓存——与被取代的各处实时判定同语义。
 */

import { isTauriRuntime } from '../ipc/runtime'

/** 宿主类别。 */
export type HostKind = 'tauri' | 'swift' | 'browser'

/** 宿主探测窗口的最小形状（测试可传字面量对象驱动）。 */
export type HostProbeWindow = Record<string, unknown>

/** 原生外壳 document-start 注入的 v1 协议会话标记。 */
export interface NativeHostMarker {
  kind: 'swift'
  protocolVersion: 1
  sessionId: string
}

function isSwiftMarker(
  value: unknown,
): value is Pick<NativeHostMarker, 'kind'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'swift'
  )
}

/** 原生宿主标记的属性读取面（issue #522 收口）：全局 window 无索引签名，
 * 不对整个窗口做类型断言——经 in 判定后按收窄属性读取，缺失即无标记。 */
function nativeHostMarker(host: object): unknown {
  return '__pwNativeHost' in host ? host.__pwNativeHost : undefined
}

/** 识别宿主类别：优先级 tauri > swift > browser；无窗口按纯浏览器。 */
export function detectHostKind(probe?: HostProbeWindow): HostKind {
  const w: object = probe ?? (typeof window === 'undefined' ? {} : window)
  if (isTauriRuntime(w)) return 'tauri'
  if (isSwiftMarker(nativeHostMarker(w))) return 'swift'
  return 'browser'
}

/** Tauri 宿主（IPC 桥存在）：命令经 `@tauri-apps/api/core` invoke。 */
export function isTauriHost(): boolean {
  return detectHostKind() === 'tauri'
}

/** Swift 原生外壳宿主（WKWebView + 注入标记）：服务由 v1 会话命令桥提供。 */
export function isSwiftHost(): boolean {
  return detectHostKind() === 'swift'
}

/** 原生宿主（tauri 或 swift）：绝不落入内存回退。 */
export function isNativeHost(): boolean {
  const kind = detectHostKind()
  return kind === 'tauri' || kind === 'swift'
}

/** 纯浏览器预览：唯一允许内存回退的宿主。 */
export function isBrowserPreviewHost(): boolean {
  return detectHostKind() === 'browser'
}
