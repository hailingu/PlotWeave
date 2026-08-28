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
import { readEntityPayload, PW_ENTITY_MIME, type EntityDragPayload } from './dragDrop'
import ExportDialog from './ExportDialog'
import { buildScriptMarkdown } from './exportScript'
import { EditableName } from './nodes/settings/NodeSettingsPanel'
import { isDuplicateEdge, branchOptionHandle, wouldCreateCycle } from './graphRules'
import { uid } from '../uid'
import { compareCodeUnits } from '../compare'
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
import { applyEpisodeTitle } from './episodeTitle'
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
  readonly project: {
    id: string
    name: string
    nodes: CanvasNode[]
    edges: Edge[]
    settings: ProjectSettings
    /** 大纲集标题（§3.5：集 = 编号 + 行内标题）。 */
    episodeTitles?: Record<number, string>
  }
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  readonly onBackHome: () => void
  /** 项目名内联重命名（§3.3 中区：更新 project.name + 首页索引）。 */
  readonly onRenameProject: (name: string) => void
  /** 打开设置页（§8.2 BYOK 配置入口，⌘,）。 */
  readonly onOpenSettings?: () => void
  /** 持久化写入（防抖节流由本组件负责；浏览器预览下为内存回退实现）。 */
  readonly onSave: (doc: {
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

/** AI 批量命令模拟器的虚拟终态与闭包收集（applyAiBatch 拆分用，S3776）。 */
interface BatchSim {
  nodes: CanvasNode[]
  edges: Edge[]
  refToId: Map<string, string>
  forward: Array<() => void>
  backward: Array<() => void>
}

/** 模拟器所需的画布写入动作。 */
interface BatchOps {
  buildNewNode: (
    type: CreatableType,
    opts?: { selected?: boolean; data?: Record<string, unknown>; against?: CanvasNode[] },
  ) => CanvasNode
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  setNodes: (updater: (all: CanvasNode[]) => CanvasNode[]) => void
  setEdges: (updater: (eds: Edge[]) => Edge[]) => void
}

const simCreate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'create_node' }>,
): void => {
  const node = ops.buildNewNode(cmd.nodeType as CreatableType, {
    selected: false,
    data: (cmd.data as Record<string, unknown>) ?? undefined,
    against: sim.nodes,
  })
  if (typeof cmd.ref === 'string' && cmd.ref !== '') sim.refToId.set(cmd.ref, node.id)
  sim.nodes = [...sim.nodes, node]
  sim.forward.push(() => ops.setNodes((all) => [...all, node]))
  sim.backward.push(() => ops.setNodes((all) => all.filter((n) => n.id !== node.id)))
}

const simUpdate = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'update_node' }>,
): void => {
  const id = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const target = sim.nodes.find((n) => n.id === id)
  if (!target) return
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(cmd.patch)) before[k] = (target.data as Record<string, unknown>)[k]
  sim.nodes = sim.nodes.map((n) =>
    n.id === id ? ({ ...n, data: { ...n.data, ...cmd.patch } } as CanvasNode) : n,
  )
  sim.forward.push(() => ops.applyDataPatch(id, cmd.patch))
  sim.backward.push(() => ops.applyDataPatch(id, before))
}

const simDelete = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'delete_node' }>,
): void => {
  const removedId = sim.refToId.get(cmd.nodeId) ?? cmd.nodeId
  const idSet = new Set([removedId])
  const removedNodes = sim.nodes.filter((n) => idSet.has(n.id))
  if (removedNodes.length === 0) return
  const removedEdges = sim.edges.filter((e) => idSet.has(e.source) || idSet.has(e.target))
  sim.nodes = sim.nodes.filter((n) => !idSet.has(n.id))
  sim.edges = sim.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target))
  // 状态删除内联（不走 deleteNodesByIds——那会额外入栈破坏单步撤销）
  sim.forward.push(() => {
    ops.setNodes((all) => all.filter((n) => n.id !== removedId))
    ops.setEdges((eds) => eds.filter((e) => e.source !== removedId && e.target !== removedId))
  })
  sim.backward.push(() => {
    ops.setNodes((all) => [...all, ...removedNodes])
    ops.setEdges((eds) => [...eds, ...removedEdges])
  })
}

/** connect_edge 的目标边：attach / branch / sequence 三态（§4.4）。 */
const connectEdgeOf = (
  sim: BatchSim,
  cmd: Extract<AiCommand, { op: 'connect_edge' }>,
  srcId: string,
  dstId: string,
): Edge => {
  const kind = typeof cmd.edgeKind === 'string' ? cmd.edgeKind : 'sequence'
  if (kind === 'attach') {
    // 分镜下挂（§4.4 垂直派生边）
    return {
      id: `e-${srcId}-shots-${dstId}-ai-${sim.forward.length}`,
      source: srcId,
      target: dstId,
      sourceHandle: SCENE_SHOT_HANDLE,
      className: 'pw-edge-attach',
    }
  }
  if (kind === 'branch') {
    // 分支选项出口：胶囊文案与分支选项同源（§4.4 不落第二份拷贝语义）
    const idx = typeof cmd.optionIndex === 'number' ? cmd.optionIndex : 0
    const branchNode = sim.nodes.find((n) => n.id === srcId)
    const optionLabel = branchNode?.type === 'branch' ? (branchNode.data.options[idx] ?? '') : ''
    return {
      id: `e-${srcId}-${branchOptionHandle(idx)}-${dstId}-ai-${sim.forward.length}`,
      source: srcId,
      target: dstId,
      sourceHandle: branchOptionHandle(idx),
      type: 'branch',
      data: { optionLabel },
    }
  }
  return {
    id: `e-${srcId}-${dstId}-ai-${sim.forward.length}`,
    source: srcId,
    target: dstId,
    className: 'pw-edge-sequence',
  }
}

const simConnect = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'connect_edge' }>,
): void => {
  const srcId = sim.refToId.get(cmd.sourceId) ?? cmd.sourceId
  const dstId = sim.refToId.get(cmd.targetId) ?? cmd.targetId
  const edge = connectEdgeOf(sim, cmd, srcId, dstId)
  sim.edges = [...sim.edges, edge]
  sim.forward.push(() => ops.setEdges((eds) => addEdge(edge, eds)))
  sim.backward.push(() => ops.setEdges((eds) => eds.filter((e) => e.id !== edge.id)))
}

const simDisconnect = (
  sim: BatchSim,
  ops: BatchOps,
  cmd: Extract<AiCommand, { op: 'disconnect_edge' }>,
): void => {
  const srcId = sim.refToId.get(cmd.sourceId) ?? cmd.sourceId
  const dstId = sim.refToId.get(cmd.targetId) ?? cmd.targetId
  const hitIdx = sim.edges.findIndex((e) => e.source === srcId && e.target === dstId)
  if (hitIdx < 0) return
  const removed = sim.edges[hitIdx]
  sim.edges = [...sim.edges.slice(0, hitIdx), ...sim.edges.slice(hitIdx + 1)]
  sim.forward.push(() =>
    ops.setEdges((eds) => eds.filter((e) => !(e.source === removed.source && e.target === removed.target))),
  )
  sim.backward.push(() => ops.setEdges((eds) => addEdge(removed, eds)))
}

/** 新连线的差异化字段（§4.4，onConnect 用，S3358 拆分）：
 * branch 选项出口 / attach 下挂 / 默认 sequence。 */
function connectEdgeExtras(
  fromBranchOption: boolean,
  branchData: { optionLabel: string } | undefined,
  fromShotHandle: boolean,
): Pick<Edge, 'type' | 'data' | 'className'> {
  if (fromBranchOption) return { type: 'branch' as const, data: branchData }
  if (fromShotHandle) return { className: 'pw-edge-attach' }
  return { className: 'pw-edge-sequence' }
}

/** 大纲拖拽的接缝计划（onOutlineDrop 步骤 1，S3776 拆分）：行落点直接
 * 锚定锚点；组尾落点从该组最后一个剧情流行向上找第一个可执行锚点。 */
function outlineSplicePlan(
  nodes: CanvasNode[],
  edges: Edge[],
  titles: Record<number, string>,
  draggedId: string,
  target: OutlineDropTarget,
): { plan: SplicePlan; anchorId: string } | null {
  if (target.kind === 'row') {
    const plan = planSpliceIntoSpine(edges, draggedId, target.anchorId, target.position)
    return plan ? { plan, anchorId: target.anchorId } : null
  }
  const group = buildOutlineGroups(nodes, edges, titles).find((g) => g.episode === target.episode)
  const spineRows = (group?.rows ?? []).filter((r) => r.id !== draggedId && r.level < 3)
  for (let i = spineRows.length - 1; i >= 0; i--) {
    const plan = planSpliceIntoSpine(edges, draggedId, spineRows[i].id, 'after')
    if (plan) return { plan, anchorId: spineRows[i].id }
  }
  return null
}

/** 大纲拖拽的边重排应用（onOutlineDrop 步骤 3，S2004 拆分）：
 * redo = 去旧边加新边；undo = 去新边还原旧边。 */
function spliceEdgesWith(eds: Edge[], removed: Edge[], added: Edge[], redo: boolean): Edge[] {
  const dropIds = new Set((redo ? removed : added).map((e) => e.id))
  const kept = eds.filter((e) => !dropIds.has(e.id))
  return redo ? [...kept, ...added] : [...kept, ...removed]
}

/** 分镜引用补丁：同名引用已存在则返回 null（去重）。 */
function refPatch(
  refs: Array<{ label: string }>,
  kind: 'character' | 'location',
  label: string,
): Record<string, unknown> | null {
  if (refs.some((r) => r.label === label)) return null
  return { refs: [...refs, { kind, label }] }
}

/** 角色实体 → 节点的引用补丁：场景出场 / 对白新台词 / 分镜垫图。 */
function characterDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (node.type === 'scene') {
    const ids = node.data.characterIds
    if (ids.includes(entity.id)) return null
    return { characterIds: [...ids, entity.id] }
  }
  if (node.type === 'dialogue') {
    return {
      lines: [...node.data.lines, { kind: 'line', speaker: entity.id, side: 'left', text: '新台词…' }],
    }
  }
  if (node.type === 'shot') return refPatch(node.data.refs, 'character', `${entity.name}垫图`)
  return null
}

/** 地点实体 → 节点的引用补丁：场景地点 / 分镜底图。 */
function locationDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (node.type === 'scene') return { locationId: entity.id }
  if (node.type === 'shot') return refPatch(node.data.refs, 'location', `${entity.name}底图`)
  return null
}

/** 设定集实体拖上节点的引用补丁（§5，onCanvasDrop 拆分用）：
 * 返回 null = 该节点不接收或已存在同类引用。 */
function entityDropPatch(
  node: CanvasNode,
  entity: EntityDragPayload,
): Record<string, unknown> | null {
  if (entity.kind === 'character') return characterDropPatch(node, entity)
  return locationDropPatch(node, entity)
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

  /** tool-calling 通道：工具调用映射出的命令数组走同一整批校验。 */
  const validateCommands = useCallback(
    (commands: AiCommand[]): BatchValidation | null => validateAiBatch(commands, aiSnapshot()),
    [aiSnapshot],
  )

  /** 读工具 get_node：返回节点完整字段 JSON；不存在返回 null。 */
  const readNode = useCallback((nodeId: string): string | null => {
    const n = nodesRef.current.find((x) => x.id === nodeId)
    return n ? JSON.stringify({ id: n.id, type: n.type, data: n.data }) : null
  }, [])


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
          id: uid('scene'),
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
          id: uid('beat'),
          type: 'beat',
          position: { x: 0, y: 0 },
          selected: select,
          data: { name: '新节拍', tone: '待定', ...opts?.data },
        }
      } else if (type === 'dialogue') {
        node = {
          id: uid('dialogue'),
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
          id: uid('branch'),
          type: 'branch',
          position: { x: 0, y: 0 },
          selected: select,
          data: { prompt: '新的分岔是…？', options: ['选项 A', '选项 B'], ...opts?.data },
        }
      } else {
        node = {
          id: uid('shot'),
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
      const ops: BatchOps = { buildNewNode, applyDataPatch, setNodes, setEdges }
      const sim: BatchSim = {
        nodes: [...nodesRef.current],
        edges: [...edgesRef.current],
        refToId: new Map(),
        forward: [],
        backward: [],
      }
      for (const cmd of batch) {
        if (cmd.op === 'create_node') simCreate(sim, ops, cmd)
        else if (cmd.op === 'update_node') simUpdate(sim, ops, cmd)
        else if (cmd.op === 'delete_node') simDelete(sim, ops, cmd)
        else if (cmd.op === 'connect_edge') simConnect(sim, ops, cmd)
        else simDisconnect(sim, ops, cmd)
      }

      sim.forward.forEach((f) => f())
      pushHistory({
        undo: () => [...sim.backward].reverse().forEach((f) => f()),
        redo: () => sim.forward.forEach((f) => f()),
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
        const idx = Number(connection.sourceHandle!.slice(BRANCH_OPTION_HANDLE_PREFIX.length))
        const srcNode = nodesRef.current.find((n) => n.id === connection.source)
        branchData = {
          optionLabel: srcNode?.type === 'branch' ? (srcNode.data.options[idx] ?? '') : '',
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

  /** 右键菜单内容（S3358 拆分）：节点菜单 / 连线菜单 / 空白处新建菜单。 */
  const ctxMenuBody = () => {
    if (ctxMenu?.nodeId) {
      return (
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
      )
    }
    if (ctxMenu?.edgeId) {
      return (
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
      )
    }
    return CREATABLE_TYPES.map((type) => (
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
  }

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
          onValidateCommands={validateCommands}
          onReadNode={readNode}
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
          {ctxMenuBody()}
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
