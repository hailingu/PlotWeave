/**
 * 全局未处理拒绝与错误事件兜底（issue #358）：React 错误边界不捕获
 * 异步 Promise 拒绝与事件处理器抛出的异常，这类失败此前没有任何用户
 * 可见或日志可见的信号。引导入口（bootstrap.ts，先于应用静态导入图
 * 求值——评审 5326220397）安装 window 级监听，为两类失败输出结构化
 * 控制台诊断（机器码 + 上下文字段，风格对齐 libraryDiagnosticTransport
 * 的 `{ code }` 形态），补齐纵深防御层。
 *
 * 不吞错硬约束：监听器不调用 preventDefault / stopPropagation——浏览器
 * 对未处理拒绝与未捕获错误的默认上报原样保留，本层只追加诊断，绝不把
 * 「静默失败」从一处搬到另一处。已内部处理错误的 `void` fire-and-forget
 * 调用不会触发 unhandledrejection（引擎语义），因此正常路径零新增噪声。
 */

/** 诊断机器码（UPPER_SNAKE）：区分两类全局失败通道。 */
export type GlobalErrorCode = 'UNHANDLED_REJECTION' | 'UNCAUGHT_ERROR'

/** 结构化诊断：消费方（devtools / 日志采集）按字段判定，不解析自由文本。 */
export interface GlobalErrorDiagnostic {
  code: GlobalErrorCode
  /** 拒绝原因 / 错误消息（安全字符串化，诊断器自身绝不抛错）。 */
  message: string
  /** Error 实例的堆栈；非 Error 值缺省。 */
  stack?: string
  /** 未捕获错误的脚本来源与位置（事件可解析时）。 */
  source?: { filename: string; lineno: number; colno: number }
}

/** 安全字符串化：Error 取 message；其余走 String()——symbol 经 String()
 * 可表示，代理等异型值抛错时回退占位。绝不让诊断本身成为新的失败源。 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message
  try {
    return String(value)
  } catch {
    return '(拒绝原因无法字符串化)'
  }
}

/** 结构化诊断输出（集中一处便于测试与后续通道演进）。 */
function report(label: string, diagnostic: GlobalErrorDiagnostic): void {
  console.error(`[GlobalError] ${label}`, diagnostic)
}

/** unhandledrejection 事件的最小结构形状（真实事件 + 测试桩共用）。 */
export interface UnhandledRejectionEventLike {
  reason: unknown
}

/** 未处理 Promise 拒绝 → 结构化诊断并输出。 */
export function handleUnhandledRejection(event: { reason: unknown }): void {
  const reason = event.reason
  const diagnostic: GlobalErrorDiagnostic = {
    code: 'UNHANDLED_REJECTION',
    message: describe(reason),
    ...(reason instanceof Error && typeof reason.stack === 'string'
      ? { stack: reason.stack }
      : {}),
  }
  report('未处理的 Promise 拒绝', diagnostic)
}

/** error 事件的最小结构形状（window 级未捕获脚本错误；资源加载错误
 * 需捕获式监听，不在本层口径内，避免资源噪声）。 */
export interface ErrorEventLike {
  message?: unknown
  filename?: unknown
  lineno?: unknown
  colno?: unknown
  error?: unknown
}

/** 未捕获脚本错误 → 结构化诊断并输出；event.error 为 Error 时优先取其
 * 消息与堆栈（比事件的展平 message 多保留堆栈上下文）。 */
export function handleErrorEvent(event: ErrorEventLike): void {
  const thrown = event.error
  const fromThrown =
    thrown instanceof Error
      ? { message: thrown.message, stack: thrown.stack }
      : undefined
  const diagnostic: GlobalErrorDiagnostic = {
    code: 'UNCAUGHT_ERROR',
    message: fromThrown?.message ?? describe(event.message),
    ...(fromThrown?.stack ? { stack: fromThrown.stack } : {}),
    ...(typeof event.filename === 'string' &&
    event.filename !== '' &&
    typeof event.lineno === 'number' &&
    typeof event.colno === 'number'
      ? {
          source: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          },
        }
      : {}),
  }
  report('未捕获的脚本错误', diagnostic)
}

/** 在目标（缺省 window）上安装两个全局兜底监听；仅在应用引导入口
 * （bootstrap.ts）调用一次，不在库/组件层重复安装。注册即返回，
 * 不阻塞启动。 */
export function installGlobalErrorGuard(target: EventTarget = window): void {
  target.addEventListener('unhandledrejection', (event) => {
    // DOM 事件子类型向下转换：真实事件携带 reason（测试经结构形状直调）
    handleUnhandledRejection(event as PromiseRejectionEvent)
  })
  target.addEventListener('error', (event) => {
    handleErrorEvent(event as ErrorEvent)
  })
}
