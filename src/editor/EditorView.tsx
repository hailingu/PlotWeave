import {
  useCallback,
  useEffect,
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
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import SceneNode, { SCENE_SHOT_HANDLE } from './nodes/SceneNode'
import DialogueNode from './nodes/DialogueNode'
import BeatNode from './nodes/BeatNode'
import BranchNode, { BRANCH_OPTION_HANDLE_PREFIX } from './nodes/BranchNode'
import ShotNode from './nodes/ShotNode'
import BranchEdge from './edges/BranchEdge'
import LeftPanel from './panels/LeftPanel'
import RightPanel, { type RightTab } from './panels/RightPanel'
import { NodeEditContext, type NodeEditApi } from './nodeEdit'
import { useCommandHistory } from './history'
import { readEntityPayload, PW_ENTITY_MIME } from './dragDrop'
import ExportDialog from './ExportDialog'
import { buildScriptMarkdown } from './exportScript'
import { EditableName } from './nodes/settings/NodeSettingsPanel'
import { isDuplicateEdge, branchOptionHandle, wouldCreateCycle } from './graphRules'
import { buildGraphDigest } from './ai/graphDigest'
import {
  beatFulfillmentMap,
  buildOutlineGroups,
  episodeOfNode,
  hostSceneMap,
  type BeatFulfillment,
  type OutlineDropTarget,
} from './outline'
import { planSpliceIntoSpine, type SplicePlan } from './spine'
import {
  extractBatchJson,
  validateAiBatch,
  type AiCommand,
  type AiGraphSnapshot,
  type BatchValidation,
} from './ai/commands'
import {
  createCharacter,
  createLocation,
  resolveCharacterName,
  resolveLocationName,
  type ProjectSettings,
} from './settings'
import type { CanvasNode } from './nodes/types'

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
  /** 打开的项目：id 用于持久化，name 用于标题栏与导出，doc 为已加载画布。 */
  project: {
    id: string
    name: string
    nodes: CanvasNode[]
    edges: Edge[]
    settings: ProjectSettings
    /** 大纲集标题（§3.5：集 = 编号 + 行内标题）。 */
    episodeTitles?: Record<number, string>
  }
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  onBackHome: () => void
  /** 项目名内联重命名（§3.3 中区：更新 project.name + 首页索引）。 */
  onRenameProject: (name: string) => void
  /** 打开设置页（§8.2 BYOK 配置入口，⌘,）。 */
  onOpenSettings?: () => void
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。 */
  onSave: (doc: {
    name: string
    nodes: CanvasNode[]
    edges: Edge[]
    settings: ProjectSettings
    episodeTitles: Record<number, string>
  }) => void
}

/** ＋节点下拉的创建项（docs/ui-design.md §3.3：场景/节奏卡/对白/分支/分镜卡）。 */
const CREATABLE_TYPES = ['scene', 'beat', 'dialogue', 'branch', 'shot'] as const
type CreatableType = (typeof CREATABLE_TYPES)[number]

const CREATE_LABELS: Record<CreatableType, string> = {
  scene: '场景',
  beat: '节奏卡',
  dialogue: '对白',
  branch: '分支',
  shot: '分镜卡',
}

/** 落盘时剥离 React Flow 运行态字段（selected/measured/dragging 等），只存持久语义。 */
function stripNode(n: CanvasNode): CanvasNode {
  return { id: n.id, type: n.type, position: n.position, data: n.data } as CanvasNode
}

function stripEdge(e: Edge): Edge {
  const out: Edge = { id: e.id, source: e.source, target: e.target }
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.type) out.type = e.type
  if (e.className) out.className = e.className
  if (e.data !== undefined) out.data = e.data
  return out
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

  // 持久化：画布变化防抖 600ms 全量落盘（剥离 React Flow 运行态字段）；
  // 跳过首次加载，仅在脏状态下卸载冲刷，避免「只打开不编辑」也盖更新时间戳。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef({
    name: project.name,
    nodes,
    edges,
    settings,
    episodeTitles,
  })
  latestRef.current = { name: project.name, nodes, edges, settings, episodeTitles }
  const firstRender = useRef(true)
  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const { name, nodes: ns, edges: es, settings: st, episodeTitles: et } = latestRef.current
    onSave({ name, nodes: ns.map(stripNode), edges: es.map(stripEdge), settings: st, episodeTitles: et })
  }, [onSave])
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushSave()
    }, 600)
  }, [nodes, edges, settings, project.name, flushSave])
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flushSave()
    }
  }, [flushSave])

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
        coalesceKey: `patch:${id}:${[...keys].sort().join(',')}`,
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

  /** 设定集补丁命令（§5）：undo/redo 闭包整体替换 settings。 */
  const applySettings = useCallback(
    (next: ProjectSettings) => setSettings(next),
    [],
  )
  const patchSettings = useCallback(
    (before: ProjectSettings, after: ProjectSettings) => {
      setSettings(after)
      pushHistory({ undo: () => applySettings(before), redo: () => applySettings(after) })
    },
    [applySettings, pushHistory],
  )

  /** 设定集编辑动作（§5）：新增用占位名，改名经 Map 替换，删除不自动清除节点引用。 */
  const settingsActions = useMemo(
    () => ({
      addCharacter: () => {
        const entity = createCharacter('新角色')
        patchSettings(settings, {
          ...settings,
          characters: [...settings.characters, entity],
        })
      },
      renameCharacter: (id: string, name: string) =>
        patchSettings(settings, {
          ...settings,
          characters: settings.characters.map((c) => (c.id === id ? { ...c, name } : c)),
        }),
      deleteCharacter: (id: string) =>
        patchSettings(settings, {
          ...settings,
          characters: settings.characters.filter((c) => c.id !== id),
        }),
      addLocation: () => {
        const entity = createLocation('新地点')
        patchSettings(settings, {
          ...settings,
          locations: [...settings.locations, entity],
        })
      },
      renameLocation: (id: string, name: string) =>
        patchSettings(settings, {
          ...settings,
          locations: settings.locations.map((l) => (l.id === id ? { ...l, name } : l)),
        }),
      deleteLocation: (id: string) =>
        patchSettings(settings, {
          ...settings,
          locations: settings.locations.filter((l) => l.id !== id),
        }),
    }),
    [patchSettings, settings],
  )

  /** 集 = 编号 + 大纲行内标题（§3.5，不建集实体表）：改名即命令，连续
   * 输入按同键合并为一步撤销；标题清空 = 移除该集命名。 */
  const renameEpisode = useCallback(
    (no: number, title: string) => {
      const before = episodeTitlesRef.current[no] ?? ''
      const next = title.trim()
      setEpisodeTitles((t) => {
        if (next === '') {
          const rest = { ...t }
          delete rest[no]
          return rest
        }
        return { ...t, [no]: next }
      })
      pushHistory({
        coalesceKey: `episode-title:${no}`,
        undo: () =>
          setEpisodeTitles((t) => {
            if (before === '') {
              const rest = { ...t }
              delete rest[no]
              return rest
            }
            return { ...t, [no]: before }
          }),
        redo: () =>
          setEpisodeTitles((t) => (next === '' ? { ...t, [no]: next } : { ...t, [no]: next })),
      })
    },
    [pushHistory],
  )

  /** 点击大纲集行（§3.5）：该集全部节点提亮、其余降透明度退后；再点取消。 */
  const toggleEpisodeFocus = useCallback((no: number | null) => {
    setFocusedEpisode((cur) => (cur === no ? null : no))
  }, [])

  /** 集聚焦的画布投影：成员保持原样，非成员加降透明度类（§3.5 ~30%）。
   * className 是运行态样式（stripNode 落盘时剥离），不入持久化。 */
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
   * 计划由 spine.ts 纯函数产出，这里整体翻译为**一条**可撤销命令。 */
  const onOutlineDrop = useCallback(
    (draggedId: string, target: OutlineDropTarget) => {
      const dragged = nodesRef.current.find((n) => n.id === draggedId)
      if (!dragged) return

      // 1) 接缝计划（groupEnd 锚到该组最后一个剧情流行）
      let plan: SplicePlan | null = null
      let anchorId: string | null = null
      if (target.kind === 'row') {
        anchorId = target.anchorId
        plan = planSpliceIntoSpine(edgesRef.current, draggedId, anchorId, target.position)
        if (!plan) return
      } else {
        const group = buildOutlineGroups(
          nodesRef.current,
          edgesRef.current,
          episodeTitlesRef.current,
        ).find((g) => g.episode === target.episode)
        const spineRows = (group?.rows ?? []).filter(
          (r) => r.id !== draggedId && r.level < 3,
        )
        for (let i = spineRows.length - 1; i >= 0; i--) {
          const cand = planSpliceIntoSpine(
            edgesRef.current,
            draggedId,
            spineRows[i].id,
            'after',
          )
          if (cand) {
            plan = cand
            anchorId = spineRows[i].id
            break
          }
        }
      }
      if (!plan) return

      // 2) 落点集归属：行落点随锚点所在组，组尾落点即目标组
      const sceneByShot = hostSceneMap(nodesRef.current, edgesRef.current)
      const anchorNode =
        anchorId !== null ? nodesRef.current.find((n) => n.id === anchorId) : undefined
      const targetEpisode =
        target.kind === 'groupEnd' ? target.episode : episodeOfNode(anchorNode!, (id) => sceneByShot.get(id))
      const oldEpisodeRaw = (dragged.data as { episodeNo?: unknown }).episodeNo
      const oldEpisode = typeof oldEpisodeRaw === 'number' ? oldEpisodeRaw : null
      const episodeChanged = targetEpisode !== oldEpisode

      const noSplice = plan.removes.length === 0 && plan.adds.length === 0
      if (noSplice && !episodeChanged) return

      // 3) 单命令执行：边手术 + episodeNo 补丁，一步撤销整批回滚
      const stamp = Date.now().toString(36)
      const removedEdges = edgesRef.current.filter((e) => plan!.removes.includes(e.id))
      const addedEdges: Edge[] = plan!.adds.map(({ source, target: t }, i) => ({
        id: `e-${source}-out-${t}-mv-${stamp}-${i}`,
        source,
        target: t,
        className: 'pw-edge-sequence',
      }))
      const applyEdges = (remove: boolean) => {
        if (addedEdges.length === 0 && removedEdges.length === 0) return
        setEdges((eds) =>
          remove
            ? [...eds.filter((e) => !removedEdges.some((r) => r.id === e.id)), ...addedEdges]
            : [...eds.filter((e) => !addedEdges.some((a) => a.id === e.id)), ...removedEdges],
        )
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

  /** 节点人读标签：画布快照、改动预览与批次执行共用。 */
  const nodeLabel = useCallback((n: CanvasNode): string => {
    switch (n.type) {
      case 'scene': return `场${n.data.sceneNo}·${n.data.name}`
      case 'dialogue': return `对白·${n.data.name}`
      case 'beat': return `节拍·${n.data.name}`
      case 'branch': return `分支·${n.data.prompt}`
      case 'shot': return `SHOT${n.data.shotNo}·${n.data.size}`
    }
  }, [])

  /** 画布上下文快照（§6「了解当前画布」+ 数据模型 §12.2 压缩视图）：
   * 节点 id/参数、连线语义、剧情流投影与设定集 id——AI 写回命令的锚点。 */
  const canvasDigest = useMemo(
    () =>
      buildGraphDigest(nodes, edges, {
        characters: settings.characters,
        locations: settings.locations,
        characterName: (id) => resolveCharacterName(settings, id),
        locationName: (id) => resolveLocationName(settings, id),
      }),
    [nodes, edges, settings],
  )

  /** AI 校验用的图快照（§12.2）：类型 + 分支选项数供分类型校验。 */
  const aiSnapshot = useCallback(
    (): AiGraphSnapshot => ({
      nodes: nodesRef.current.map((n) => ({
        id: n.id,
        type: n.type,
        label: nodeLabel(n),
        ...(n.type === 'branch' ? { optionsCount: n.data.options.length } : {}),
      })),
      edges: edgesRef.current.map((e) => ({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        type: e.type,
      })),
    }),
    [nodeLabel],
  )

  /** 解析并整批校验助手回复里的命令；无批次（纯讨论）返回 null。
   * 校验语义见 ai/commands.ts：任一条非法则整批拒绝。 */
  const validateAiReply = useCallback(
    (text: string): BatchValidation | null => {
      const parsed = extractBatchJson(text)
      if (!parsed) return null
      return validateAiBatch(parsed.commands, aiSnapshot())
    },
    [aiSnapshot],
  )


  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行 = 选中该节点并居中。 */
  const locateNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      fitView({ nodes: [{ id }], duration: 400, maxZoom: 1 })
    },
    [fitView, setNodes],
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
   * （批量连续创建时传模拟数组防止编号重复）。 */
  const buildNewNode = useCallback(
    (
      type: CreatableType,
      opts?: { at?: XYPosition; selected?: boolean; data?: Record<string, unknown>; against?: CanvasNode[] },
    ): CanvasNode => {
      const nds = opts?.against ?? nodesRef.current
      const select = opts?.selected ?? true
      const maxNo = (pick: (n: CanvasNode) => number) =>
        Math.max(0, ...nds.map(pick)) + 1
      let node: CanvasNode
      if (type === 'scene') {
        node = {
          id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'scene',
          position: { x: 0, y: 0 },
          selected: select,
          data: {
            name: '新场景',
            sceneNo: maxNo((n) => (n.type === 'scene' ? n.data.sceneNo : 0)),
            interior: true,
            time: '🌙 夜',
            synopsis: '这一场发生了什么…',
            characterIds: [],
            ...opts?.data,
          },
        }
      } else if (type === 'beat') {
        node = {
          id: `beat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'beat',
          position: { x: 0, y: 0 },
          selected: select,
          data: { name: '新节拍', tone: '待定', ...opts?.data },
        }
      } else if (type === 'dialogue') {
        node = {
          id: `dialogue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'dialogue',
          position: { x: 0, y: 0 },
          selected: select,
          data: {
            name: '新对白',
            lines: [
              { kind: 'line', speaker: settings.characters[0]?.id, side: 'left', text: '新台词…' },
            ],
            ...opts?.data,
          },
        }
      } else if (type === 'branch') {
        node = {
          id: `branch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'branch',
          position: { x: 0, y: 0 },
          selected: select,
          data: { prompt: '新的分岔是…？', options: ['选项 A', '选项 B'], ...opts?.data },
        }
      } else {
        node = {
          id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'shot',
          position: { x: 0, y: 0 },
          selected: select,
          data: {
            shotNo: maxNo((n) => (n.type === 'shot' ? n.data.shotNo : 0)),
            size: '中景',
            picture: '画面描述…',
            prompt: '',
            refs: [],
            ...opts?.data,
          },
        }
      }
      const cascade = (nds.length % 5) * 28
      if (opts?.at) {
        node.position = opts.at
      } else {
        // 落在当前视口中心，连续创建时阶梯偏移避免叠死
        const rect = canvasRef.current?.getBoundingClientRect()
        if (rect) {
          const center = screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
          node.position = { x: center.x - 170 + cascade, y: center.y - 60 + cascade }
        }
      }
      return node
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

  /** ✦AI 改动落地（§6 改动预览卡、数据模型 §12 Agent 是命令的另一个生产者）：
   * 先按当前图重新整批校验（防预览后用户又改了画布），再逐条翻译为
   * setNodes/setEdges 的前进/回退闭包，整体作为**一条**复合命令入栈——
   * 执行整批生效，⌘Z 一步撤销即整批回滚。返回错误文案或 null。 */
  const applyAiBatch = useCallback(
    (batch: AiCommand[]): string | null => {
      if (batch.length === 0) return null
      const fresh = validateAiBatch(batch, aiSnapshot())
      if (!fresh.ok) {
        return `改动无法安全执行：${fresh.issues[0]?.message ?? '批次校验未通过'}`
      }

      // 折叠模拟：批量创建时场号/镜号基线与引用解析都基于虚拟终态，
      // 每个动作的前进/回退闭包在模拟期一次性捕获，不做运行期查询。
      let simNodes = [...nodesRef.current]
      let simEdges = [...edgesRef.current]
      const refToId = new Map<string, string>()
      const resolveId = (raw: string): string => refToId.get(raw) ?? raw
      const forward: Array<() => void> = []
      const backward: Array<() => void> = []

      for (const cmd of batch) {
        switch (cmd.op) {
          case 'create_node': {
            const node = buildNewNode(cmd.nodeType as CreatableType, {
              selected: false,
              data: (cmd.data as Record<string, unknown>) ?? undefined,
              against: simNodes,
            })
            if (typeof cmd.ref === 'string' && cmd.ref !== '') refToId.set(cmd.ref, node.id)
            simNodes = [...simNodes, node]
            forward.push(() => setNodes((all) => [...all, node]))
            backward.push(() => setNodes((all) => all.filter((n) => n.id !== node.id)))
            break
          }
          case 'update_node': {
            const id = resolveId(cmd.nodeId)
            const target = simNodes.find((n) => n.id === id)
            if (!target) continue
            const keys = Object.keys(cmd.patch)
            const before: Record<string, unknown> = {}
            for (const k of keys) before[k] = (target.data as Record<string, unknown>)[k]
            simNodes = simNodes.map((n) =>
              n.id === id ? ({ ...n, data: { ...n.data, ...cmd.patch } } as CanvasNode) : n,
            )
            forward.push(() => applyDataPatch(id, cmd.patch))
            backward.push(() => applyDataPatch(id, before))
            break
          }
          case 'delete_node': {
            const removedId = resolveId(cmd.nodeId)
            const idSet = new Set([removedId])
            const removedNodes = simNodes.filter((n) => idSet.has(n.id))
            if (removedNodes.length === 0) continue
            const removedEdges = simEdges.filter((e) => idSet.has(e.source) || idSet.has(e.target))
            simNodes = simNodes.filter((n) => !idSet.has(n.id))
            simEdges = simEdges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
            // 状态删除内联（不走 deleteNodesByIds——那会额外入栈破坏单步撤销）
            forward.push(() => {
              setNodes((all) => all.filter((n) => n.id !== removedId))
              setEdges((eds) => eds.filter((e) => e.source !== removedId && e.target !== removedId))
            })
            backward.push(() => {
              setNodes((all) => [...all, ...removedNodes])
              setEdges((eds) => [...eds, ...removedEdges])
            })
            break
          }
          case 'connect_edge': {
            const srcId = resolveId(cmd.sourceId)
            const dstId = resolveId(cmd.targetId)
            const kind = typeof cmd.edgeKind === 'string' ? cmd.edgeKind : 'sequence'
            let edge: Edge
            if (kind === 'attach') {
              // 分镜下挂（§4.4 垂直派生边）
              edge = {
                id: `e-${srcId}-shots-${dstId}-ai-${forward.length}`,
                source: srcId,
                target: dstId,
                sourceHandle: SCENE_SHOT_HANDLE,
                className: 'pw-edge-attach',
              }
            } else if (kind === 'branch') {
              // 分支选项出口：胶囊文案与分支选项同源（§4.4 不落第二份拷贝语义）
              const idx = typeof cmd.optionIndex === 'number' ? cmd.optionIndex : 0
              const branchNode = simNodes.find((n) => n.id === srcId)
              const optionLabel =
                branchNode?.type === 'branch' ? (branchNode.data.options[idx] ?? '') : ''
              edge = {
                id: `e-${srcId}-${branchOptionHandle(idx)}-${dstId}-ai-${forward.length}`,
                source: srcId,
                target: dstId,
                sourceHandle: branchOptionHandle(idx),
                type: 'branch',
                data: { optionLabel },
              }
            } else {
              edge = {
                id: `e-${srcId}-${dstId}-ai-${forward.length}`,
                source: srcId,
                target: dstId,
                className: 'pw-edge-sequence',
              }
            }
            simEdges = [...simEdges, edge]
            forward.push(() => setEdges((eds) => addEdge(edge, eds)))
            backward.push(() => setEdges((eds) => eds.filter((e) => e.id !== edge.id)))
            break
          }
          case 'disconnect_edge': {
            const srcId = resolveId(cmd.sourceId)
            const dstId = resolveId(cmd.targetId)
            const hitIdx = simEdges.findIndex(
              (e) => e.source === srcId && e.target === dstId,
            )
            if (hitIdx < 0) continue
            const removed = simEdges[hitIdx]
            simEdges = [...simEdges.slice(0, hitIdx), ...simEdges.slice(hitIdx + 1)]
            forward.push(() =>
              setEdges((eds) => eds.filter((e) => !(e.source === removed.source && e.target === removed.target))),
            )
            backward.push(() => setEdges((eds) => addEdge(removed, eds)))
            break
          }
        }
      }

      forward.forEach((f) => f())
      pushHistory({
        undo: () => [...backward].reverse().forEach((f) => f()),
        redo: () => forward.forEach((f) => f()),
      })
      setOpenSettingsId(null)
      return null
    },
    [aiSnapshot, applyDataPatch, buildNewNode, pushHistory, setEdges, setNodes],
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
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-pw-settings],[data-pw-gear],.editor-plus,.editor-ctx')) {
        closeSettings()
        setPlusOpen(false)
        setCtxMenu(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.closest('input,textarea,select,[contenteditable="true"]')
      if (e.key === 'Escape') {
        closeSettings()
        setPlusOpen(false)
        setCtxMenu(null)
        setExportOpen(false)
        return
      }
      if (typing) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoHistory()
        else undoHistory()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoHistory()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const nodeIds = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
        if (nodeIds.length > 0) {
          e.preventDefault()
          deleteNodesByIds(nodeIds)
          return
        }
        const edgeIds = edgesRef.current.filter((ed) => ed.selected).map((ed) => ed.id)
        if (edgeIds.length > 0) {
          e.preventDefault()
          deleteEdgesByIds(edgeIds)
        }
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeSettings, deleteEdgesByIds, deleteNodesByIds, redoHistory, undoHistory])

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
      const nodeId = (e.target as HTMLElement).closest?.('.react-flow__node')?.getAttribute('data-id')
      const node = nodeId ? nodesRef.current.find((n) => n.id === nodeId) : undefined

      if (node) {
        if (entity.kind === 'character') {
          if (node.type === 'scene' && !node.data.characterIds.includes(entity.id)) {
            patchNode(node.id, { characterIds: [...node.data.characterIds, entity.id] })
          } else if (node.type === 'dialogue') {
            patchNode(node.id, {
              lines: [...node.data.lines, { kind: 'line', speaker: entity.id, side: 'left', text: '新台词…' }],
            })
          } else if (node.type === 'shot' && !node.data.refs.some((r) => r.label === `${entity.name}垫图`)) {
            patchNode(node.id, { refs: [...node.data.refs, { kind: 'character', label: `${entity.name}垫图` }] })
          }
        } else if (node.type === 'scene') {
          patchNode(node.id, { locationId: entity.id })
        } else if (node.type === 'shot' && !node.data.refs.some((r) => r.label === `${entity.name}底图`)) {
          patchNode(node.id, { refs: [...node.data.refs, { kind: 'location', label: `${entity.name}底图` }] })
        }
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
        const idx = Number(connection.sourceHandle!.slice(BRANCH_OPTION_HANDLE_PREFIX.length))
        const srcNode = nodesRef.current.find((n) => n.id === connection.source)
        branchData = {
          optionLabel: srcNode?.type === 'branch' ? (srcNode.data.options[idx] ?? '') : '',
        }
      }
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...(fromBranchOption
          ? { type: 'branch' as const, data: branchData }
          : fromShotHandle
            ? { className: 'pw-edge-attach' }
            : { className: 'pw-edge-sequence' }),
      }
      setEdges((eds) => addEdge(edge, eds))
      pushHistory({
        undo: () => setEdges((eds) => eds.filter((e) => e.id !== edge.id)),
        redo: () => setEdges((eds) => addEdge(edge, eds)),
      })
    },
    [pushHistory, setEdges],
  )

  return (
    <NodeEditContext.Provider value={nodeEditApi}>
    <div className="editor-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；按钮可点击（§3.3）。 */}
      <header className="editor-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className={`editor-tbtn${leftOpen ? ' on' : ''}`}
          onClick={() => setLeftOpen((v) => !v)}
          aria-pressed={leftOpen}
          aria-label="切换边栏"
          title="显示或隐藏边栏"
        >
          ▤
        </button>
        <button
          type="button"
          className="editor-tbtn"
          onClick={undoHistory}
          disabled={!canUndo}
          aria-label="撤销"
          title="撤销 (⌘Z)"
        >
          ↩︎
        </button>
        <button
          type="button"
          className="editor-tbtn"
          onClick={redoHistory}
          disabled={!canRedo}
          aria-label="重做"
          title="重做 (⌘⇧Z)"
        >
          ↪︎
        </button>
        <button
          type="button"
          className="editor-back"
          onClick={onBackHome}
          aria-label="返回首页"
        >
          ‹ 首页
        </button>
        {/* 项目名居中（§3.3 中区）：点击内联重命名 */}
        <span className="editor-title">
          <EditableName
            value={project.name}
            ariaLabel="项目名"
            singleClick
            onChange={onRenameProject}
          />
        </span>
        <div className="editor-plus">
          <button
            type="button"
            className={`editor-tbtn io${plusOpen ? ' on' : ''}`}
            onClick={() => setPlusOpen((v) => !v)}
            aria-pressed={plusOpen}
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            aria-label="新增节点"
            title="新增节点"
          >
            ＋ 节点 ▾
          </button>
          {plusOpen && (
            <div className="editor-menu" role="menu" aria-label="节点类型">
              {CREATABLE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="editor-menu-item"
                  role="menuitem"
                  onClick={() => createNode(type)}
                >
                  {CREATE_LABELS[type]}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="editor-tbtn"
          onClick={() => setExportOpen(true)}
          aria-label="导出剧本"
          title="导出剧本（场景 + 对白，分镜附录）"
        >
          ⤓ 导出
        </button>
        <button
          type="button"
          className={`editor-tbtn${rightOpen && rightTab === 'inspector' ? ' on' : ''}`}
          onClick={() => {
            setRightTab('inspector')
            setRightOpen(rightTab !== 'inspector' || !rightOpen)
          }}
          aria-pressed={rightOpen && rightTab === 'inspector'}
          aria-label="切换检查器"
          title="显示或隐藏检查器"
        >
          ◫
        </button>
        <button
          type="button"
          className={`editor-tbtn editor-tbtn-ai${rightTab === 'ai' && rightOpen ? ' on' : ''}`}
          onClick={() => {
            setRightTab('ai')
            setRightOpen(rightTab !== 'ai' || !rightOpen)
          }}
          aria-pressed={rightTab === 'ai' && rightOpen}
          aria-label="切换 AI 面板"
          title="显示或隐藏 ✦AI"
        >
          ✦ AI
        </button>
      </header>
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
            fitView
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
          onApplyAiBatch={applyAiBatch}
        />
      </div>
      {/* 右键上下文菜单：节点 = 设置/复制/删除；空白 = 五类新增（§4.3） */}
      {ctxMenu && (
        <div
          className="editor-ctx"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 150),
            top: ctxMenu.y,
          }}
          role="menu"
          aria-label="画布上下文菜单"
        >
          {ctxMenu.nodeId ? (
            <>
              <button
                type="button"
                className="editor-menu-item"
                role="menuitem"
                onClick={() => {
                  toggleSettings(ctxMenu.nodeId!)
                  setCtxMenu(null)
                }}
              >
                ⚙️ 打开设置
              </button>
              <button
                type="button"
                className="editor-menu-item"
                role="menuitem"
                onClick={() => {
                  duplicateNode(ctxMenu.nodeId!)
                  setCtxMenu(null)
                }}
              >
                ⧉ 复制
              </button>
              <button
                type="button"
                className="editor-menu-item editor-menu-danger"
                role="menuitem"
                onClick={() => {
                  deleteNodesByIds([ctxMenu.nodeId!])
                  setCtxMenu(null)
                }}
              >
                🗑 删除
              </button>
            </>
          ) : ctxMenu.edgeId ? (
            <button
              type="button"
              className="editor-menu-item editor-menu-danger"
              role="menuitem"
              onClick={() => {
                deleteEdgesByIds([ctxMenu.edgeId!])
                setCtxMenu(null)
              }}
            >
              ✂️ 删除连线
            </button>
          ) : (
            CREATABLE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="editor-menu-item"
                role="menuitem"
                onClick={() => {
                  createNode(type)
                  setCtxMenu(null)
                }}
              >
                ＋ {CREATE_LABELS[type]}
              </button>
            ))
          )}
        </div>
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
