/**
 * 画布拖放 hook（EditorView 拆出的交互段，docs/ui-design.md §5/§7.3）：
 * - 设定集实体：拖上节点建引用补丁；空白处按实体预填生成场景节点；
 * - 资产库条目：拖上分镜卡 = 拷贝进项目（Rust 导入 + §9.3 预检）→
 *   资产入会话索引 + 引用位绑定，合并为**一条**可撤销命令；
 *   落点不是分镜卡或资产类型无引用位语义时不导入（不产生孤儿文件）。
 */
import { useCallback, type DragEvent as ReactDragEvent, type RefObject } from 'react'
import type { XYPosition } from '@xyflow/react'
import { PW_ENTITY_MIME, PW_LIBRARY_ASSET_MIME, readEntityPayload, readLibraryAssetPayload } from './dragDrop'
import { entityDropPatch } from './entityDrop'
import { bindAssetRefPatch, shotRefKindForAsset } from './assetDrop'
import { projectAssets } from './projectAssets'
import type { HistoryCommand } from './history'
import type { CreatableType } from './creatable'
import type { AssetRef } from '../model/document'
import type { CanvasNode } from './nodes/types'

/** useCanvasDrop 的依赖注入：状态读写与命令栈全部来自 EditorView。 */
export interface CanvasDropDeps {
  projectId: string
  nodesRef: RefObject<CanvasNode[]>
  /** 编辑即命令通道（实体引用补丁走这里，含合并撤销）。 */
  patchNode: (id: string, patch: Record<string, unknown>) => void
  /** 纯状态写入（资产绑定命令的 redo/undo 与初次应用共用）。 */
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  createNode: (
    type: CreatableType,
    opts?: { at?: XYPosition; data?: Record<string, unknown> },
  ) => void
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
  pushHistory: (cmd: HistoryCommand) => void
  /** 用户可见的拖放失败诊断（类型不支持 / 导入落盘失败）。 */
  onError: (message: string) => void
}

/** drop 命中的节点：事件目标向上找 .react-flow__node 容器取 data-id。 */
function hitNode(e: ReactDragEvent, nodesRef: RefObject<CanvasNode[]>): CanvasNode | undefined {
  const hit = (e.target as HTMLElement).closest?.('.react-flow__node') as HTMLElement | null
  const nodeId = hit?.dataset.id
  return nodeId ? nodesRef.current?.find((n) => n.id === nodeId) : undefined
}

export function useCanvasDrop(deps: CanvasDropDeps) {
  const {
    projectId,
    nodesRef,
    patchNode,
    applyDataPatch,
    createNode,
    screenToFlowPosition,
    addAsset,
    removeAsset,
    pushHistory,
    onError,
  } = deps

  /** 库资产落分镜卡的异步编排：先按载荷判定引用位 kind（不支持则不调
   * 导入，避免孤儿文件），导入成功后才绑定并入栈——文件落盘是拷贝语义，
   * 撤销只回滚索引条目与引用位（§7.3 延迟回收：文件不随撤销删除）。 */
  const dropLibraryAsset = useCallback(
    (e: ReactDragEvent) => {
      const payload = readLibraryAssetPayload(e.dataTransfer)
      if (!payload) return
      e.preventDefault()
      const node = hitNode(e, nodesRef)
      if (node?.type !== 'shot') return
      const kind = shotRefKindForAsset(payload)
      if (kind === null) {
        onError(`资产「${payload.name}」（${payload.mime}）不能作为分镜引用位`)
        return
      }
      const nodeId = node.id
      void (async () => {
        try {
          const asset = await projectAssets.importFromLibrary(projectId, payload.id)
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
            redo: () => {
              addAsset(asset)
              applyDataPatch(nodeId, { refs: next })
            },
          })
        } catch (err) {
          onError(`资产「${payload.name}」导入失败：${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    },
    [projectId, nodesRef, applyDataPatch, addAsset, removeAsset, pushHistory, onError],
  )

  const onCanvasDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes(PW_ENTITY_MIME) || e.dataTransfer.types.includes(PW_LIBRARY_ASSET_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const onCanvasDrop = useCallback(
    (e: ReactDragEvent) => {
      const entity = readEntityPayload(e.dataTransfer)
      if (!entity) {
        dropLibraryAsset(e)
        return
      }
      e.preventDefault()
      const node = hitNode(e, nodesRef)
      if (node) {
        const patch = entityDropPatch(node, entity)
        if (patch) patchNode(node.id, patch)
        return
      }
      // 空白处：按实体预填生成场景（§5 拖上空画布直接生成预填节点）
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (entity.kind === 'character') {
        createNode('scene', { at, data: { characterIds: [entity.id] } })
      } else {
        createNode('scene', { at, data: { locationId: entity.id } })
      }
    },
    [dropLibraryAsset, nodesRef, patchNode, screenToFlowPosition, createNode],
  )

  return { onCanvasDragOver, onCanvasDrop }
}
