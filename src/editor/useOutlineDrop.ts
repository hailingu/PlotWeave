/**
 * 大纲拖拽落点 hook（EditorView 拆出的交互段，docs/ui-design.md §3.5）：
 * 重排 sequence 边 + 跨组改集归属，计划由 outlineDrop/spine 纯函数产出，
 * 这里整体翻译为**一条**可撤销命令（边手术 + episodeNo 补丁一步回滚）。
 */
import { useCallback, type RefObject } from 'react'
import type { Edge } from '@xyflow/react'
import { episodeOfNode, hostSceneMap, type OutlineDropTarget } from './outline'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import type { SplicePlan } from './spine'
import { episodeNoPatch } from './nodes/patch'
import type { HistoryCommand } from './history'
import type { CanvasNode } from './nodes/types'

/** useOutlineDrop 的依赖注入：状态镜像 ref 与写通道全部来自 EditorView。 */
export interface OutlineDropDeps {
  nodesRef: RefObject<CanvasNode[]>
  edgesRef: RefObject<Edge[]>
  episodeTitlesRef: RefObject<Record<number, string>>
  /** 纯状态写入（episodeNo 补丁，按节点类型判别绑定，issue 16）。 */
  applyDataPatch: (id: string, cmd: ReturnType<typeof episodeNoPatch>) => void
  setEdges: (fn: (eds: Edge[]) => Edge[]) => void
  pushHistory: (cmd: HistoryCommand) => void
}

/** 大纲移动的接缝计划与集归属解析（useOutlineDrop 拆分，issue #99）：
 * 行落点随锚点所在组，组尾落点即目标组；返回 null = 无可执行变化。 */
function resolveOutlineMove(
  nodes: CanvasNode[],
  edges: Edge[],
  episodeTitles: Record<number, string>,
  draggedId: string,
  target: OutlineDropTarget,
): {
  plan: SplicePlan
  targetEpisode: number | null
  oldEpisode: number | null
  episodeChanged: boolean
} | null {
  const planned = outlineSplicePlan(
    nodes,
    edges,
    episodeTitles,
    draggedId,
    target,
  )
  if (!planned) return null
  const { plan, anchorId } = planned
  const sceneByShot = hostSceneMap(nodes, edges)
  const anchorNode = nodes.find((n) => n.id === anchorId)
  const targetEpisode =
    target.kind === 'groupEnd'
      ? target.episode
      : episodeOfNode(anchorNode!, (id) => sceneByShot.get(id))
  const dragged = nodes.find((n) => n.id === draggedId)
  const oldEpisode =
    dragged && typeof dragged.data.episodeNo === 'number'
      ? dragged.data.episodeNo
      : null
  const noSplice = plan.removes.length === 0 && plan.adds.length === 0
  const episodeChanged = targetEpisode !== oldEpisode
  if (noSplice && !episodeChanged) return null
  return { plan, targetEpisode, oldEpisode, episodeChanged }
}

export function useOutlineDrop(deps: OutlineDropDeps) {
  const {
    nodesRef,
    edgesRef,
    episodeTitlesRef,
    applyDataPatch,
    setEdges,
    pushHistory,
  } = deps

  return useCallback(
    (draggedId: string, target: OutlineDropTarget) => {
      const dragged = nodesRef.current?.find((n) => n.id === draggedId)
      if (!dragged) return
      // 大纲行可拖拽的只有编剧侧四类（LeftPanel level < 3）；分镜卡随宿主
      // 场景分集（§3.5，运行态不落独立 episodeNo），图片节点不进大纲——
      // 非四类直接放弃，不产出注定被序列化剥离的分集补丁
      if (
        dragged.type !== 'scene' &&
        dragged.type !== 'beat' &&
        dragged.type !== 'dialogue' &&
        dragged.type !== 'branch'
      ) {
        return
      }

      // 1)–2) 接缝计划与集归属（groupEnd 锚到该组最后一个剧情流行；
      // 行落点随锚点所在组，组尾落点即目标组）
      const resolved = resolveOutlineMove(
        nodesRef.current ?? [],
        edgesRef.current ?? [],
        episodeTitlesRef.current ?? {},
        draggedId,
        target,
      )
      if (!resolved) return
      const { plan, targetEpisode, oldEpisode, episodeChanged } = resolved

      // 3) 单命令执行：边手术 + episodeNo 补丁，一步撤销整批回滚
      const stamp = Date.now().toString(36)
      const removedEdges = (edgesRef.current ?? []).filter((e) =>
        plan.removes.includes(e.id),
      )
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
        applyDataPatch(draggedId, episodeNoPatch(dragged.type, ep ?? undefined))
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
    [
      nodesRef,
      edgesRef,
      episodeTitlesRef,
      applyDataPatch,
      pushHistory,
      setEdges,
    ],
  )
}
