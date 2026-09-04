/** Tauri 路径（IPC 门面）：mock @tauri-apps/api/core，并以
 * window.__TAURI_INTERNALS__ 让模块级 isTauri 判定为真——
 * 每个用例 resetModules 后重新动态 import，拿到隔离的模块实例。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const load = async (): Promise<typeof import('./projectAssets')> => import('./projectAssets')

/** 一条合法的 Rust 侧 AssetRef。 */
const assetRef = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pa-1',
  relPath: 'assets/pa-1.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-09-04T08:00:00.000Z',
  ...over,
})

describe('projectAssets Tauri 路径：importFromLibrary', () => {
  it('先导入后预检（§9.3）：返回预检后的规范化条目', async () => {
    invoke
      .mockResolvedValueOnce(assetRef({ mime: ' Image/PNG ' }))
      .mockResolvedValueOnce(assetRef())
    const { projectAssets } = await load()
    const asset = await projectAssets.importFromLibrary('p-1', 'la-1')
    expect(asset.id).toBe('pa-1')
    expect(asset.mime).toBe('image/png')
    expect(invoke.mock.calls[0]).toEqual([
      'import_project_asset_from_library',
      { id: 'p-1', libraryAssetId: 'la-1' },
    ])
    expect(invoke.mock.calls[1][0]).toBe('validate_project_asset')
    const validated = invoke.mock.calls[1][1] as { id: string; asset: { id: string } }
    expect(validated.id).toBe('p-1')
    expect(validated.asset.id).toBe('pa-1')
  })

  it('导入或预检返回无效条目抛错（坏数据不进会话索引）', async () => {
    invoke.mockResolvedValueOnce({ id: '' })
    const { projectAssets } = await load()
    await expect(projectAssets.importFromLibrary('p-1', 'la-1')).rejects.toThrow(/无效资产条目/)

    invoke.mockReset()
    invoke.mockResolvedValueOnce(assetRef()).mockResolvedValueOnce({ id: 'pa-1' })
    await expect(projectAssets.importFromLibrary('p-1', 'la-1')).rejects.toThrow(/无效资产条目/)
  })
})

describe('projectAssets Tauri 路径：revalidate（撤销后重做防线，issue #10）', () => {
  it('经 validate_project_asset 复验：通过则兑现；返回无效条目拒绝', async () => {
    invoke.mockResolvedValueOnce(assetRef())
    const { projectAssets } = await load()
    await expect(projectAssets.revalidate('p-1', assetRef() as never)).resolves.toBeUndefined()
    expect(invoke.mock.calls[0]).toEqual([
      'validate_project_asset',
      { id: 'p-1', asset: assetRef() },
    ])

    invoke.mockReset()
    invoke.mockResolvedValueOnce({ id: '' })
    await expect(projectAssets.revalidate('p-1', assetRef() as never)).rejects.toThrow(
      /无效资产条目/,
    )
  })
})

describe('projectAssets Tauri 路径：mediaUrl', () => {
  it('project_asset_path 返回的绝对路径经 convertFileSrc 合成', async () => {
    invoke.mockResolvedValue('/Users/x/Library/PlotWeave/projects/p-1/assets/pa-1.png')
    const { projectAssets } = await load()
    const url = await projectAssets.mediaUrl('p-1', assetRef() as never)
    expect(url).toBe('asset://cvt//Users/x/Library/PlotWeave/projects/p-1/assets/pa-1.png')
    expect(invoke.mock.calls[0]).toEqual([
      'project_asset_path',
      { id: 'p-1', relPath: 'assets/pa-1.png' },
    ])
  })
})
