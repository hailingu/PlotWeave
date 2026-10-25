// @vitest-environment happy-dom
/** 跨面板重挂载的列表失效收敛（issue #802）：保留真实面板、真实库门面
 * 与每资产队列，仅 IPC 边界可控。覆盖成功导入／改名／标签跨重挂载无需
 * 额外交互即显示最新持久化状态，以及在途草稿不被过期中间态抢占、他
 * 实例删除失败不卡死隐藏与乱序旧响应不回退的保留回归。 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { AssetsPanel } from './AssetsPanel'
import { stubIntersectionObserver } from './testDomStubs'
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
  vi.mocked(invoke).mockReset()
})
afterAll(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  vi.unstubAllGlobals()
})

let nextId = 0

/** 每个场景独立的合法资产，隔离门面会话队列与持久化快照。 */
function storedAsset(name = '角色'): LibraryAsset {
  return {
    id: `remount-${++nextId}`,
    name,
    kind: 'character',
    view: null,
    mime: 'image/png',
    relPath: `assets/${name}.png`,
    tags: ['A'],
    groupId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** 完成门：由场景显式落定，不依赖真实时钟。 */
function gate() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** 可控 IPC 存储：list 按调用时刻快照（晚返回的旧读取不携带新状态），
 * import/update/delete 按键位门控；首次 list 可挂起以构造乱序。 */
function remountStorage(options: { holdFirstList?: boolean } = {}) {
  const original = storedAsset()
  const assets = new Map<string, LibraryAsset>([[original.id, original]])
  const updates = new Map<string, ReturnType<typeof gate>>()
  const imports = new Map<string, ReturnType<typeof gate>>()
  const deletion = gate()
  const firstList = options.holdFirstList ? gate() : undefined
  const writes: string[] = []
  const requestedImports: string[] = []
  let listCalls = 0
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    const args = raw as {
      id: string
      name: string
      patch: Partial<LibraryAsset>
    }
    if (command === 'list_library_assets') {
      const byId = structuredClone(Object.fromEntries(assets))
      listCalls += 1
      if (listCalls === 1) await firstList?.promise
      return { assets: { byId } }
    }
    if (command === 'import_library_asset') {
      requestedImports.push(args.name)
      await imports.get(args.name)?.promise
      const asset = storedAsset(args.name)
      assets.set(asset.id, asset)
      return structuredClone(asset)
    }
    if (command === 'update_library_asset') {
      const key =
        args.patch.tags !== undefined
          ? `tags:${args.patch.tags.join(',')}`
          : `name:${args.patch.name}`
      writes.push(key)
      await updates.get(key)?.promise
      const current = assets.get(args.id)
      if (!current) throw new Error('资产不存在')
      const updated = { ...current, ...structuredClone(args.patch) }
      assets.set(args.id, updated)
      return structuredClone(updated)
    }
    if (command === 'delete_library_asset') {
      await deletion.promise
      assets.delete(args.id)
      return {}
    }
    throw new Error(`意外 IPC：${command}`)
  })
  return {
    writes,
    requestedImports,
    holdUpdate: (key: string) => {
      const held = gate()
      updates.set(key, held)
      return held
    },
    holdImport: (name: string) => {
      const held = gate()
      imports.set(name, held)
      return held
    },
    releaseDelete: () => deletion.resolve(),
    rejectDelete: (message: string) => deletion.reject(new Error(message)),
    releaseFirstList: () => firstList?.resolve(),
    readNames: () => [...assets.values()].map((a) => a.name),
  }
}

/** 挂载真实面板并进入角色分类，等待行渲染完成。 */
async function mountCharacter() {
  const panel = render(<AssetsPanel />)
  fireEvent.click(await screen.findByText('角色设定'))
  await screen.findByRole('button', { name: '删除资产 角色' })
  return panel
}

/** happy-dom 的 File 适配真实门面导入的 arrayBuffer 读取。 */
function directFile(name: string): File {
  const file = new File(['image'], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([1]).buffer,
  })
  return file
}

/** 经隐藏文件入口注入多选文件（真实 onChange 链路）。 */
function pickFiles(names: string[]) {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map(directFile),
  })
  Object.defineProperty(input, 'value', {
    configurable: true,
    writable: true,
    value: 'C:\\fakepath\\picked.png',
  })
  fireEvent.change(input)
}

/** 以真实输入事件形成编辑意图，并等待提交链发出。 */
async function editTags(value: string) {
  const input = screen.getByLabelText<HTMLInputElement>('资产标签 角色')
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  await act(async () => {})
}

describe('成功写入跨重挂载的即时收敛（issue #802）', () => {
  it('标签 B 落盘后，新面板无需额外交互即显示 B', async () => {
    const storage = remountStorage()
    const writingB = storage.holdUpdate('tags:B')
    const oldPanel = await mountCharacter()
    await editTags('B')
    oldPanel.unmount()

    await mountCharacter()
    const input = screen.getByLabelText<HTMLInputElement>('资产标签 角色')
    expect(input.value).toBe('A')

    await act(async () => {
      writingB.resolve()
    })
    await waitFor(() => expect(input.value).toBe('B'))
    expect(storage.readNames()).toEqual(['角色'])
  })

  it('改名落盘后，新面板无需额外交互即显示新名', async () => {
    const storage = remountStorage()
    const renaming = storage.holdUpdate('name:新名')
    const oldPanel = await mountCharacter()
    fireEvent.doubleClick(screen.getByRole('button', { name: '角色' }))
    const nameInput = screen.getByRole('textbox', { name: '资产名 角色' })
    fireEvent.change(nameInput, { target: { value: '新名' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    fireEvent.blur(nameInput)
    await act(async () => {})
    oldPanel.unmount()

    await mountCharacter()
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()

    await act(async () => {
      renaming.resolve()
    })
    expect(
      await screen.findByRole('button', { name: '删除资产 新名' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除资产 角色' })).toBeNull()
    expect(storage.readNames()).toEqual(['新名'])
  })
})

describe('导入与删除的跨重挂载收敛（issue #802）', () => {
  it('导入落盘后，新面板无需额外交互即显示新资产且不重复', async () => {
    const storage = remountStorage()
    const importing = storage.holdImport('迟到导入.png')
    const oldPanel = await mountCharacter()
    pickFiles(['迟到导入.png'])
    await waitFor(() =>
      expect(storage.requestedImports).toEqual(['迟到导入.png']),
    )
    oldPanel.unmount()

    await mountCharacter()
    expect(screen.queryByRole('button', { name: '迟到导入.png' })).toBeNull()

    await act(async () => {
      importing.resolve()
    })
    expect(
      await screen.findAllByRole('button', { name: '迟到导入.png' }),
    ).toHaveLength(1)
    expect(storage.readNames()).toEqual(['角色', '迟到导入.png'])
  })

  it('他实例删除落盘后新面板行消失；删除在途的重读不误隐藏，失败后行保持', async () => {
    const settled = remountStorage()
    const oldPanel = await mountCharacter()
    fireEvent.click(screen.getByRole('button', { name: '删除资产 角色' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(screen.queryByRole('button', { name: '删除资产 角色' })).toBeNull()
    oldPanel.unmount()

    const panel = await mountCharacter()
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()
    await act(async () => {
      settled.releaseDelete()
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '删除资产 角色' }),
      ).toBeNull(),
    )
    panel.unmount()

    const rejected = remountStorage()
    const oldPanel2 = await mountCharacter()
    fireEvent.click(screen.getByRole('button', { name: '删除资产 角色' }))
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    oldPanel2.unmount()

    await mountCharacter()
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()
    // 删除在途期间旁路导入落盘触发重读：本实例未隐藏该行，不得按门面
    // 在途状态误隐藏（隐藏只属于发起确认删除的实例）。
    await act(async () => {
      await libraryStore.put(directFile('旁路.png'), 'character')
    })
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '删除资产 旁路.png' }),
    ).toBeTruthy()
    await act(async () => {
      rejected.rejectDelete('删除拒绝')
    })
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '删除资产 旁路.png' }),
    ).toBeTruthy()
    expect(await libraryStore.list()).toMatchObject([
      { name: '角色' },
      { name: '旁路.png' },
    ])
  })
})

describe('浏览器预览导入的回执幂等（issue #802 评审）', () => {
  it('通知重读先于导入回执落地时不重复显示', async () => {
    // 纯浏览器预览（内存回退）：list() 即时 resolve，put 的通知重读可
    // 先于导入回执追加落地——回执必须按资产 id 幂等合并。隐藏文件入口
    // 的直选默认导入「其他」分类。
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    try {
      await libraryStore.put(directFile('预览存量.png'), 'other')
      render(<AssetsPanel />)
      fireEvent.click(await screen.findByText('其他'))
      await screen.findByRole('button', { name: '删除资产 预览存量.png' })
      pickFiles(['预览新增.png'])
      expect(
        await screen.findAllByRole('button', { name: '预览新增.png' }),
      ).toHaveLength(1)
      expect(await libraryStore.list()).toHaveLength(2)
    } finally {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        value: {},
      })
    }
  })
})

describe('收敛重读的保留回归（issue #802）', () => {
  it('旧 B 落盘触发重读不抢占本实例在途草稿 C；C 落盘后收敛', async () => {
    const storage = remountStorage()
    const writingB = storage.holdUpdate('tags:B')
    const oldPanel = await mountCharacter()
    await editTags('B')
    oldPanel.unmount()

    await mountCharacter()
    const writingC = storage.holdUpdate('tags:C')
    await editTags('C')
    expect(screen.getByLabelText<HTMLInputElement>('资产标签 角色').value).toBe(
      'C',
    )

    await act(async () => {
      writingB.resolve()
    })
    // 存储已是 B，但本实例 C 仍在途：显示保留提交意图 C，不被 B 抢占。
    expect(await libraryStore.list()).toMatchObject([{ tags: ['B'] }])
    expect(screen.getByLabelText<HTMLInputElement>('资产标签 角色').value).toBe(
      'C',
    )

    await act(async () => {
      writingC.resolve()
    })
    expect(await libraryStore.list()).toMatchObject([{ tags: ['C'] }])
    expect(screen.getByLabelText<HTMLInputElement>('资产标签 角色').value).toBe(
      'C',
    )
    expect(storage.writes).toEqual(['tags:B', 'tags:C'])
  })

  it('C 失败后，后续收敛重读不推进 saved 清除保留的失败草稿', async () => {
    const storage = remountStorage()
    const writingB = storage.holdUpdate('tags:B')
    const oldPanel = await mountCharacter()
    await editTags('B')
    oldPanel.unmount()

    await mountCharacter()
    const writingC = storage.holdUpdate('tags:C')
    await editTags('C')
    await act(async () => {
      writingB.resolve()
    })
    // C 的写入排在 B 之后被门挂起；拒绝使其失败（队列随后清空）。
    await act(async () => {
      writingC.reject(new Error('保存失败'))
    })
    expect(await screen.findByText(/保存失败/)).toBeTruthy()

    // C 已失败（门面队列空），此后任意成功写入触发重读：未解决失败的
    // 标签意图仍占有该行投影，saved 不被推进到 B，草稿 C 保留可重试。
    await act(async () => {
      await libraryStore.put(directFile('旁路.png'), 'character')
    })
    expect(screen.getByLabelText<HTMLInputElement>('资产标签 角色').value).toBe(
      'C',
    )
    expect(screen.getByText(/保存失败/)).toBeTruthy()
    expect(await libraryStore.list()).toMatchObject([
      { tags: ['B'] },
      { name: '旁路.png' },
    ])
  })
})

describe('终态与乱序的收敛（issue #802）', () => {
  it('失败标签意图不冻结他实例改名：名称收敛、草稿保留（PR #835 评审）', async () => {
    const storage = remountStorage()
    const renaming = storage.holdUpdate('name:新名')
    const oldPanel = await mountCharacter()
    fireEvent.doubleClick(screen.getByRole('button', { name: '角色' }))
    const nameInput = screen.getByRole('textbox', { name: '资产名 角色' })
    fireEvent.change(nameInput, { target: { value: '新名' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    fireEvent.blur(nameInput)
    await act(async () => {})
    oldPanel.unmount()

    await mountCharacter()
    const writingC = storage.holdUpdate('tags:C')
    await editTags('C')
    await act(async () => {
      renaming.resolve()
    })
    await act(async () => {
      writingC.reject(new Error('保存失败'))
    })
    // C 失败后的重读只保留本地 tags 字段：他实例已落盘的改名收敛显示，
    // 失败草稿 C 与错误仍保留。
    expect(
      await screen.findByRole('button', { name: '删除资产 新名' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除资产 角色' })).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('资产标签 新名').value).toBe(
      'C',
    )
    expect(screen.getByText(/保存失败/)).toBeTruthy()
    expect(await libraryStore.list()).toMatchObject([{ name: '新名' }])
  })

  it('B 落盘、C 失败后，新面板无未决意图即收敛到 B', async () => {
    const storage = remountStorage()
    const writingB = storage.holdUpdate('tags:B')
    const writingC = storage.holdUpdate('tags:C')
    const oldPanel = await mountCharacter()
    await editTags('B')
    await editTags('C')
    oldPanel.unmount()

    await mountCharacter()
    const input = screen.getByLabelText<HTMLInputElement>('资产标签 角色')
    expect(input.value).toBe('A')

    await act(async () => {
      writingB.resolve()
    })
    // B 落盘时 C 仍在途，新面板保留 A 投影；C 随后失败（队列清空）也
    // 发布通知——新实例没有未决意图，收敛到已落盘的 B。
    await act(async () => {
      writingC.reject(new Error('保存失败'))
    })
    await waitFor(() => expect(input.value).toBe('B'))
    expect(storage.readNames()).toEqual(['角色'])
    expect((await libraryStore.list())[0]?.tags).toEqual(['B'])
  })

  it('乱序防护：迟到的初始读取不回退已收敛列表', async () => {
    const storage = remountStorage({ holdFirstList: true })
    render(<AssetsPanel />)
    fireEvent.click(await screen.findByText('角色设定'))
    // 初始读取挂起期间旁路导入落盘：通知触发的重读先收敛展示。
    await act(async () => {
      await libraryStore.put(directFile('先落盘.png'), 'character')
    })
    expect(
      await screen.findAllByRole('button', { name: '删除资产 先落盘.png' }),
    ).toHaveLength(1)
    await act(async () => {
      storage.releaseFirstList()
    })
    expect(
      screen.getByRole('button', { name: '删除资产 先落盘.png' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除资产 角色' })).toBeTruthy()
  })
})
