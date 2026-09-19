import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryAsset } from './libraryStore'

/** Tauri 路径（IPC 门面）：mock @tauri-apps/api/core，并以
 * window.__TAURI_INTERNALS__ 让模块级 isTauri 判定为真——
 * 每个用例 resetModules 后重新动态 import，拿到隔离的模块实例。 */

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  vi.doMock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invoke(...args),
  }))
  invoke.mockReset()
})

const load = async (): Promise<typeof import('./libraryStore')> =>
  import('./libraryStore')

/** 一条合法的 Rust 侧索引条目。 */
const entry = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'la-1',
  name: '参考图.png',
  kind: 'reference',
  view: null,
  mime: 'image/png',
  relPath: 'assets/la-1.png',
  tags: ['夜景'],
  groupId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

/** §7.2 Record 形状（issue #29）：list_library_assets 的 assets 为
 * { byId: { [id]: entry } }，键自动取条目 id。 */
const byId = (
  ...entries: Array<Record<string, unknown>>
): Record<string, unknown> => ({
  byId: Object.fromEntries(entries.map((e) => [e.id, e])),
})

describe('libraryStore Tauri 路径：list（normalizeAsset 归一化）', () => {
  it('字段缺失/类型异常时逐字段兜底，kind 未知归 other', async () => {
    invoke.mockResolvedValue({
      assets: byId(
        entry(),
        // 缺 id → 整条丢弃；其余坏字段按兜底规则归一
        entry({ id: '' }),
        entry({
          id: 'la-2',
          name: '',
          kind: 'mystery',
          view: 3,
          mime: null,
          relPath: 7,
          tags: 'x',
          groupId: 42,
          createdAt: 't',
        }),
      ),
    })
    const { libraryStore } = await load()
    const list = await libraryStore.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'la-1', kind: 'reference' })
    expect(list[1]).toMatchObject({
      id: 'la-2',
      name: '未命名资产',
      kind: 'other',
      view: null,
      mime: 'application/octet-stream',
      relPath: '',
      tags: [],
      groupId: null,
      // createdAt 现为字符串（§7.2 ISO）：'t' 是合法字符串类型原样保留，
      // 前端不做 ISO 校验（那是后端落盘契约）；非字符串才回退空串
      createdAt: 't',
    })
  })

  it('assets 字段缺失/非 Record 形状时按空库处理', async () => {
    // assets 字段缺失
    invoke.mockResolvedValue({})
    const { libraryStore } = await load()
    await expect(libraryStore.list()).resolves.toEqual([])

    // assets 非 Record 形状（旧数组形状已废弃，按空库处理）
    invoke.mockResolvedValue({ assets: [entry()] })
    await expect(libraryStore.list()).resolves.toEqual([])

    // byId 非对象
    invoke.mockResolvedValue({ assets: { byId: 'x' } })
    await expect(libraryStore.list()).resolves.toEqual([])
  })
})

describe('libraryStore Tauri 路径：警告诊断', () => {
  it('后端隔离警告逐条进 console.warn 诊断路径', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: byId(entry()),
      warnings: ['已隔离非法索引条目 #1：…', '已隔离非法索引条目 #2：…'],
    })
    const { libraryStore } = await load()
    await expect(libraryStore.list()).resolves.toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]).toContain('已隔离非法索引条目 #1：…')
    warn.mockRestore()
  })

  it('warnings 缺失/非字符串/空串项不产生告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: byId(entry()),
      warnings: [42, '', null],
    })
    const { libraryStore } = await load()
    await libraryStore.list()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('libraryStore Tauri 路径：待清理快照', () => {
  it('cleanupPending 进用户可见诊断通道并保留控制台明细（issue #135）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: byId(entry()),
      cleanupPending: ['媒体已隔离待清理：assets/la-1.png'],
      diagnosticsRevision: '1',
    })
    const { libraryStore } = await load()
    await libraryStore.list()
    const diagnostics = await import('./libraryDiagnostics')
    expect(diagnostics.cleanupPendingSnapshot()).toEqual([
      '媒体已隔离待清理：assets/la-1.png',
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toEqual(['媒体已隔离待清理：assets/la-1.png'])
    warn.mockRestore()
  })

  it('cleanupPending 缺失时不发布也不告警（正常状态不误报，issue #135）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({ assets: byId(entry()) })
    const { libraryStore } = await load()
    await libraryStore.list()
    const diagnostics = await import('./libraryDiagnostics')
    expect(diagnostics.cleanupPendingSnapshot()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('删除返回 cleanupPending 时同样进诊断通道（issue #135）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      cleanupPending: ['媒体已隔离待清理：assets/la-1.png'],
      diagnosticsRevision: '2',
    })
    const { libraryStore } = await load()
    await libraryStore.remove('la-1')
    const diagnostics = await import('./libraryDiagnostics')
    expect(diagnostics.cleanupPendingSnapshot()).toEqual([
      '媒体已隔离待清理：assets/la-1.png',
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('libraryStore Tauri 路径：写操作警告', () => {
  it('put 返回条目携带 warnings 时同样上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(
      entry({ id: 'la-9', warnings: ['已隔离非法索引条目 #1：…'] }),
    )
    const { libraryStore } = await load()
    await libraryStore.put(
      new File(['x'], 'a.png', { type: 'image/png' }),
      'other',
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toContain('已隔离非法索引条目 #1：…')
    warn.mockRestore()
  })

  it('updateMeta 返回条目携带 warnings 时同样上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(
      entry({
        warnings: ['条目 la-1 的 mime 已规范化： Image/PNG → image/png'],
      }),
    )
    const { libraryStore } = await load()
    await libraryStore.updateMeta('la-1', { name: '改名' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('remove 响应携带 warnings 时上报诊断；缺省不产生告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { libraryStore } = await load()
    invoke.mockResolvedValue({ warnings: ['已隔离非法索引条目 #2：…'] })
    await libraryStore.remove('la-1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toContain('已隔离非法索引条目 #2：…')

    invoke.mockResolvedValue(null)
    await libraryStore.remove('la-1')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('libraryStore Tauri 路径：put', () => {
  it('字节数组序列化传参，返回条目经归一化', async () => {
    invoke.mockResolvedValue(entry({ id: 'la-9' }))
    const { libraryStore } = await load()
    const asset: LibraryAsset = await libraryStore.put(
      new File([new Uint8Array([1, 2, 255])], '新图.png', {
        type: 'image/png',
      }),
      'reference',
    )
    expect(asset.id).toBe('la-9')
    const [cmd, args] = invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(cmd).toBe('import_library_asset')
    expect(args).toMatchObject({
      name: '新图.png',
      mime: 'image/png',
      kind: 'reference',
    })
    expect(args.bytes).toEqual([1, 2, 255])
  })

  it('空 MIME 传参时兜底 octet-stream；返回无效条目抛错', async () => {
    invoke.mockResolvedValueOnce(entry())
    const { libraryStore } = await load()
    await libraryStore.put(new File(['x'], 'a.bin'), 'other')
    expect(invoke.mock.calls[0][1]).toMatchObject({
      mime: 'application/octet-stream',
    })

    invoke.mockResolvedValueOnce({ id: '' })
    await expect(
      libraryStore.put(new File(['x'], 'b.bin'), 'other'),
    ).rejects.toThrow(/无效条目/)
  })
})

describe('libraryStore Tauri 路径：updateMeta / remove', () => {
  /** 宏任务节拍：清空门面队列与动态 import 的微任务链。 */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('补丁透传给 update_library_asset；无效返回抛错', async () => {
    invoke.mockResolvedValueOnce(entry({ id: 'la-1', name: '改名.png' }))
    const { libraryStore } = await load()
    const updated = await libraryStore.updateMeta('la-1', { name: '改名.png' })
    expect(updated.name).toBe('改名.png')
    expect(invoke.mock.calls[0]).toEqual([
      'update_library_asset',
      { id: 'la-1', patch: { name: '改名.png' } },
    ])

    invoke.mockResolvedValueOnce(null)
    await expect(libraryStore.updateMeta('la-1', {})).rejects.toThrow(
      /无效条目/,
    )
  })

  it('remove 透传 id 给 delete_library_asset', async () => {
    invoke.mockResolvedValue(undefined)
    const { libraryStore } = await load()
    await libraryStore.remove('la-1')
    expect(invoke.mock.calls[0]).toEqual([
      'delete_library_asset',
      { id: 'la-1' },
    ])
  })

  it('同资产 updateMeta 串行：前一落定前后一不发起 invoke（PR #176 评审）', async () => {
    const { libraryStore } = await load()
    let resolveFirst!: (v: unknown) => void
    invoke.mockImplementationOnce(
      () => new Promise((res) => (resolveFirst = res)),
    )
    invoke.mockImplementationOnce(() => Promise.resolve(entry({ tags: ['C'] })))
    const first = libraryStore.updateMeta('la-1', { tags: ['B'] })
    await tick() // 队列发出第一次 invoke（挂起）
    const second = libraryStore.updateMeta('la-1', { tags: ['C'] })
    await tick()
    expect(invoke).toHaveBeenCalledTimes(1) // 第二次在第一次落定前排队不发起

    resolveFirst(entry({ tags: ['B'] }))
    await expect(first).resolves.toMatchObject({ tags: ['B'] })
    await expect(second).resolves.toMatchObject({ tags: ['C'] })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('不同资产的 updateMeta 互不阻塞', async () => {
    const { libraryStore } = await load()
    let resolveA!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((res) => (resolveA = res)))
    invoke.mockImplementationOnce(() =>
      Promise.resolve(entry({ id: 'la-2', name: '乙' })),
    )
    const first = libraryStore.updateMeta('la-1', { name: '甲' })
    await tick()
    const second = libraryStore.updateMeta('la-2', { name: '乙' })
    await tick()
    expect(invoke).toHaveBeenCalledTimes(2) // la-2 不等 la-1 落定

    resolveA(entry({ name: '甲' }))
    await expect(first).resolves.toMatchObject({ name: '甲' })
    await expect(second).resolves.toMatchObject({ name: '乙' })
  })

  it('updateMeta 成功记录持久化快照，跨调用方可见；remove 清除（PR #176 评审）', async () => {
    invoke.mockResolvedValueOnce(entry({ tags: ['B'] }))
    const { libraryStore } = await load()
    await libraryStore.updateMeta('la-1', { tags: ['B'] })
    expect(libraryStore.persistedSnapshot('la-1')?.tags).toEqual(['B'])
    expect(libraryStore.persistedSnapshot('la-2')).toBeUndefined()

    invoke.mockResolvedValue(undefined)
    await libraryStore.remove('la-1')
    expect(libraryStore.persistedSnapshot('la-1')).toBeUndefined()
  })
})

describe('libraryStore Tauri 路径：删除队列隔离与恢复', () => {
  it('一个资产更新挂起不阻塞另一个资产删除', async () => {
    const { libraryStore } = await load()
    let release!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    invoke.mockResolvedValueOnce(undefined)
    const update = libraryStore.updateMeta('la-1', { tags: ['B'] })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    await expect(libraryStore.remove('la-2')).resolves.toBeUndefined()
    expect(libraryStore.hasPendingOperation('la-1')).toBe(true)
    expect(libraryStore.hasPendingOperation('la-2')).toBe(false)
    release(entry({ tags: ['B'] }))
    await expect(update).resolves.toMatchObject({ tags: ['B'] })
    expect(libraryStore.persistedSnapshot('la-1')?.tags).toEqual(['B'])
  })

  it('删除失败不阻塞已排队的后续更新，落定后可回收队列', async () => {
    const { libraryStore } = await load()
    invoke.mockRejectedValueOnce(new Error('删除失败'))
    invoke.mockResolvedValueOnce(entry({ tags: ['C'] }))
    const removal = libraryStore.remove('la-1')
    const update = libraryStore.updateMeta('la-1', { tags: ['C'] })
    await expect(removal).rejects.toThrow('删除失败')
    await expect(update).resolves.toMatchObject({ tags: ['C'] })
    expect(libraryStore.persistedSnapshot('la-1')?.tags).toEqual(['C'])
    expect(libraryStore.hasPendingOperation('la-1')).toBe(false)
  })
})

describe('libraryStore Tauri 路径：mediaUrl', () => {
  it('经 get_asset_media_url 取 opaque URL：只传 scope + assetId，relPath 不进媒体链路（issue #26）', async () => {
    invoke.mockResolvedValue('pwmedia://localhost/library/la-1')
    const { libraryStore } = await load()
    const url = await libraryStore.mediaUrl({ id: 'la-1' })
    expect(url).toBe('pwmedia://localhost/library/la-1')
    expect(invoke.mock.calls[0]).toEqual([
      'get_asset_media_url',
      { scope: { kind: 'library' }, assetId: 'la-1' },
    ])
  })
})

describe('libraryStore Tauri 路径：冲突期条目（issue #25）', () => {
  it('normalizeAsset 保留 conflicted 标记；未标记不引入字段', async () => {
    invoke.mockResolvedValue({
      assets: byId(entry({ conflicted: true }), entry({ id: 'la-2' })),
    })
    const { libraryStore } = await load()
    const list = await libraryStore.list()
    expect(list[0].conflicted).toBe(true)
    expect(list[1].conflicted).toBeUndefined()
  })

  it('冲突期条目的媒体 URL 拒绝服务，不发起 IPC', async () => {
    const { libraryStore } = await load()
    await expect(
      libraryStore.mediaUrl({
        id: 'la-1',
        conflicted: true,
      }),
    ).rejects.toThrow(/冲突期/)
    expect(invoke.mock.calls).toHaveLength(0)
  })
})

describe('libraryStore Tauri 路径：隔离区积压可见性（issue #25 评审）', () => {
  it('cleanupPending 非空时上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: byId(entry()),
      cleanupPending: ['媒体已隔离待清理：assets/la-9.png'],
      diagnosticsRevision: '3',
    })
    const { libraryStore } = await load()
    await libraryStore.list()
    expect(warn).toHaveBeenCalledWith('[Library] 删除隔离区待清理：', [
      '媒体已隔离待清理：assets/la-9.png',
    ])
    warn.mockRestore()
  })

  it('cleanupPending 缺失或为空数组不产生额外告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: byId(entry()),
      cleanupPending: [],
      diagnosticsRevision: '4',
    })
    const { libraryStore } = await load()
    await libraryStore.list()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---- 组列表诊断可见性（评审修复，PR #36 第一轮）----

describe('libraryStore Tauri 路径：listGroups', () => {
  it('listGroups 携带 list_library_assets 的 warnings 与 cleanupPending 诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      groups: byId(entry()),
      warnings: ['条目 la-1 已隔离'],
      cleanupPending: ['assets/.trash/t-1'],
      diagnosticsRevision: '5',
    })
    const { libraryStore } = await load()
    const groups = await libraryStore.listGroups()
    expect(groups).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      '[Library] 索引条目隔离：',
      '条目 la-1 已隔离',
    )
    expect(warn).toHaveBeenCalledWith('[Library] 删除隔离区待清理：', [
      'assets/.trash/t-1',
    ])
  })
})

/// upsertGroup 响应携带 cleanupPending 时经诊断路径上报（评审修复，PR #36
/// 第三轮）：与 list/delete 同款。
describe('libraryStore Tauri 路径：upsertGroup', () => {
  it('upsertGroup 响应携带 cleanupPending 时上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warn.mockClear() // 同文件先前用例可能以相同参数调用过 warn——清掉累积记录
    invoke.mockResolvedValueOnce({
      id: 'g-1',
      name: '女主',
      kind: 'character',
      cleanupPending: ['assets/.trash/t-1'],
      diagnosticsRevision: '6',
    })
    const { libraryStore } = await load()
    await libraryStore.upsertGroup({
      id: 'g-1',
      name: '女主',
      kind: 'character',
    })
    expect(warn).toHaveBeenCalledWith('[Library] 删除隔离区待清理：', [
      'assets/.trash/t-1',
    ])
  })
})

describe('libraryStore Tauri 路径：导入/更新的 cleanupPending 上报（PR #222 评审 P2）', () => {
  it('导入返回携带 cleanupPending 时进诊断通道', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(
      entry({
        id: 'la-9',
        cleanupPending: ['媒体已隔离待清理：assets/la-1.png'],
        diagnosticsRevision: '7',
      }),
    )
    const { libraryStore } = await load()
    await libraryStore.put(
      new File(['x'], 'a.png', { type: 'image/png' }),
      'reference',
    )
    const diagnostics = await import('./libraryDiagnostics')
    expect(diagnostics.cleanupPendingSnapshot()).toEqual([
      '媒体已隔离待清理：assets/la-1.png',
    ])
    warn.mockRestore()
  })

  it('更新返回携带 cleanupPending 时进诊断通道；空快照按恢复后状态替换', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(
      entry({
        id: 'la-1',
        cleanupPending: ['媒体已隔离待清理：assets/la-1.png'],
        diagnosticsRevision: '8',
      }),
    )
    const { libraryStore } = await load()
    await libraryStore.updateMeta('la-1', { name: '改名' })
    const diagnostics = await import('./libraryDiagnostics')
    expect(diagnostics.cleanupPendingSnapshot()).toHaveLength(1)
    // 恢复/人工清理后的空快照：整体替换，积压显示消失
    invoke.mockResolvedValue(
      entry({ id: 'la-1', cleanupPending: [], diagnosticsRevision: '9' }),
    )
    await libraryStore.updateMeta('la-1', { name: '再改' })
    expect(diagnostics.cleanupPendingSnapshot()).toEqual([])
    warn.mockRestore()
  })
})
