// @vitest-environment happy-dom
/** Entry-level regressions: removing page-owned cleanup must leave the rendered fixture behind. */
import { screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const diagnostics = vi.hoisted(() => ({
  begin: (): Promise<(() => void) | undefined> => Promise.resolve(undefined),
}))
// Replace only the asynchronous external event transport; React and the canvas stay real.
vi.mock('../../library/libraryDiagnosticTransport', () => ({
  initializeLibraryDiagnostics: () => diagnostics.begin(),
}))

/** React Flow needs only this browser API stand-in for the entry's DOM lifetime test. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Synthetic navigation has an explicit BFCache outcome; ordinary Event lacks persisted. */
function hide(persisted = false): void {
  const event = new Event('pagehide')
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

/** Execute the production entry and let its real React commit settle. */
async function boot(): Promise<void> {
  await act(async () => {
    await import('./main')
  })
}

beforeEach(() => {
  vi.resetModules()
  diagnostics.begin = () => Promise.resolve(undefined)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = '<div id="root"></div>'
  window.location.hash = '#fixture'
})

afterEach(async () => {
  await act(async () => hide())
  delete (window as Window & { __pwRunCanvasPerf?: unknown }).__pwRunCanvasPerf
  document.body.replaceChildren()
  window.location.hash = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native Web entry ownership (#573)', () => {
  it('permanent pagehide synchronously unmounts the actual rendered canvas', async () => {
    await boot()
    expect(document.getElementsByClassName('react-flow__node')).toHaveLength(9)
    await act(async () => hide())
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(document.getElementsByClassName('react-flow__handle')).toHaveLength(
      0,
    )
  })
  it('preserves the same mounted tree on persisted pagehide and releases once on permanent exit', async () => {
    const subscription = diagnosticSubscription()
    diagnostics.begin = () => Promise.resolve(subscription.stop)
    await boot()
    const node = document.getElementsByClassName('react-flow__node')[0]
    await act(async () => hide(true))
    window.dispatchEvent(new Event('pageshow'))
    expect(document.getElementsByClassName('react-flow__node')[0]).toBe(node)
    subscription.pulse()
    expect(subscription.received()).toBe(1)
    await act(async () => {
      hide()
      hide()
    })
    subscription.pulse()
    expect(subscription.received()).toBe(1)
    expect(subscription.stopped()).toBe(1)
    expect(document.getElementById('root')?.childElementCount).toBe(0)
  })
})

describe('native Web entry startup races (#573)', () => {
  it('never mounts after permanent pagehide while diagnostics initialization is pending', async () => {
    let complete: (stop: () => void) => void = () => {
      throw new Error('not initialized')
    }
    diagnostics.begin = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    await boot()
    await act(async () => {
      hide()
      hide()
    })
    const subscription = diagnosticSubscription()
    await act(async () => complete(subscription.stop))
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    subscription.pulse()
    expect(subscription.received()).toBe(0)
    expect(subscription.stopped()).toBe(1)
  })

  it('can finish initialization after a persisted hide without replacing the page', async () => {
    let complete: (stop: () => void) => void = () => {
      throw new Error('not initialized')
    }
    diagnostics.begin = () =>
      new Promise((resolve) => {
        complete = resolve
      })
    await boot()
    await act(async () => hide(true))
    const subscription = diagnosticSubscription()
    await act(async () => complete(subscription.stop))
    expect(document.getElementsByClassName('react-flow__node')).toHaveLength(9)
    subscription.pulse()
    expect(subscription.received()).toBe(1)
    await act(async () => hide())
    expect(subscription.stopped()).toBe(1)
  })
})

describe('native Web entry disposal failures (#573)', () => {
  it('restores captured multi-port source/target membership after real root disposal', async () => {
    await boot()
    const ports = Array.from(
      document.getElementsByClassName('react-flow__handle'),
    )
    const membership = ports.map((port) => [
      port.classList.contains('source'),
      port.classList.contains('target'),
    ])
    expect(ports.length).toBeGreaterThan(9)
    await act(async () => hide())
    expect(ports.every((port) => !port.isConnected)).toBe(true)
    expect(
      ports.map((port) => [
        port.classList.contains('source'),
        port.classList.contains('target'),
      ]),
    ).toEqual(membership)
    expect(document.getElementById('root')?.childElementCount).toBe(0)
  })

  it('still unmounts when external diagnostics cleanup throws and reports the failure', async () => {
    const error = new Error('synthetic subscription cleanup failure')
    diagnostics.begin = () =>
      Promise.resolve(() => {
        throw error
      })
    const report = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    await boot()
    await act(async () => hide())
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(report).toHaveBeenCalledWith('[Canvas] 页面清理失败', {
      code: 'PW_CANVAS_DISPOSE_FAILED',
      error,
    })
  })

  it('reports unexpected startup failure without mounting or leaving a rejecting promise', async () => {
    const error = new Error('synthetic transport initialization failure')
    diagnostics.begin = () => Promise.reject(error)
    const report = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    await boot()
    expect(document.getElementById('root')?.childElementCount).toBe(0)
    expect(report).toHaveBeenCalledWith('[Canvas] 页面初始化失败', {
      code: 'PW_CANVAS_INITIALIZATION_FAILED',
      error,
    })
  })
})

/** A concrete external subscription exposes delivery and idempotence through real browser events. */
function diagnosticSubscription() {
  let count = 0
  let stops = 0
  const receive = () => {
    count += 1
  }
  window.addEventListener('pw-diagnostic-test', receive)
  return {
    pulse: () => window.dispatchEvent(new Event('pw-diagnostic-test')),
    received: () => count,
    stopped: () => stops,
    stop: () => {
      stops += 1
      window.removeEventListener('pw-diagnostic-test', receive)
    },
  }
}

it('production entry mounts the actual application and completes its host lifecycle', async () => {
  window.location.hash = ''
  const ready = vi.fn()
  vi.stubGlobal('webkit', {
    messageHandlers: { canvasHost: { postMessage: ready } },
  })
  await boot()
  expect(await screen.findByRole('button', { name: /新建项目/ })).toBeTruthy()
  expect(document.getElementsByClassName('react-flow__node')).toHaveLength(0)
  await waitFor(() => expect(ready).toHaveBeenCalledWith({ event: 'ready' }))
  await act(async () => hide())
  expect(document.getElementById('root')?.childElementCount).toBe(0)
  expect('__pwApplyHostAppearance' in window).toBe(false)
})

it('explicit performance entry installs the runner and mounts the requested fixture only', async () => {
  window.location.hash = '#perf:100'
  await boot()
  expect(
    (window as Window & { __pwRunCanvasPerf?: unknown }).__pwRunCanvasPerf,
  ).toBeTypeOf('function')
  expect(document.getElementsByClassName('react-flow__node')).toHaveLength(100)
  await act(async () => hide())
  expect(document.getElementById('root')?.childElementCount).toBe(0)
})
