/**
 * 编辑器文档状态（EditorView 拆出的状态域）：节点/连线/设定集/集标题/资产
 * 索引/集聚焦六个会话状态，外加命令栈与拖放读取「当前值」所需的镜像 ref
 * 与视口 ref（数据模型 §3 视口随文档持久化）。镜像在渲染期赋值：undo/redo
 * 闭包必须在 setState updater 之外读到最新状态（StrictMode 下 updater 双调）。
 * 返回对象按字段 memo：状态不变时保持引用稳定，下游 useMemo/useCallback 有效。
 */
import { useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  useEdgesState,
  useNodesState,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'
import type { ProjectContent } from '../model/content'

/** 编辑器打开的项目：项目 id + 已加载的会话内容（App 经 EditorView 传入）。 */
export type EditorProjectContent = { id: string } & ProjectContent

/** 文档状态与镜像 ref：会话状态的唯一持有者，写通道原样交给命令栈消费。 */
export interface EditorDocument {
  nodes: CanvasNode[]
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>
  onNodesChange: OnNodesChange<CanvasNode>
  edges: Edge[]
  setEdges: Dispatch<SetStateAction<Edge[]>>
  onEdgesChange: OnEdgesChange<Edge>
  settings: ProjectSettings
  setSettings: Dispatch<SetStateAction<ProjectSettings>>
  episodeTitles: Record<number, string>
  setEpisodeTitles: Dispatch<SetStateAction<Record<number, string>>>
  assets: ProjectContent['assets']
  setAssets: Dispatch<SetStateAction<ProjectContent['assets']>>
  focusedEpisode: number | null
  setFocusedEpisode: Dispatch<SetStateAction<number | null>>
  nodesRef: MutableRefObject<CanvasNode[]>
  edgesRef: MutableRefObject<Edge[]>
  /** 设定集镜像（issue 44）：AI 校验/落地读取「当前」实体注册表——
   * 预览到确认之间用户的设定集编辑经此被重校验发现。 */
  settingsRef: MutableRefObject<ProjectSettings>
  assetsRef: MutableRefObject<ProjectContent['assets']>
  episodeTitlesRef: MutableRefObject<Record<number, string>>
  viewportRef: MutableRefObject<Viewport | undefined>
}

/** 从项目会话内容初始化文档状态，并建立镜像 ref 与视口 ref。 */
export function useEditorDocument(project: EditorProjectContent): EditorDocument {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(project.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges)
  const [settings, setSettings] = useState<ProjectSettings>(project.settings)
  /** 大纲集标题（§3.5）与集聚焦态：聚焦时该集节点提亮、其余降透明度。 */
  const [episodeTitles, setEpisodeTitles] = useState<Record<number, string>>(
    project.episodeTitles ?? {},
  )
  /** 项目资产索引（§7.1/§7.3）：会话内可新增（库资产拖上画布拷贝导入），
   * 入 SessionDocPart 随防抖落盘；assetsRef 镜像供 AI 快照/剧本导出消费。 */
  const [assets, setAssets] = useState(project.assets)
  const [focusedEpisode, setFocusedEpisode] = useState<number | null>(null)

  // 状态镜像：命令的 undo/redo 需要读取「当前」状态计算逆操作；
  // StrictMode 下 setState updater 会双调，副作用必须在 updater 外完成。
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const assetsRef = useRef(assets)
  assetsRef.current = assets
  const episodeTitlesRef = useRef(episodeTitles)
  episodeTitlesRef.current = episodeTitles

  // 视口随文档持久化（数据模型 §3）：本身无重渲染，onMoveEnd 更新 ref 后
  // 经 markDirty 显式标脏并换入最新文档——纯平移/缩放也会防抖落盘，
  // 卸载冲刷与后续内容保存拿到的都是最新视口（不落 stale 值）。
  const viewportRef = useRef<Viewport | undefined>(project.viewport)

  return useMemo(
    () => ({
      nodes,
      setNodes,
      onNodesChange,
      edges,
      setEdges,
      onEdgesChange,
      settings,
      setSettings,
      episodeTitles,
      setEpisodeTitles,
      assets,
      setAssets,
      focusedEpisode,
      setFocusedEpisode,
    nodesRef,
    edgesRef,
    settingsRef,
    assetsRef,
    episodeTitlesRef,
    viewportRef,
  }),
    [
      nodes,
      setNodes,
      onNodesChange,
      edges,
      setEdges,
      onEdgesChange,
      settings,
      setSettings,
      episodeTitles,
      setEpisodeTitles,
      assets,
      setAssets,
      focusedEpisode,
      setFocusedEpisode,
    ],
  )
}
