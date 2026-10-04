/** 选中节点对齐的命令边界：一次对齐一个撤销单元，无位移和失败均不写文档。 */
import { useCallback } from 'react'
import type { XYPosition } from '@xyflow/react'
import { computeCanvasAlignment, type CanvasAlignment } from './canvasAlignment'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'

/** 对齐所需的最小文档写通道、当前快照与诊断出口。 */
export interface CanvasAlignmentDeps {
  nodesRef: EditorDocument['nodesRef']
  setNodes: EditorDocument['setNodes']
  pushHistory: (command: HistoryCommand) => void
  onError: (message: string) => void
}

/** 读取触发时的选中状态，历史回放只写位置，保留随后更新的内容与其他节点。 */
export function useCanvasAlignment({
  nodesRef,
  setNodes,
  pushHistory,
  onError,
}: CanvasAlignmentDeps) {
  const onAlignNodes = useCallback(
    (alignment: CanvasAlignment) => {
      const nodes = nodesRef.current
      let after: Map<string, XYPosition>
      try {
        after = computeCanvasAlignment(nodes, alignment)
      } catch (error) {
        onError(
          `对齐失败：${error instanceof Error ? error.message : String(error)}，已保留原布局`,
        )
        return
      }
      if (after.size === 0) return
      const before = new Map(
        nodes
          .filter((node) => after.has(node.id))
          .map((node) => [node.id, { ...node.position }]),
      )
      const apply = (positions: Map<string, XYPosition>) =>
        setNodes((current) =>
          current.map((node) => {
            const position = positions.get(node.id)
            return position ? { ...node, position: { ...position } } : node
          }),
        )
      pushHistory({ undo: () => apply(before), redo: () => apply(after) })
      apply(after)
    },
    [nodesRef, onError, pushHistory, setNodes],
  )
  return { onAlignNodes }
}
