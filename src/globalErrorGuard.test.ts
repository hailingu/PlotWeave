// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleErrorEvent,
  handleUnhandledRejection,
  installGlobalErrorGuard,
} from './globalErrorGuard'

/**
 * 全局错误兜底契约（issue #358）：两个方向都必须成立——
 * ① 未处理拒绝与未捕获错误被上报且可见（机器码结构化诊断）；
 * ② 事件不被吞掉（不 preventDefault，浏览器默认上报原样保留）、
 * 安装本身静默，正常路径零新增噪声。
 */

describe('全局错误兜底（issue #358）', () => {
  let target: EventTarget
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    target = new EventTarget()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('unhandledrejection：输出机器码结构化诊断，且不吞掉事件', () => {
    installGlobalErrorGuard(target)
    const event = new Event('unhandledrejection', { cancelable: true })
    ;(event as { reason?: unknown }).reason = new Error('probe')
    target.dispatchEvent(event)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
      code: 'UNHANDLED_REJECTION',
      message: 'probe',
    })
    // 不吞错硬约束：可取消事件派发后 defaultPrevented 仍为 false
    expect(event.defaultPrevented).toBe(false)
  })

  it('unhandledrejection：Error 值携带堆栈，非 Error 值安全字符串化', () => {
    const boom = new Error('boom')
    handleUnhandledRejection({ reason: boom })
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
      code: 'UNHANDLED_REJECTION',
      message: 'boom',
      stack: boom.stack,
    })
    handleUnhandledRejection({ reason: 'plain' })
    expect(errorSpy.mock.calls[1]?.[1]).toMatchObject({
      code: 'UNHANDLED_REJECTION',
      message: 'plain',
    })
    handleUnhandledRejection({ reason: 42 })
    expect(errorSpy.mock.calls[2]?.[1]).toMatchObject({
      code: 'UNHANDLED_REJECTION',
      message: '42',
    })
  })

  it('error 事件：输出带来源位置的结构化诊断，且不吞掉事件', () => {
    installGlobalErrorGuard(target)
    const event = new ErrorEvent('error', {
      message: 'x is not a function',
      filename: 'app.js',
      lineno: 3,
      colno: 7,
      cancelable: true,
    })
    target.dispatchEvent(event)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
      code: 'UNCAUGHT_ERROR',
      message: 'x is not a function',
      source: { filename: 'app.js', lineno: 3, colno: 7 },
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('error 事件：event.error 为 Error 时优先取其消息与堆栈', () => {
    const err = new Error('thrown')
    handleErrorEvent({ message: 'Uncaught', error: err })
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
      code: 'UNCAUGHT_ERROR',
      message: 'thrown',
      stack: err.stack,
    })
  })

  it('诊断器自身绝不抛错（symbol 等异型拒绝值）', () => {
    expect(() =>
      handleUnhandledRejection({ reason: Symbol('x') }),
    ).not.toThrow()
    expect(() => handleUnhandledRejection({ reason: undefined })).not.toThrow()
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it('安装本身静默：无错误发生时不产生任何输出', () => {
    installGlobalErrorGuard(target)
    target.dispatchEvent(new Event('unrelated'))
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
