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
    convertFileSrc: (p: string) => `asset://cvt/${p}`,
  }))
  invoke.mockReset()
})

const load = async (): Promise<typeof import('./libraryStore')> => import('./libraryStore')

/** 一条合法的 Rust 侧索引条目。 */
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'la-1',
  name: '参考图.png',
  kind: 'reference',
  view: null,
  mime: 'image/png',
  relPath: 'assets/la-1.png',
  tags: ['夜景'],
  groupId: null,
  createdAt: 1700000000000,
  ...over,
})

describe('libraryStore Tauri 路径：list（normalizeAsset 归一化）', () => {
  it('字段缺失/类型异常时逐字段兜底，kind 未知归 other', async () => {
    invoke.mockResolvedValue({
      assets: [
        entry(),
        // 缺 id → 整条丢弃；其余坏字段按兜底规则归一
        entry({ id: '' }),
        entry({ id: 'la-2', name: '', kind: 'mystery', view: 3, mime: null, relPath: 7, tags: 'x', groupId: 42, createdAt: 't' }),
      ],
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
      createdAt: 0,
    })
  })

  it('assets 字段缺失/非数组时按空库处理', async () => {
    invoke.mockResolvedValue({})
    const { libraryStore } = await load()
    await expect(libraryStore.list()).resolves.toEqual([])
  })

  it('后端隔离警告逐条进 console.warn 诊断路径', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue({
      assets: [entry()],
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
    invoke.mockResolvedValue({ assets: [entry()], warnings: [42, '', null] })
    const { libraryStore } = await load()
    await libraryStore.list()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('put 返回条目携带 warnings 时同样上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(entry({ id: 'la-9', warnings: ['已隔离非法索引条目 #1：…'] }))
    const { libraryStore } = await load()
    await libraryStore.put(new File(['x'], 'a.png', { type: 'image/png' }), 'other')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toContain('已隔离非法索引条目 #1：…')
    warn.mockRestore()
  })

  it('updateMeta 返回条目携带 warnings 时同样上报诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockResolvedValue(entry({ warnings: ['条目 la-1 的 mime 已规范化： Image/PNG → image/png'] }))
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
      new File([new Uint8Array([1, 2, 255])], '新图.png', { type: 'image/png' }),
      'reference',
    )
    expect(asset.id).toBe('la-9')
    const [cmd, args] = invoke.mock.calls[0] as [string, Record<string, unknown>]
    expect(cmd).toBe('library_put')
    expect(args).toMatchObject({ name: '新图.png', mime: 'image/png', kind: 'reference' })
    expect(args.bytes).toEqual([1, 2, 255])
  })

  it('空 MIME 传参时兜底 octet-stream；返回无效条目抛错', async () => {
    invoke.mockResolvedValueOnce(entry())
    const { libraryStore } = await load()
    await libraryStore.put(new File(['x'], 'a.bin'), 'other')
    expect(invoke.mock.calls[0][1]).toMatchObject({ mime: 'application/octet-stream' })

    invoke.mockResolvedValueOnce({ id: '' })
    await expect(
      libraryStore.put(new File(['x'], 'b.bin'), 'other'),
    ).rejects.toThrow(/无效条目/)
  })
})

describe('libraryStore Tauri 路径：updateMeta / remove', () => {
  it('补丁透传给 library_update_meta；无效返回抛错', async () => {
    invoke.mockResolvedValueOnce(entry({ id: 'la-1', name: '改名.png' }))
    const { libraryStore } = await load()
    const updated = await libraryStore.updateMeta('la-1', { name: '改名.png' })
    expect(updated.name).toBe('改名.png')
    expect(invoke.mock.calls[0]).toEqual([
      'library_update_meta',
      { id: 'la-1', patch: { name: '改名.png' } },
    ])

    invoke.mockResolvedValueOnce(null)
    await expect(libraryStore.updateMeta('la-1', {})).rejects.toThrow(/无效条目/)
  })

  it('remove 透传 id 给 library_delete', async () => {
    invoke.mockResolvedValue(undefined)
    const { libraryStore } = await load()
    await libraryStore.remove('la-1')
    expect(invoke.mock.calls[0]).toEqual(['library_delete', { id: 'la-1' }])
  })
})

describe('libraryStore Tauri 路径：mediaUrl', () => {
  it('library_dir_path + 相对路径经 convertFileSrc 合成', async () => {
    invoke.mockResolvedValue('/Users/x/Library/PlotWeave/library')
    const { libraryStore } = await load()
    const url = await libraryStore.mediaUrl(entry() as unknown as LibraryAsset)
    expect(url).toBe(
      'asset://cvt//Users/x/Library/PlotWeave/library/assets/la-1.png',
    )
  })
})
