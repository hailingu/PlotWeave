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

/** File and metadata scenarios share named completion gates without scheduling real delays. */
function pauseByName(
  gates: Map<string, ReturnType<typeof decision>>,
  name: string,
) {
  const gate = decision()
  gates.set(name, gate)
  return gate
}

/** Storage changes only on acknowledged success; the first deletion is controlled and imports may reject by filename. */
function mutationStorage(
  options: { holdList?: boolean; holdMedia?: boolean } = {},
) {
  const original = storedAsset('原有.png')
  const assets = new Map([[original.id, original]])
  const deletion = decision()
  const listing = decision()
  const media = decision()
  const mediaRequests: string[] = []
  const importGates = new Map<string, ReturnType<typeof decision>>()
  const renameGates = new Map<string, ReturnType<typeof decision>>()
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
    if (command === IPC_COMMANDS.listLibraryAssets) {
      const byId = structuredClone(Object.fromEntries(assets))
      if (options.holdList) await listing.promise
      return { assets: { byId } }
    }
    if (command === IPC_COMMANDS.getAssetMediaUrl) {
      mediaRequests.push(args.assetId)
      if (options.holdMedia) await media.promise
      return `blob:${args.assetId}`
    }
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
      if (args.patch.name) await renameGates.get(args.patch.name)?.promise
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
    listing,
    media,
    mediaRequests,
    imported,
    names: () => [...assets.values()].map((a) => a.name),
    pauseImport: (name: string) => pauseByName(importGates, name),
    pauseRename: (name: string) => pauseByName(renameGates, name),
  }
}

/** Mount the real panel and wait for its initially persisted thumbnail before mutating it. */
async function mountOtherAssets(withThumbnail = true) {
  render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('其他'))
  if (withThumbnail) await screen.findByAltText('原有.png')
  else await screen.findByRole('button', { name: '原有.png' })
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

it('keeps acknowledged imports, continues the remaining files after a rejection, and resets the input for retry (#719)', async () => {
  const storage = mutationStorage()
  const second = storage.pauseImport('坏图.png')
  await mountOtherAssets()
  const input = pickFiles(['成功.png', '坏图.png', '未处理.png'])
  await waitFor(() =>
    expect(storage.imported).toEqual(['成功.png', '坏图.png']),
  )
  expect(input.value).toContain('fakepath')
  await act(async () => second.reject(new Error('文件不可读')))
  // #719: the rejection no longer aborts the batch — the remaining file is still imported.
  expect(await screen.findByRole('button', { name: '未处理.png' })).toBeTruthy()
  expect(await screen.findByText(/成功 2 个，失败 1 个/)).toBeTruthy()
  expect(screen.getByText(/坏图.png.*文件不可读/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '成功.png' })).toBeTruthy()
  expect(storage.imported).toEqual(['成功.png', '坏图.png', '未处理.png'])
  expect(storage.names()).toEqual(['原有.png', '成功.png', '未处理.png'])
  expect(input.value).toBe('')
  pickFiles(['重试.png'])
  expect(await screen.findByRole('button', { name: '重试.png' })).toBeTruthy()
  expect(storage.names()).toEqual([
    '原有.png',
    '成功.png',
    '未处理.png',
    '重试.png',
  ])
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

it('admits imports only after the initial list settles, including the hidden file entry', async () => {
  const storage = mutationStorage({ holdList: true })
  render(<AssetsPanel />)
  fireEvent.click(screen.getByText('其他'))
  try {
    expect
      .soft(
        (screen.getByRole('button', { name: '＋ 导入' }) as HTMLButtonElement)
          .disabled,
      )
      .toBe(true)
    pickFiles(['等待.png'])
    await act(async () => {})
    expect.soft(storage.imported).toEqual([])
  } finally {
    await act(async () => storage.listing.resolve())
  }
  await screen.findByAltText('原有.png')
  pickFiles(['就绪.png'])
  expect(await screen.findByRole('button', { name: '就绪.png' })).toBeTruthy()
  expect(storage.names()).toEqual(['原有.png', '就绪.png'])
})

it.each([true, false])(
  'revokes the pending thumbnail beforeDeleteAck=%s without reviving a deleted cache',
  async (beforeDeleteAck) => {
    const storage = mutationStorage({ holdMedia: true })
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    await mountOtherAssets(false)
    await waitFor(() =>
      expect(storage.mediaRequests).toEqual([storage.original.id]),
    )
    await confirmRemoval()
    if (beforeDeleteAck) await act(async () => storage.media.resolve())
    await act(async () => storage.deletion.resolve())
    if (!beforeDeleteAck) await act(async () => storage.media.resolve())
    expect(storage.names()).toEqual([])
    expect(screen.queryByRole('button', { name: '原有.png' })).toBeNull()
    expect(revoke).toHaveBeenCalledExactlyOnceWith(
      `blob:${storage.original.id}`,
    )
  },
)

it('keeps a pending thumbnail valid when deletion rejects', async () => {
  const storage = mutationStorage({ holdMedia: true })
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  await mountOtherAssets(false)
  await waitFor(() =>
    expect(storage.mediaRequests).toEqual([storage.original.id]),
  )
  await confirmRemoval()
  await act(async () => storage.deletion.reject(new Error('拒绝删除')))
  expect(await screen.findByRole('button', { name: '原有.png' })).toBeTruthy()
  await act(async () => storage.media.resolve())
  expect(await screen.findByAltText('原有.png')).toBeTruthy()
  expect(revoke).not.toHaveBeenCalled()
  expect(storage.names()).toEqual(['原有.png'])
})

it('releases an unresolved thumbnail after its panel unmounts', async () => {
  const storage = mutationStorage({ holdMedia: true })
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  await mountOtherAssets(false)
  await waitFor(() =>
    expect(storage.mediaRequests).toEqual([storage.original.id]),
  )
  cleanup()
  await act(async () => storage.media.resolve())
  expect(revoke).toHaveBeenCalledExactlyOnceWith(`blob:${storage.original.id}`)
})

it('does not start a new thumbnail for an import acknowledged after unmount', async () => {
  const storage = mutationStorage()
  const importGate = storage.pauseImport('迟到.png')
  await mountOtherAssets()
  pickFiles(['迟到.png'])
  await waitFor(() => expect(storage.imported).toEqual(['迟到.png']))
  cleanup()
  await act(async () => importGate.resolve())
  expect(storage.names()).toEqual(['原有.png', '迟到.png'])
  expect(storage.mediaRequests).toEqual([storage.original.id])
})

it.each([
  ['listed', false, false],
  ['imported', false, false],
  ['listed', true, false],
  ['imported', true, false],
  ['listed', false, true],
  ['imported', false, true],
] as const)(
  'restores durable %s metadata: renameSucceeds=%s, settledBeforeConfirm=%s',
  async (origin, renameSucceeds, settledBeforeConfirm) => {
    const storage = mutationStorage()
    const renaming = storage.pauseRename('待决.png')
    await mountOtherAssets()
    const originalName = origin === 'listed' ? '原有.png' : '新导入.png'
    if (origin === 'imported') {
      pickFiles([originalName])
      await screen.findByRole('button', { name: originalName })
    }
    const target = (await libraryStore.list()).find(
      (asset) => asset.name === originalName,
    )
    if (!target) throw new Error('Missing independently persisted fixture')
    expect(libraryStore.persistedSnapshot(target.id)).toBeUndefined()
    fireEvent.doubleClick(screen.getByRole('button', { name: originalName }))
    const input = screen.getByRole('textbox', {
      name: `资产名 ${originalName}`,
    })
    fireEvent.change(input, { target: { value: '待决.png' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await screen.findByRole('button', { name: '待决.png' })
    fireEvent.click(screen.getByRole('button', { name: '删除资产 待决.png' }))
    const confirm = await screen.findByRole('button', { name: '删除' })
    const settleRename = async () => {
      await act(async () => {
        if (renameSucceeds) renaming.resolve()
        else renaming.reject(new Error('改名拒绝'))
      })
    }
    if (settledBeforeConfirm) await settleRename()
    fireEvent.click(confirm)
    if (!settledBeforeConfirm) await settleRename()
    await act(async () => storage.deletion.reject(new Error('删除拒绝')))
    expect(await screen.findByText(/删除拒绝/)).toBeTruthy()
    const expectedName = renameSucceeds ? '待决.png' : originalName
    const absentName = renameSucceeds ? originalName : '待决.png'
    expect(screen.getByRole('button', { name: expectedName })).toBeTruthy()
    expect(screen.queryByRole('button', { name: absentName })).toBeNull()
    expect(screen.queryByText(/改名拒绝/)).toBeNull()
    expect(storage.names()).toEqual(
      origin === 'listed' ? [expectedName] : ['原有.png', expectedName],
    )
  },
)

it('cancelling a pending delete keeps the real rename failure and rollback active', async () => {
  const storage = mutationStorage()
  const renaming = storage.pauseRename('待决.png')
  await mountOtherAssets()
  fireEvent.doubleClick(screen.getByRole('button', { name: '原有.png' }))
  const input = screen.getByRole('textbox', { name: '资产名 原有.png' })
  fireEvent.change(input, { target: { value: '待决.png' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
  await screen.findByRole('button', { name: '待决.png' })
  fireEvent.click(screen.getByRole('button', { name: '删除资产 待决.png' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消' }))
  await act(async () => renaming.reject(new Error('改名拒绝')))
  expect(await screen.findByText(/改名拒绝/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '原有.png' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '待决.png' })).toBeNull()
  expect(storage.names()).toEqual(['原有.png'])
})
