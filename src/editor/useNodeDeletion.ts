/**
 * 节点删除 hook（EditorView 拆出，§4.3/§7.3）：删除一组节点及其全部连线；
 * 被删图片节点的产物若不再被幸存节点/角色头像引用，随同一可撤销复合命令
 * 移出资产索引（doomedImageAssets 判定与重新生成回收同口径，媒体文件
 * 留存待延迟回收，undo 恢复）。
 */
import { useCallback } from 'react'
import type { Edge } from '@xyflow/react'
import { doomedImageAssets } from './imagegen/state'
import type { HistoryCommand } from './history'
import type { AssetRef } from '../model/document'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'

/** useNodeDeletion 的依赖注入：状态读写与命令栈全部来自 EditorView。 */
export interface NodeDeletionDeps {
  nodesRef: { current: CanvasNode[] }
  edgesRef: { current: Edge[] }
  settings: ProjectSettings
  assetsRef: { current: { byId: Record<string, AssetRef> } | undefined }
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
  setNodes: (updater: (nds: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
  pushHistory: (cmd: HistoryCommand) => void
  closeSettings: () => void
}

/** 返回节点删除回调：⚙️ 面板与右键菜单共用入口。 */
export function useNodeDeletion(deps: NodeDeletionDeps): (ids: string[]) => void {
  const {
    nodesRef,
    edgesRef,
    settings,
    assetsRef,
    addAsset,
    removeAsset,
    setNodes,
    setEdges,
    pushHistory,
    closeSettings,
  } = deps

  return useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids)
      const removedNodes = nodesRef.current.filter((n) => idSet.has(n.id))
      if (removedNodes.length === 0) return
      const removedEdges = edgesRef.current.filter(
        (e) => idSet.has(e.source) || idSet.has(e.target),
      )
      const doomed = doomedImageAssets(
        removedNodes,
        nodesRef.current.filter((n) => !idSet.has(n.id)),
        settings.characters,
        assetsRef.current?.byId,
      )
      const apply = (remove: boolean) => {
        setNodes((nds) => (remove ? nds.filter((n) => !idSet.has(n.id)) : [...nds, ...removedNodes]))
        setEdges((eds) =>
          remove
            ? eds.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
            : [...eds, ...removedEdges],
        )
        doomed.forEach((a) => (remove ? removeAsset(a.id) : addAsset(a)))
      }
      apply(true)
      pushHistory({ undo: () => apply(false), redo: () => apply(true) })
      closeSettings()
    },
    [addAsset, assetsRef, closeSettings, edgesRef, nodesRef, pushHistory, removeAsset, setEdges, setNodes, settings.characters],
  )
}
