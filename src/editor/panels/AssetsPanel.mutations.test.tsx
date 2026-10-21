// @vitest-environment happy-dom
/** #700: real panel and library facade reconcile acknowledged storage results; only IPC is controlled. */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  setHostCommandTransportForTests,
  type HostCommandTransport,
} from '../../ipc/invoke'
import { AssetsPanel } from './AssetsPanel'
import { stubIntersectionObserver } from './testDomStubs'
import { resetRenameStateForTests } from './assetsRenameState'
import {
  libraryStore,
  type LibraryAsset,
  type LibraryKind,
} from '../../library/libraryStore'
import { IPC_COMMANDS } from '../../ipc/commands'

vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
})
const invoke =
  vi.fn<(...args: Parameters<HostCommandTransport>) => Promise<unknown>>()

beforeAll(() => {
  stubIntersectionObserver(true)
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invoke.mockReset()
  setHostCommandTransportForTests(null)
  resetRenameStateForTests()
})
afterAll(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.unstubAllGlobals()
})

let nextId = 0

/** Each test owns a valid persisted asset, so real facade queues and snapshots cannot leak across cases. */
function storedAsset(name: string, kind: LibraryKind = 'other'): LibraryAsset {
  return {
    id: `mutation-${++nextId}`,
    name,
    kind,
    mime: 'image/png',
    view: null,
    relPath: `assets/mutation-${nextId}.png`,
    tags: [],
    groupId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Completion is released by the scenario, never by elapsed wall-clock time. */
function decision() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Storage changes only on acknowledged success; the first deletion is controlled and imports may reject by filename. */
function mutationStorage() {
  const original = storedAsset('原有.png')
  const assets = new Map([[original.id, original]])
  const deletion = decision()
  const importGates = new Map<string, ReturnType<typeof decision>>()
  const imported: string[] = []
  let deletes = 0
  invoke.mockImplementation(async (command, raw) => {
    const args = raw as {
      id: string
      name: string
      kind: LibraryKind
      patch: Partial<LibraryAsset>
      assetId: string
    }
    if (command === IPC_COMMANDS.listLibraryAssets)
      return { assets: { byId: Object.fromEntries(assets) } }
    if (command === IPC_COMMANDS.getAssetMediaUrl) return `blob:${args.assetId}`
    if (command === IPC_COMMANDS.deleteLibraryAsset) {
      deletes += 1
      if (deletes === 1) await deletion.promise
      assets.delete(args.id)
      return {}
    }
    if (command === IPC_COMMANDS.importLibraryAsset) {
      imported.push(args.name)
      await importGates.get(args.name)?.promise
      const asset = storedAsset(args.name, args.kind)
      assets.set(asset.id, asset)
      return structuredClone(asset)
    }
    if (command === IPC_COMMANDS.updateLibraryAsset) {
      const current = assets.get(args.id)
      if (!current) throw new Error('missing asset')
      const updated = { ...current, ...args.patch }
      assets.set(args.id, updated)
      return structuredClone(updated)
    }
    throw new Error(`Unexpected IPC: ${command}`)
  })
  setHostCommandTransportForTests(
    <T,>(...args: Parameters<HostCommandTransport>) =>
      invoke(...args) as Promise<T>,
  )
  return {
    original,
    deletion,
    imported,
    names: () => [...assets.values()].map((a) => a.name),
    pauseImport: (name: string) => {
      const gate = decision()
      importGates.set(name, gate)
      return gate
    },
  }
}

/** Mount the real panel and wait for its initially persisted thumbnail before mutating it. */
async function mountOtherAssets() {
  render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('其他'))
  await screen.findByAltText('原有.png')
}

/** A real confirmation still owns admission; tests never call the deletion helper directly. */
async function confirmRemoval(name = '原有.png') {
  fireEvent.click(screen.getByRole('button', { name: `删除资产 ${name}` }))
  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
}

/** Only File.arrayBuffer is adapted for happy-dom; the real facade still executes bounded import and IPC normalization. */
function pickFiles(names: string[]) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  const files = names.map((name) => {
    const file = new File(['image'], name, { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([1]).buffer,
    })
    return file
  })
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  // Injected FileList does not update happy-dom's fake path; model it so clearing is observable.
  Object.defineProperty(input, 'value', {
    configurable: true,
    writable: true,
    value: 'C:\\fakepath\\picked.png',
  })
  fireEvent.change(input)
  return input
}

it('restores a rejected optimistic deletion, keeps its thumbnail, and allows a successful retry', async () => {
  const storage = mutationStorage()
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  await mountOtherAssets()
  await confirmRemoval()
  expect(screen.queryByRole('button', { name: '原有.png' })).toBeNull()
  await act(async () => storage.deletion.reject(new Error('删除拒绝')))
  expect(await screen.findByText(/删除拒绝/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '原有.png' })).toBeTruthy()
  expect(storage.names()).toEqual(['原有.png'])
  expect(revoke).not.toHaveBeenCalled()
  expect(screen.getByAltText('原有.png').getAttribute('src')).toBe(
    `blob:${storage.original.id}`,
  )
  await confirmRemoval()
  await waitFor(() =>
    expect(revoke).toHaveBeenCalledExactlyOnceWith(
      `blob:${storage.original.id}`,
    ),
  )
  expect(storage.names()).toEqual([])
  expect(screen.queryByRole('button', { name: '原有.png' })).toBeNull()
  expect(screen.queryByText(/删除拒绝/)).toBeNull()
})

it('keeps acknowledged imports after a later file rejects and resets the input for retry', async () => {
  const storage = mutationStorage()
  const second = storage.pauseImport('坏图.png')
  await mountOtherAssets()
  const input = pickFiles(['成功.png', '坏图.png', '未处理.png'])
  await waitFor(() =>
    expect(storage.imported).toEqual(['成功.png', '坏图.png']),
  )
  expect(input.value).toContain('fakepath')
  await act(async () => second.reject(new Error('文件不可读')))
  expect(await screen.findByText(/坏图.png.*文件不可读/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '成功.png' })).toBeTruthy()
  expect(storage.names()).toEqual(['原有.png', '成功.png'])
  expect(input.value).toBe('')
  pickFiles(['重试.png'])
  expect(await screen.findByRole('button', { name: '重试.png' })).toBeTruthy()
  expect(storage.names()).toEqual(['原有.png', '成功.png', '重试.png'])
  expect(screen.queryByText(/文件不可读/)).toBeNull()
})

it('publishes each successful import before the next one completes', async () => {
  const storage = mutationStorage()
  const second = storage.pauseImport('稍后.png')
  await mountOtherAssets()
  pickFiles(['先到.png', '稍后.png'])
  await waitFor(() =>
    expect(storage.imported).toEqual(['先到.png', '稍后.png']),
  )
  try {
    expect(screen.getByRole('button', { name: '先到.png' })).toBeTruthy()
    expect(storage.names()).toEqual(['原有.png', '先到.png'])
  } finally {
    await act(async () => second.resolve())
  }
  expect(await screen.findByRole('button', { name: '稍后.png' })).toBeTruthy()
})

it('restores the facade persisted baseline and preserves imports completed during a rejected delete', async () => {
  const storage = mutationStorage()
  await mountOtherAssets()
  await libraryStore.updateMeta(storage.original.id, { name: '最近落盘.png' })
  await confirmRemoval()
  pickFiles(['并行导入.png'])
  expect(
    await screen.findByRole('button', { name: '并行导入.png' }),
  ).toBeTruthy()
  await act(async () => storage.deletion.reject(new Error('日志冲突')))
  expect(await screen.findByText(/日志冲突/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '最近落盘.png' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '并行导入.png' })).toHaveLength(
    1,
  )
  expect(storage.names()).toEqual(['最近落盘.png', '并行导入.png'])
})
