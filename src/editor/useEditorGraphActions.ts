/**
 * 画布写动作装配（EditorView 拆分后的接线层）：把节点补丁/创建、节点与连线
 * 删除、连线规则、右键菜单、集编辑、设定集动作、大纲拖拽、节点拖拽历史与
 * 画布拖放各自需要的文档写通道与命令栈接线到一处，供装配层与布局层消费。
 * 本模块只做依赖注入与分组，不新增语义；各动作的行为由对应 hook 单测守护。
 */
import type { FitView, XYPosition } from '@xyflow/react'
import { useAssetIndex, type AssetIndexActions } from './useAssetIndex'
import { useCanvasDrop } from './useCanvasDrop'
import { useConnectionRules, type ConnectionRules } from './useConnectionRules'
import { useEdgeDeletion } from './useEdgeDeletion'
import {
  useEditorContextMenu,
  type EditorContextMenuHandlers,
} from './useEditorContextMenu'
import { useEpisodeEditing, type EpisodeEditing } from './useEpisodeEditing'
import { useNodeCreation, type NodeCreationActions } from './useNodeCreation'
import { useNodeDeletion } from './useNodeDeletion'
import { useNodeDragHistory } from './useNodeDragHistory'
import { useAutoLayout } from './useAutoLayout'
import { useNodePatch, type NodePatchActions } from './useNodePatch'
import { useOutlineDrop } from './useOutlineDrop'
import { useSettingsActions } from './useSettingsActions'
import type { EditorDocument } from './useEditorDocument'
import type { EditorPanels } from './useEditorPanels'
import type { HistoryCommand } from './history'
import type { OutlineDropTarget } from './outline'
import type { SettingsActions } from './panels/LeftPanel'

/** 画布写动作装配的依赖：文档/面板状态、命令栈、落点换算、视口适配与错误上浮。 */
export interface EditorGraphActionsDeps {
  projectId: string
  doc: EditorDocument
  panels: EditorPanels
  pushHistory: (cmd: HistoryCommand) => void
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition
  /** 画布容器：新节点落点中心换算读它。 */
  canvasRef: { current: HTMLDivElement | null }
  /** 自动排布完成后的视图适配。 */
  fitView: FitView
  /** 拖放导入失败等瞬态动作诊断上浮。 */
  onError: (message: string) => void
}

/** 编辑器全部画布写动作，按域分组下传。 */
export interface EditorGraphActions {
  /** 资产索引增删（导入/生成/删除命令共用）。 */
  assets: AssetIndexActions
  patch: NodePatchActions
  creation: NodeCreationActions
  /** 🗑 节点删除（含连线清理与产物回收，同一撤销单元）。 */
  deleteNodesByIds: (ids: string[]) => void
  /** 🗑 连线删除（选中边 + Delete / 右键菜单）。 */
  deleteEdgesByIds: (ids: string[]) => void
  connection: ConnectionRules
  menu: EditorContextMenuHandlers
  episodes: EpisodeEditing
  settingsActions: SettingsActions
  outlineDrop: (draggedId: string, target: OutlineDropTarget) => void
  drag: ReturnType<typeof useNodeDragHistory>
  /** 自动排布（issue #94）：整图位置整理为一次撤销单元。 */
  layout: ReturnType<typeof useAutoLayout>
  drop: ReturnType<typeof useCanvasDrop>
}

/** 删除动作对（useEditorGraphActions 拆分，issue #99）：节点级联删除
 * （设定集引用/资产回收随宿主）+ 边删除。 */
function useGraphDeletion(
  deps: EditorGraphActionsDeps,
  assets: ReturnType<typeof useAssetIndex>,
) {
  const deleteNodesByIds = useNodeDeletion({
    nodesRef: deps.doc.nodesRef,
    edgesRef: deps.doc.edgesRef,
    settings: deps.doc.settings,
    assetsRef: deps.doc.assetsRef,
    addAsset: assets.addAsset,
    removeAsset: assets.removeAsset,
    setNodes: deps.doc.setNodes,
    setEdges: deps.doc.setEdges,
    pushHistory: deps.pushHistory,
    closeSettings: deps.panels.closeSettings,
  })
  const deleteEdgesByIds = useEdgeDeletion(deps.doc, deps.pushHistory)
  return { deleteNodesByIds, deleteEdgesByIds }
}

/** 组装画布写动作族（不含持久化、AI 桥与快捷键）。 */
export function useEditorGraphActions(
  deps: EditorGraphActionsDeps,
): EditorGraphActions {
  const {
    projectId,
    doc,
    panels,
    pushHistory,
    screenToFlowPosition,
    canvasRef,
    fitView,
    onError,
  } = deps
  const assets = useAssetIndex(doc.setAssets)
  const patch = useNodePatch(doc, pushHistory)
  const creation = useNodeCreation({
    doc,
    setPlusOpen: panels.setPlusOpen,
    closeSettings: panels.closeSettings,
    screenToFlowPosition,
    canvasRef,
    pushHistory,
  })
  const { deleteNodesByIds, deleteEdgesByIds } = useGraphDeletion(deps, assets)
  const connection = useConnectionRules(doc, pushHistory)
  const menu = useEditorContextMenu(doc, panels.setCtxMenu)
  const episodes = useEpisodeEditing(doc, pushHistory)
  const { settingsActions } = useSettingsActions(
    doc.settings,
    doc.setSettings,
    pushHistory,
  )
  const outlineDrop = useOutlineDrop({
    nodesRef: doc.nodesRef,
    edgesRef: doc.edgesRef,
    episodeTitlesRef: doc.episodeTitlesRef,
    applyDataPatch: patch.applyDataPatch,
    setEdges: doc.setEdges,
    pushHistory,
  })
  const drag = useNodeDragHistory({ setNodes: doc.setNodes, pushHistory })
  const layout = useAutoLayout({
    nodesRef: doc.nodesRef,
    edgesRef: doc.edgesRef,
    setNodes: doc.setNodes,
    pushHistory,
    fitView,
    onError,
  })
  const drop = useCanvasDrop({
    projectId,
    nodesRef: doc.nodesRef,
    patchNode: patch.patchNode,
    applyDataPatch: patch.applyDataPatch,
    createNode: creation.createNode,
    screenToFlowPosition,
    addAsset: assets.addAsset,
    removeAsset: assets.removeAsset,
    pushHistory,
    onError,
  })

  return {
    assets,
    patch,
    creation,
    deleteNodesByIds,
    deleteEdgesByIds,
    connection,
    menu,
    episodes,
    settingsActions,
    outlineDrop,
    drag,
    layout,
    drop,
  }
}
