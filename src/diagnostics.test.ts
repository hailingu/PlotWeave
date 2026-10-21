/** 统一诊断记录补充分级和域，保留原前缀、上下文引用及延后安装的 console sink。 */
import { afterEach, expect, it, vi } from 'vitest'
import { createDiagnostic, reportDiagnostic } from './diagnostics'

afterEach(() => vi.restoreAllMocks())

it.each([
  ['WARN', 'warn'],
  ['ERROR', 'error'],
] as const)(
  '%s 保留原参数位置和 Error/循环上下文，追加同构记录',
  (level, method) => {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    const error = new Error('owned failure')
    const payload: { self?: unknown } = {}
    payload.self = payload
    const emit = createDiagnostic(
      level,
      'plotweave::frontend::probe',
      'PROBE_FAILED',
    )
    emit('[probe] original prefix', payload, error, error.stack)
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      '[probe] original prefix',
      payload,
      error,
      error.stack,
      {
        level,
        target: 'plotweave::frontend::probe',
        code: 'PROBE_FAILED',
        message: '[probe] original prefix',
      },
    )
    expect(spy.mock.calls[0]?.[1]).toBe(payload)
    expect(spy.mock.calls[0]?.[2]).toBe(error)
  },
)

it('建立 reporter 不输出，调用时使用最新 console sink', () => {
  const first = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const emit = createDiagnostic(
    'WARN',
    'plotweave::frontend::probe',
    'PROBE_FAILED',
  )
  expect(first).not.toHaveBeenCalled()
  first.mockRestore()
  const latest = vi.spyOn(console, 'warn').mockImplementation(() => {})
  emit('[probe] later')
  expect(latest).toHaveBeenCalledExactlyOnceWith('[probe] later', {
    level: 'WARN',
    target: 'plotweave::frontend::probe',
    code: 'PROBE_FAILED',
    message: '[probe] later',
  })
})

it('直接记录保留动态机器码及已有负载，完全不读取上下文属性', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const context = new Proxy(
    {},
    {
      get: () => {
        throw new Error('must not inspect')
      },
    },
  )
  const record = {
    level: 'ERROR' as const,
    target: 'plotweave::frontend::global',
    code: 'UNHANDLED_REJECTION',
    message: '[GlobalError] rejected',
  }
  reportDiagnostic(record, context)
  expect(spy.mock.calls[0]?.[1]).toBe(context)
  expect(spy.mock.calls[0]?.[2]).toBe(record)
})
