// @vitest-environment happy-dom
/** Durable Swift settings writes refresh mounted consumers without replacing the AI conversation owner. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IPC_COMMANDS } from '../ipc/commands'
import { settingsStore } from './settingsStore'
import { defaultSettings, type AppSettings } from './types'
import { useSettingsSnapshot } from './useSettingsSnapshot'

/** The real v1 IPC transport targets only this synthetic page and in-memory host reply. */
const host = window as Window & {
  __pwNativeHost?: unknown
  __TAURI_INTERNALS__?: unknown
  webkit?: unknown
}
let stored: AppSettings
let transport = vi.fn()
let eventCleanup = new AbortController()

beforeEach(() => {
  eventCleanup = new AbortController()
  stored = defaultSettings()
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'snapshot-page',
  }
  transport = vi.fn(
    async (request: {
      command: string
      args?: { prefs?: AppSettings }
    }): Promise<unknown> => {
      if (request.command === IPC_COMMANDS.savePrefs) {
        if (!request.args?.prefs)
          throw new Error('fixture expected complete prefs')
        stored = request.args.prefs
        return { ok: null }
      }
      if (request.command === IPC_COMMANDS.loadPrefs) return { ok: stored }
      throw new Error('unexpected fixture IPC')
    },
  )
  host.webkit = {
    messageHandlers: { plotweaveHost: { postMessage: transport } },
  }
})
afterEach(() => {
  eventCleanup.abort()
  cleanup()
  vi.restoreAllMocks()
  delete host.__pwNativeHost
  delete host.__TAURI_INTERNALS__
  delete host.webkit
})

/** Deferred reads expose out-of-order refresh completion without relying on timer scheduling. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('a successful Swift save refreshes an already mounted snapshot with a payload-free event', async () => {
  const seen = vi.fn()
  window.addEventListener('settings-changed', seen, {
    signal: eventCleanup.signal,
  })
  const { result } = renderHook(() => useSettingsSnapshot())
  await waitFor(() => expect(result.current).not.toBeNull())
  const next = {
    ...stored,
    defaultChat: 'openai:new-model',
    providers: stored.providers.map((provider) =>
      provider.id === 'openai'
        ? { ...provider, models: ['new-model'], keyEnc: 'pw2:fixture-envelope' }
        : provider,
    ),
  }
  await act(async () => {
    await settingsStore.save(next)
  })
  await waitFor(() =>
    expect(result.current?.defaultChat).toBe('openai:new-model'),
  )
  expect(result.current?.providers[0]?.keyEnc).toBe('pw2:fixture-envelope')
  expect(seen).toHaveBeenCalledTimes(1)
  expect(seen.mock.calls[0]?.[0]).toBeInstanceOf(Event)
  expect(
    (seen.mock.calls[0]?.[0] as Event & { detail?: unknown }).detail,
  ).toBeUndefined()
  window.removeEventListener('settings-changed', seen)
})

it('failed Swift saves emit no refresh and retain the current mounted snapshot', async () => {
  const seen = vi.fn()
  window.addEventListener('settings-changed', seen, {
    signal: eventCleanup.signal,
  })
  const { result } = renderHook(() => useSettingsSnapshot())
  await waitFor(() => expect(result.current).not.toBeNull())
  const previous = result.current
  transport.mockResolvedValueOnce({
    error: { code: 'PW_STORAGE_ERROR', message: 'fixture disk failure' },
  })
  await expect(
    settingsStore.save({ ...stored, defaultChat: 'openai:unsaved' }),
  ).rejects.toThrow('fixture disk failure')
  expect(result.current).toEqual(previous)
  expect(seen).not.toHaveBeenCalled()
  window.removeEventListener('settings-changed', seen)
})

it('a newer failed refresh clears availability and a late older success cannot restore stale providers', async () => {
  const old = deferred<AppSettings>()
  const stale = { ...stored, defaultChat: 'openai:stale' }
  const load = vi
    .spyOn(settingsStore, 'load')
    .mockResolvedValueOnce(stored)
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error('fixture newest read failure'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { result } = renderHook(() => useSettingsSnapshot())
  await waitFor(() => expect(result.current).not.toBeNull())
  await act(async () => {
    await settingsStore.save(stored)
  })
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => {
    await settingsStore.save(stored)
  })
  expect(load).toHaveBeenCalledTimes(3)
  expect(result.current).toBeNull()
  await act(async () => {
    old.resolve(stale)
    await old.promise
  })
  expect(result.current).toBeNull()
})

it('unmount removes the Swift subscription before a later durable write', async () => {
  const load = vi.spyOn(settingsStore, 'load').mockResolvedValue(stored)
  const view = renderHook(() => useSettingsSnapshot())
  await waitFor(() => expect(view.result.current).not.toBeNull())
  view.unmount()
  await settingsStore.save(stored)
  expect(load).toHaveBeenCalledTimes(1)
})

it.each(['browser', 'tauri'] as const)(
  '%s keeps the existing mount-only snapshot behavior',
  async (kind) => {
    delete host.__pwNativeHost
    if (kind === 'tauri') host.__TAURI_INTERNALS__ = {}
    const load = vi.spyOn(settingsStore, 'load').mockResolvedValue(stored)
    const { result } = renderHook(() => useSettingsSnapshot())
    await waitFor(() => expect(result.current).not.toBeNull())
    await act(async () => {
      window.dispatchEvent(new Event('settings-changed'))
      await Promise.resolve()
    })
    expect(load).toHaveBeenCalledTimes(1)
  },
)
