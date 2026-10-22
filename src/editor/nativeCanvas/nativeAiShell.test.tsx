// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AiThread } from '../panels/AiThread'
import { settingsStore } from '../../settings/settingsStore'
import type { AiSession } from '../../ai/session'

/** Native actions drive the production AI session; model transport alone is deterministic. */
const host = window as Window & {
  __pwNativeHost?: unknown
  __pwNativeIntent?: (request: unknown) => Promise<unknown>
  webkit?: unknown
}
let requestId = 0
/** Commands retain project targeting and session identity just like the native UI. */
function intent(command: string, args: Record<string, unknown> = {}) {
  return host.__pwNativeIntent?.({
    protocolVersion: 1,
    sessionId: 'ai-page',
    requestId: String(++requestId),
    command,
    args: { projectId: 'p', ...args },
  })
}
afterEach(() => {
  cleanup()
  delete host.__pwNativeHost
  delete host.webkit
  vi.restoreAllMocks()
})

it('native AI send persists user/assistant history and clear requires confirmation', async () => {
  Element.prototype.scrollTo = vi.fn()
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['model'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: 'test:model',
    defaultImage: null,
  })
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'ai-page',
  }
  const postMessage = vi.fn(async () => ({
    ok: { role: 'assistant', content: '故事继续。' },
  }))
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage },
    },
  }
  const saved: AiSession[] = []
  render(
    <AiThread
      projectId="p"
      onSaveSession={async (session) => {
        saved.push(session)
      }}
    />,
  )
  await waitFor(() => expect(host.__pwNativeIntent).toBeTypeOf('function'))
  let result: unknown
  await act(async () => {
    result = await intent('ai.send', { text: '继续写', projectId: 'old' })
  })
  expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  expect(postMessage).not.toHaveBeenCalled()
  await act(async () => {
    result = await intent('ai.send', { text: '继续写' })
  })
  expect(result).toEqual({ ok: null })
  await waitFor(() =>
    expect(saved[saved.length - 1]?.entries.map((entry) => entry.text)).toEqual(
      ['继续写', '故事继续。'],
    ),
  )
  await act(async () => {
    result = await intent('ai.clear')
  })
  expect(result).toMatchObject({ error: { code: 'PW_INTENT_FAILED' } })
  await act(async () => {
    await intent('ai.clear', { confirmed: true })
  })
  await waitFor(() => expect(saved[saved.length - 1]?.entries).toEqual([]))
})

it('native model choice is committed before a following send in the same task', async () => {
  Element.prototype.scrollTo = vi.fn()
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['one', 'two'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: 'test:one',
    defaultImage: null,
  })
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'ai-page',
  }
  const requests: unknown[] = []
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: {
        postMessage: async (request: unknown) => {
          requests.push(request)
          return { ok: { role: 'assistant', content: '继续。' } }
        },
      },
    },
  }
  render(<AiThread projectId="p" />)
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await intent('ai.selectModel', { model: 'test:two' })
    await intent('ai.send', { text: '模型二' })
  })
  const models = requests.map(
    (request) => (request as { args: { model: string } }).args.model,
  )
  expect(models.length).toBeGreaterThan(0)
  expect(models.every((model) => model === 'two')).toBe(true)
})

it('native cancel remains reachable and late model completion cannot append an assistant', async () => {
  Element.prototype.scrollTo = vi.fn()
  vi.spyOn(settingsStore, 'load').mockResolvedValue({
    providers: [
      {
        id: 'test',
        label: '测试',
        baseUrl: 'https://example.test/v1',
        enabled: true,
        models: ['model'],
        keyEnc: 'fixture',
      },
    ],
    defaultChat: 'test:model',
    defaultImage: null,
  })
  host.__pwNativeHost = {
    kind: 'swift',
    protocolVersion: 1,
    sessionId: 'ai-page',
  }
  let finish!: (value: unknown) => void
  const postMessage = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  host.webkit = {
    messageHandlers: {
      canvasHost: { postMessage: vi.fn() },
      plotweaveHost: { postMessage },
    },
  }
  const saved: AiSession[] = []
  render(
    <AiThread
      projectId="p"
      onSaveSession={async (value) => {
        saved.push(value)
      }}
    />,
  )
  await act(async () => {
    await Promise.resolve()
  })
  let send: Promise<unknown> | undefined
  await act(async () => {
    send = intent('ai.send', { text: '请写下一场' })
  })
  await waitFor(() => expect(postMessage).toHaveBeenCalled())
  await act(async () => {
    await intent('ai.cancel')
    finish({ ok: { role: 'assistant', content: '迟到内容' } })
    await send
  })
  await waitFor(() =>
    expect(
      saved[saved.length - 1]?.entries.some((entry) => entry.kind === 'note'),
    ).toBe(true),
  )
  expect(
    saved[saved.length - 1]?.entries.some(
      (entry) => entry.role === 'assistant',
    ),
  ).toBe(false)
})
