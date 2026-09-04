/**
 * 库资产落分镜卡的异步编排 hook（docs/ui-design.md §7.3）：
 * 先按载荷判定引用位 kind（不支持则不调导入，避免孤儿文件）；同一分镜卡
 * 导入在途期间的再次拖入在导入调用前拒绝——两个 in-flight 导入读同一
 * refs 快照会互相覆盖（丢一次绑定且两份资产都滞留索引）；导入成功后以
 * Rust 返回的权威 MIME 复核 kind（载荷可能过期/伪造），再绑定并入栈。
 * 文件落盘是拷贝语义，撤销只回滚索引条目与引用位（§7.3 延迟回收：
 * 文件不随撤销删除）；重做经 redoGuard 复验落盘状态后才恢复（issue #10：
 * 撤销窗口内文件被外部删改则拒绝重做入脏）。
 */
import { useCallback, useRef, type DragEvent as ReactDragEvent, type RefObject } from 'react'
import { hitDropNode, readLibraryAssetPayload } from './dragDrop'
import { bindAssetRefPatch, shotRefKindForAsset } from './assetDrop'
import { projectAssets } from './projectAssets'
import type { HistoryCommand } from './history'
import type { AssetRef } from '../model/document'
import type { CanvasNode } from './nodes/types'

/** useLibraryAssetDrop 的依赖注入：状态读写与命令栈全部来自 EditorView。 */
export interface LibraryAssetDropDeps {
  projectId: string
  nodesRef: RefObject<CanvasNode[]>
  /** 纯状态写入（资产绑定命令的 redo/undo 与初次应用共用）。 */
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
  pushHistory: (cmd: HistoryCommand) => void
  /** 用户可见的拖放失败诊断（类型不支持 / 在途冲突 / MIME 不符 / 落盘失败）。 */
  onError: (message: string) => void
}

/** 返回库资产 drop 处理器；由 useCanvasDrop 在实体载荷不命中时委托调用。 */
export function useLibraryAssetDrop(deps: LibraryAssetDropDeps) {
  const { projectId, nodesRef, applyDataPatch, addAsset, removeAsset, pushHistory, onError } = deps
  /** 同一分镜卡的导入在途标记（按 nodeId 串行化，宁可拒绝也不覆盖绑定）。 */
  const inFlightRef = useRef(new Set<string>())

  return useCallback(
    (e: ReactDragEvent) => {
      const payload = readLibraryAssetPayload(e.dataTransfer)
      if (!payload) return
      e.preventDefault()
      const node = hitDropNode(e, nodesRef.current)
      if (node?.type !== 'shot') return
      const kind = shotRefKindForAsset(payload)
      if (kind === null) {
        onError(`资产「${payload.name}」（${payload.mime}）不能作为分镜引用位`)
        return
      }
      const nodeId = node.id
      if (inFlightRef.current.has(nodeId)) {
        onError(`分镜卡正在导入资产，请稍后再拖入「${payload.name}」`)
        return
      }
      inFlightRef.current.add(nodeId)
      void (async () => {
        try {
          const asset = await projectAssets.importFromLibrary(projectId, payload.id)
          // 载荷可能过期/伪造：以导入返回的权威 MIME 复核引用位 kind
          if (shotRefKindForAsset({ kind: payload.kind, mime: asset.mime }) !== kind) {
            onError(`资产「${payload.name}」实际类型（${asset.mime}）与拖拽载荷不符，未绑定`)
            return
          }
          // 导入在途期间节点可能被删除/改型：以当前状态为准重查
          const cur = nodesRef.current?.find((n) => n.id === nodeId)
          if (cur?.type !== 'shot') return
          const before = cur.data.refs
          const patch = bindAssetRefPatch(before, kind, asset.id)
          if (!patch) return
          const next = patch.refs
          addAsset(asset)
          applyDataPatch(nodeId, { refs: next })
          pushHistory({
            undo: () => {
              removeAsset(asset.id)
              applyDataPatch(nodeId, { refs: before })
            },
            // 重做防线（issue #10）：撤销窗口内文件可能被外部删改，
            // redoGuard 复验通过才应用；拒绝则本次重做放弃（文件恢复后可重试）
            redoGuard: () => projectAssets.revalidate(projectId, asset),
            redo: () => {
              addAsset(asset)
              applyDataPatch(nodeId, { refs: next })
            },
          })
        } catch (err) {
          onError(`资产「${payload.name}」导入失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          inFlightRef.current.delete(nodeId)
        }
      })()
    },
    [projectId, nodesRef, applyDataPatch, addAsset, removeAsset, pushHistory, onError],
  )
}
