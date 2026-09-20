/** 图库诊断会话存储的单元测试：警告累积/去重语义与删除隔离区待清理
 * 状态（issue #135）的快照、关闭与不误报语义；待清理条目为结构化
 * { kind, message } 载荷（issue #229），分类按机器码 kind 不经文案。
 * 模块级状态经 resetModules + 动态 import 隔离。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const load = async (): Promise<typeof import('./libraryDiagnostics')> =>
  import('./libraryDiagnostics')

const routine = (message: string) => ({ kind: 'routine' as const, message })
const evidence = (message: string) => ({ kind: 'evidence' as const, message })

beforeEach(() => {
  vi.resetModules()
})

describe('libraryDiagnostics：删除隔离区待清理状态（issue #135）', () => {
  it('警告触发的清理保护跨关闭、空响应和重复发布保留', async () => {
    const d = await load()
    expect(d.libraryCleanupBlockedSnapshot()).toBe(false)
    d.publishLibraryWarnings([null, '', 1])
    expect(d.libraryCleanupBlockedSnapshot()).toBe(false)
    d.publishLibraryWarnings(['无法自动核对的图库状态'])
    expect(d.libraryCleanupBlockedSnapshot()).toBe(true)
    d.dismissLibraryWarnings()
    d.publishLibraryWarnings([])
    d.publishLibraryWarnings(undefined)
    d.publishCleanupPending([], '1')
    expect(d.libraryWarningsSnapshot()).toEqual([])
    expect(d.libraryCleanupBlockedSnapshot()).toBe(true)
    d.publishLibraryWarnings(['无法自动核对的图库状态'])
    expect(d.libraryCleanupBlockedSnapshot()).toBe(true)
  })

  it('发布结构化待清理条目后快照可见；内容非数组/空数组不显示（不误报）', async () => {
    const d = await load()
    d.publishCleanupPending('not-an-array', '2')
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishCleanupPending([], '3')
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishCleanupPending(
      [routine('媒体已隔离待清理：assets/la-1.png'), evidence('.trash/t-2')],
      '4',
    )
    expect(d.cleanupPendingSnapshot()).toEqual([
      routine('媒体已隔离待清理：assets/la-1.png'),
      evidence('.trash/t-2'),
    ])
  })

  it('关闭后内容不变保持隐藏，内容变化即重新显示', async () => {
    const d = await load()
    d.publishCleanupPending([routine('媒体已隔离待清理：assets/la-1.png')], '5')
    expect(d.cleanupPendingSnapshot()).toHaveLength(1)
    d.dismissLibraryWarnings()
    expect(d.cleanupPendingSnapshot()).toEqual([])
    // 结构相同的新对象再次发布：用户已关闭本轮，保持隐藏（按内容比较，
    // 新载荷对象引用不同不得误判为内容变化而重复打扰）
    d.publishCleanupPending([routine('媒体已隔离待清理：assets/la-1.png')], '6')
    expect(d.cleanupPendingSnapshot()).toEqual([])
    // 内容变化（新增待清理项）：重新显示
    d.publishCleanupPending(
      [routine('媒体已隔离待清理：assets/la-1.png'), evidence('.trash/t-2')],
      '7',
    )
    expect(d.cleanupPendingSnapshot()).toHaveLength(2)
  })

  it('快照语义是当前状态而非历史累积：条目减少即跟随', async () => {
    const d = await load()
    d.publishCleanupPending([routine('a'), routine('b'), routine('c')], '8')
    expect(d.cleanupPendingSnapshot()).toHaveLength(3)
    // 恢复完成/部分清理后的新快照替换旧状态（不累积新旧两份）
    d.publishCleanupPending([routine('a')], '9')
    expect(d.cleanupPendingSnapshot()).toEqual([routine('a')])
    d.publishCleanupPending([], '10')
    expect(d.cleanupPendingSnapshot()).toEqual([])
  })

  it('关闭同时清空警告与待清理显示，但后续警告仍可重新显示', async () => {
    const d = await load()
    d.publishLibraryWarnings(['已隔离非法索引条目 #1：…'])
    d.publishCleanupPending(
      [routine('媒体已隔离待清理：assets/la-1.png')],
      '11',
    )
    d.dismissLibraryWarnings()
    expect(d.libraryWarningsSnapshot()).toEqual([])
    expect(d.cleanupPendingSnapshot()).toEqual([])
    d.publishLibraryWarnings(['已隔离非法索引条目 #2：…'])
    expect(d.libraryWarningsSnapshot()).toEqual(['已隔离非法索引条目 #2：…'])
  })

  it('归一化 fail-safe（issue #229）：未知 kind 与裸字符串一律归证据类，缺 message 的条目丢弃', async () => {
    const d = await load()
    d.publishCleanupPending(
      [
        // 后端未来新增类别：前端不认识即不得给清理指引（保守归证据）
        { kind: 'future-kind', message: '新类别：whatever' },
        // 裸字符串（脏数据/旧形态）：同样不得给清理指引
        '媒体已隔离待清理：assets/la-9.png',
        // 缺/空 message 的条目无法展示，丢弃
        { kind: 'routine' },
        { kind: 'routine', message: '' },
        42,
      ],
      '12',
    )
    expect(d.cleanupPendingSnapshot()).toEqual([
      evidence('新类别：whatever'),
      evidence('媒体已隔离待清理：assets/la-9.png'),
    ])
  })
})

describe('partitionCleanupPending：按机器码 kind 分类（issue #229）', () => {
  it('kind 决定分类：routine 可给清理指引，evidence 不得指引删除', async () => {
    const d = await load()
    const { routine: r, evidence: e } = d.partitionCleanupPending([
      routine('媒体已隔离待清理：assets/la-1.png'),
      routine('隔离项保留（身份绑定清理不可用）：la-2 / .trash/t-x'),
      evidence('隔离项保留（身份不符或被占用）：la-4 / .trash/t-y'),
      evidence('.trash/t-indexuncertain-1'),
    ])
    expect(r).toEqual([
      '媒体已隔离待清理：assets/la-1.png',
      '隔离项保留（身份绑定清理不可用）：la-2 / .trash/t-x',
    ])
    expect(e).toEqual([
      '隔离项保留（身份不符或被占用）：la-4 / .trash/t-y',
      '.trash/t-indexuncertain-1',
    ])
  })

  it('文案措辞/本地化不改变分类——同文案不同 kind 各归各类', async () => {
    const d = await load()
    // 验收：改变展示文案不改变清理分类——分类只读 kind，不推导自然语言
    const { routine: r, evidence: e } = d.partitionCleanupPending([
      routine('隔离项保留（身份不符或被占用）：la-4 / .trash/t-y'),
      evidence('媒体已隔离待清理：assets/la-1.png'),
    ])
    expect(r).toEqual(['隔离项保留（身份不符或被占用）：la-4 / .trash/t-y'])
    expect(e).toEqual(['媒体已隔离待清理：assets/la-1.png'])
  })

  it('运行期未知 kind  fail-safe 归证据（绕过类型的脏数据同样不给删除指引）', async () => {
    const d = await load()
    const dirty = {
      kind: 'unexpected',
      message: 'whatever',
    } as unknown as Parameters<typeof d.partitionCleanupPending>[0][number]
    const { routine: r, evidence: e } = d.partitionCleanupPending([dirty])
    expect(r).toEqual([])
    expect(e).toEqual(['whatever'])
  })
})
