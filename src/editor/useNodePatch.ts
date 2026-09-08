/**
 * 节点字段补丁写入（EditorView 拆出的节点写域，docs/ui-design.md §4.3/§8.2.2）：
 * applyDataPatch 是纯状态写入（命令 undo/redo 共用），patchNode 是「编辑即命令」
 * 入口——实时合并字段补丁，连续同类补丁合并为一步撤销；分支 options 补丁若
 * 删除了选项，其出口 branch 边一并删除且与选项进同一撤销单元（不留悬空连线，
 * 不静默改接）。补丁按节点类型判别绑定（NodeDataPatch），合并语义收口在
 * mergeNodeData。
 */
import { useCallback } from 'react'
import { compareCodeUnits } from '../compare'
import { removedOptionHandles } from './graphRules'
import { dataPatchOf, mergeNodeData, type NodeDataPatch } from './nodes/patch'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'

/** 节点字段写入对：纯写入与入栈的「编辑即命令」入口。 */
export interface NodePatchActions {
  applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  patchNode: (id: string, cmd: NodeDataPatch) => void
}

/** 补丁的撤销合并键：同节点同字段组的连续输入合并为一步。 */
const patchCoalesceKey = (id: string, keys: string[]): string =>
  `patch:${id}:${[...keys].sort(compareCodeUnits).join(',')}`

/** 以文档写通道与命令栈实现节点字段补丁。 */
export function useNodePatch(
  doc: EditorDocument,
  pushHistory: (cmd: HistoryCommand) => void,
): NodePatchActions {
  const { nodesRef, edgesRef, setNodes, setEdges } = doc

  const applyDataPatch = useCallback(
    (id: string, cmd: NodeDataPatch) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? mergeNodeData(n, cmd.patch) : n)))
    },
    [setNodes],
  )

  const patchNode = useCallback(
    (id: string, cmd: NodeDataPatch) => {
      const cur = nodesRef.current.find((n) => n.id === id)
      if (!cur) return
      const keys = Object.keys(cmd.patch)
      const before: Record<string, unknown> = {}
      for (const k of keys) before[k] = (cur.data as Record<string, unknown>)[k]
      applyDataPatch(id, cmd)
      // 级联：新态缺失的选项句柄 → 删其出口边（branch 节点限定）
      const removedHandles =
        cur.type === 'branch' && cmd.nodeType === 'branch' && Array.isArray(cmd.patch.options)
          ? removedOptionHandles(cur.data.options, cmd.patch.options)
          : []
      const beforeEdges = edgesRef.current
      const dropEdges = () => {
        const gone = new Set(removedHandles)
        setEdges((eds) =>
          eds.filter((e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle))),
        )
      }
      if (removedHandles.length > 0) dropEdges()
      const undo = () => {
        applyDataPatch(id, dataPatchOf(cmd.nodeType, before))
        if (removedHandles.length > 0) setEdges(beforeEdges)
      }
      const redo = () => {
        applyDataPatch(id, cmd)
        if (removedHandles.length > 0) dropEdges()
      }
      // 有边级联时不可与普通补丁合并撤销，单独成步
      if (removedHandles.length > 0) {
        pushHistory({ undo, redo })
      } else {
        pushHistory({ coalesceKey: patchCoalesceKey(id, keys), undo, redo })
      }
    },
    [applyDataPatch, edgesRef, nodesRef, setEdges, pushHistory],
  )

  return { applyDataPatch, patchNode }
}
