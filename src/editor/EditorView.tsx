import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type XYPosition,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import SceneNode from './nodes/SceneNode'
import DialogueNode from './nodes/DialogueNode'
import BeatNode from './nodes/BeatNode'
import BranchNode from './nodes/BranchNode'
import ShotNode from './nodes/ShotNode'
import BranchEdge from './edges/BranchEdge'
import LeftPanel from './panels/LeftPanel'
import RightPanel, { type RightTab } from './panels/RightPanel'
import EditorTitlebar from './EditorTitlebar'
import CanvasContextMenu from './CanvasContextMenu'
import { NodeEditContext, type NodeEditApi } from './nodeEdit'
import { useCommandHistory } from './history'
import { readEntityPayload, PW_ENTITY_MIME } from './dragDrop'
import ExportDialog from './ExportDialog'
import { buildScriptMarkdown } from './exportScript'
import {
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  branchOptionIdOf,
  connectEdgeExtras,
  isDuplicateEdge,
  wouldCreateCycle,
} from './graphRules'
import { compareCodeUnits } from '../compare'
import {
  beatFulfillmentMap,
  episodeOfNode,
  hostSceneMap,
  type BeatFulfillment,
  type OutlineDropTarget,
} from './outline'
import { outlineSplicePlan, spliceEdgesWith } from './outlineDrop'
import { entityDropPatch } from './entityDrop'
import { applyEpisodeTitle } from './episodeTitle'
import { useDebouncedSave } from './useDebouncedSave'
import { useEditorHotkeys } from './useEditorHotkeys'
import { useSettingsActions } from './useSettingsActions'
import { useAiBridge } from './useAiBridge'
import { buildCanvasNode } from './nodeFactory'
import type { CreatableType } from './creatable'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'
import type { ProjectContent } from '../model/content'

/** 画布节点类型注册：索引卡 / 对白 / 节奏卡 / 分支 / 分镜卡（docs/ui-design.md §4.2）。 */
const nodeTypes: NodeTypes = {
  scene: SceneNode,
  dialogue: DialogueNode,
  beat: BeatNode,
  branch: BranchNode,
  shot: ShotNode,
}

/** 连线类型注册：branch = 品牌渐变 + 选项胶囊；sequence 用默认贝塞尔加样式类。 */
const edgeTypes: EdgeTypes = {
  branch: BranchEdge,
}

interface EditorViewProps {
  /** 打开的项目：id 用于持久化，doc 为已加载的会话文档（含名称/画布/设定集/集标题/视口）。 */
  readonly project: { id: string } & ProjectContent
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  readonly onBackHome: () => void
  /** 项目名内联重命名（§3.3 中区：更新 project.name + 首页索引）。 */
  readonly onRenameProject: (name: string) => void
  /** 打开设置页（§8.2 BYOK 配置入口，⌘,）。 */
  readonly onOpenSettings?: () => void
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。 */
  readonly onSave: (doc: ProjectContent) => void
}

/**
 * 剧本画布编辑器：顶部统一工具栏（§3.3 左 = 边栏开关 + 返回首页，
 * 中 = 项目名，右 = ＋节点 / 检查器 / ✦AI），下方为三栏布局（§3.4）。
 * 本组件只负责挂 ReactFlowProvider（供内部 useReactFlow 计算创建位置），
 * 状态与交互全部在 EditorWindow 中。
 */
export default function EditorView(props: EditorViewProps) {
  return (
    <ReactFlowProvider>
      <EditorWindow {...props} />
    </ReactFlowProvider>
  )
}

/**
 * 编辑器主体：节点创建（＋节点下拉）、⚙️ 设置面板（编辑即命令）、
 * 复制/删除，以及三栏面板开关。全部写操作经命令栈可撤销/重做
 * （§3.3 撤销重做、§4.3 删除可撤销）；画布变化防抖落盘（持久化）。
 * 纯逻辑已拆至邻近模块：落盘调度 useDebouncedSave、全局快捷键
 * useEditorHotkeys、设定集动作 useSettingsActions、✦AI 桥 useAiBridge、
 * 大纲拖拽 outlineDrop、实体拖放 entityDrop、AI 批量模拟 ai/batchSim。
 */
function EditorWindow({ project, onBackHome, onRenameProject, onOpenSettings, onSave }: EditorViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(project.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges)
  const [settings, setSettings] = useState<ProjectSettings>(project.settings)
  /** 大纲集标题（§3.5）与集聚焦态：聚焦时该集节点提亮、其余降透明度。 */
  const [episodeTitles, setEpisodeTitles] = useState<Record<number, string>>(
    project.episodeTitles ?? {},
  )
  const [focusedEpisode, setFocusedEpisode] = useState<number | null>(null)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)

  // 状态镜像：命令的 undo/redo 需要读取「当前」状态计算逆操作；
  // StrictMode 下 setState updater 会双调，副作用必须在 updater 外完成。
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const episodeTitlesRef = useRef(episodeTitles)
  episodeTitlesRef.current = episodeTitles

  // 视口随文档持久化（数据模型 §3）：本身无重渲染，onMoveEnd 更新 ref 后
  // 经 markDirty 显式标脏并换入最新文档——纯平移/缩放也会防抖落盘，
  // 卸载冲刷与后续内容保存拿到的都是最新视口（不落 stale 值）。
  const viewportRef = useRef<Viewport | undefined>(project.viewport)

  const markDirty = useDebouncedSave(
    {
      name: project.name,
      createdAt: project.createdAt,
      nodes,
      edges,
      settings,
      episodeTitles,
      viewport: viewportRef.current,
    },
    onSave,
  )

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      viewportRef.current = vp
      markDirty({
        name: project.name,
        createdAt: project.createdAt,
        nodes,
        edges,
        settings,
        episodeTitles,
        viewport: vp,
      })
    },
    [markDirty, project.name, project.createdAt, nodes, edges, settings, episodeTitles],
  )

  // 命令栈（§3.3/§4.3）：全部写操作入栈，undo 始终兜底
  const {
    push: pushHistory,
    undo: undoHistory,
    redo: redoHistory,
    canUndo,
    canRedo,
  } = useCommandHistory()

  // 三栏面板状态（§3.4：220–320pt 可调，显隐会话内记忆——组件态即会话态）
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftWidth, setLeftWidth] = useState(248)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(264)
  const [rightTab, setRightTab] = useState<RightTab>('inspector')
  const selectedNode = nodes.find((n) => n.selected)

  // ⚙️ 设置面板、＋节点下拉、右键菜单与导出对话框（§4.3：失焦收起）
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    nodeId?: string
    edgeId?: string
  } | null>(null)

  const toggleSettings = useCallback((id: string) => {
    setOpenSettingsId((cur) => (cur === id ? null : id))
  }, [])
  const closeSettings = useCallback(() => setOpenSettingsId(null), [])

  /** 字段补丁的纯状态写入，patch 命令的 undo/redo 共用。 */
  const applyDataPatch = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n,
        ),
      )
    },
    [setNodes],
  )

  /** 编辑即命令：实时合并字段补丁；连续同类补丁合并为一步撤销（§4.3）。 */
  const patchNode = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      const cur = nodesRef.current.find((n) => n.id === id)
      if (!cur) return
      const keys = Object.keys(patch)
      const before: Record<string, unknown> = {}
      for (const k of keys) before[k] = (cur.data as Record<string, unknown>)[k]
      applyDataPatch(id, patch)
      pushHistory({
        coalesceKey: `patch:${id}:${[...keys].sort(compareCodeUnits).join(',')}`,
        undo: () => applyDataPatch(id, before),
        redo: () => applyDataPatch(id, patch),
      })
    },
    [applyDataPatch, pushHistory],
  )

  /** ⧉ 复制：同 data 新 id，右下偏移并只选中新副本；入栈可撤销。 */
  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodesRef.current.find((n) => n.id === id)
      if (!src) return
      const copy = {
        ...src,
        id: `${src.type}-${Date.now()}`,
        position: { x: src.position.x + 48, y: src.position.y + 40 },
        selected: true,
        data: { ...src.data },
      } as CanvasNode
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), copy])
      pushHistory({
        undo: () => setNodes((nds) => nds.filter((n) => n.id !== copy.id)),
        redo: () => setNodes((nds) => [...nds, copy]),
      })
      setOpenSettingsId(null)
    },
    [pushHistory, setNodes],
  )

  /** 🗑 删除一组节点及其全部连线：入栈可撤销（§4.3 删除可撤销，无需确认）。 */
  const deleteNodesByIds = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids)
      const removedNodes = nodesRef.current.filter((n) => idSet.has(n.id))
      if (removedNodes.length === 0) return
      const removedEdges = edgesRef.current.filter(
        (e) => idSet.has(e.source) || idSet.has(e.target),
      )
      const apply = (remove: boolean) => {
        setNodes((nds) =>
          remove
            ? nds.filter((n) => !idSet.has(n.id))
            : [...nds, ...removedNodes],
        )
        setEdges((eds) =>
          remove
            ? eds.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
            : [...eds, ...removedEdges],
        )
      }
      apply(true)
      pushHistory({ undo: () => apply(false), redo: () => apply(true) })
      setOpenSettingsId(null)
    },
    [pushHistory, setEdges, setNodes],
  )

  /** 删除一组连线（选中边 + Delete）：入栈可撤销。 */
  const deleteEdgesByIds = useCallback(
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
    [pushHistory, setEdges],
  )

  /** 🗑 单节点删除（⚙️ 面板入口），走同一命令路径。 */
  const deleteNode = useCallback((id: string) => deleteNodesByIds([id]), [deleteNodesByIds])

  const { settingsActions } = useSettingsActions(settings, setSettings, pushHistory)

  /** 集 = 编号 + 大纲行内标题（§3.5，不建集实体表）：改名即命令，连续
   * 输入按同键合并为一步撤销；标题清空 = 移除该集命名。 */
  const renameEpisode = useCallback(
    (no: number, title: string) => {
      const before = episodeTitlesRef.current[no] ?? ''
      setEpisodeTitles((t) => applyEpisodeTitle(t, no, title))
      pushHistory({
        coalesceKey: `episode-title:${no}`,
        undo: () => setEpisodeTitles((t) => applyEpisodeTitle(t, no, before)),
        redo: () => setEpisodeTitles((t) => applyEpisodeTitle(t, no, title)),
      })
    },
    [pushHistory],
  )

  /** 点击大纲集行（§3.5）：该集全部节点提亮、其余降透明度退后；再点取消。 */
  const toggleEpisodeFocus = useCallback((no: number | null) => {
    setFocusedEpisode((cur) => (cur === no ? null : no))
  }, [])

  /** 集聚焦的画布投影：成员保持原样，非成员加降透明度类（§3.5 ~30%）。
   * className 是运行态样式（落盘时由模型层序列化剥离），不入持久化。 */
  const displayNodes = useMemo(() => {
    if (focusedEpisode === null) return nodes
    const sceneByShot = hostSceneMap(nodes, edges)
    return nodes.map((n) =>
      episodeOfNode(n, (id) => sceneByShot.get(id)) === focusedEpisode
        ? n
        : ({ ...n, className: 'pw-node-dim' } as CanvasNode),
    )
  }, [nodes, edges, focusedEpisode])

  /** 大纲拖拽落点（§3.5）：重排 sequence 边 + 跨组改集归属，
   * 计划由 outlineDrop/spine 纯函数产出，这里整体翻译为**一条**可撤销命令。 */
  const onOutlineDrop = useCallback(
    (draggedId: string, target: OutlineDropTarget) => {
      const dragged = nodesRef.current.find((n) => n.id === draggedId)
      if (!dragged) return

      // 1) 接缝计划（groupEnd 锚到该组最后一个剧情流行）
      const planned = outlineSplicePlan(
        nodesRef.current,
        edgesRef.current,
        episodeTitlesRef.current,
        draggedId,
        target,
      )
      if (!planned) return
      const { plan, anchorId } = planned

      // 2) 落点集归属：行落点随锚点所在组，组尾落点即目标组
      const sceneByShot = hostSceneMap(nodesRef.current, edgesRef.current)
      const anchorNode = nodesRef.current.find((n) => n.id === anchorId)
      const targetEpisode =
        target.kind === 'groupEnd' ? target.episode : episodeOfNode(anchorNode!, (id) => sceneByShot.get(id))
      const oldEpisodeRaw = (dragged.data as { episodeNo?: unknown }).episodeNo
      const oldEpisode = typeof oldEpisodeRaw === 'number' ? oldEpisodeRaw : null
      const episodeChanged = targetEpisode !== oldEpisode

      const noSplice = plan.removes.length === 0 && plan.adds.length === 0
      if (noSplice && !episodeChanged) return

      // 3) 单命令执行：边手术 + episodeNo 补丁，一步撤销整批回滚
      const stamp = Date.now().toString(36)
      const removedEdges = edgesRef.current.filter((e) => plan.removes.includes(e.id))
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
    [applyDataPatch, pushHistory, setEdges],
  )

  /** 索引卡的 🎞 镜数：派生自该场 attach 下挂边数量（§7.2，不落镜像字段）。 */
  const shotCountOf = useCallback(
    (id: string) =>
      edgesRef.current.filter(
        (e) => e.source === id && e.sourceHandle === SCENE_SHOT_HANDLE,
      ).length,
    [],
  )

  /** 节拍兑现状态（§3.5）：sequence 邻接派生，供胶囊与大纲行展示。 */
  const beatFulfillment = useMemo(() => beatFulfillmentMap(nodes, edges), [nodes, edges])
  const beatFulfillmentOf = useCallback(
    (id: string): BeatFulfillment | null => beatFulfillment.get(id) ?? null,
    [beatFulfillment],
  )

  /** 连线实时校验（§4.3）：自环 / 成环 / 重复边为非法；attach 下挂一对多合法。
   * 判定语义与 AI 批量校验共用 graphRules 纯函数；attach 是垂直派生边，
   * 不参与剧情流环检测（§4.4 横向 = 剧情顺序，垂直 = 派生从属）。 */
  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (conn.source === conn.target) return false
      const existing = edgesRef.current
      if (isDuplicateEdge(existing, conn)) return false
      if (conn.sourceHandle === SCENE_SHOT_HANDLE) return true
      const flowEdges = existing.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
      return !wouldCreateCycle(flowEdges, conn.source, conn.target)
    },
    [],
  )

  /** 新建节点的对象构建（默认字段 + 落点），不入状态、不入栈。
   * 手动创建与 ✦AI 批量创建共用；against 提供场号/镜号的基线列表
   * （批量连续创建时传模拟数组防止编号重复）。纯构建逻辑见 nodeFactory。 */
  const buildNewNode = useCallback(
    (
      type: CreatableType,
      opts?: { at?: XYPosition; selected?: boolean; data?: Record<string, unknown>; against?: CanvasNode[] },
    ): CanvasNode => {
      const rect = opts?.at ? undefined : canvasRef.current?.getBoundingClientRect()
      const center = rect
        ? screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : null
      return buildCanvasNode(type, opts, {
        against: opts?.against ?? nodesRef.current,
        characters: settings.characters,
        center,
      })
    },
    [screenToFlowPosition, settings],
  )

  /** ＋节点/拖拽生成：构建节点 → 入状态 → 单步入栈可撤销。 */
  const createNode = useCallback(
    (type: CreatableType, opts?: { at?: XYPosition; data?: Record<string, unknown> }) => {
      const node = buildNewNode(type, { at: opts?.at, selected: true, data: opts?.data })
      setNodes((all) => [...all.map((n) => ({ ...n, selected: false })), node])
      pushHistory({
        undo: () => setNodes((all) => all.filter((n) => n.id !== node.id)),
        redo: () => setNodes((all) => [...all, node]),
      })
      setPlusOpen(false)
      setOpenSettingsId(null)
    },
    [buildNewNode, pushHistory, setNodes],
  )

  // ✦AI 桥（§6/§12）：画布快照、整批校验、读工具、改动落地（一条复合命令入栈）
  const { canvasDigest, validateAiReply, validateCommands, readNode, applyAiBatch } = useAiBridge({
    nodes,
    edges,
    settings,
    nodesRef,
    edgesRef,
    buildNewNode,
    applyDataPatch,
    setNodes,
    setEdges,
    pushHistory,
    closeSettings,
  })

  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行 = 选中该节点并居中。 */
  const locateNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      fitView({ nodes: [{ id }], duration: 400, maxZoom: 1 })
    },
    [fitView, setNodes],
  )

  const nodeEditApi = useMemo<NodeEditApi>(
    () => ({
      openSettingsId,
      toggleSettings,
      closeSettings,
      patchNode,
      duplicateNode,
      deleteNode,
      shotCountOf,
      beatFulfillmentOf,
      settings,
    }),
    [openSettingsId, toggleSettings, closeSettings, patchNode, duplicateNode, deleteNode, shotCountOf, beatFulfillmentOf, settings],
  )

  // 失焦收起（§4.3）＋ 全局快捷键：⌘Z/⌘⇧Z 撤销重做、Delete 删除选中。
  useEditorHotkeys({
    onEscape: useCallback(() => {
      closeSettings()
      setPlusOpen(false)
      setCtxMenu(null)
      setExportOpen(false)
    }, [closeSettings]),
    onCloseTransient: useCallback(() => {
      closeSettings()
      setPlusOpen(false)
      setCtxMenu(null)
    }, [closeSettings]),
    onUndo: undoHistory,
    onRedo: redoHistory,
    selectedNodeIds: useCallback(
      () => nodesRef.current.filter((n) => n.selected).map((n) => n.id),
      [],
    ),
    selectedEdgeIds: useCallback(
      () => edgesRef.current.filter((ed) => ed.selected).map((ed) => ed.id),
      [],
    ),
    onDeleteNodes: deleteNodesByIds,
    onDeleteEdges: deleteEdgesByIds,
  })

  // 右键上下文菜单（§4.3：全部操作同时可从右键菜单到达）。
  // 节点菜单在右键时单选该节点；空白菜单复用 ＋节点 的五类创建。
  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: CanvasNode) => {
      e.preventDefault()
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === node.id })))
      setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id })
    },
    [setNodes],
  )
  const onEdgeContextMenu = useCallback((e: ReactMouseEvent, edge: Edge) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id })
  }, [])
  const onPaneContextMenu = useCallback((e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  // 设定集 → 画布拖放（§5 建立引用 = 拖拽）：
  // 拖上节点建引用（角色→索引卡出场角色/对白台词/分镜垫图；地点→索引卡地点/分镜底图），
  // 拖上空白按实体预填生成场景节点。全部走 patch/create 命令，可撤销。
  const onCanvasDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes(PW_ENTITY_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const onCanvasDrop = useCallback(
    (e: ReactDragEvent) => {
      const entity = readEntityPayload(e.dataTransfer)
      if (!entity) return
      e.preventDefault()
      const hit = (e.target as HTMLElement).closest?.('.react-flow__node') as HTMLElement | null
      const nodeId = hit?.dataset.id
      const node = nodeId ? nodesRef.current.find((n) => n.id === nodeId) : undefined

      if (node) {
        const patch = entityDropPatch(node, entity)
        if (patch) patchNode(node.id, patch)
        return
      }

      // 空白处：按实体预填生成场景（§5 拖上空画布直接生成预填节点）
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (entity.kind === 'character') {
        createNode('scene', { at, data: { characterIds: [entity.id] } })
      } else {
        createNode('scene', { at, data: { locationId: entity.id } })
      }
    },
    [createNode, patchNode, screenToFlowPosition],
  )

  // 节点拖拽整段记为一步撤销：起点位置在 dragStart 记录、落点入栈。
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

  // 从分支选项端口拉出的连线建成 branch 边（胶囊文案取自该选项，与节点
  // 选项同源）；从索引卡底部端口拉出的建成 attach 派生边（垂直下挂分镜卡）；
  // 其余为 sequence（§4.4）。入栈可撤销。
  const onConnect = useCallback(
    (connection: Connection) => {
      const fromBranchOption = connection.sourceHandle?.startsWith(
        BRANCH_OPTION_HANDLE_PREFIX,
      )
      const fromShotHandle = connection.sourceHandle === SCENE_SHOT_HANDLE
      let branchData: { optionLabel: string } | undefined
      if (fromBranchOption) {
        const optionId = branchOptionIdOf(connection.sourceHandle)
        const srcNode = nodesRef.current.find((n) => n.id === connection.source)
        branchData = {
          optionLabel:
            srcNode?.type === 'branch'
              ? (srcNode.data.options.find((o) => o.id === optionId)?.label ?? '')
              : '',
        }
      }
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...connectEdgeExtras(fromBranchOption ?? false, branchData, fromShotHandle),
      }
      setEdges((eds) => addEdge(edge, eds))
      pushHistory({
        undo: () => setEdges((eds) => eds.filter((e) => e.id !== edge.id)),
        redo: () => setEdges((eds) => addEdge(edge, eds)),
      })
    },
    [pushHistory, setEdges],
  )

  /** 右栏页切换：同页再点收起，异页直接切换并展开。 */
  const toggleRight = useCallback(
    (tab: RightTab) => {
      setRightTab(tab)
      setRightOpen(rightTab !== tab || !rightOpen)
    },
    [rightTab, rightOpen],
  )

  return (
    <NodeEditContext.Provider value={nodeEditApi}>
    <div className="editor-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；按钮可点击（§3.3）。 */}
      <EditorTitlebar
        projectName={project.name}
        onRenameProject={onRenameProject}
        leftOpen={leftOpen}
        onToggleLeft={() => setLeftOpen((v) => !v)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undoHistory}
        onRedo={redoHistory}
        onBackHome={onBackHome}
        plusOpen={plusOpen}
        onTogglePlus={() => setPlusOpen((v) => !v)}
        onCreateNode={(type) => createNode(type)}
        onOpenExport={() => setExportOpen(true)}
        inspectorOn={rightOpen && rightTab === 'inspector'}
        aiOn={rightTab === 'ai' && rightOpen}
        onToggleRight={toggleRight}
      />
      <div className="editor-body">
        <LeftPanel
          open={leftOpen}
          width={leftWidth}
          onResize={setLeftWidth}
          nodes={nodes}
          edges={edges}
          onLocate={locateNode}
          selectedId={selectedNode?.id}
          settings={settings}
          settingsActions={settingsActions}
          episodeTitles={episodeTitles}
          focusedEpisode={focusedEpisode}
          onFocusEpisode={toggleEpisodeFocus}
          onRenameEpisode={renameEpisode}
          onOutlineDrop={onOutlineDrop}
        />
        <div className="canvas-root" ref={canvasRef} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            proOptions={{ hideAttribution: true }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            isValidConnection={isValidConnection}
            /* 删除统一走命令栈（含连线清理），禁用内置 Delete 行为 */
            deleteKeyCode={null}
            /* 有持久化视口则恢复，否则首开 fitView（§3 视口随文档持久化） */
            defaultViewport={project.viewport}
            fitView={!project.viewport}
            onMoveEnd={onMoveEnd}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="var(--canvas-dot)"
            />
            <Controls />
          </ReactFlow>
        </div>
        <RightPanel
          open={rightOpen}
          width={rightWidth}
          onResize={setRightWidth}
          tab={rightTab}
          onTabChange={(t) => {
            setRightTab(t)
            setRightOpen(true)
          }}
          selectedNode={selectedNode}
          attachedShotCount={selectedNode ? shotCountOf(selectedNode.id) : 0}
          settings={settings}
          onOpenSettings={onOpenSettings}
          canvasDigest={canvasDigest}
          onValidateAi={validateAiReply}
          onValidateCommands={validateCommands}
          onReadNode={readNode}
          onApplyAiBatch={applyAiBatch}
        />
      </div>
      {/* 右键上下文菜单：节点 = 设置/复制/删除；空白 = 五类新增（§4.3） */}
      {ctxMenu && (
        <CanvasContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          nodeId={ctxMenu.nodeId}
          edgeId={ctxMenu.edgeId}
          onToggleSettings={toggleSettings}
          onDuplicate={duplicateNode}
          onDeleteNode={(id) => deleteNodesByIds([id])}
          onDeleteEdge={(id) => deleteEdgesByIds([id])}
          onCreate={(type) => createNode(type)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {/* 剧本导出对话框（§3.3/§3.5）：打开时按当前画布生成 */}
      {exportOpen && (
        <ExportDialog
          projectName={project.name}
          text={buildScriptMarkdown(project.name, nodes, edges, settings)}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
    </NodeEditContext.Provider>
  )
}
