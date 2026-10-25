/** 资产列表跨挂载收敛的纯合并逻辑（issue #802）。 */
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'

/**
 * 版本通知重读后的列表收敛（issue #802）：以最新持久化状态为基线——
 * 补入他实例落盘的新条目、移除已删除条目；两类本地投影不被过期中间态
 * 抢占：本实例确认删除仍在途（乐观隐藏）的条目不得因存储残影复活（
 * 删除失败恢复时由调用方解除隐藏）；投影仍被占有的条目（ownedProjections
 * 含本实例在途提交或未解决失败的标签重试意图；门面在途更新/删除经
 * hasPendingOperation 判定——其落定/解除会再次发布通知或走既定同步点
 * 收敛）保留本地投影，保住乐观改名与提交草稿的显示身份。投影被占有但
 * 本地缺失的条目（他实例导入后改名链）按最新持久化状态展示。隐藏集合
 * 由本实例独占：他实例的在途删除对本实例只是一条尚未落定的存储事实，
 * 行保持可见，落盘或失败后再按存储真值收敛。
 */
export function reconcileReloadedAssets(
  local: readonly LibraryAsset[],
  fresh: readonly LibraryAsset[],
  hiddenRemovals: ReadonlySet<string>,
  ownedProjections: ReadonlySet<string>,
): LibraryAsset[] {
  return fresh
    .filter((asset) => !hiddenRemovals.has(asset.id))
    .map((asset) => {
      if (
        !ownedProjections.has(asset.id) &&
        !libraryStore.hasPendingOperation(asset.id)
      )
        return asset
      return local.find((a) => a.id === asset.id) ?? asset
    })
}
