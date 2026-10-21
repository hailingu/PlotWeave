// @vitest-environment happy-dom
/** 真实应用错误边界与全局守卫的失败诊断保留旧上下文，并携带共同记录。 */
import { afterEach, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'
import { handleUnhandledRejection } from './globalErrorGuard'

afterEach(() => vi.restoreAllMocks())

it('应用渲染失败仍输出原 Error 与组件栈，并标识失败域', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('render failure')
  new ErrorBoundary({ children: null }).componentDidCatch(error, {
    componentStack: 'owned component stack',
  })
  expect(spy).toHaveBeenCalledExactlyOnceWith(
    '[PlotWeave] 界面崩溃',
    error,
    'owned component stack',
    {
      level: 'ERROR',
      target: 'plotweave::frontend::app',
      code: 'APP_RENDER_FAILED',
      message: '[PlotWeave] 界面崩溃',
    },
  )
})

it('全局拒绝的原 message/stack 不被前缀覆盖，动态码保留', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('owned rejection')
  handleUnhandledRejection({ reason: error })
  expect(spy).toHaveBeenCalledExactlyOnceWith(
    '[GlobalError] 未处理的 Promise 拒绝',
    {
      code: 'UNHANDLED_REJECTION',
      message: 'owned rejection',
      stack: error.stack,
    },
    {
      level: 'ERROR',
      target: 'plotweave::frontend::global',
      code: 'UNHANDLED_REJECTION',
      message: '[GlobalError] 未处理的 Promise 拒绝',
    },
  )
})
