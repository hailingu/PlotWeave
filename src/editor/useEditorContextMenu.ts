/**
 * 右键上下文菜单触发（EditorView 拆出的交互域，docs/ui-design.md §4.3：
 * 全部操作同时可从右键菜单到达）。节点菜单在右键时单选该节点，连线菜单
 * 记录边 id，空白菜单两者皆无（复用 ＋节点 的五类创建）；三者只写入菜单
 * 触发态，具体动作由 CanvasContextMenu 经既有命令通道触发。
 */
import { useCallback, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import type { Edge } from '@xyflow/react'
import type { EditorDocument } from './useEditorDocument'
import type { ContextMenuState } from './useEditorPanels'
import type { CanvasNode } from './nodes/types'

/** 三种右键入口：节点 / 连线 / 空白画布。 */
export interface EditorContextMenuHandlers {
  onNodeContextMenu: (event: ReactMouseEvent, node: CanvasNode) => void
  onEdgeContextMenu: (event: ReactMouseEvent, edge: Edge) => void
  onPaneContextMenu: (event: ReactMouseEvent | MouseEvent) => void
}

/** 生成右键菜单处理器；节点菜单附带单选该节点的选中态写入。 */
export function useEditorContextMenu(
  doc: EditorDocument,
  setCtxMenu: Dispatch<SetStateAction<ContextMenuState | null>>,
): EditorContextMenuHandlers {
  const { setNodes } = doc
  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: CanvasNode) => {
      e.preventDefault()
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === node.id })))
      setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
    },
    [setCtxMenu, setNodes],
  )
  const onEdgeContextMenu = useCallback(
    (e: ReactMouseEvent, edge: Edge) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id })
    },
    [setCtxMenu],
  )
  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    },
    [setCtxMenu],
  )

  return { onNodeContextMenu, onEdgeContextMenu, onPaneContextMenu }
}
