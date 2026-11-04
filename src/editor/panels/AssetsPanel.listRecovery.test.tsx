// @vitest-environment happy-dom
/** #853：真实面板和库门面的读取恢复；仅 IPC 完成次序与故障可控。 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { AssetsPanel } from './AssetsPanel'
import { stubIntersectionObserver } from './testDomStubs'
import { resetRenameStateForTests } from './assetsRenameState'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeAll(() => {
  stubIntersectionObserver()
})
afterEach(() => {
  cleanup()
  resetRenameStateForTests()
  vi.mocked(invoke).mockReset()
})
afterAll(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.unstubAllGlobals()
})

/** 可控读取回执，不使用时钟决定事件次序。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let nextId = 0
/** IPC 存储替身保留真实门面的通知、排序和读取规范化。 */
function storage() {
  let asset: LibraryAsset = {
    id: `recovery-${++nextId}`,
    name: '角色',
    kind: 'character',
    view: null,
    mime: 'image/png',
    relPath: 'assets/character.png',
    tags: [],
    groupId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const reads: ReturnType<typeof deferred<unknown>>[] = []
  const failures = new Map<string, string>()
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    if (command === 'list_library_assets') {
      const read = deferred<unknown>()
      reads.push(read)
      return read.promise
    }
    const failure = failures.get(command)
    if (failure) throw new Error(failure)
    if (command === 'update_library_asset') {
      const { patch } = raw as { patch: Partial<LibraryAsset> }
      asset = { ...asset, ...patch }
      return structuredClone(asset)
    }
    if (command === 'import_library_asset') return structuredClone(asset)
    throw new Error(`意外 IPC：${command}`)
  })
  return {
    asset,
    failures,
    succeed: async (index: number, name = '角色') => {
      await act(async () => {})
      await act(async () => {
        reads[index]!.resolve({
          assets: { byId: { [asset.id]: { ...asset, name } } },
        })
      })
    },
    fail: async (index: number, message = '列表暂不可读') => {
      await act(async () => {})
      await act(async () => reads[index]!.reject(new Error(message)))
    },
    refresh: async () => {
      await act(async () => {
        await libraryStore.updateMeta(asset.id, { view: 'front' })
      })
    },
  }
}

/** 通过真实文件输入触发导入，File 只适配 happy-dom 缺少的 arrayBuffer。 */
function importFile() {
  const file = new File(['image'], '角色.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([1]).buffer,
  })
  fireEvent.change(document.querySelector('input[type=file]')!, {
    target: { files: [file] },
  })
}

describe('资产列表读取恢复（#853）', () => {
  it('失败后通知重读成功，更新列表并清除旧读取错误', async () => {
    const store = storage()
    render(<AssetsPanel />)
    await store.fail(0)
    expect(screen.getByText('Error: 列表暂不可读')).toBeTruthy()
    await store.refresh()
    await store.succeed(1, '恢复角色')
    expect(screen.queryByText('Error: 列表暂不可读')).toBeNull()
    fireEvent.click(screen.getByText('角色设定'))
    expect(
      screen.getByRole('button', { name: '删除资产 恢复角色' }),
    ).toBeTruthy()
  })

  it('重试开始保留旧错误，重试失败显示当前失败', async () => {
    const store = storage()
    render(<AssetsPanel />)
    await store.fail(0)
    await store.refresh()
    expect(screen.getByText('Error: 列表暂不可读')).toBeTruthy()
    await store.fail(1, '仍不可读')
    expect(screen.getByText('Error: 仍不可读')).toBeTruthy()
    expect(screen.queryByText('Error: 列表暂不可读')).toBeNull()
  })

  it.each(['success', 'failure'])(
    '新读取成功后忽略过期的 %s 回执',
    async (late) => {
      const store = storage()
      render(<AssetsPanel />)
      await store.fail(0)
      await store.refresh()
      await store.refresh()
      await store.succeed(2, '最新角色')
      if (late === 'success') await store.succeed(1, '旧角色')
      else await store.fail(1, '过期读取失败')
      expect(screen.queryByText(/列表暂不可读|过期读取失败/)).toBeNull()
      fireEvent.click(screen.getByText('角色设定'))
      expect(
        screen.getByRole('button', { name: '删除资产 最新角色' }),
      ).toBeTruthy()
      expect(
        screen.queryByRole('button', { name: '删除资产 旧角色' }),
      ).toBeNull()
    },
  )

  it('新读取失败后，旧成功不能清除有效错误', async () => {
    const store = storage()
    render(<AssetsPanel />)
    await store.succeed(0)
    await store.refresh()
    await store.refresh()
    await store.fail(2, '最新读取失败')
    await store.succeed(1)
    expect(screen.getByText('Error: 最新读取失败')).toBeTruthy()
  })
})

describe('资产列表与操作错误隔离（#853）', () => {
  it('列表恢复只清读取错误，保留同时发生的导入错误', async () => {
    const store = storage()
    render(<AssetsPanel />)
    await store.fail(0)
    store.failures.set('import_library_asset', '导入拒绝')
    importFile()
    await screen.findByText(/导入拒绝/)
    expect(screen.getByText(/列表暂不可读/)).toBeTruthy()
    await store.refresh()
    await store.succeed(1)
    expect(screen.queryByText(/列表暂不可读/)).toBeNull()
    expect(screen.getByText(/导入拒绝/)).toBeTruthy()
  })

  it.each(['delete', 'rename', 'tags'])(
    '成功重读不能清除 %s 操作错误',
    async (action) => {
      const store = storage()
      render(<AssetsPanel />)
      await store.succeed(0)
      fireEvent.click(screen.getByText('角色设定'))
      if (action === 'delete') {
        store.failures.set('delete_library_asset', '操作拒绝')
        fireEvent.click(screen.getByRole('button', { name: '删除资产 角色' }))
        fireEvent.click(screen.getByRole('button', { name: '删除' }))
      } else {
        store.failures.set('update_library_asset', '操作拒绝')
        if (action === 'tags') {
          const input = screen.getByLabelText('资产标签 角色')
          fireEvent.change(input, { target: { value: '新标签' } })
          fireEvent.blur(input)
        } else {
          fireEvent.doubleClick(screen.getByText('角色', { exact: true }))
          const input = screen.getByDisplayValue('角色')
          fireEvent.change(input, { target: { value: '改名角色' } })
          fireEvent.blur(input)
        }
      }
      await screen.findByText(/操作拒绝/)
      // update/remove 的失败通知也会触发读取；随后显式通知覆盖它。
      store.failures.clear()
      await store.refresh()
      await store.succeed(2)
      expect(screen.getByText(/操作拒绝/)).toBeTruthy()
      await store.succeed(1)
    },
  )

  it('导入成功不能清除随后仍失败的列表错误', async () => {
    const store = storage()
    render(<AssetsPanel />)
    await store.fail(0)
    importFile()
    await act(async () => {})
    await store.fail(1, '列表仍失败')
    expect(screen.getByText('Error: 列表仍失败')).toBeTruthy()
  })
})

describe('资产列表读取生命周期（#853）', () => {
  it('卸载后的旧成功不影响新面板的读取错误', async () => {
    const store = storage()
    const old = render(<AssetsPanel />)
    old.unmount()
    render(<AssetsPanel />)
    await store.fail(1, '新面板失败')
    await store.succeed(0)
    expect(screen.getByText('Error: 新面板失败')).toBeTruthy()
  })
})
