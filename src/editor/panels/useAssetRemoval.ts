/** 资产删除确认的编排状态族（AssetsPanel 拆分，issue #99；issue #802
 * 评审拆出）：待删目标捕获与确认/取消处置——纯编排，乐观隐藏删除的
 * 执行体（removeLibraryAsset）与确认框渲染留在 AssetsPanel。 */
import { useState } from 'react'
import { libraryStore, type LibraryAsset } from '../../library/libraryStore'
import { renameBaselineSnapshot } from './assetsRenameState'

/** Confirmation retains its displayed asset and an independently captured durable name for a rejected deletion. */
export interface AssetRemoval {
  readonly asset: LibraryAsset
  readonly fallbackName: string
}

/** Opening a dialog must not clear rename state; confirmed metadata can still advance before deletion finishes. */
export function assetRemovalTarget(asset: LibraryAsset): AssetRemoval {
  return {
    asset,
    fallbackName:
      libraryStore.persistedSnapshot(asset.id)?.name ??
      renameBaselineSnapshot(asset.id) ??
      asset.name,
  }
}

/** 确认删除编排状态族（issue #802 评审拆出）：捕获待删目标（含拒绝
 * 回退的已落盘名称锚点，见 assetRemovalTarget——门面跨挂载快照优先，
 * 改名锚点兜底），确认时终结该行标签/改名编辑再执行乐观隐藏删除；
 * 取消仅关闭确认框。 */
export function useAssetRemoval(
  forgetTags: (id: string) => void,
  forgetRename: (id: string) => void,
  removeAsset: (asset: LibraryAsset) => void,
) {
  /** 待删除资产（非 null 时弹应用内确认框）。 */
  const [pendingRemove, setPendingRemove] = useState<AssetRemoval | null>(null)
  const requestRemove = (asset: LibraryAsset) =>
    setPendingRemove(assetRemovalTarget(asset))
  const confirmRemove = ({ asset, fallbackName }: AssetRemoval) => {
    forgetTags(asset.id)
    forgetRename(asset.id)
    removeAsset({ ...asset, name: fallbackName })
  }
  return {
    pendingRemove,
    requestRemove,
    confirmRemove,
    closeRemove: () => setPendingRemove(null),
  }
}
