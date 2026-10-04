import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetRef } from '../model/document'

/**
 * 内存回退边界（docs/swiftui-react-flow-migration-plan.md §3、矩阵 M16）：
 * 「内存回退仅限纯浏览器预览」是收敛后的关键不变量——Swift 宿主（原生
 * 注入 `__pwNativeHost={kind:"swift"}`、无 Tauri 标记）调用任一存储门面
 * 都必须以稳定错误码可见失败（§4.1 首次加载失败提供可见错误，不显示虚假
 * 的空项目/空历史），绝不静默落入内存模式伪装成功。
 */

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

const stubSwiftHost = () =>
  vi.stubGlobal('window', { __pwNativeHost: { kind: 'swift' } })

const stubBrowserPreview = () => vi.stubGlobal('window', {})

const assetRef: AssetRef = {
  id: 'pa_probe',
  relPath: 'assets/pa_probe.png',
  mime: 'image/png',
  source: 'upload',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('Swift 宿主：存储门面可见失败，不落内存模式', () => {
  beforeEach(stubSwiftHost)

  it('projectStore.list 拒绝（不得以内存列表伪装成功）', async () => {
    const { projectStore } = await import('../projectStore')
    await expect(projectStore.list()).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })

  it('settingsStore.load 拒绝（不得以默认值内存态伪装成功）', async () => {
    const { settingsStore } = await import('../settings/settingsStore')
    await expect(settingsStore.load()).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })

  it('libraryStore.list 拒绝', async () => {
    const { libraryStore } = await import('../library/libraryStore')
    await expect(libraryStore.list()).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })

  it('loadAiSession 拒绝（不得返回空历史）', async () => {
    const { loadAiSession } = await import('../aiSessionStore')
    await expect(loadAiSession('p1')).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })

  it('projectAssets.mediaUrl 拒绝（不得走内存 object URL 路径）', async () => {
    const { projectAssets } = await import('../editor/projectAssets')
    await expect(
      projectAssets.mediaUrl('p1', assetRef.id),
    ).rejects.toMatchObject({
      code: 'PW_HOST_COMMAND_UNAVAILABLE',
    })
  })
})

describe('纯浏览器预览：内存回退保持现状', () => {
  beforeEach(stubBrowserPreview)

  it('projectStore.list 解析内存种子列表', async () => {
    const { projectStore } = await import('../projectStore')
    const list = await projectStore.list()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
  })

  it('settingsStore.load 解析默认设置（providers 就位）', async () => {
    const { settingsStore } = await import('../settings/settingsStore')
    const settings = await settingsStore.load()
    expect(Array.isArray(settings.providers)).toBe(true)
  })

  it('loadAiSession 返回空历史', async () => {
    const { loadAiSession } = await import('../aiSessionStore')
    const result = await loadAiSession('p1')
    expect(result.session.entries).toEqual([])
  })

  it('projectAssets.mediaUrl 走内存路径（回退诊断，而非宿主错误码）', async () => {
    const { projectAssets } = await import('../editor/projectAssets')
    await expect(projectAssets.mediaUrl('p1', assetRef.id)).rejects.toThrow(
      '浏览器预览不落盘',
    )
  })
})
