// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTransientActionFeedback } from './useTransientActionFeedback'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(['A', 'B'])(
  'restarts the full lifetime when A is followed by %s',
  (next) => {
    const { result } = renderHook(() => useTransientActionFeedback('p'))
    act(() => result.current.report('A'))
    act(() => vi.advanceTimersByTime(6_000))
    act(() => result.current.report(next))
    act(() => vi.advanceTimersByTime(2_000))
    expect(result.current.message).toBe(next)
    act(() => vi.advanceTimersByTime(5_999))
    expect(result.current.message).toBe(next)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.message).toBeNull()
  },
)

it('a cancelled callback cannot clear a replacement or its own later repetition', () => {
  const timers = vi.spyOn(globalThis, 'setTimeout')
  const { result } = renderHook(() => useTransientActionFeedback('p'))
  act(() => result.current.report('A'))
  const oldExpiry = timers.mock.lastCall?.[0]
  expect(oldExpiry).toBeTypeOf('function')
  act(() => result.current.report('B'))
  act(() => {
    if (typeof oldExpiry === 'function') oldExpiry()
  })
  expect(result.current.message).toBe('B')
  act(() => result.current.report('A'))
  act(() => {
    if (typeof oldExpiry === 'function') oldExpiry()
  })
  expect(result.current.message).toBe('A')
})

it('switching projects invalidates old publishers, clears timers and never replays a message', () => {
  const { result, rerender } = renderHook(
    ({ id }) => useTransientActionFeedback(id),
    {
      initialProps: { id: 'a' },
    },
  )
  const oldReport = result.current.report
  act(() => oldReport('old'))
  expect(vi.getTimerCount()).toBe(1)
  rerender({ id: 'b' })
  expect(result.current.message).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  act(() => result.current.report('new'))
  act(() => oldReport('late'))
  expect(result.current.message).toBe('new')
  rerender({ id: 'a' })
  expect(result.current.message).toBeNull()
  act(() => oldReport('late on return'))
  expect(result.current.message).toBeNull()
  act(() => result.current.report('current'))
  act(() => vi.advanceTimersByTime(8_000))
  expect(result.current.message).toBeNull()
})

it('unmount releases the timer and rejects late async reports; remount starts empty', () => {
  const hook = renderHook(() => useTransientActionFeedback('p'))
  const report = hook.result.current.report
  act(() => report('old'))
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => report('late'))
  expect(vi.getTimerCount()).toBe(0)
  const remount = renderHook(() => useTransientActionFeedback('p'))
  expect(remount.result.current.message).toBeNull()
  act(() => remount.result.current.report('new'))
  act(() => vi.advanceTimersByTime(7_999))
  expect(remount.result.current.message).toBe('new')
})

it('StrictMode cleanup does not disable the current publisher or expiry', () => {
  const { result } = renderHook(() => useTransientActionFeedback('p'), {
    wrapper: StrictMode,
  })
  act(() => result.current.report('current'))
  expect(result.current.message).toBe('current')
  act(() => vi.advanceTimersByTime(8_000))
  expect(result.current.message).toBeNull()
})
