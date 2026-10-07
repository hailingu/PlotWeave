// @vitest-environment happy-dom
/** Native settings intents use the production controller and expose no credential material. */
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { useExitFlush } from '../useExitFlush'
import {
  useNativeSettingsShell,
  type NativeSettingsOptions,
} from './useNativeSettingsShell'
import { normalizeSettings } from './types'
import { settingsStore } from './settingsStore'
import { defaultSettings, type AppSettings } from './types'

/** Injected native page identity and its two independent WebKit channels. */
const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
let sink = vi.fn()
let serial = 0
let stored: AppSettings

/** Runs a fresh native intent through the public bridge rather than a mocked action owner. */
async function intent(command: string, args: Record<string, unknown> = {}) {
  let reply: unknown
  await act(async () => {
    reply = await host.__pwNativeIntent?.({
      protocolVersion: 1,
      sessionId: 'settings-page',
      requestId: String(++serial),
      command,
      args,
    })
  })
  return reply
}

/** Reads the latest readonly settings payload emitted to the Swift projection sink. */
function projection(): Record<string, unknown> | undefined {
  const last = sink.mock.calls[sink.mock.calls.length - 1]?.[0] as
    | {
        projection?: { settings?: Record<string, unknown> }
      }
    | undefined
  return last?.projection?.settings
}

beforeEach(() => {
  serial = 0
  stored = defaultSettings()
  stored.providers[0]!.keyEnc = 'pw2:original-envelope'
  sink = vi.fn()
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'settings-page',
  }
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: sink },
      plotweaveHost: { postMessage: vi.fn(async () => ({ ok: null })) },
    },
  }
  vi.spyOn(settingsStore, 'load').mockImplementation(async () => stored)
  vi.spyOn(settingsStore, 'save').mockImplementation(async (next) => {
    stored = next
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete host.__pwNativeHost
  delete host.webkit
})

it('publishes safe settings and persists native edits through the existing close flush', async () => {
  const onClose = vi.fn()
  render(<SettingsView onClose={onClose} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  expect(projection()?.providers).toContainEqual({
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    models: ['gpt-4o-mini', 'gpt-4o'],
    keyConfigured: true,
  })
  expect(JSON.stringify(projection())).not.toContain('pw2:original-envelope')
  expect(
    await intent('settings.patchProvider', {
      id: 'openai',
      patch: {
        baseUrl: 'https://native.example/v1',
        models: ['chat', 'image'],
      },
    }),
  ).toEqual({ ok: null })
  expect(
    await intent('settings.setDefaults', {
      defaultChat: 'openai:chat',
      defaultImage: 'openai:image',
    }),
  ).toEqual({ ok: null })
  expect(settingsStore.save).not.toHaveBeenCalled()
  expect(await intent('settings.close')).toEqual({ ok: null })
  expect(stored.providers[0]?.baseUrl).toBe('https://native.example/v1')
  expect(stored.defaultChat).toBe('openai:chat')
  expect(stored.defaultImage).toBe('openai:image')
  expect(stored.providers[0]?.keyEnc).toBe('pw2:original-envelope')
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('native patches compose before React commits and an immediate close persists every field', async () => {
  const onClose = vi.fn()
  render(<SettingsView onClose={onClose} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  await act(async () => {
    expect(
      await startIntent('settings.patchProvider', {
        id: 'openai',
        patch: { baseUrl: 'https://composed.example/v1' },
      }),
    ).toEqual({ ok: null })
    expect(
      await startIntent('settings.patchProvider', {
        id: 'openai',
        patch: { models: ['composed-model'] },
      }),
    ).toEqual({ ok: null })
    expect(
      await startIntent('settings.setDefaults', {
        defaultChat: 'openai:composed-model',
        defaultImage: null,
      }),
    ).toEqual({ ok: null })
    expect(await startIntent('settings.close')).toEqual({ ok: null })
  })
  expect(stored.providers[0]?.baseUrl).toBe('https://composed.example/v1')
  expect(stored.providers[0]?.models).toEqual(['composed-model'])
  expect(stored.defaultChat).toBe('openai:composed-model')
  expect(stored.providers[0]?.keyEnc).toBe('pw2:original-envelope')
  expect(onClose).toHaveBeenCalledTimes(1)
})

/** Explicit deferred work exposes close/encryption interleavings without clock sleeps. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Starts an intent without awaiting it, allowing another state transition while it is in flight. */
function startIntent(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const reply = host.__pwNativeIntent?.({
    protocolVersion: 1,
    sessionId: 'settings-page',
    requestId: String(++serial),
    command,
    args,
  })
  if (!reply) throw new Error('native owner is unavailable')
  return reply
}

it('loading and failed loads refuse writes, while retry invalidates the old completion', async () => {
  const old = deferred<AppSettings>()
  const next = { ...stored, defaultChat: 'openai:gpt-4o' }
  vi.mocked(settingsStore.load)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(next)
  render(<SettingsView onClose={vi.fn()} />)
  expect(projection()?.phase).toBe('loading')
  expect(
    await intent('settings.patchProvider', {
      id: 'openai',
      patch: { enabled: false },
    }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(settingsStore.save).not.toHaveBeenCalled()
  expect(await intent('settings.retry')).toEqual({ ok: null })
  expect(projection()?.defaultChat).toBe('openai:gpt-4o')
  await act(async () => {
    old.resolve(stored)
    await old.promise
  })
  expect(projection()?.defaultChat).toBe('openai:gpt-4o')
})

it('load errors remain visible and retry never writes fallback defaults', async () => {
  vi.mocked(settingsStore.load).mockRejectedValueOnce(
    new Error('invalid prefs'),
  )
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('error'))
  expect(projection()?.error).toBe('invalid prefs')
  expect(
    await intent('settings.setDefaults', {
      defaultChat: null,
      defaultImage: null,
    }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(settingsStore.save).not.toHaveBeenCalled()
  expect(await intent('settings.retry')).toEqual({ ok: null })
  expect(projection()?.phase).toBe('ready')
  expect(settingsStore.save).not.toHaveBeenCalled()
})

it('failed close retains edits and returns an error before a successful retry navigates', async () => {
  const onClose = vi.fn()
  vi.mocked(settingsStore.save).mockRejectedValueOnce(new Error('disk full'))
  render(<SettingsView onClose={onClose} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  await intent('settings.patchProvider', {
    id: 'openai',
    patch: { models: ['edited-model'] },
  })
  expect(await intent('settings.close')).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(onClose).not.toHaveBeenCalled()
  expect(projection()?.closing).toBe(false)
  expect(projection()?.error).toContain('disk full')
  expect(await intent('settings.close')).toEqual({ ok: null })
  expect(stored.providers[0]?.models).toEqual(['edited-model'])
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('concurrent close intents await the same pending save and navigate once', async () => {
  const save = deferred<void>()
  const onClose = vi.fn()
  vi.mocked(settingsStore.save).mockReturnValueOnce(save.promise)
  render(<SettingsView onClose={onClose} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  await intent('settings.setDefaults', {
    defaultChat: 'openai:gpt-4o',
    defaultImage: null,
  })
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  try {
    await act(async () => {
      first = startIntent('settings.close')
      second = startIntent('settings.close')
    })
    await waitFor(() => expect(projection()?.closing).toBe(true))
    expect(onClose).not.toHaveBeenCalled()
    expect(settingsStore.save).toHaveBeenCalledTimes(1)
    expect(await intent('settings.removeKey', { id: 'openai' })).toMatchObject({
      error: { code: 'PW_INTENT_FAILED' },
    })
    await act(async () => {
      save.resolve()
      await Promise.all([first, second])
    })
    expect(await first).toEqual({ ok: null })
    expect(await second).toEqual({ ok: null })
    expect(onClose).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      save.resolve()
      await Promise.allSettled([first, second])
    })
  }
})

it('validates native input without enabling arbitrary provider or credential writes', async () => {
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  for (const patch of [
    { keyEnc: 'pw2:injected' },
    { id: 'other' },
    { enabled: 'yes' },
    { models: [1] },
    null,
  ]) {
    expect(
      await intent('settings.patchProvider', { id: 'openai', patch }),
    ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  }
  expect(
    await intent('settings.patchProvider', {
      id: 'missing',
      patch: { label: 'wrong' },
    }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(
    await intent('settings.setDefaults', {
      defaultChat: 123,
      defaultImage: null,
    }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(await intent('settings.unknown')).toMatchObject({
    error: { code: 'PW_INTENT_FAILED' },
  })
  expect(settingsStore.save).not.toHaveBeenCalled()
})

it('key encryption merges onto the latest provider without reverting concurrent native edits', async () => {
  const encryption = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(encryption.promise)
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  const initial = stored
  const encrypted = {
    ...initial,
    providers: initial.providers.map((item) =>
      item.id === 'openai' ? { ...item, keyEnc: 'pw2:new-envelope' } : item,
    ),
  }
  let pending!: Promise<unknown>
  try {
    await act(async () => {
      pending = startIntent('settings.setKey', {
        id: 'openai',
        key: '  secret-value  ',
      })
    })
    await waitFor(() =>
      expect(settingsStore.setProviderKey).toHaveBeenCalledWith(
        initial,
        'openai',
        'secret-value',
      ),
    )
    await intent('settings.patchProvider', {
      id: 'openai',
      patch: { baseUrl: 'https://updated.example/v1', models: ['new'] },
    })
    await intent('settings.setDefaults', {
      defaultChat: 'openai:new',
      defaultImage: null,
    })
    await act(async () => {
      encryption.resolve(encrypted)
      await pending
    })
    expect(await pending).toEqual({ ok: null })
    await intent('settings.close')
    expect(stored.providers[0]).toMatchObject({
      baseUrl: 'https://updated.example/v1',
      models: ['new'],
      keyEnc: 'pw2:new-envelope',
    })
    expect(stored.defaultChat).toBe('openai:new')
    expect(JSON.stringify(projection())).not.toContain('secret-value')
    expect(JSON.stringify(projection())).not.toContain('pw2:new-envelope')
  } finally {
    await act(async () => {
      encryption.resolve(encrypted)
      await Promise.allSettled([pending])
    })
  }
})

it('removing a key invalidates a late encryption completion rather than restoring the credential', async () => {
  const encryption = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(encryption.promise)
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  let pending!: Promise<unknown>
  await act(async () => {
    pending = startIntent('settings.setKey', { id: 'openai', key: 'secret' })
    await Promise.resolve()
  })
  await waitFor(() => expect(settingsStore.setProviderKey).toHaveBeenCalled())
  await intent('settings.removeKey', { id: 'openai' })
  await act(async () => {
    encryption.resolve(stored)
    await pending
  })
  expect(await pending).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(
    (projection()?.providers as Array<{ keyConfigured: boolean }>)[0]
      ?.keyConfigured,
  ).toBe(false)
  await intent('settings.close')
  expect(stored.providers[0]?.keyEnc).toBeUndefined()
})

it('unmount invalidates pending encryption and releases the settings intent owner', async () => {
  const encryption = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(encryption.promise)
  const view = render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  let pending!: Promise<unknown>
  await act(async () => {
    pending = startIntent('settings.setKey', { id: 'openai', key: 'secret' })
    await Promise.resolve()
  })
  await waitFor(() => expect(settingsStore.setProviderKey).toHaveBeenCalled())
  view.unmount()
  await act(async () => {
    encryption.resolve(stored)
    await pending
  })
  expect(await pending).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(settingsStore.save).not.toHaveBeenCalled()
  expect(host.__pwNativeIntent).toBeUndefined()
})

it('builtin provider labels retain the existing normalization constraint, while custom labels remain editable', async () => {
  stored.providers.push({
    id: 'custom',
    label: 'custom',
    baseUrl: 'https://custom.example/v1',
    enabled: true,
    models: ['m'],
  })
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  expect(
    await intent('settings.patchProvider', {
      id: 'openai',
      patch: { label: '我的服务' },
    }),
  ).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(
    await intent('settings.patchProvider', {
      id: 'custom',
      patch: { label: '我的服务' },
    }),
  ).toEqual({ ok: null })
  await intent('settings.close')
  expect(
    normalizeSettings(stored).providers.find(
      (provider) => provider.id === 'openai',
    )?.label,
  ).toBe('OpenAI 兼容')
  expect(
    normalizeSettings(stored).providers.find(
      (provider) => provider.id === 'custom',
    )?.label,
  ).toBe('我的服务')
})

it.each(['new load generation', 'removed provider'] as const)(
  'late key encryption cannot write after %s',
  async (transition) => {
    const encryption = deferred<AppSettings>()
    vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(
      encryption.promise,
    )
    const update = vi.fn()
    const generation = { current: 1 }
    const options: NativeSettingsOptions = {
      settings: stored,
      phase: 'ready',
      error: null,
      closing: false,
      loadGeneration: generation,
      update,
      requestClose: async () => true,
      trackPendingKey: (work) => work,
      reload: vi.fn(),
    }
    const view = renderHook((props) => useNativeSettingsShell(props), {
      initialProps: options,
    })
    let pending!: Promise<unknown>
    await act(async () => {
      pending = startIntent('settings.setKey', { id: 'openai', key: 'secret' })
      await Promise.resolve()
    })
    await waitFor(() => expect(settingsStore.setProviderKey).toHaveBeenCalled())
    if (transition === 'new load generation') generation.current += 1
    const settings =
      transition === 'removed provider'
        ? {
            ...stored,
            providers: stored.providers.filter(
              (provider) => provider.id !== 'openai',
            ),
          }
        : stored
    view.rerender({ ...options, settings })
    await act(async () => {
      encryption.resolve(stored)
      await pending
    })
    expect(await pending).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
    expect(update).not.toHaveBeenCalled()
    expect(projection()?.providers).toHaveLength(settings.providers.length)
  },
)

it('newer key request wins when encryptions complete in reverse order', async () => {
  const older = deferred<AppSettings>()
  const newer = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey')
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise)
  render(<SettingsView onClose={vi.fn()} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  await act(async () => {
    first = startIntent('settings.setKey', { id: 'openai', key: 'old-secret' })
    second = startIntent('settings.setKey', { id: 'openai', key: 'new-secret' })
    await Promise.resolve()
  })
  const encrypted = (keyEnc: string): AppSettings => ({
    ...stored,
    providers: stored.providers.map((provider) =>
      provider.id === 'openai' ? { ...provider, keyEnc } : provider,
    ),
  })
  await act(async () => {
    newer.resolve(encrypted('pw2:newer'))
    await second
  })
  expect(await second).toEqual({ ok: null })
  await act(async () => {
    older.resolve(encrypted('pw2:older'))
    await first
  })
  expect(await first).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  await intent('settings.close')
  expect(stored.providers[0]?.keyEnc).toBe('pw2:newer')
})

/** Swift termination reaches the same application-level exit listener as a real window close. */
function quitHost() {
  const events = window as Window & {
    __pwDispatchHostEvent?: (name: string, payload: unknown) => void
  }
  events.__pwDispatchHostEvent?.('app-quit-requested', null)
}

it('application quit waits for pending preferences instead of exiting before the settings debounce', async () => {
  const save = deferred<void>()
  vi.mocked(settingsStore.save).mockReturnValueOnce(save.promise)
  render(<SettingsView onClose={vi.fn()} />)
  const exit = renderHook(() => useExitFlush())
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  await intent('settings.setDefaults', {
    defaultChat: 'openai:gpt-4o',
    defaultImage: null,
  })
  const native = (
    host.webkit as {
      messageHandlers: {
        plotweaveHost: { postMessage: ReturnType<typeof vi.fn> }
      }
    }
  ).messageHandlers.plotweaveHost.postMessage
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'acknowledge_quit_listener' }),
    ),
  )
  await act(async () => {
    quitHost()
    await Promise.resolve()
  })
  expect(
    native.mock.calls.some(([payload]) => payload.command === 'app_exit'),
  ).toBe(false)
  expect(settingsStore.save).toHaveBeenCalledTimes(1)
  await act(async () => {
    save.resolve()
    await save.promise
  })
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'app_exit' }),
    ),
  )
  expect(exit.result.current).toBeNull()
})

it('settings close waits for encryption started before close and saves the resulting credential', async () => {
  const encryption = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(encryption.promise)
  const onClose = vi.fn()
  render(<SettingsView onClose={onClose} />)
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  let key!: Promise<unknown>
  await act(async () => {
    key = startIntent('settings.setKey', { id: 'openai', key: 'secret' })
    await Promise.resolve()
  })
  await waitFor(() => expect(settingsStore.setProviderKey).toHaveBeenCalled())
  let closing!: Promise<unknown>
  await act(async () => {
    closing = startIntent('settings.close')
    await Promise.resolve()
  })
  expect(onClose).not.toHaveBeenCalled()
  const encrypted = {
    ...stored,
    providers: stored.providers.map((provider) =>
      provider.id === 'openai' ? { ...provider, keyEnc: 'pw2:new' } : provider,
    ),
  }
  await act(async () => {
    encryption.resolve(encrypted)
    await Promise.all([key, closing])
  })
  expect(await key).toEqual({ ok: null })
  expect(await closing).toEqual({ ok: null })
  expect(stored.providers[0]?.keyEnc).toBe('pw2:new')
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('quit reports settings save failure and preserves the latest edit for a successful retry', async () => {
  vi.mocked(settingsStore.save).mockRejectedValueOnce(
    new Error('prefs disk full'),
  )
  render(<SettingsView onClose={vi.fn()} />)
  const exit = renderHook(() => useExitFlush())
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  await intent('settings.setDefaults', {
    defaultChat: 'openai:gpt-4o',
    defaultImage: null,
  })
  const native = (
    host.webkit as {
      messageHandlers: {
        plotweaveHost: { postMessage: ReturnType<typeof vi.fn> }
      }
    }
  ).messageHandlers.plotweaveHost.postMessage
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'acknowledge_quit_listener' }),
    ),
  )
  await act(async () => {
    quitHost()
    await Promise.resolve()
  })
  await waitFor(() => expect(exit.result.current).toContain('应用设置保存失败'))
  expect(
    native.mock.calls.some(([payload]) => payload.command === 'app_exit'),
  ).toBe(false)
  await act(async () => {
    quitHost()
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'app_exit' }),
    ),
  )
  expect(stored.defaultChat).toBe('openai:gpt-4o')
})

it('quit waits for a key edit through encryption and persistence before native exit', async () => {
  const encryption = deferred<AppSettings>()
  vi.spyOn(settingsStore, 'setProviderKey').mockReturnValue(encryption.promise)
  render(<SettingsView onClose={vi.fn()} />)
  renderHook(() => useExitFlush())
  await waitFor(() => expect(projection()?.phase).toBe('ready'))
  const native = (
    host.webkit as {
      messageHandlers: {
        plotweaveHost: { postMessage: ReturnType<typeof vi.fn> }
      }
    }
  ).messageHandlers.plotweaveHost.postMessage
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'acknowledge_quit_listener' }),
    ),
  )
  let key!: Promise<unknown>
  await act(async () => {
    key = startIntent('settings.setKey', { id: 'openai', key: 'secret' })
    await Promise.resolve()
  })
  await waitFor(() => expect(settingsStore.setProviderKey).toHaveBeenCalled())
  await act(async () => {
    quitHost()
    await Promise.resolve()
  })
  expect(
    native.mock.calls.some(([payload]) => payload.command === 'app_exit'),
  ).toBe(false)
  const encrypted = {
    ...stored,
    providers: stored.providers.map((provider) =>
      provider.id === 'openai'
        ? { ...provider, keyEnc: 'pw2:quit-key' }
        : provider,
    ),
  }
  await act(async () => {
    encryption.resolve(encrypted)
    await key
  })
  await waitFor(() =>
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'app_exit' }),
    ),
  )
  expect(stored.providers[0]?.keyEnc).toBe('pw2:quit-key')
})
