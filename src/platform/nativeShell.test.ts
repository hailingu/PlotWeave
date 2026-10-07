// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from './nativeShell'

/** Real bridge globals with deterministic host identity and message sink. */
const hostWindow = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}

const cleanups: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  delete hostWindow.__pwNativeHost
  delete hostWindow.webkit
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Installs the same session envelope the native document-start script supplies. */
function installHost(sessionId = 'page-a') {
  hostWindow.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId,
  }
}

/** Native intents bind both their request and current page identity. */
function request(command: string, requestId = 'r1', sessionId = 'page-a') {
  return { protocolVersion: 1, sessionId, requestId, command, args: {} }
}

describe('native shell intent ownership', () => {
  it('shares an in-flight result and preserves completion without repeating a mutation', async () => {
    installHost()
    let finish: ((value: unknown) => void) | undefined
    let created = 0
    cleanups.push(
      registerNativeIntentHandler('app', async () => {
        created += 1
        return new Promise((resolve) => {
          finish = resolve
        })
      }),
    )
    const first = hostWindow.__pwNativeIntent?.(request('app.createProject'))
    const duplicate = hostWindow.__pwNativeIntent?.(
      request('app.createProject'),
    )
    await vi.waitFor(() => expect(created).toBe(1))
    finish?.({ id: 'project-new' })
    expect(await first).toEqual({ ok: { id: 'project-new' } })
    expect(await duplicate).toEqual(await first)
    expect(
      await hostWindow.__pwNativeIntent?.(request('app.createProject')),
    ).toEqual(await first)
    expect(created).toBe(1)
  })

  it('rejects stale page identity and conflicting reuse before invoking actions', async () => {
    installHost()
    const action = vi.fn(async () => 'saved')
    cleanups.push(registerNativeIntentHandler('editor', action))
    expect(
      await hostWindow.__pwNativeIntent?.(
        request('editor.save', 'r1', 'old-page'),
      ),
    ).toMatchObject({
      error: { code: 'PW_STALE_SESSION' },
    })
    expect(action).not.toHaveBeenCalled()
    await hostWindow.__pwNativeIntent?.(request('editor.save'))
    expect(
      await hostWindow.__pwNativeIntent?.(request('editor.delete')),
    ).toMatchObject({
      error: { code: 'PW_REQUEST_CONFLICT' },
    })
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('rejects a late completion when the page identity changes', async () => {
    installHost()
    let finish: (() => void) | undefined
    cleanups.push(
      registerNativeIntentHandler(
        'app',
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
    )
    const pending = hostWindow.__pwNativeIntent?.(request('app.open'))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    installHost('page-b')
    finish?.()
    expect(await pending).toMatchObject({ error: { code: 'PW_STALE_SESSION' } })
  })

  it('publishes ordered read-only domain projections bound to the live session', () => {
    installHost()
    const postMessage = vi.fn()
    hostWindow.webkit = { messageHandlers: { canvasHost: { postMessage } } }
    publishNativeProjection('app', {
      route: 'home',
      projects: [{ id: 'p', name: '测试' }],
    })
    publishNativeProjection('editor', { projectId: 'p', canUndo: true })
    const first = postMessage.mock.calls[0]?.[0]
    const last = postMessage.mock.calls[1]?.[0]
    expect(last).toMatchObject({
      event: 'projection',
      protocolVersion: 1,
      sessionId: 'page-a',
      projection: {
        app: { route: 'home' },
        editor: { projectId: 'p', canUndo: true },
      },
    })
    expect(last.sequence).toBeGreaterThan(first.sequence)
  })
})

/** Explicit digest completion controls mutation admission independently of handler completion. */
function pendingDigest() {
  let resolve!: (value: ArrayBuffer) => void
  const promise = new Promise<ArrayBuffer>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('fingerprints credential-bearing intent payloads with SHA-256 and preserves reuse/conflict semantics', async () => {
  installHost()
  const digest = vi.spyOn(crypto.subtle, 'digest')
  const action = vi.fn(async () => null)
  cleanups.push(registerNativeIntentHandler('settings', action))
  const payload = {
    ...request('settings.setKey'),
    args: { id: 'provider', key: 'private-key' },
  }
  expect(await hostWindow.__pwNativeIntent?.(payload)).toEqual({ ok: null })
  expect(await hostWindow.__pwNativeIntent?.(payload)).toEqual({ ok: null })
  expect(
    await hostWindow.__pwNativeIntent?.({
      ...payload,
      args: { id: 'provider', key: 'different-key' },
    }),
  ).toMatchObject({ error: { code: 'PW_REQUEST_CONFLICT' } })
  expect(action).toHaveBeenCalledTimes(1)
  expect(digest).toHaveBeenCalledTimes(3)
  expect(
    digest.mock.calls.every(([algorithm]) => algorithm === 'SHA-256'),
  ).toBe(true)
})

it('registers one pending mutation before asynchronous digest completion', async () => {
  installHost()
  const firstDigest = pendingDigest()
  const secondDigest = pendingDigest()
  const digest = vi
    .spyOn(crypto.subtle, 'digest')
    .mockReturnValueOnce(firstDigest.promise)
    .mockReturnValueOnce(secondDigest.promise)
  const action = vi.fn(async () => 'created')
  cleanups.push(registerNativeIntentHandler('app', action))
  const first = hostWindow.__pwNativeIntent?.(request('app.create'))
  const second = hostWindow.__pwNativeIntent?.(request('app.create'))
  await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2))
  expect(action).not.toHaveBeenCalled()
  const hash = new Uint8Array(32).fill(1).buffer
  firstDigest.resolve(hash)
  expect(await first).toEqual({ ok: 'created' })
  secondDigest.resolve(hash)
  expect(await second).toEqual({ ok: 'created' })
  expect(action).toHaveBeenCalledTimes(1)
})

it('does not execute an old-session mutation when its digest finishes after reload', async () => {
  installHost()
  const digest = pendingDigest()
  vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise)
  const action = vi.fn()
  cleanups.push(registerNativeIntentHandler('app', action))
  const pending = hostWindow.__pwNativeIntent?.(request('app.create'))
  installHost('page-b')
  digest.resolve(new Uint8Array(32).buffer)
  expect(await pending).toMatchObject({ error: { code: 'PW_STALE_SESSION' } })
  expect(action).not.toHaveBeenCalled()
})

it('returns an explicit crypto failure without invoking a mutation or using a plaintext fallback', async () => {
  installHost()
  vi.stubGlobal('crypto', {})
  const action = vi.fn()
  cleanups.push(registerNativeIntentHandler('app', action))
  expect(
    await hostWindow.__pwNativeIntent?.(request('app.create')),
  ).toMatchObject({ error: { code: 'PW_INTENT_CRYPTO_UNAVAILABLE' } })
  expect(action).not.toHaveBeenCalled()
})

it('digest completion order cannot reverse distinct native edits, while owned async work stays concurrent', async () => {
  installHost()
  const firstDigest = pendingDigest()
  const secondDigest = pendingDigest()
  vi.spyOn(crypto.subtle, 'digest')
    .mockReturnValueOnce(firstDigest.promise)
    .mockReturnValueOnce(secondDigest.promise)
  const started: string[] = []
  let finishFirst!: () => void
  cleanups.push(
    registerNativeIntentHandler('settings', (_command, args) => {
      started.push(String(args.value))
      return args.value === 'old'
        ? new Promise<void>((resolve) => {
            finishFirst = resolve
          })
        : null
    }),
  )
  const old = hostWindow.__pwNativeIntent?.({
    ...request('settings.patch', 'first'),
    args: { value: 'old' },
  })
  const newer = hostWindow.__pwNativeIntent?.({
    ...request('settings.patch', 'second'),
    args: { value: 'new' },
  })
  await Promise.resolve()
  secondDigest.resolve(new Uint8Array(32).fill(2).buffer)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(started).toEqual([])
  firstDigest.resolve(new Uint8Array(32).fill(1).buffer)
  await vi.waitFor(() => expect(started).toEqual(['old', 'new']))
  expect(await newer).toEqual({ ok: null })
  finishFirst()
  expect(await old).toEqual({ ok: null })
})
