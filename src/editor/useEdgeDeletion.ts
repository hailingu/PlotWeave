/**
 * 连线删除（EditorView 拆出的连线写域，docs/ui-design.md §4.3 可撤销）：
 * 删除一组连线（选中边 + Delete / 右键菜单）入栈一步可撤销，undo 按删除前
 * 的数组顺序追加复原。节点删除的连线清理不走这里，由 useNodeDeletion
 * 与节点删除合并为同一撤销单元。
 */
import { useCallback } from 'react'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'

/** 删除一组连线 id（不存在的 id 忽略；全不存在时不入栈）。 */
export function useEdgeDeletion(
  doc: EditorDocument,
  pushHistory: (cmd: HistoryCommand) => void,
): (ids: string[]) => void {
  const { edgesRef, setEdges } = doc
  return useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids)
      const removed = edgesRef.current.filter((e) => idSet.has(e.id))
      if (removed.length === 0) return
      const apply = (remove: boolean) =>
        setEdges((eds) =>
          remove ? eds.filter((e) => !idSet.has(e.id)) : [...eds, ...removed],
        )
      apply(true)
      pushHistory({ undo: () => apply(false), redo: () => apply(true) })
    },
    [edgesRef, pushHistory, setEdges],
  )
}
