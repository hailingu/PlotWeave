/**
 * 节点拖拽历史 hook（EditorView 拆出的交互段）：节点拖拽整段记为一步
 * 撤销——起点位置在 dragStart 记录、落点入栈，过程帧不入栈。
 */
import { useCallback, useRef } from 'react'
import type { XYPosition } from '@xyflow/react'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

/** useNodeDragHistory 的依赖注入：写通道与命令栈来自 EditorView。 */
export interface NodeDragHistoryDeps {
  setNodes: (fn: (nds: CanvasNode[]) => CanvasNode[]) => void
  pushHistory: (cmd: HistoryCommand) => void
}

export function useNodeDragHistory({ setNodes, pushHistory }: NodeDragHistoryDeps) {
  const dragStartPos = useRef<Map<string, XYPosition> | null>(null)

  const onNodeDragStart = useCallback(
    (_e: MouseEvent | TouchEvent, _node: CanvasNode, dragged: CanvasNode[]) => {
      dragStartPos.current = new Map(dragged.map((n) => [n.id, { ...n.position }]))
    },
    [],
  )

  const onNodeDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, _node: CanvasNode, dragged: CanvasNode[]) => {
      const before = dragStartPos.current
      dragStartPos.current = null
      if (!before) return
      const moved = dragged.filter((n) => {
        const b = before.get(n.id)
        return b && (b.x !== n.position.x || b.y !== n.position.y)
      })
      if (moved.length === 0) return
      const after = new Map(moved.map((n) => [n.id, { ...n.position }]))
      const apply = (positions: Map<string, XYPosition>) =>
        setNodes((nds) =>
          nds.map((n) => {
            const p = positions.get(n.id)
            return p ? { ...n, position: { ...p } } : n
          }),
        )
      pushHistory({ undo: () => apply(before), redo: () => apply(after) })
    },
    [pushHistory, setNodes],
  )

  return { onNodeDragStart, onNodeDragStop }
}
