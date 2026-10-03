/**
 * 节点位置历史入口：拖拽整段一步，非拖拽位置变更（键盘移动）每批一步；
 * 坐标回放共用文档写通道，选择、测量和无位移变更不进入命令栈。
 */
import { useCallback, useRef } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'
import type { EditorDocument } from './useEditorDocument'

/** useNodeDragHistory 的依赖注入：写通道与命令栈来自 EditorView。 */
export interface NodeDragHistoryDeps {
  nodesRef: EditorDocument['nodesRef']
  onNodesChange: EditorDocument['onNodesChange']
  setNodes: (fn: (nds: CanvasNode[]) => CanvasNode[]) => void
  pushHistory: (cmd: HistoryCommand) => void
}

/** 仅捕获实际移动节点的前后坐标；回放保留节点其他属性与未参与节点。 */
function recordPositionHistory(
  {
    setNodes,
    pushHistory,
  }: Pick<NodeDragHistoryDeps, 'setNodes' | 'pushHistory'>,
  before: Map<string, XYPosition>,
  after: Map<string, XYPosition>,
) {
  const movedBefore = new Map<string, XYPosition>()
  const movedAfter = new Map<string, XYPosition>()
  for (const [id, position] of after) {
    const previous = before.get(id)
    if (!previous || (previous.x === position.x && previous.y === position.y))
      continue
    movedBefore.set(id, { ...previous })
    movedAfter.set(id, { ...position })
  }
  if (movedAfter.size === 0) return
  const apply = (positions: Map<string, XYPosition>) =>
    setNodes((nodes) =>
      nodes.map((node) => {
        const position = positions.get(node.id)
        return position ? { ...node, position: { ...position } } : node
      }),
    )
  pushHistory({ undo: () => apply(movedBefore), redo: () => apply(movedAfter) })
}

/** 统一接线框架位置变更与拖拽起止；拖拽期间仅由 stop 记录历史，避免重复入栈。 */
export function useNodeDragHistory({
  nodesRef,
  onNodesChange: applyNodeChanges,
  setNodes,
  pushHistory,
}: NodeDragHistoryDeps) {
  const dragStartPos = useRef<Map<string, XYPosition> | null>(null)

  const onNodesChange = useCallback<EditorDocument['onNodesChange']>(
    (changes) => {
      const after = new Map<string, XYPosition>()
      if (dragStartPos.current === null) {
        for (const change of changes) {
          if (
            change.type === 'position' &&
            change.dragging === false &&
            change.position
          )
            after.set(change.id, change.position)
        }
      }
      if (after.size > 0) {
        const before = new Map(
          nodesRef.current.map((node) => [node.id, node.position]),
        )
        recordPositionHistory({ setNodes, pushHistory }, before, after)
      }
      applyNodeChanges(changes)
    },
    [applyNodeChanges, nodesRef, pushHistory, setNodes],
  )

  const onNodeDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, _node: CanvasNode, dragged: CanvasNode[]) => {
      dragStartPos.current = new Map(
        dragged.map((n) => [n.id, { ...n.position }]),
      )
    },
    [],
  )

  const onNodeDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, _node: CanvasNode, dragged: CanvasNode[]) => {
      const before = dragStartPos.current
      dragStartPos.current = null
      if (!before) return
      const after = new Map(dragged.map((node) => [node.id, node.position]))
      recordPositionHistory({ setNodes, pushHistory }, before, after)
    },
    [pushHistory, setNodes],
  )

  return { onNodesChange, onNodeDragStart, onNodeDragStop }
}
