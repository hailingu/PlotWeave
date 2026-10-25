/** 资产列表状态族（AssetsPanel 拆分，issue #99；issue #802 订阅收敛）：
 * 挂载加载、错误与缩略 URL 缓存，收敛重读的投影保护与乐观隐藏。 */
import { useEffect, useRef, useState } from 'react'
import {
  libraryStore,
  subscribeLibraryChange,
  type LibraryAsset,
} from '../../library/libraryStore'
import { reconcileReloadedAssets } from './assetsListReconciliation'
import { useAssetThumbnails } from './useAssetThumbnails'

/** 资产列表加载与收敛状态族：挂载读取、错误与缩略 URL 缓存（懒加载：
 * 进入类别才取）。issue #802：订阅库门面的成功写入通知——挂载期间其他
 * 面板实例（含已卸载实例的排队写入）落定的结果即时失效重读，当前实例
 * 无需再次失焦或重挂载即收敛到最新持久化状态；重读合并保留被占有的
 * 投影与乐观隐藏（assetsListReconciliation），仅采纳最新一次发出的
 * 读取，迟到的旧响应丢弃。 */
export function useLibraryAssetList() {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const thumbnails = useAssetThumbnails()
  /** 本实例已确认删除、删除仍在途的资产：重读时不得让存储残影复活该行
   * （issue #802）；删除失败恢复时解除。 */
  const hiddenRemovals = useRef(new Set<string>())
  /** 投影仍被本实例占有的资产（在途提交或未解决失败的标签重试意图）：
   * 重读时保留本地投影（issue #802），由占有的提交钩子显式解除。 */
  const ownedProjections = useRef(new Set<string>())
  useEffect(() => {
    let alive = true
    let latestLoad = 0
    const load = () => {
      const seq = ++latestLoad
      libraryStore
        .list()
        .then((fresh) => {
          if (!alive || seq !== latestLoad) return
          setAssets((local) =>
            reconcileReloadedAssets(
              local,
              fresh,
              hiddenRemovals.current,
              ownedProjections.current,
            ),
          )
        })
        .catch((err) => {
          if (!alive || seq !== latestLoad) return
          setError(String(err))
        })
        .finally(() => {
          if (alive && seq === latestLoad) setLoading(false)
        })
    }
    load()
    const unsubscribe = subscribeLibraryChange(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  const hideAsset = (id: string) => {
    hiddenRemovals.current.add(id)
  }
  const unhideAsset = (id: string) => {
    hiddenRemovals.current.delete(id)
  }
  const ownProjection = (id: string) => {
    ownedProjections.current.add(id)
  }
  const releaseProjection = (id: string) => {
    ownedProjections.current.delete(id)
  }
  return {
    assets,
    setAssets,
    error,
    setError,
    loading,
    hideAsset,
    unhideAsset,
    ownProjection,
    releaseProjection,
    ...thumbnails,
  }
}
