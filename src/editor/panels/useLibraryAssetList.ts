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
 * 读取，迟到的旧响应丢弃。issue #853：读取错误由有效读取成功解除；
 * setError 仅持有导入/删除错误，列表恢复不得代替操作恢复。 */
export function useLibraryAssetList() {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [operationError, setOperationError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const thumbnails = useAssetThumbnails()
  /** 本实例已确认删除、删除仍在途的资产：重读时不得让存储残影复活该行
   * （issue #802）；删除失败恢复时解除。 */
  const hiddenRemovals = useRef(new Set<string>())
  /** tags 投影被本实例占有的资产（在途提交或未解决失败的标签重试意图）：
   * 重读时只保留本地 tags 字段（PR #835 评审：失败草稿可无限期占有，
   * 不得冻结 name 等无关字段），由标签提交钩子显式解除。 */
  const ownedTagsProjections = useRef(new Set<string>())
  useEffect(() => {
    let alive = true
    let latestLoad = 0
    const load = () => {
      const seq = ++latestLoad
      libraryStore
        .list()
        .then((fresh) => {
          if (!alive || seq !== latestLoad) return
          setListError(null)
          setAssets((local) =>
            reconcileReloadedAssets(
              local,
              fresh,
              hiddenRemovals.current,
              ownedTagsProjections.current,
            ),
          )
        })
        .catch((err) => {
          if (!alive || seq !== latestLoad) return
          setListError(String(err))
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
  const ownTagsProjection = (id: string) => {
    ownedTagsProjections.current.add(id)
  }
  const releaseTagsProjection = (id: string) => {
    ownedTagsProjections.current.delete(id)
  }
  return {
    assets,
    setAssets,
    error: [listError, operationError].filter(Boolean).join('；') || null,
    setError: setOperationError,
    loading,
    hideAsset,
    unhideAsset,
    ownTagsProjection,
    releaseTagsProjection,
    ...thumbnails,
  }
}
