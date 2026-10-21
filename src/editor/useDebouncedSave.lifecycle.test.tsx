// @vitest-environment happy-dom
/** #699: parent callback churn must preserve debounce and real unmount/exit ownership. */
import { StrictMode, Suspense, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDebouncedSave } from './useDebouncedSave'
import { EMPTY_SETTINGS } from './settings'
import type { ProjectContent } from '../model/content'
import {
  flushPendingCanvasSaves,
  hasPendingCanvasSaves,
  registerCanvasFlushGate,
} from '../canvasSaveRegistry'

type Save = (doc: ProjectContent) => void | Promise<void>
interface SaveProps {
  readonly doc: ProjectContent
  readonly onSave: Save
  readonly onResult?: (error: unknown) => void
  readonly suspend?: boolean
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  registerCanvasFlushGate(null)
  vi.useRealTimers()
})

/** Only the durable name changes; graph identity stays outside this scheduling regression. */
function doc(name = '原项目'): ProjectContent {
  return { name, nodes: [], edges: [], settings: EMPTY_SETTINGS }
}

/** Real hook and real exit registry; the scenario owns only its storage acknowledgement. */
function mountSave(onSave: Save = vi.fn()) {
  const initial = { doc: doc(), onSave, onResult: vi.fn() }
  const view = renderHook(
    (props: SaveProps) =>
      useDebouncedSave(props.doc, props.onSave, 600, props.onResult),
    { initialProps: initial },
  )
  return { ...view, initial }
}

/** Advance the virtual deadline and settle the actual async save chain together. */
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

/** A controlled in-flight write permits observation before and after its receipt. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it.each(['save', 'result'] as const)(
  '%s callback identity changes do not flush or reset an existing debounce deadline',
  async (kind) => {
    const save = vi.fn()
    const view = mountSave(save)
    const changed = { ...view.initial, doc: doc('已编辑') }
    view.rerender(changed)
    await advance(200)
    view.rerender({
      ...changed,
      onSave: kind === 'save' ? (next) => save(next) : save,
      onResult: kind === 'result' ? vi.fn() : changed.onResult,
    })
    expect(save).not.toHaveBeenCalled()
    expect(hasPendingCanvasSaves()).toBe(true)
    expect(view.result.current.saveStatus).toBe('saving')
    await advance(399)
    expect(save).not.toHaveBeenCalled()
    await advance(1)
    expect(save).toHaveBeenCalledExactlyOnceWith(changed.doc)
    expect(hasPendingCanvasSaves()).toBe(false)
  },
)

it('callback churn on a clean document and its real unmount perform no write', async () => {
  const first = vi.fn()
  const latest = vi.fn()
  const view = mountSave(first)
  view.rerender({ ...view.initial, onSave: latest, onResult: vi.fn() })
  view.unmount()
  await advance(5000)
  expect(first).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()
  expect(hasPendingCanvasSaves()).toBe(false)
})

it('a real dirty unmount uses the latest committed callback exactly once', async () => {
  const first = vi.fn()
  const latest = vi.fn()
  const view = mountSave(first)
  const changed = { ...view.initial, doc: doc('卸载快照') }
  view.rerender(changed)
  await advance(200)
  view.rerender({ ...changed, onSave: latest })
  expect(first).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()
  view.unmount()
  await advance(5000)
  expect(latest).toHaveBeenCalledExactlyOnceWith(changed.doc)
  expect(first).not.toHaveBeenCalled()
  expect(hasPendingCanvasSaves()).toBe(false)
})

it('only real unmount supplements an in-flight write with the newest edit', async () => {
  const first = deferred()
  const save = vi.fn<Save>().mockImplementationOnce(() => first.promise)
  const view = mountSave(save)
  view.rerender({ ...view.initial, doc: doc('在途A') })
  await advance(600)
  expect(save).toHaveBeenCalledTimes(1)
  const changed = { ...view.initial, doc: doc('后续B') }
  view.rerender(changed)
  await advance(100)
  view.rerender({ ...changed, onSave: (next) => save(next) })
  await advance(0)
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => view.unmount())
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls.map(([saved]) => saved.name)).toEqual([
    '在途A',
    '后续B',
  ])
  await act(async () => first.resolve())
  await advance(5000)
  expect(save).toHaveBeenCalledTimes(2)
})

it('a failed write retains its retry deadline across a parent rerender', async () => {
  const save = vi.fn<Save>().mockRejectedValueOnce(new Error('只读'))
  const view = mountSave(save)
  const changed = { ...view.initial, doc: doc('保留重试') }
  view.rerender(changed)
  await advance(600)
  expect(view.result.current.saveStatus).toBe('failed')
  expect(hasPendingCanvasSaves()).toBe(true)
  await advance(200)
  view.rerender({ ...changed, onSave: (next) => save(next) })
  expect(save).toHaveBeenCalledTimes(1)
  expect(view.result.current.saveStatus).toBe('failed')
  await advance(399)
  expect(save).toHaveBeenCalledTimes(1)
  await advance(1)
  expect(save).toHaveBeenCalledTimes(2)
  expect(view.result.current.saveStatus).toBe('saved')
  expect(hasPendingCanvasSaves()).toBe(false)
})

it('the exit registry still flushes immediately and waits for the real acknowledgement', async () => {
  const pending = deferred()
  const first = vi.fn()
  const latest = vi.fn(() => pending.promise)
  const view = mountSave(first)
  const changed = { ...view.initial, doc: doc('退出快照') }
  view.rerender(changed)
  view.rerender({ ...changed, onSave: latest })
  expect(first).not.toHaveBeenCalled()
  let settled = false
  let flushing!: Promise<void>
  await act(async () => {
    flushing = flushPendingCanvasSaves().then(() => {
      settled = true
    })
  })
  expect(latest).toHaveBeenCalledExactlyOnceWith(changed.doc)
  expect(settled).toBe(false)
  await act(async () => {
    pending.resolve()
    await flushing
  })
  expect(settled).toBe(true)
  view.unmount()
  await advance(5000)
  expect(latest).toHaveBeenCalledTimes(1)
  expect(first).not.toHaveBeenCalled()
})

it('a suspended uncommitted callback cannot replace the real unmount owner', async () => {
  const committed = vi.fn()
  const suspended = vi.fn()
  const never = deferred()
  const initial: SaveProps = { doc: doc(), onSave: committed }
  const view = renderHook(
    (props: SaveProps) => {
      const state = useDebouncedSave(props.doc, props.onSave)
      if (props.suspend) throw never.promise
      return state
    },
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <Suspense fallback={null}>{children}</Suspense>
      ),
    },
  )
  const changed = { ...initial, doc: doc('已提交草稿') }
  view.rerender(changed)
  view.rerender({ ...changed, onSave: suspended, suspend: true })
  view.unmount()
  await advance(5000)
  expect(committed).toHaveBeenCalledExactlyOnceWith(changed.doc)
  expect(suspended).not.toHaveBeenCalled()
})

it('StrictMode lifecycle replay stays silent and the real dirty unmount writes once', async () => {
  const save = vi.fn()
  const initial: SaveProps = { doc: doc(), onSave: save }
  const view = renderHook(
    (props: SaveProps) => useDebouncedSave(props.doc, props.onSave),
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    },
  )
  expect(save).not.toHaveBeenCalled()
  const changed = { ...initial, doc: doc('严格模式') }
  view.rerender(changed)
  view.rerender({ ...changed, onSave: (next) => save(next) })
  expect(save).not.toHaveBeenCalled()
  view.unmount()
  await advance(5000)
  expect(save).toHaveBeenCalledExactlyOnceWith(changed.doc)
})
