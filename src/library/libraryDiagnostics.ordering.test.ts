/** PR #222：按后端 diagnosticsRevision 保持待清理快照单调，关闭/重复/非法
 * 响应均不能回退；字符串 u64 合同见 docs/data-model.md §7.2。条目为结构化
 * { kind, message } 载荷（issue #229）。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const routine = (message: string) => ({ kind: 'routine', message })

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('旧空响应和重复序号不能覆盖新条目；新空响应允许清除', async () => {
  const d = await import('./libraryDiagnostics')
  d.publishCleanupPending([routine('pending')], '2')
  d.publishCleanupPending([], '1')
  d.publishCleanupPending([], '2')
  expect(d.cleanupPendingSnapshot()).toEqual([routine('pending')])
  d.publishCleanupPending([], '3')
  expect(d.cleanupPendingSnapshot()).toEqual([])
})

it('同内容的新序号也推进版本；关闭提示不重置版本且重复内容不重显', async () => {
  const d = await import('./libraryDiagnostics')
  d.publishCleanupPending([routine('pending')], '2')
  const snapshot = d.cleanupPendingSnapshot()
  d.publishCleanupPending([routine('pending')], '4')
  expect(d.cleanupPendingSnapshot()).toBe(snapshot)
  d.publishCleanupPending([], '3')
  expect(d.cleanupPendingSnapshot()).toBe(snapshot)
  d.dismissLibraryWarnings()
  d.publishCleanupPending([routine('other')], '3')
  d.publishCleanupPending([routine('pending')], '5')
  expect(d.cleanupPendingSnapshot()).toEqual([])
  d.publishCleanupPending([routine('new')], '6')
  expect(d.cleanupPendingSnapshot()).toEqual([routine('new')])
})

it.each([
  undefined,
  null,
  2,
  '',
  '0',
  '01',
  '-1',
  '1.5',
  '18446744073709551616',
])('非法序号 %s 保留当前快照，不推进版本并记录诊断', async (revision) => {
  const d = await import('./libraryDiagnostics')
  d.publishCleanupPending([routine('pending')], '1')
  d.publishCleanupPending([], revision)
  expect(d.cleanupPendingSnapshot()).toEqual([routine('pending')])
  expect(console.warn).toHaveBeenCalledWith('[Library] 无效待清理快照', {
    code: 'LIBRARY_DIAGNOSTICS_SNAPSHOT_INVALID',
  })
  d.publishCleanupPending([routine('new')], '2')
  expect(d.cleanupPendingSnapshot()).toEqual([routine('new')])
})

it('异型载荷不提升版本；u64 大序号比较不丢精度', async () => {
  const d = await import('./libraryDiagnostics')
  d.publishCleanupPending([routine('pending')], '9007199254740992')
  d.publishCleanupPending(null, '18446744073709551615')
  d.publishCleanupPending([routine('new')], '9007199254740993')
  d.publishCleanupPending([], '9007199254740992')
  expect(d.cleanupPendingSnapshot()).toEqual([routine('new')])
  d.publishCleanupPending([], '18446744073709551615')
  expect(d.cleanupPendingSnapshot()).toEqual([])
})
