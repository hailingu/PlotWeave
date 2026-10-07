/** Swift WKWebView v1 命令边界：按页面会话归属回执，不重试结果未知请求。 */
import { IPC_COMMANDS, type IpcCommandName } from '../ipc/commands'

/** 原生系统服务命令的事实源，与业务IPC注册表分开维护。 */
export const SYSTEM_HOST_COMMANDS = {
  copyText: 'system.copyText',
  saveText: 'system.saveText',
} as const

/** 系统交付服务与既有业务 IPC 共用同一宿主请求协议。 */
export type SwiftHostCommand =
  | IpcCommandName
  | (typeof SYSTEM_HOST_COMMANDS)[keyof typeof SYSTEM_HOST_COMMANDS]

/** 宿主请求身份在同一 Web 模块生命周期内单调且不复用。 */
interface SwiftHostRequest {
  protocolVersion: 1
  sessionId: string
  requestId: string
  command: SwiftHostCommand
  args?: Record<string, unknown>
}

/** 原生 WithReply 通道；结果在边界校验后才交给业务消费者。 */
interface SwiftMessageHandler {
  postMessage(request: SwiftHostRequest): Promise<unknown>
}

/** 当前注入的协议会话与其消息发送口。 */
interface SwiftBridge {
  window: Window
  sessionId: string
  handler: SwiftMessageHandler
}

/** 原生或桥边界失败；未知结果不表示底层操作已取消或没有执行。 */
export class SwiftHostError extends Error {
  /** 保存稳定机器码，并明确拒绝是否仍可能对应已执行的底层操作。 */
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'SwiftHostError'
  }
}

let nextRequestId = 0

/** 严格验证桥协议；仅 kind 的旧标记仍属于 Swift，但不能执行服务请求。 */
function readSwiftBridge(): SwiftBridge | null {
  if (typeof window === 'undefined') return null
  const host = window as Window & {
    __pwNativeHost?: {
      kind?: unknown
      protocolVersion?: unknown
      sessionId?: unknown
    }
    webkit?: { messageHandlers?: { plotweaveHost?: SwiftMessageHandler } }
  }
  const marker = host.__pwNativeHost
  const handler = host.webkit?.messageHandlers?.plotweaveHost
  if (
    marker?.kind !== 'swift' ||
    marker.protocolVersion !== 1 ||
    typeof marker.sessionId !== 'string' ||
    marker.sessionId === '' ||
    typeof handler?.postMessage !== 'function'
  )
    return null
  return { window: host, sessionId: marker.sessionId, handler }
}

/** 当前有效的 Swift 协议会话；事件监听据此隔离重载前后的消费者。 */
export function currentSwiftHostSession(): string | null {
  return readSwiftBridge()?.sessionId ?? null
}

/** 能力探测只检查桥就绪；不会把 Swift 的未接通能力降级成浏览器内存。 */
export function hasSwiftHostTransport(): boolean {
  return readSwiftBridge() !== null
}

/** 用户保存面板不设期限；模型预算覆盖 Rust 总预算（图像600秒）并保留余量。 */
function deadlineOf(command: SwiftHostCommand): number | null {
  if (command === SYSTEM_HOST_COMMANDS.saveText) return null
  if (command === IPC_COMMANDS.llmChat) return 150_000
  if (command === IPC_COMMANDS.llmImageGenerate) return 660_000
  return 30_000
}

/** 只接受互斥的成功／结构化失败信封，非法信封保留结果未知语义。 */
function unwrapReply<T>(reply: unknown): T {
  if (reply !== null && typeof reply === 'object' && !Array.isArray(reply)) {
    const value = reply as Record<string, unknown>
    const success = Object.prototype.hasOwnProperty.call(value, 'ok')
    const failure = Object.prototype.hasOwnProperty.call(value, 'error')
    if (success && !failure) return value.ok as T
    if (
      failure &&
      !success &&
      value.error !== null &&
      typeof value.error === 'object'
    ) {
      const error = value.error as Record<string, unknown>
      if (
        typeof error.code === 'string' &&
        error.code !== '' &&
        typeof error.message === 'string'
      ) {
        throw new SwiftHostError(error.code, error.message)
      }
    }
  }
  throw new SwiftHostError(
    'PW_HOST_PROTOCOL_INVALID',
    '原生宿主回执不符合协议，本次结果未知',
    true,
  )
}

/** 页面结束、超时与会话替换均拒绝当前请求，迟到回执没有二次落定通道。 */
function awaitReply<T>(
  bridge: SwiftBridge,
  request: SwiftHostRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      bridge.window.removeEventListener('pagehide', onPageEnd)
      action()
    }
    const onPageEnd = () =>
      finish(() =>
        reject(
          new SwiftHostError(
            'PW_HOST_SESSION_ENDED',
            '原生页面会话已结束，本次结果未知',
            true,
          ),
        ),
      )
    bridge.window.addEventListener('pagehide', onPageEnd, { once: true })
    const deadline = deadlineOf(request.command)
    if (deadline !== null)
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new SwiftHostError(
                'PW_HOST_TIMEOUT',
                '等待原生宿主回执超时，本次结果未知；请核对状态后重试',
                true,
              ),
            ),
          ),
        deadline,
      )
    const receive = (reply: unknown) =>
      finish(() => {
        if (readSwiftBridge()?.sessionId !== bridge.sessionId) {
          reject(
            new SwiftHostError(
              'PW_HOST_SESSION_ENDED',
              '原生页面会话已更换，本次结果未知',
              true,
            ),
          )
          return
        }
        try {
          resolve(unwrapReply<T>(reply))
        } catch (error) {
          reject(error)
        }
      })
    const fail = (error: unknown) =>
      finish(() =>
        reject(
          new SwiftHostError(
            'PW_HOST_TRANSPORT_FAILED',
            `原生宿主传输失败，本次结果未知：${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        ),
      )
    void deliverReply(bridge, request, receive, fail)
  })
}

/** Observes synchronous throws and rejected WithReply promises through the same failure owner. */
async function deliverReply(
  bridge: SwiftBridge,
  request: SwiftHostRequest,
  receive: (reply: unknown) => void,
  fail: (error: unknown) => void,
): Promise<void> {
  try {
    await bridge.handler.postMessage(request).then(receive, fail)
  } catch (error) {
    fail(error)
  }
}

/** 执行一笔原生请求：身份只分配一次，没有传输级自动重试。 */
export function invokeSwiftHost<T = unknown>(
  command: SwiftHostCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  const bridge = readSwiftBridge()
  if (!bridge)
    return Promise.reject(
      new SwiftHostError(
        'PW_HOST_COMMAND_UNAVAILABLE',
        '原生宿主命令传输未就绪或协议版本不匹配',
      ),
    )
  return awaitReply<T>(bridge, {
    protocolVersion: 1,
    sessionId: bridge.sessionId,
    requestId: `${bridge.sessionId}:${++nextRequestId}`,
    command,
    ...(args === undefined ? {} : { args }),
  })
}
