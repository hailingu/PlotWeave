/**
 * 资产索引写入（EditorView 拆出的资产域，docs/ui-design.md §7.3）：新增条目
 * 按 id 键控并入，移除只删索引条目（媒体文件留存待延迟回收）。库导入、
 * 生成产物与节点删除的 apply/undo/redo 共用同一对写入。
 */
import { useCallback } from 'react'
import type { AssetRef } from '../model/document'
import type { EditorDocument } from './useEditorDocument'

/** 资产索引写入对：由调用方包进可撤销命令，本 hook 不入栈。 */
export interface AssetIndexActions {
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
}

/** 以文档状态的 setAssets 为写通道的资产索引增删。 */
export function useAssetIndex(setAssets: EditorDocument['setAssets']): AssetIndexActions {
  const addAsset = useCallback(
    (asset: AssetRef) => setAssets((cur) => ({ byId: { ...cur?.byId, [asset.id]: asset } })),
    [setAssets],
  )
  const removeAsset = useCallback(
    (assetId: string) =>
      setAssets((cur) => {
        if (!cur) return cur
        const byId = { ...cur.byId }
        delete byId[assetId]
        return { byId }
      }),
    [setAssets],
  )
  return { addAsset, removeAsset }
}
