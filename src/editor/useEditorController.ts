/**
 * 编辑器装配层（EditorView 拆分后的组合根）：按域组装文档状态、面板状态、
 * 持久化、命令栈、视图派生、画布写动作、AI 桥与全局快捷键，并产出布局层
 * props、节点编辑上下文与图片生成 Provider 的依赖。本模块只做接线与分组，
 * 各动作语义由对应 hook 的单元测试守护。
 */
import { useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { FitView, XYPosition } from '@xyflow/react'
import { useAiBridge, type AiBridge } from './useAiBridge'
import { useCanvasView, type CanvasView } from './useCanvasView'
import { useCommandHistory } from './history'
import {
  useEditorDocument,
  type EditorDocument,
  type EditorProjectContent,
} from './useEditorDocument'
import { useEditorGraphActions, type EditorGraphActions } from './useEditorGraphActions'
import { useEditorHotkeys } from './useEditorHotkeys'
import { useEditorPanels, type EditorPanels } from './useEditorPanels'
import { useEditorPersistence, type EditorPersistence } from './useEditorPersistence'
import { useNodeEditApi } from './useNodeEditApi'
import type { CommandHistory } from './editorLayoutProps'
import type { NodeEditApi } from './nodeEdit'
import type { HistoryCommand } from './history'
import type { NodeDataPatch } from './nodes/patch'
import type { CanvasNode } from './nodes/types'
import type { ProjectSettings } from './settings'
import type { AssetRef } from '../model/document'
import type { ProjectContent } from '../model/content'

/** 图片生成 Provider 的结构化依赖（ImageGenProvider 按形状消费）。 */
export interface ImageGenBinding {
  projectId: string
  nodes: CanvasNode[]
  nodesRef: MutableRefObject<CanvasNode[]>
  assetsRef: MutableRefObject<ProjectContent['assets']>
  settings: ProjectSettings
  applyDataPatch: (id: string, cmd: NodeDataPatch) => void
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
  pushHistory: (cmd: HistoryCommand) => void
}

/** 装配层输入：项目、落盘回调与 ReactFlow 视口能力。 */
export interface EditorControllerDeps {
  project: EditorProjectContent
  onSave: (doc: ProjectContent) => void | Promise<void>
  screenToFlowPosition: (pos: { x: number; y: number }) => XYPosition
  fitView: FitView
}

/** 装配层输出：布局层 props 的域对象 + Provider 依赖。 */
export interface EditorController {
  canvasRef: RefObject<HTMLDivElement>
  doc: EditorDocument
  panels: EditorPanels
  persistence: EditorPersistence
  history: CommandHistory
  view: CanvasView
  graph: EditorGraphActions
  ai: AiBridge
  actionError: string | null
  nodeEditApi: NodeEditApi
  imageGen: ImageGenBinding
}

/** 组装编辑器全部状态、动作与 Provider 依赖。 */
export function useEditorController(deps: EditorControllerDeps): EditorController {
  const { project, onSave, screenToFlowPosition, fitView } = deps
  const canvasRef = useRef<HTMLDivElement>(null)
  const doc = useEditorDocument(project)
  const panels = useEditorPanels()
  const [actionError, setActionError] = useState<string | null>(null)
  const persistence = useEditorPersistence(project, doc, onSave)
  const history = useCommandHistory(setActionError)
  const view = useCanvasView(doc, fitView)
  const graph = useEditorGraphActions({
    projectId: project.id,
    doc,
    panels,
    pushHistory: history.push,
    screenToFlowPosition,
    canvasRef,
    onError: setActionError,
  })
  const ai = useAiBridge({
    nodes: doc.nodes,
    edges: doc.edges,
    settings: doc.settings,
    nodesRef: doc.nodesRef,
    edgesRef: doc.edgesRef,
    assetsRef: doc.assetsRef,
    buildNewNode: graph.creation.buildNewNode,
    applyDataPatch: graph.patch.applyDataPatch,
    setNodes: doc.setNodes,
    setEdges: doc.setEdges,
    pushHistory: history.push,
    closeSettings: panels.closeSettings,
  })
  useEditorHotkeys({
    onEscape: panels.closeAllTransient,
    onCloseTransient: panels.closeTransient,
    onUndo: history.undo,
    onRedo: history.onRedo,
    selectedNodeIds: view.selectedNodeIds,
    selectedEdgeIds: view.selectedEdgeIds,
    onDeleteNodes: graph.deleteNodesByIds,
    onDeleteEdges: graph.deleteEdgesByIds,
  })
  const nodeEditApi = useNodeEditApi(project.id, doc, panels, graph, view)
  return {
    canvasRef,
    doc,
    panels,
    persistence,
    history,
    view,
    graph,
    ai,
    actionError,
    nodeEditApi,
    imageGen: {
      projectId: project.id,
      nodes: doc.nodes,
      nodesRef: doc.nodesRef,
      assetsRef: doc.assetsRef,
      settings: doc.settings,
      applyDataPatch: graph.patch.applyDataPatch,
      addAsset: graph.assets.addAsset,
      removeAsset: graph.assets.removeAsset,
      pushHistory: history.push,
    },
  }
}
