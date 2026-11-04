/** 资产列表跨挂载收敛的纯合并逻辑（issue #802）。 */
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

/**
 * 版本通知重读后的列表收敛（issue #802）：以最新持久化状态为基线——
 * 补入他实例落盘的新条目、移除已删除条目；两类本地投影不被过期中间态
 * 抢占：本实例确认删除仍在途（乐观隐藏）的条目不得因存储残影复活（
 * 删除失败恢复时由调用方解除隐藏）；门面在途更新/删除的条目整条保留
 * 本地投影（乐观改名与提交草稿的显示身份，瞬态——落定即再次通知收敛）。
 * 本实例标签意图（在途或未解决失败）占有的条目只按字段保留 tags——
 * 未解决失败可无限期占有，整条保留会把无关字段（如他实例已成功落盘的
 * 改名）一并冻结；tags 字段保留使提交草稿/失败草稿的显示不被推进，
 * 其余字段随最新持久化状态收敛（PR #835 评审）。被占有但本地缺失的
 * 条目（他实例导入后改名链）按最新持久化状态展示。隐藏集合由本实例
 * 独占：他实例的在途删除对本实例只是一条尚未落定的存储事实，行保持
 * 可见，落盘或失败后再按存储真值收敛。
 */
export function reconcileReloadedAssets(
  local: readonly LibraryAsset[],
  fresh: readonly LibraryAsset[],
  hiddenRemovals: ReadonlySet<string>,
  ownedTagsProjections: ReadonlySet<string>,
): LibraryAsset[] {
  return fresh
    .filter((asset) => !hiddenRemovals.has(asset.id))
    .map((asset) => {
      const localProjection = local.find((a) => a.id === asset.id)
      if (localProjection === undefined) return asset
      if (libraryStore.hasPendingOperation(asset.id)) return localProjection
      if (ownedTagsProjections.has(asset.id))
        return { ...asset, tags: localProjection.tags }
      return asset
    })
}
