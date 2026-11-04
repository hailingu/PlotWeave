// @vitest-environment happy-dom
/** #850: real Web settings owner/store/saver with delayed encryption at the host boundary. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IPC_COMMANDS } from '../ipc/commands'
import { setHostCommandTransportForTests } from '../ipc/invoke'
import { SettingsView } from './SettingsView'
import { defaultSettings, type AppSettings } from './types'

/** Synthetic host replies hold encryption independently from preference persistence. */
interface Encryption {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

const host = window as Window & { __TAURI_INTERNALS__?: object }
let stored: AppSettings
let writes: AppSettings[]
let encryptions: Encryption[]

beforeEach(() => {
  stored = defaultSettings()
  stored.providers[0].keyEnc = 'pw2:original-openai'
  stored.providers[1].keyEnc = 'pw2:original-ark'
  writes = []
  encryptions = []
  host.__TAURI_INTERNALS__ = {}
  setHostCommandTransportForTests(
    async <T,>(command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case IPC_COMMANDS.loadPrefs:
          return structuredClone(stored) as T
        case IPC_COMMANDS.savePrefs:
          stored = JSON.parse(JSON.stringify(args?.prefs)) as AppSettings
          writes.push(structuredClone(stored))
          return undefined as T
        case IPC_COMMANDS.setProviderKey:
          return new Promise<string>((resolve, reject) => {
            encryptions.push({ resolve, reject })
          }) as Promise<T>
        default:
          throw new Error(`Unexpected settings command: ${command}`)
      }
    },
  )
})

afterEach(() => {
  cleanup()
  setHostCommandTransportForTests(null)
  delete host.__TAURI_INTERNALS__
  vi.useRealTimers()
})

/** Loads the real editor before starting the controlled debounce clock. */
async function openSettings() {
  let resolveClose!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  const onClose = vi.fn(resolveClose)
  render(<SettingsView onClose={onClose} />)
  await screen.findByText('OpenAI 兼容')
  vi.useFakeTimers()
  return Object.assign(onClose, { closed })
}

/** Exercises either public key submission entry without replacing the store. */
function submitKey(value: string, index = 0, enter = false) {
  const input = screen.getByLabelText(
    index === 0 ? 'OpenAI 兼容 API key' : '火山引擎 Ark API key',
  )
  fireEvent.change(input, { target: { value } })
  if (enter) fireEvent.keyDown(input, { key: 'Enter' })
  else fireEvent.click(screen.getAllByRole('button', { name: '保存' })[index])
}

/** Closes through the real fixed-point flush, then checks the caller-visible close outcome. */
async function closeSettings(
  onClose: Awaited<ReturnType<typeof openSettings>>,
) {
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  await onClose.closed
  expect(onClose).toHaveBeenCalledTimes(1)
}

it.each(['success', 'failure'])(
  'clear invalidates a late encryption %s, including close flush',
  async (outcome) => {
    const onClose = await openSettings()
    submitKey('synthetic-obsolete')
    fireEvent.click(screen.getAllByRole('button', { name: '清除' })[0])
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(stored.providers[0].keyEnc).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      if (outcome === 'success') encryptions[0].resolve('pw2:obsolete')
      else encryptions[0].reject(new Error('obsolete encryption failure'))
    })
    expect(screen.queryByText(/obsolete encryption failure/)).toBeNull()
    expect(screen.getAllByText('未配置')).toHaveLength(1)
    expect(stored.providers[0].keyEnc).toBeUndefined()
    expect(writes.length).toBeGreaterThan(0)
    expect(
      writes.every((snapshot) => snapshot.providers[0].keyEnc === undefined),
    ).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  },
)

it('merges only keyEnc while preserving current provider edits, other providers and defaults', async () => {
  const onClose = await openSettings()
  submitKey('synthetic-new')
  const addresses = screen.getAllByRole('textbox', { name: /BASE URL/ })
  fireEvent.change(addresses[0], {
    target: { value: 'https://new.example/v1' },
  })
  fireEvent.change(addresses[1], {
    target: { value: 'https://other.example/v1' },
  })
  fireEvent.click(screen.getAllByRole('checkbox')[1])
  fireEvent.change(
    screen
      .getAllByRole('textbox')
      .find((element) => element.tagName === 'TEXTAREA')!,
    {
      target: { value: 'new-chat\nnew-image' },
    },
  )
  fireEvent.change(screen.getByRole('combobox', { name: /AI 对话模型/ }), {
    target: { value: 'openai:new-chat' },
  })
  fireEvent.change(screen.getByRole('combobox', { name: /图像生成模型/ }), {
    target: { value: 'openai:new-image' },
  })
  await act(async () => encryptions[0].resolve('pw2:new'))
  expect((addresses[0] as HTMLInputElement).value).toBe(
    'https://new.example/v1',
  )
  expect(
    (
      screen.getByRole('combobox', {
        name: /AI 对话模型/,
      }) as HTMLSelectElement
    ).value,
  ).toBe('openai:new-chat')
  await closeSettings(onClose)
  expect(stored.providers[0]).toMatchObject({
    keyEnc: 'pw2:new',
    baseUrl: 'https://new.example/v1',
    models: ['new-chat', 'new-image'],
  })
  expect(stored.providers[1]).toMatchObject({
    keyEnc: 'pw2:original-ark',
    baseUrl: 'https://other.example/v1',
    enabled: false,
  })
  expect(stored.defaultChat).toBe('openai:new-chat')
  expect(stored.defaultImage).toBe('openai:new-image')
})

it.each(['success', 'failure'])(
  'a superseded %s cannot overwrite the newer key or its form state',
  async (outcome) => {
    const onClose = await openSettings()
    submitKey('synthetic-first')
    submitKey('synthetic-second', 0, true)
    await act(async () => encryptions[1].resolve('pw2:second'))
    fireEvent.change(screen.getByLabelText('OpenAI 兼容 API key'), {
      target: { value: 'later draft' },
    })
    await act(async () => {
      if (outcome === 'success') encryptions[0].resolve('pw2:first')
      else encryptions[0].reject(new Error('superseded failure'))
    })
    expect(
      (screen.getByLabelText('OpenAI 兼容 API key') as HTMLInputElement).value,
    ).toBe('later draft')
    expect(screen.queryByText(/superseded failure/)).toBeNull()
    await closeSettings(onClose)
    expect(stored.providers[0].keyEnc).toBe('pw2:second')
  },
)

it('independent provider completions in one React batch retain both encrypted keys', async () => {
  const onClose = await openSettings()
  submitKey('synthetic-openai')
  submitKey('synthetic-ark', 1)
  await act(async () => {
    encryptions[0].resolve('pw2:new-openai')
    encryptions[1].resolve('pw2:new-ark')
  })
  await closeSettings(onClose)
  expect(stored.providers.map((provider) => provider.keyEnc)).toEqual([
    'pw2:new-openai',
    'pw2:new-ark',
  ])
})

it('latest failure remains visible after an older success, and a fresh submission recovers', async () => {
  const onClose = await openSettings()
  submitKey('synthetic-first')
  submitKey('synthetic-second')
  await act(async () =>
    encryptions[1].reject(new Error('current encryption failure')),
  )
  expect(screen.getByText(/current encryption failure/)).toBeTruthy()
  await act(async () => encryptions[0].resolve('pw2:obsolete'))
  expect(screen.getByText(/current encryption failure/)).toBeTruthy()
  await act(async () => vi.advanceTimersByTime(600))
  expect(stored.providers[0].keyEnc).toBe('pw2:original-openai')
  submitKey('synthetic-retry')
  await act(async () => encryptions[2].resolve('pw2:retry'))
  expect(screen.queryByText(/current encryption failure/)).toBeNull()
  await closeSettings(onClose)
  expect(stored.providers[0].keyEnc).toBe('pw2:retry')
})

it('a valid receipt preserves a draft typed after submission while close waits for persistence', async () => {
  const onClose = await openSettings()
  submitKey('synthetic-submitted')
  fireEvent.change(screen.getByLabelText('OpenAI 兼容 API key'), {
    target: { value: 'later draft' },
  })
  fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => encryptions[0].resolve('pw2:submitted'))
  expect(
    (screen.getByLabelText('OpenAI 兼容 API key') as HTMLInputElement).value,
  ).toBe('later draft')
  expect(stored.providers[0].keyEnc).toBe('pw2:submitted')
  expect(onClose).toHaveBeenCalledTimes(1)
})
