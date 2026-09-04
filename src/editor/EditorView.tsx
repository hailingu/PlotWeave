import {
  useCallback,
  useMemo,
  useRef,
  useState,
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
import ImageNode from './nodes/ImageNode'
import { ImageGenProvider } from './imagegen/ImageGenProvider'
import { useNodeDeletion } from './useNodeDeletion'
import BranchEdge from './edges/BranchEdge'
import LeftPanel from './panels/LeftPanel'
import RightPanel, { type RightTab } from './panels/RightPanel'
import EditorTitlebar from './EditorTitlebar'
import CanvasContextMenu from './CanvasContextMenu'
import { NodeEditContext, type NodeEditApi } from './nodeEdit'
import { useCommandHistory } from './history'
import ErrorBanner from './ErrorBanner'
import { errorBannerMessage } from './errorBannerMessage'
import ExportDialog from './ExportDialog'
import { buildScriptMarkdown } from './exportScript'
import {
  BRANCH_OPTION_HANDLE_PREFIX,
  SCENE_SHOT_HANDLE,
  branchOptionIdOf,
  connectEdgeExtras,
  connectionEndpointIssue,
  connectionKindOf,
  hasAttachHost,
  isDuplicateEdge,
  removedOptionHandles,
  wouldCreateCycle,
} from './graphRules'
import { compareCodeUnits } from '../compare'
import {
  applyEpisodeFocus,
  beatFulfillmentMap,
  type BeatFulfillment,
} from './outline'
import { useOutlineDrop } from './useOutlineDrop'
import { useCanvasDrop } from './useCanvasDrop'
import { useNodeDragHistory } from './useNodeDragHistory'
import { applyEpisodeTitle } from './episodeTitle'
import { useDebouncedSave } from './useDebouncedSave'
import { sessionDoc } from './sessionDoc'
import { useEditorHotkeys } from './useEditorHotkeys'
import { useSettingsActions } from './useSettingsActions'
import { useAiBridge } from './useAiBridge'
import { buildCanvasNode } from './nodeFactory'
import type { CreatableType } from './creatable'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'
import type { AssetRef } from '../model/document'
import type { ProjectContent } from '../model/content'

/** 画布节点类型注册：索引卡 / 对白 / 节奏卡 / 分支 / 分镜卡 / 图片节点（docs/ui-design.md §4.2/§13）。 */
const nodeTypes: NodeTypes = {
  scene: SceneNode,
  dialogue: DialogueNode,
  beat: BeatNode,
  branch: BranchNode,
  shot: ShotNode,
  image: ImageNode,
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
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。
   * 返回 Promise 时失败会上浮：重置脏标记自动重试并横幅提示。 */
  readonly onSave: (doc: ProjectContent) => void | Promise<void>
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
 * 大纲拖拽 useOutlineDrop、画布拖放 useCanvasDrop（实体引用 + 库资产
 * 导入绑定，§5/§7.3）、节点拖拽历史 useNodeDragHistory、AI 批量模拟
 * ai/batchSim。
 */
function EditorWindow({ project, onBackHome, onRenameProject, onOpenSettings, onSave }: EditorViewProps) {
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
  const { screenToFlowPosition, fitView } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)

  // 状态镜像：命令的 undo/redo 需要读取「当前」状态计算逆操作；
  // StrictMode 下 setState updater 会双调，副作用必须在 updater 外完成。
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const assetsRef = useRef(assets)
  assetsRef.current = assets
  const episodeTitlesRef = useRef(episodeTitles)
  episodeTitlesRef.current = episodeTitles

  // 视口随文档持久化（数据模型 §3）：本身无重渲染，onMoveEnd 更新 ref 后
  // 经 markDirty 显式标脏并换入最新文档——纯平移/缩放也会防抖落盘，
  // 卸载冲刷与后续内容保存拿到的都是最新视口（不落 stale 值）。
  const viewportRef = useRef<Viewport | undefined>(project.viewport)

  // 防抖保存失败的用户可见诊断（§10.2）：失败即横幅提示并自动重试，
  // 成功后清除——保存失败不再只留在开发者控制台里丢编辑
  const [saveError, setSaveError] = useState<string | null>(null)
  const handleSaveResult = useCallback((err: unknown) => {
    if (err === null) {
      setSaveError(null)
      return
    }
    setSaveError(errorBannerMessage(err))
  }, [])
  // 拖放导入失败的用户可见诊断（库资产类型不支持 / 落盘失败，§7.3）
  const [actionError, setActionError] = useState<string | null>(null)

  const markDirty = useDebouncedSave(
    sessionDoc(project, {
      nodes,
      edges,
      settings,
      episodeTitles,
      viewport: viewportRef.current,
      assets,
    }),
    onSave,
    600,
    handleSaveResult,
  )

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      viewportRef.current = vp
      markDirty(
        sessionDoc(project, {
          nodes,
          edges,
          settings,
          episodeTitles,
          viewport: vp,
          assets,
        }),
      )
    },
    [markDirty, project, nodes, edges, settings, episodeTitles, assets],
  )

  // 命令栈（§3.3/§4.3）：全部写操作入栈，undo 兜底；重做拒绝上浮横幅（issue #10）
  const {
    push: pushHistory,
    undo: undoHistory,
    onRedo: redoWithDiagnostics,
    canUndo,
    canRedo,
  } = useCommandHistory(setActionError)

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

  /** 编辑即命令：实时合并字段补丁；连续同类补丁合并为一步撤销（§4.3）。
   * 分支节点的 options 补丁若删除了选项，其出口 branch 边一并删除且
   * 与选项进同一撤销单元（§8.2.2——不留悬空连线，不静默改接）。 */
  const patchNode = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      const cur = nodesRef.current.find((n) => n.id === id)
      if (!cur) return
      const keys = Object.keys(patch)
      const before: Record<string, unknown> = {}
      for (const k of keys) before[k] = (cur.data as Record<string, unknown>)[k]
      applyDataPatch(id, patch)
      // 级联：新态缺失的选项句柄 → 删其出口边（branch 节点限定）
      const removedHandles =
        cur.type === 'branch' && Array.isArray(patch.options)
          ? removedOptionHandles(
              (cur.data as { options: Array<{ id: string }> }).options,
              patch.options as Array<{ id: string }>,
            )
          : []
      const beforeEdges = edgesRef.current
      if (removedHandles.length > 0) {
        const gone = new Set(removedHandles)
        setEdges((eds) => eds.filter((e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle))))
      }
      const undo = () => {
        applyDataPatch(id, before)
        if (removedHandles.length > 0) setEdges(beforeEdges)
      }
      const redo = () => {
        applyDataPatch(id, patch)
        if (removedHandles.length > 0) {
          const gone = new Set(removedHandles)
          setEdges((eds) => eds.filter((e) => !(e.source === id && e.sourceHandle && gone.has(e.sourceHandle))))
        }
      }
      // 有边级联时不可与普通补丁合并撤销，单独成步
      if (removedHandles.length > 0) {
        pushHistory({ undo, redo })
      } else {
        pushHistory({
          coalesceKey: `patch:${id}:${[...keys].sort(compareCodeUnits).join(',')}`,
          undo,
          redo,
        })
      }
    },
    [applyDataPatch, pushHistory, setEdges],
  )

  /** 资产索引写入（§7.3 导入/生成命令的 apply/undo/redo 共用）：新增条目
   * 按 id 键控并入；移除只删索引条目，媒体文件留存待延迟回收（§7.3）。 */
  const addAsset = useCallback(
    (asset: AssetRef) =>
      setAssets((cur) => ({ byId: { ...cur?.byId, [asset.id]: asset } })),
    [],
  )
  const removeAsset = useCallback(
    (assetId: string) =>
      setAssets((cur) => {
        if (!cur) return cur
        const byId = { ...cur.byId }
        delete byId[assetId]
        return { byId }
      }),
    [],
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

  /** 🗑 节点删除（§4.3 可撤销 + §7.3 产物回收）拆至 useNodeDeletion。 */
  const deleteNodesByIds = useNodeDeletion({
    nodesRef,
    edgesRef,
    settings,
    assetsRef,
    addAsset,
    removeAsset,
    setNodes,
    setEdges,
    pushHistory,
    closeSettings,
  })

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

  /** 集聚焦的画布投影（§3.5 ~30% 降透明度退后）；纯派生见 outline。 */
  const displayNodes = useMemo(
    () => applyEpisodeFocus(nodes, edges, focusedEpisode),
    [nodes, edges, focusedEpisode],
  )

  /** 大纲拖拽落点（§3.5）：计划由 outlineDrop/spine 纯函数产出，
   * useOutlineDrop 翻译为一条可撤销命令。 */
  const onOutlineDrop = useOutlineDrop({
    nodesRef,
    edgesRef,
    episodeTitlesRef,
    applyDataPatch,
    setEdges,
    pushHistory,
  })

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

  /** 连线实时校验（§4.3）：自环 / 成环 / 重复边 / 端点类型越界为非法；
   * attach 下挂一对多合法。判定语义与 AI 批量校验共用 graphRules 纯函数；
   * attach 是垂直派生边，不参与剧情流环检测（§4.4 横向 = 剧情顺序，
   * 垂直 = 派生从属）；端点类型约束是加载侧孤儿边规则的交互对等——
   * 放行分镜卡参与剧情流之类的连线，会在下次加载被静默删除。 */
  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (conn.source === conn.target) return false
      const existing = edgesRef.current
      if (isDuplicateEdge(existing, conn)) return false
      const nodeTypeOf = (id: string) => nodesRef.current.find((n) => n.id === id)?.type
      if (conn.sourceHandle === SCENE_SHOT_HANDLE) {
        if (connectionEndpointIssue(nodeTypeOf(conn.source), nodeTypeOf(conn.target), 'attach') !== null) {
          return false
        }
        // 宿主唯一（§5）：已有宿主的分镜不接受第二条下挂——换宿主须先断开
        return !hasAttachHost(existing, conn.target)
      }
      const flowEdges = existing.filter((e) => e.sourceHandle !== SCENE_SHOT_HANDLE)
      if (wouldCreateCycle(flowEdges, conn.source, conn.target)) return false
      // Connection 无 type/className，语义从端口推出（选项出口 = branch），
      // 误归 sequence 会被「分支不得以 sequence 连出」拒绝而拖不出连线
      const kind = connectionKindOf(conn)
      return connectionEndpointIssue(nodeTypeOf(conn.source), nodeTypeOf(conn.target), kind) === null
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
    assetsRef,
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
      projectId: project.id,
      openSettingsId,
      toggleSettings,
      closeSettings,
      patchNode,
      duplicateNode,
      deleteNode,
      shotCountOf,
      beatFulfillmentOf,
      settings,
      assets,
    }),
    [project.id, openSettingsId, toggleSettings, closeSettings, patchNode, duplicateNode, deleteNode, shotCountOf, beatFulfillmentOf, settings, assets],
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
    onRedo: redoWithDiagnostics,
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

  // 设定集 → 画布拖放（§5 建立引用 = 拖拽）：拖上节点建引用（角色→索引卡
  // 出场角色/对白台词/分镜垫图；地点→索引卡地点/分镜底图），拖上空白按实体
  // 预填生成场景节点；资产库条目拖上分镜卡 = 拷贝进项目并绑定引用位（§7.3）。
  // 全部走 patch/create/导入命令，可撤销。
  const { onCanvasDragOver, onCanvasDrop } = useCanvasDrop({
    projectId: project.id,
    nodesRef,
    patchNode,
    applyDataPatch,
    createNode,
    screenToFlowPosition,
    addAsset,
    removeAsset,
    pushHistory,
    onError: setActionError,
  })

  // 节点拖拽整段记为一步撤销：起点位置在 dragStart 记录、落点入栈。
  const { onNodeDragStart, onNodeDragStop } = useNodeDragHistory({ setNodes, pushHistory })

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
    {/* 图片节点生成调度（§13）：依赖本组件的命令回调与资产索引写入 */}
    <ImageGenProvider projectId={project.id} nodes={nodes} nodesRef={nodesRef} assetsRef={assetsRef} settings={settings} applyDataPatch={applyDataPatch} addAsset={addAsset} removeAsset={removeAsset} pushHistory={pushHistory}>
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
        onRedo={redoWithDiagnostics}
        onBackHome={onBackHome}
        plusOpen={plusOpen}
        onTogglePlus={() => setPlusOpen((v) => !v)}
        onCreateNode={(type) => createNode(type)}
        onOpenExport={() => setExportOpen(true)}
        inspectorOn={rightOpen && rightTab === 'inspector'}
        aiOn={rightTab === 'ai' && rightOpen}
        onToggleRight={toggleRight}
      />
      {saveError !== null && (
        <ErrorBanner
          message={`自动保存失败：${saveError}（修改已保留，正在自动重试；可检查磁盘后继续编辑）`}
        />
      )}
      {actionError !== null && <ErrorBanner message={actionError} />}
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
          text={buildScriptMarkdown(project.name, nodes, edges, settings, assetsRef.current)}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
    </ImageGenProvider>
    </NodeEditContext.Provider>
  )
}
