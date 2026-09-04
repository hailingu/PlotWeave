/**
 * 大纲拖拽落点 hook（EditorView 拆出的交互段，docs/ui-design.md §3.5）：
 * 重排 sequence 边 + 跨组改集归属，计划由 outlineDrop/spine 纯函数产出，
 * 这里整体翻译为**一条**可撤销命令（边手术 + episodeNo 补丁一步回滚）。
 */
import { useCallback, type RefObject } from 'react'
import type { Edge } from '@xyflow/react'
import { episodeOfNode, hostSceneMap, type OutlineDropTarget } from './outline'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

/** useOutlineDrop 的依赖注入：状态镜像 ref 与写通道全部来自 EditorView。 */
export interface OutlineDropDeps {
  nodesRef: RefObject<CanvasNode[]>
  edgesRef: RefObject<Edge[]>
  episodeTitlesRef: RefObject<Record<number, string>>
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  setEdges: (fn: (eds: Edge[]) => Edge[]) => void
  pushHistory: (cmd: HistoryCommand) => void
}

export function useOutlineDrop(deps: OutlineDropDeps) {
  const { nodesRef, edgesRef, episodeTitlesRef, applyDataPatch, setEdges, pushHistory } = deps

  return useCallback(
    (draggedId: string, target: OutlineDropTarget) => {
      const dragged = nodesRef.current?.find((n) => n.id === draggedId)
      if (!dragged) return

      // 1) 接缝计划（groupEnd 锚到该组最后一个剧情流行）
      const planned = outlineSplicePlan(
        nodesRef.current ?? [],
        edgesRef.current ?? [],
        episodeTitlesRef.current ?? {},
        draggedId,
        target,
      )
      if (!planned) return
      const { plan, anchorId } = planned

      // 2) 落点集归属：行落点随锚点所在组，组尾落点即目标组
      const sceneByShot = hostSceneMap(nodesRef.current ?? [], edgesRef.current ?? [])
      const anchorNode = nodesRef.current?.find((n) => n.id === anchorId)
      const targetEpisode =
        target.kind === 'groupEnd' ? target.episode : episodeOfNode(anchorNode!, (id) => sceneByShot.get(id))
      const oldEpisodeRaw = (dragged.data as { episodeNo?: unknown }).episodeNo
      const oldEpisode = typeof oldEpisodeRaw === 'number' ? oldEpisodeRaw : null
      const episodeChanged = targetEpisode !== oldEpisode

      const noSplice = plan.removes.length === 0 && plan.adds.length === 0
      if (noSplice && !episodeChanged) return

      // 3) 单命令执行：边手术 + episodeNo 补丁，一步撤销整批回滚
      const stamp = Date.now().toString(36)
      const removedEdges = (edgesRef.current ?? []).filter((e) => plan.removes.includes(e.id))
      const addedEdges: Edge[] = plan.adds.map(({ source, target: t }, i) => ({
        id: `e-${source}-out-${t}-mv-${stamp}-${i}`,
        source,
        target: t,
        className: 'pw-edge-sequence',
      }))
      const applyEdges = (redo: boolean) => {
        if (addedEdges.length === 0 && removedEdges.length === 0) return
        setEdges((eds) => spliceEdgesWith(eds, removedEdges, addedEdges, redo))
      }
      const patchEp = (ep: number | null) =>
        applyDataPatch(draggedId, { episodeNo: ep ?? undefined })
      applyEdges(true)
      if (episodeChanged) patchEp(targetEpisode)
      pushHistory({
        undo: () => {
          applyEdges(false)
          if (episodeChanged) patchEp(oldEpisode)
        },
        redo: () => {
          applyEdges(true)
          if (episodeChanged) patchEp(targetEpisode)
        },
      })
    },
    [nodesRef, edgesRef, episodeTitlesRef, applyDataPatch, pushHistory, setEdges],
  )
}
