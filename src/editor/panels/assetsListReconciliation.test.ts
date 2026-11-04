/** 收敛合并的纯逻辑单元（issue #802）：重读列表对门面在途整条保留、
 * 标签意图字段级保留、乐观隐藏与新增条目的处置——集成行为由
 * AssetsPanel.remount.test.tsx 验证。 */
import { describe, expect, it, vi } from 'vitest'
import { reconcileReloadedAssets } from './assetsListReconciliation'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

const asset = (id: string, over: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id,
  name: id,
  kind: 'character',
  view: null,
  mime: 'image/png',
  relPath: `assets/${id}.png`,
  tags: [],
  groupId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('reconcileReloadedAssets（issue #802）', () => {
  const facadePending = new Set(['facade-pending'])
  const ownedTags = new Set(['owned-tags'])
  const empty = new Set<string>()
  vi.spyOn(libraryStore, 'hasPendingOperation').mockImplementation(
    (id: string) => facadePending.has(id),
  )

  it('无占有/隐藏时整表采用最新持久化状态', () => {
    expect(
      reconcileReloadedAssets(
        [asset('local')],
        [asset('fresh')],
        empty,
        ownedTags,
      ),
    ).toEqual([asset('fresh')])
  })

  it('门面在途更新的条目整条保留本地投影（乐观改名/提交草稿，瞬态）', () => {
    expect(
      reconcileReloadedAssets(
        [asset('facade-pending', { name: '乐观名' })],
        [asset('facade-pending', { name: '旧名' })],
        empty,
        ownedTags,
      ),
    ).toEqual([asset('facade-pending', { name: '乐观名' })])
  })

  it('标签意图占有的条目只保留 tags 字段，无关字段随存储收敛（PR #835 评审）', () => {
    expect(
      reconcileReloadedAssets(
        [asset('owned-tags', { name: '旧名', tags: ['草稿'] })],
        [asset('owned-tags', { name: '新名', tags: ['已存'] })],
        empty,
        ownedTags,
      ),
    ).toEqual([asset('owned-tags', { name: '新名', tags: ['草稿'] })])
  })

  it('本实例乐观隐藏的删除在途条目不因存储残影复活', () => {
    expect(
      reconcileReloadedAssets(
        [asset('hidden')],
        [asset('hidden'), asset('kept')],
        new Set(['hidden']),
        ownedTags,
      ),
    ).toEqual([asset('kept')])
  })

  it('他实例导入落盘的新条目补入展示', () => {
    expect(
      reconcileReloadedAssets([], [asset('imported')], empty, ownedTags),
    ).toEqual([asset('imported')])
  })

  it('被占有但本地缺失的条目（他实例导入后改名链）按最新持久化状态展示', () => {
    expect(
      reconcileReloadedAssets(
        [asset('other')],
        [asset('facade-pending', { name: '落盘名' })],
        empty,
        empty,
      ),
    ).toEqual([asset('facade-pending', { name: '落盘名' })])
  })

  it('已在存储删除的条目移出展示', () => {
    expect(
      reconcileReloadedAssets([asset('gone')], [], empty, ownedTags),
    ).toEqual([])
  })
})
