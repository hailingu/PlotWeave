/**
 * 项目资产门面浏览器内存回退路径（无 __TAURI_INTERNALS__）：
 * 导入生成合法 AssetRef（假规范 relPath，能过归一化往返），并经源
 * blob 建独立 object URL——拷贝语义：源库资产删除不影响项目缩略图
 * （issue #8），重载即失效（预览语义，不落盘）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', {})
})

const load = async () => {
  const { libraryStore } = await import('../library/libraryStore')
  const { projectAssets } = await import('./projectAssets')
  return { libraryStore, projectAssets }
}

describe('projectAssets 内存回退：importFromLibrary', () => {
  it('生成项目级 AssetRef：新 id、assets/ 前缀 relPath、规范 mime、source=upload、规范 UTC createdAt', async () => {
    const { libraryStore, projectAssets } = await load()
    const lib = await libraryStore.put(new File([new Uint8Array([1])], '林晚.PNG', { type: 'image/png' }), 'character')
    const asset = await projectAssets.importFromLibrary('p-1', lib.id)
    expect(asset.id.startsWith('pa-')).toBe(true)
    expect(asset.relPath).toBe(`assets/${asset.id}.png`)
    expect(asset.mime).toBe('image/png')
    expect(asset.source).toBe('upload')
    expect(new Date(asset.createdAt).toISOString()).toBe(asset.createdAt)
  })

  it('未知库资产拒绝', async () => {
    const { projectAssets } = await load()
    await expect(projectAssets.importFromLibrary('p-1', 'la-9')).rejects.toThrow(/库资产不存在/)
  })
})

describe('projectAssets 内存回退：mediaUrl', () => {
  it('本会话导入的资产解析出 object URL；未知资产拒绝', async () => {
    const { libraryStore, projectAssets } = await load()
    const lib = await libraryStore.put(new File(['x'], 'a.png', { type: 'image/png' }), 'reference')
    const asset = await projectAssets.importFromLibrary('p-1', lib.id)
    const url = await projectAssets.mediaUrl('p-1', asset)
    expect(url.startsWith('blob:')).toBe(true)
    await expect(
      projectAssets.mediaUrl('p-1', { ...asset, id: 'pa-gone' }),
    ).rejects.toThrow(/不在本会话内存/)
  })

  it('源库资产删除后项目媒体 URL 仍解析（拷贝语义 §7.3，issue #8）', async () => {
    const { libraryStore, projectAssets } = await load()
    const lib = await libraryStore.put(new File(['y'], 'b.png', { type: 'image/png' }), 'character')
    const asset = await projectAssets.importFromLibrary('p-1', lib.id)
    await libraryStore.remove(lib.id)
    await expect(projectAssets.mediaUrl('p-1', asset)).resolves.toMatch(/^blob:/)
  })
})

describe('projectAssets 内存回退：revalidate', () => {
  it('无盘上文件可校验：恒通过（重做防线在预览态直通，issue #10）', async () => {
    const { projectAssets } = await load()
    const asset = {
      id: 'pa-1',
      relPath: 'assets/pa-1.png',
      mime: 'image/png',
      source: 'upload',
      createdAt: '2026-09-04T08:00:00.000Z',
    } as const
    await expect(projectAssets.revalidate('p-1', asset)).resolves.toBeUndefined()
  })
})
