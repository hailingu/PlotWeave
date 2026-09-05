/**
 * 画布拖放 hook（EditorView 拆出的交互段，docs/ui-design.md §5/§7.3）：
 * - 设定集实体：拖上节点建引用补丁；空白处按实体预填生成场景节点；
 * - 资产库条目：委托 useLibraryAssetDrop——拖上分镜卡 = 拷贝进项目
 *  （Rust 导入 + §9.3 预检）→ 资产入会话索引 + 引用位绑定，合并为
 *   **一条**可撤销命令；落点不是分镜卡或资产类型无引用位语义时不导入
 *  （不产生孤儿文件）。
 */
import { useCallback, type DragEvent as ReactDragEvent } from 'react'
import type { XYPosition } from '@xyflow/react'
import {
  PW_ENTITY_MIME,
  PW_LIBRARY_ASSET_MIME,
  hitDropNode,
  readEntityPayload,
} from './dragDrop'
import { entityDropPatch } from './entityDrop'
import { useLibraryAssetDrop, type LibraryAssetDropDeps } from './useLibraryAssetDrop'
import type { CreatableType } from './creatable'
import type { NodeDataPatch } from './nodes/patch'

/** useCanvasDrop 的依赖注入：库资产拖放子 hook 依赖 + 实体路径所需的状态读写。 */
export interface CanvasDropDeps extends LibraryAssetDropDeps {
  /** 编辑即命令通道（实体引用补丁走这里，含合并撤销）；补丁按节点类型
   * 判别绑定（issue 16）。 */
  patchNode: (id: string, cmd: NodeDataPatch) => void
  createNode: (
    type: CreatableType,
    opts?: { at?: XYPosition; data?: Record<string, unknown> },
  ) => void
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition
}

export function useCanvasDrop(deps: CanvasDropDeps) {
  const { nodesRef, patchNode, createNode, screenToFlowPosition } = deps
  const dropLibraryAsset = useLibraryAssetDrop(deps)

  const onCanvasDragOver = useCallback((e: ReactDragEvent) => {
    if (
      e.dataTransfer.types.includes(PW_ENTITY_MIME) ||
      e.dataTransfer.types.includes(PW_LIBRARY_ASSET_MIME)
    ) {
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
      const node = hitDropNode(e, nodesRef.current)
      if (node) {
        const cmd = entityDropPatch(node, entity)
        if (cmd) patchNode(node.id, cmd)
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
