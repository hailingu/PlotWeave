// @vitest-environment happy-dom
/** 标签编辑的跨挂载集成回归（issue #124 / PR #176）：保留真实组件、
 * 门面队列与持久化快照，仅在 IPC 边界模拟可控存储；检查写入后的存储
 * 和可见输入，捕获把陈旧显示误判为编辑、或把真实撤回误判为未变。 */
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
import AssetsPanel from './AssetsPanel'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.mocked(invoke).mockReset()
})
afterAll(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.unstubAllGlobals()
})

let nextId = 0

/** 每个场景使用独立的合法资产，避免门面会话快照相互影响。 */
function storedAsset(): LibraryAsset {
  return {
    id: `cross-mount-${++nextId}`,
    name: '角色',
    kind: 'character',
    view: null,
    mime: 'image/png',
    relPath: 'assets/character.png',
    tags: ['A'],
    groupId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 可控 IPC 存储：首次写入挂起，后续写入可失败；读取返回独立快照，
 * 成功才应用补丁。资产 ID 隔离各用例的真实门面队列与持久化快照。 */
function mockStorage() {
  let saved = storedAsset()
  let release!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: string[][] = []
  let failNext = false
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'list_library_assets') {
      return { assets: { byId: { [saved.id]: structuredClone(saved) } } }
    }
    if (command !== 'update_library_asset')
      throw new Error(`意外 IPC：${command}`)
    const { id, patch } = args as { id: string; patch: Partial<LibraryAsset> }
    if (id !== saved.id) throw new Error('更新了错误的资产')
    writes.push([...(patch.tags ?? saved.tags)])
    if (writes.length === 1) await firstWrite
    else if (failNext) {
      failNext = false
      throw new Error('保存失败')
    }
    saved = { ...saved, ...structuredClone(patch) }
    return structuredClone(saved)
  })
  return {
    release,
    writes,
    readTags: () => [...saved.tags],
    failNextWrite: () => {
      failNext = true
    },
  }
}

/** 挂载真实面板并进入角色分类，保留整个面板的卸载入口。 */
async function mountTags() {
  const panel = render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('角色设定'))
  const input = await screen.findByLabelText<HTMLInputElement>('资产标签 角色')
  return { ...panel, input }
}

/** 以真实输入事件形成编辑意图，并等待提交链发出可执行的 IPC。 */
async function editTags(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  await act(async () => {})
}

/** 旧面板提交 B 后卸载，新面板在 B 落盘前读到 A。 */
async function remountDuringSave() {
  const storage = mockStorage()
  const oldPanel = await mountTags()
  await editTags(oldPanel.input, 'B')
  oldPanel.unmount()
  const panel = await mountTags()
  expect(panel.input.value).toBe('A')
  return { storage, ...panel }
}

describe('跨挂载未编辑失焦（PR #176 review 5207545814）', () => {
  it.each([false, true])(
    '旧提交成功前先失焦=%s：旧显示不覆盖存储',
    async (blurBeforeSave) => {
      const { storage, input } = await remountDuringSave()
      if (blurBeforeSave) {
        fireEvent.focus(input)
        fireEvent.blur(input)
        await act(async () => {})
        expect(storage.writes).toEqual([['B']])
      }
      await act(async () => {
        storage.release()
      })
      expect(storage.readTags()).toEqual(['B'])
      fireEvent.focus(input)
      fireEvent.blur(input)
      await act(async () => {})
      expect(storage.readTags()).toEqual(['B'])
      expect(storage.writes).toEqual([['B']])
      expect(input.value).toBe('B')
      cleanup()
      expect((await mountTags()).input.value).toBe('B')
    },
  )
})

describe('跨挂载编辑与失败恢复', () => {
  it('明确撤回 A 在 B 之后落盘，重复失焦不重复提交', async () => {
    const { storage, input } = await remountDuringSave()
    fireEvent.change(input, { target: { value: '草稿' } })
    await editTags(input, 'A')
    await act(async () => {
      storage.release()
    })
    expect(storage.readTags()).toEqual(['A'])
    expect(input.value).toBe('A')
    fireEvent.blur(input)
    await act(async () => {})
    expect(storage.writes).toEqual([['B'], ['A']])
  })

  it('C 失败后保留草稿可直接失焦重试', async () => {
    const { storage, input } = await remountDuringSave()
    storage.failNextWrite()
    await editTags(input, 'C')
    await act(async () => {
      storage.release()
    })
    expect(await screen.findByText(/保存失败/)).toBeTruthy()
    expect(storage.readTags()).toEqual(['B'])
    expect(input.value).toBe('C')
    fireEvent.blur(input)
    await act(async () => {})
    expect(storage.readTags()).toEqual(['C'])
    expect(input.value).toBe('C')
    expect(screen.queryByText(/保存失败/)).toBeNull()
  })
})

describe('失败草稿与陈旧显示的身份', () => {
  it('失败后行重挂载丢弃草稿，未编辑失焦不写回 A', async () => {
    const { storage } = await remountDuringSave()
    storage.failNextWrite()
    await editTags(screen.getByLabelText('资产标签 角色'), 'C')
    await act(async () => {
      storage.release()
    })
    expect(await screen.findByText(/保存失败/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回分类列表' }))
    fireEvent.click(await screen.findByText('角色设定'))
    const input = screen.getByLabelText<HTMLInputElement>('资产标签 角色')
    fireEvent.blur(input)
    await act(async () => {})
    expect(storage.readTags()).toEqual(['B'])
    expect(storage.writes).toEqual([['B'], ['C']])
    expect(input.value).toBe('B')
    expect(screen.getByText(/保存失败/)).toBeTruthy()
  })
})

describe('跨挂载的提交顺序', () => {
  it('旧面板已排队的 C 不能晚于新面板的 D 写入', async () => {
    const storage = mockStorage()
    const oldPanel = await mountTags()
    await editTags(oldPanel.input, 'B')
    await editTags(oldPanel.input, 'C')
    oldPanel.unmount()
    const panel = await mountTags()
    await editTags(panel.input, 'D')
    await act(async () => {
      storage.release()
    })
    expect(storage.readTags()).toEqual(['D'])
    expect(storage.writes).toEqual([['B'], ['C'], ['D']])
    expect(panel.input.value).toBe('D')
    panel.unmount()
    expect((await mountTags()).input.value).toBe('D')
  })
})

describe('值相等时的失败草稿重试', () => {
  it('撤回 A 失败后再次失焦仍重试 A', async () => {
    const { storage, input } = await remountDuringSave()
    await act(async () => {
      storage.release()
    })
    storage.failNextWrite()
    fireEvent.change(input, { target: { value: '草稿' } })
    await editTags(input, 'A')
    expect(await screen.findByText(/保存失败/)).toBeTruthy()
    expect(storage.readTags()).toEqual(['B'])
    fireEvent.blur(input)
    await act(async () => {})
    expect(storage.readTags()).toEqual(['A'])
    expect(input.value).toBe('A')
    expect(screen.queryByText(/保存失败/)).toBeNull()
  })
})

/** 模拟 Rust library_op_lock：同一库的更新和删除互斥、失败释放锁；
 * 第一次更新持锁挂起，让删除与尚未发出的后续更新竞争锁次序。 */
function mockDeletionStorage(failUpdate = false, failDelete = false) {
  let saved = storedAsset()
  let exists = true
  let release!: () => void
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve
  })
  const operations: string[] = []
  let lock = Promise.resolve()
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === 'list_library_assets') {
      return Promise.resolve({
        assets: { byId: exists ? { [saved.id]: structuredClone(saved) } : {} },
      })
    }
    const run = lock.then(async () => {
      const { id, patch } = args as {
        id: string
        patch?: Partial<LibraryAsset>
      }
      if (id !== saved.id) throw new Error('更新了错误的资产')
      if (command === 'delete_library_asset') {
        operations.push('delete')
        if (failDelete) throw new Error('删除失败')
        exists = false
        return {}
      }
      if (command !== 'update_library_asset')
        throw new Error(`意外 IPC：${command}`)
      const tag = patch?.tags?.[0] ?? ''
      operations.push(tag)
      if (!exists) throw new Error('资产不存在')
      if (operations.length === 1) await firstWrite
      if (failUpdate && tag === 'C') throw new Error('标签保存失败')
      saved = { ...saved, ...structuredClone(patch) }
      return structuredClone(saved)
    })
    lock = run.then(
      () => {},
      () => {},
    )
    return run
  })
  return { release, operations, id: saved.id }
}

/** 只在应用确认框中确认删除；取消路径由对应测试独立触发。 */
async function confirmAssetDeletion() {
  fireEvent.click(screen.getByRole('button', { name: '删除资产 角色' }))
  fireEvent.click(await screen.findByRole('button', { name: '删除' }))
  await act(async () => {})
}

describe('删除与排队更新（PR #176 review 5208013926）', () => {
  it.each([false, true])(
    '后续更新失败=%s：删除在更新之后且不残留标签错误',
    async (failUpdate) => {
      const storage = mockDeletionStorage(failUpdate)
      const panel = await mountTags()
      await editTags(panel.input, 'B')
      await editTags(panel.input, 'C')
      await confirmAssetDeletion()
      expect(screen.queryByLabelText('资产标签 角色')).toBeNull()
      await act(async () => {
        storage.release()
      })
      expect(document.querySelector('.pw-assets-error')).toBeNull()
      expect(storage.operations).toEqual(['B', 'C', 'delete'])
      expect(await libraryStore.list()).toEqual([])
      expect(libraryStore.persistedSnapshot(storage.id)).toBeUndefined()
    },
  )

  it('删除失败仍显示删除错误并保留此前更新', async () => {
    const storage = mockDeletionStorage(false, true)
    const panel = await mountTags()
    await editTags(panel.input, 'B')
    await editTags(panel.input, 'C')
    await confirmAssetDeletion()
    await act(async () => {
      storage.release()
    })
    expect(screen.getByText(/删除失败/)).toBeTruthy()
    expect(storage.operations).toEqual(['B', 'C', 'delete'])
    expect(await libraryStore.list()).toMatchObject([{ tags: ['C'] }])
    expect(libraryStore.persistedSnapshot(storage.id)?.tags).toEqual(['C'])
  })
})

describe('删除取消与既有失败', () => {
  it('取消删除不失效标签提交，保存失败仍可见', async () => {
    const storage = mockDeletionStorage(true)
    const panel = await mountTags()
    await editTags(panel.input, 'B')
    await editTags(panel.input, 'C')
    fireEvent.click(screen.getByRole('button', { name: '删除资产 角色' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await act(async () => {
      storage.release()
    })
    expect(screen.getByText(/标签保存失败/)).toBeTruthy()
    expect(panel.input.value).toBe('C')
    expect(storage.operations).toEqual(['B', 'C'])
    expect(await libraryStore.list()).toMatchObject([{ tags: ['B'] }])
  })

  it('确认删除清除本资产已经显示的标签失败', async () => {
    const storage = mockDeletionStorage(true)
    const panel = await mountTags()
    await editTags(panel.input, 'B')
    await editTags(panel.input, 'C')
    await act(async () => {
      storage.release()
    })
    expect(screen.getByText(/标签保存失败/)).toBeTruthy()
    await confirmAssetDeletion()
    expect(document.querySelector('.pw-assets-error')).toBeNull()
    expect(await libraryStore.list()).toEqual([])
  })
})
