/** 图库诊断会话存储的单元测试：警告累积/去重语义与删除隔离区待清理
 * 状态（issue #135）的快照、关闭与不误报语义。模块级状态经
 * resetModules + 动态 import 隔离。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const load = async (): Promise<typeof import('./libraryDiagnostics')> =>
  import('./libraryDiagnostics')

beforeEach(() => {
  vi.resetModules()
})

describe('libraryDiagnostics：删除隔离区待清理状态（issue #135）', () => {
  it('发布待清理条目后快照可见；内容非数组/空数组不显示（不误报）', async () => {
    const d = await load()
    d.publishCleanupPending('not-an-array')
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishCleanupPending([])
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishCleanupPending(['媒体已隔离待清理：assets/la-1.png', 'la-2.png'])
    expect(d.cleanupPendingSnapshot()).toEqual([
      '媒体已隔离待清理：assets/la-1.png',
      'la-2.png',
    ])
  })

  it('关闭后内容不变保持隐藏，内容变化即重新显示', async () => {
    const d = await load()
    d.publishCleanupPending(['assets/la-1.png'])
    expect(d.cleanupPendingSnapshot()).toHaveLength(1)
    d.dismissLibraryWarnings()
    expect(d.cleanupPendingSnapshot()).toEqual([])
    // 相同内容再次发布：用户已关闭本轮，保持隐藏（不重复打扰）
    d.publishCleanupPending(['assets/la-1.png'])
    expect(d.cleanupPendingSnapshot()).toEqual([])
    // 内容变化（新增待清理项）：重新显示
    d.publishCleanupPending(['assets/la-1.png', 'assets/la-2.png'])
    expect(d.cleanupPendingSnapshot()).toHaveLength(2)
  })

  it('快照语义是当前状态而非历史累积：条目减少即跟随', async () => {
    const d = await load()
    d.publishCleanupPending(['a', 'b', 'c'])
    expect(d.cleanupPendingSnapshot()).toHaveLength(3)
    // 恢复完成/部分清理后的新快照替换旧状态（不累积新旧两份）
    d.publishCleanupPending(['a'])
    expect(d.cleanupPendingSnapshot()).toEqual(['a'])
    d.publishCleanupPending([])
    expect(d.cleanupPendingSnapshot()).toEqual([])
  })

  it('关闭同时清空警告与待清理显示，但后续警告仍可重新显示', async () => {
    const d = await load()
    d.publishLibraryWarnings(['已隔离非法索引条目 #1：…'])
    d.publishCleanupPending(['assets/la-1.png'])
    d.dismissLibraryWarnings()
    expect(d.libraryWarningsSnapshot()).toEqual([])
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishLibraryWarnings(['已隔离非法索引条目 #2：…'])
    expect(d.libraryWarningsSnapshot()).toEqual(['已隔离非法索引条目 #2：…'])
  })
})
