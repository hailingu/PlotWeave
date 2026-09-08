/**
 * 画布视图派生与定位（EditorView 拆出的视图域，docs/ui-design.md §3.5/§7.2）：
 * 集聚焦投影、索引卡镜数、节拍兑现状态、当前选中节点，以及大纲行点击的
 * 「选中并居中」。全部由节点/连线本身派生，不落镜像字段；定位只改选中态与
 * 视口，不进命令栈（视图操作不是文档编辑）。
 */
import { useCallback, useMemo } from 'react'
import type { FitView } from '@xyflow/react'
import { applyEpisodeFocus, beatFulfillmentMap, type BeatFulfillment } from './outline'
import { SCENE_SHOT_HANDLE } from './graphRules'
import type { EditorDocument } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

/** 定位居中动画时长（毫秒）：与大纲行点击的视觉节奏一致。 */
const LOCATE_DURATION_MS = 400

/** 画布视图派生值、选中态读取与定位动作。 */
export interface CanvasView {
  /** 集聚焦的画布投影（§3.5 ~30% 降透明度退后）。 */
  displayNodes: CanvasNode[]
  /** 当前选中节点（单选语义：ReactFlow 选中变化驱动）。 */
  selectedNode: CanvasNode | undefined
  /** 索引卡的 🎞 镜数：派生自该场 attach 下挂边数量（§7.2，不落镜像）。 */
  shotCountOf: (id: string) => number
  /** 节拍兑现状态（§3.5）：非节拍 id 返回 null。 */
  beatFulfillmentOf: (id: string) => BeatFulfillment | null
  /** Delete 的删除对象：当前选中节点/连线 id 列表（读画布镜像 ref）。 */
  selectedNodeIds: () => string[]
  selectedEdgeIds: () => string[]
  /** 大纲 ⇄ 画布联动（§3.5）：选中该节点并居中。 */
  locateNode: (id: string) => void
}

/** 由文档状态派生视图，并给出大纲联动所需的定位回调。 */
export function useCanvasView(doc: EditorDocument, fitView: FitView): CanvasView {
  const { nodes, edges, edgesRef, nodesRef, focusedEpisode, setNodes } = doc

  const displayNodes = useMemo(
    () => applyEpisodeFocus(nodes, edges, focusedEpisode),
    [nodes, edges, focusedEpisode],
  )
  const selectedNode = nodes.find((n) => n.selected)

  const shotCountOf = useCallback(
    (id: string) =>
      edgesRef.current.filter((e) => e.source === id && e.sourceHandle === SCENE_SHOT_HANDLE)
        .length,
    [edgesRef],
  )
  const beatFulfillment = useMemo(() => beatFulfillmentMap(nodes, edges), [nodes, edges])
  const beatFulfillmentOf = useCallback(
    (id: string): BeatFulfillment | null => beatFulfillment.get(id) ?? null,
    [beatFulfillment],
  )
  const selectedNodeIds = useCallback(
    () => nodesRef.current.filter((n) => n.selected).map((n) => n.id),
    [nodesRef],
  )
  const selectedEdgeIds = useCallback(
    () => edgesRef.current.filter((e) => e.selected).map((e) => e.id),
    [edgesRef],
  )
  const locateNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      fitView({ nodes: [{ id }], duration: LOCATE_DURATION_MS, maxZoom: 1 })
    },
    [fitView, setNodes],
  )

  return {
    displayNodes,
    selectedNode,
    shotCountOf,
    beatFulfillmentOf,
    selectedNodeIds,
    selectedEdgeIds,
    locateNode,
  }
}
