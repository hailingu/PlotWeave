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
import { LIN_WAN } from './sampleData'
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
  }
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  onBackHome: () => void
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。 */
  onSave: (doc: { name: string; nodes: CanvasNode[]; edges: Edge[] }) => void
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
function EditorWindow({ project, onBackHome, onSave }: EditorViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(project.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)

  // 状态镜像：命令的 undo/redo 需要读取「当前」状态计算逆操作；
  // StrictMode 下 setState updater 会双调，副作用必须在 updater 外完成。
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  // 持久化：画布变化防抖 600ms 全量落盘（剥离 React Flow 运行态字段）；
  // 跳过首次加载，仅在脏状态下卸载冲刷，避免「只打开不编辑」也盖更新时间戳。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef({ name: project.name, nodes, edges })
  latestRef.current = { name: project.name, nodes, edges }
  const firstRender = useRef(true)
  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const { name, nodes: ns, edges: es } = latestRef.current
    onSave({ name, nodes: ns.map(stripNode), edges: es.map(stripEdge) })
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
  }, [nodes, edges, project.name, flushSave])
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

  /** 索引卡的 🎞 镜数：派生自该场 attach 下挂边数量（§7.2，不落镜像字段）。 */
  const shotCountOf = useCallback(
    (id: string) =>
      edgesRef.current.filter(
        (e) => e.source === id && e.sourceHandle === SCENE_SHOT_HANDLE,
      ).length,
    [],
  )

  /** 大纲 ⇄ 画布联动（§3.5）：点击大纲行 = 选中该节点并居中。 */
  const locateNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      fitView({ nodes: [{ id }], duration: 400, maxZoom: 1 })
    },
    [fitView, setNodes],
  )

  /** 连线实时校验（§4.3）：自环 / 成环 / 重复边为非法；attach 下挂一对多合法。 */
  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => {
      if (conn.source === conn.target) return false
      const existing = edgesRef.current
      const duplicate = existing.some(
        (e) =>
          e.source === conn.source &&
          e.target === conn.target &&
          e.sourceHandle === conn.sourceHandle,
      )
      if (duplicate) return false
      if (conn.sourceHandle === SCENE_SHOT_HANDLE) return true
      // 成环检测：从 target 沿现有边能否回到 source
      const adjacency = new Map<string, string[]>()
      for (const e of existing) {
        const list = adjacency.get(e.source) ?? []
        list.push(e.target)
        adjacency.set(e.source, list)
      }
      const seen = new Set<string>()
      const stack = [conn.target]
      while (stack.length > 0) {
        const cur = stack.pop()!
        if (cur === conn.source) return false
        if (seen.has(cur)) continue
        seen.add(cur)
        for (const next of adjacency.get(cur) ?? []) stack.push(next)
      }
      return true
    },
    [],
  )

  /** 新建节点的默认字段（占位文案引导填写；场号/镜号取当前最大值 +1）。
   * opts.at 指定落点（拖拽生成预填节点），opts.data 合并覆盖默认字段。 */
  const createNode = useCallback(
    (type: CreatableType, opts?: { at?: XYPosition; data?: Record<string, unknown> }) => {
      const nds = nodesRef.current
      const maxNo = (pick: (n: CanvasNode) => number) =>
        Math.max(0, ...nds.map(pick)) + 1
      let node: CanvasNode
      if (type === 'scene') {
        node = {
          id: `scene-${Date.now()}`,
          type: 'scene',
          position: { x: 0, y: 0 },
          selected: true,
          data: {
            name: '新场景',
            sceneNo: maxNo((n) => (n.type === 'scene' ? n.data.sceneNo : 0)),
            interior: true,
            location: '地点',
            time: '🌙 夜',
            synopsis: '这一场发生了什么…',
            characters: [],
            ...opts?.data,
          },
        }
      } else if (type === 'beat') {
        node = {
          id: `beat-${Date.now()}`,
          type: 'beat',
          position: { x: 0, y: 0 },
          selected: true,
          data: { name: '新节拍', tone: '待定', ...opts?.data },
        }
      } else if (type === 'dialogue') {
        node = {
          id: `dialogue-${Date.now()}`,
          type: 'dialogue',
          position: { x: 0, y: 0 },
          selected: true,
          data: {
            name: '新对白',
            lines: [{ kind: 'line', speaker: LIN_WAN, side: 'left', text: '新台词…' }],
            ...opts?.data,
          },
        }
      } else if (type === 'branch') {
        node = {
          id: `branch-${Date.now()}`,
          type: 'branch',
          position: { x: 0, y: 0 },
          selected: true,
          data: { prompt: '新的分岔是…？', options: ['选项 A', '选项 B'], ...opts?.data },
        }
      } else {
        node = {
          id: `shot-${Date.now()}`,
          type: 'shot',
          position: { x: 0, y: 0 },
          selected: true,
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
          const cascade = (nds.length % 5) * 28
          node.position = { x: center.x - 170 + cascade, y: center.y - 60 + cascade }
        }
      }
      setNodes((all) => [...all.map((n) => ({ ...n, selected: false })), node])
      pushHistory({
        undo: () => setNodes((all) => all.filter((n) => n.id !== node.id)),
        redo: () => setNodes((all) => [...all, node]),
      })
      setPlusOpen(false)
      setOpenSettingsId(null)
    },
    [pushHistory, screenToFlowPosition, setNodes],
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
    }),
    [openSettingsId, toggleSettings, closeSettings, patchNode, duplicateNode, deleteNode, shotCountOf],
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
          if (node.type === 'scene' && !node.data.characters.some((c) => c.label === entity.avatar.label)) {
            patchNode(node.id, { characters: [...node.data.characters, entity.avatar] })
          } else if (node.type === 'dialogue') {
            patchNode(node.id, {
              lines: [...node.data.lines, { kind: 'line', speaker: entity.avatar, side: 'left', text: '新台词…' }],
            })
          } else if (node.type === 'shot' && !node.data.refs.some((r) => r.label === `${entity.name}垫图`)) {
            patchNode(node.id, { refs: [...node.data.refs, { kind: 'character', label: `${entity.name}垫图` }] })
          }
        } else if (node.type === 'scene') {
          patchNode(node.id, { location: entity.name })
        } else if (node.type === 'shot' && !node.data.refs.some((r) => r.label === `${entity.name}底图`)) {
          patchNode(node.id, { refs: [...node.data.refs, { kind: 'location', label: `${entity.name}底图` }] })
        }
        return
      }

      // 空白处：按实体预填生成场景（§5 拖上空画布直接生成预填节点）
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (entity.kind === 'character') {
        createNode('scene', { at, data: { characters: [entity.avatar] } })
      } else {
        createNode('scene', { at, data: { location: entity.name } })
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

  // 从分支选项端口拉出的连线建成 branch 边；从索引卡底部端口拉出的建成
  // attach 派生边（垂直下挂分镜卡）；其余为 sequence（§4.4）。入栈可撤销。
  const onConnect = useCallback(
    (connection: Connection) => {
      const fromBranchOption = connection.sourceHandle?.startsWith(
        BRANCH_OPTION_HANDLE_PREFIX,
      )
      const fromShotHandle = connection.sourceHandle === SCENE_SHOT_HANDLE
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...(fromBranchOption
          ? { type: 'branch' }
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
        <span className="editor-title" data-tauri-drag-region>
          {project.name}
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
          onLocate={locateNode}
          selectedId={selectedNode?.id}
        />
        <div className="canvas-root" ref={canvasRef} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
          <ReactFlow
            nodes={nodes}
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
          text={buildScriptMarkdown(project.name, nodes, edges)}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
    </NodeEditContext.Provider>
  )
}
