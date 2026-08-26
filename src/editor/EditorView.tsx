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
import { LIN_WAN, CHEN_MO } from './sampleData'
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

/**
 * 示例画布：一个两幕短剧结构，演示生产管线的完整上下游关系——
 * 第一幕：节奏卡「雨夜对峙」→ 索引卡「雨夜天台」（挂两张分镜卡）
 * → 对白「真相逼近」→ 分支「是否发现真相」；
 * 支线：坦白 → 索引卡「天台摊牌」→ 对白「十年前的雨」；
 *       隐瞒 → 索引卡「独自离开」；
 * 第二幕：节奏卡「身份揭晓」→ 两线汇合于索引卡「旧公寓」（挂一张分镜卡）
 * → 分支「是否原谅」→ 双结局「天台黎明」/「车站告别」。
 * 随后由真实剧本数据替换。
 */
const initialNodes: CanvasNode[] = [
  {
    id: 'beat-1',
    type: 'beat',
    position: { x: 0, y: 80 },
    data: { name: '雨夜对峙', tone: '压抑渐强' },
  },
  {
    id: 'scene-3',
    type: 'scene',
    position: { x: 320, y: 40 },
    selected: true,
    data: {
      name: '雨夜天台',
      sceneNo: 3,
      interior: false,
      location: '天台',
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '林晚翻出父亲死亡当夜的档案，陈默突然出现，要她立刻离开天台。',
      characters: [LIN_WAN, CHEN_MO],
    },
  },
  {
    id: 'shot-1',
    type: 'shot',
    position: { x: 175, y: 320 },
    data: {
      shotNo: 1,
      size: '远景',
      picture: '雨夜城市天台全景，林晚撑伞站在栏杆边，陈默从阴影中走出。',
      prompt: 'rainy rooftop at night, cinematic wide shot, neon reflections, two figures confronting',
      refs: [
        { kind: 'character', label: '林晚垫图' },
        { kind: 'location', label: '天台底图' },
        { kind: 'audio', label: '雨声' },
      ],
    },
  },
  {
    id: 'shot-2',
    type: 'shot',
    position: { x: 505, y: 320 },
    data: {
      shotNo: 2,
      size: '特写',
      picture: '档案袋里的旧照片特写，指尖颤抖，雨水滴落在照片上。',
      prompt: 'extreme close-up of trembling hands holding an old photo, raindrops, shallow depth of field',
      refs: [
        { kind: 'character', label: '林晚垫图' },
        { kind: 'audio', label: '雨声' },
      ],
    },
  },
  {
    id: 'dialogue-1',
    type: 'dialogue',
    position: { x: 770, y: 60 },
    data: {
      name: '真相逼近',
      lines: [
        { kind: 'line', speaker: LIN_WAN, side: 'left', text: '你早就知道，对吗？' },
        { kind: 'action', text: '陈默沉默，雨声渐大' },
        { kind: 'line', speaker: CHEN_MO, side: 'right', text: '……我是为了保护你。' },
      ],
    },
  },
  {
    id: 'branch-1',
    type: 'branch',
    position: { x: 1230, y: 60 },
    data: { prompt: '林晚是否发现真相？', options: ['坦白', '隐瞒'] },
  },
  {
    id: 'scene-4',
    type: 'scene',
    position: { x: 1630, y: -60 },
    data: {
      name: '天台摊牌',
      sceneNo: 4,
      interior: false,
      location: '天台',
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默坦白当年真相，林晚在雨中久久无言。',
      characters: [LIN_WAN, CHEN_MO],
    },
  },
  {
    id: 'dialogue-2',
    type: 'dialogue',
    position: { x: 2080, y: -60 },
    data: {
      name: '十年前的雨',
      lines: [
        { kind: 'line', speaker: CHEN_MO, side: 'left', text: '那晚，我也在旧公寓。' },
        { kind: 'line', speaker: LIN_WAN, side: 'right', text: '为什么十年都不告诉我？' },
      ],
    },
  },
  {
    id: 'scene-5',
    type: 'scene',
    position: { x: 1630, y: 240 },
    data: {
      name: '独自离开',
      sceneNo: 5,
      interior: false,
      location: '天台',
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默选择隐瞒，林晚转身离开，雨幕吞没背影。',
      characters: [LIN_WAN],
    },
  },
  {
    id: 'beat-2',
    type: 'beat',
    position: { x: 2080, y: 260 },
    data: { name: '身份揭晓', tone: '爆发' },
  },
  {
    id: 'scene-6',
    type: 'scene',
    position: { x: 2530, y: 80 },
    data: {
      name: '旧公寓',
      sceneNo: 6,
      interior: true,
      location: '旧公寓',
      time: '🌙 夜',
      synopsis: '林晚在旧公寓找到父亲留下的第二张照片，两条支线的真相在此汇合。',
      characters: [LIN_WAN],
    },
  },
  {
    id: 'shot-3',
    type: 'shot',
    position: { x: 2550, y: 340 },
    data: {
      shotNo: 3,
      size: '中景',
      picture: '旧公寓昏黄灯光下，林晚蹲在纸箱前，手里的照片微微发抖。',
      prompt: 'dim old apartment, medium shot, woman crouching by cardboard boxes, warm tungsten light',
      refs: [
        { kind: 'character', label: '林晚垫图' },
        { kind: 'location', label: '旧公寓底图' },
      ],
    },
  },
  {
    id: 'branch-2',
    type: 'branch',
    position: { x: 2980, y: 80 },
    data: { prompt: '林晚是否原谅陈默？', options: ['原谅', '不原谅'] },
  },
  {
    id: 'scene-7',
    type: 'scene',
    position: { x: 3430, y: -20 },
    data: {
      name: '天台黎明',
      sceneNo: 7,
      interior: false,
      location: '天台',
      time: '🌅 晨',
      synopsis: '雨停了，两人并肩坐在天台边缘，看城市醒来。',
      characters: [LIN_WAN, CHEN_MO],
    },
  },
  {
    id: 'scene-8',
    type: 'scene',
    position: { x: 3430, y: 260 },
    data: {
      name: '车站告别',
      sceneNo: 8,
      interior: false,
      location: '车站',
      time: '🌅 晨',
      synopsis: '林晚独自踏上列车，把那张照片留在了站台长椅上。',
      characters: [LIN_WAN],
    },
  },
]

/** 示例连线：sequence 中性灰走横向剧情流；attach 细虚线从索引卡底部垂直下挂分镜卡；
 * branch 从分支选项端口出发、带选项胶囊。 */
const initialEdges: Edge[] = [
  // 第一幕：节奏卡 → 索引卡 → 对白 → 分支
  { id: 'e-beat1-scene3', source: 'beat-1', target: 'scene-3', className: 'pw-edge-sequence' },
  {
    id: 'e-scene3-shot1',
    source: 'scene-3',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-1',
    className: 'pw-edge-attach',
  },
  {
    id: 'e-scene3-shot2',
    source: 'scene-3',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-2',
    className: 'pw-edge-attach',
  },
  { id: 'e-scene3-dialogue1', source: 'scene-3', target: 'dialogue-1', className: 'pw-edge-sequence' },
  { id: 'e-dialogue1-branch1', source: 'dialogue-1', target: 'branch-1', className: 'pw-edge-sequence' },
  // 支线：坦白 / 隐瞒
  {
    id: 'e-branch1-confess',
    source: 'branch-1',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}0`,
    target: 'scene-4',
    type: 'branch',
    data: { optionLabel: '坦白' },
  },
  {
    id: 'e-branch1-hide',
    source: 'branch-1',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}1`,
    target: 'scene-5',
    type: 'branch',
    data: { optionLabel: '隐瞒' },
  },
  { id: 'e-scene4-dialogue2', source: 'scene-4', target: 'dialogue-2', className: 'pw-edge-sequence' },
  // 第二幕：节奏卡 → 两线汇合于旧公寓
  { id: 'e-dialogue2-scene6', source: 'dialogue-2', target: 'scene-6', className: 'pw-edge-sequence' },
  { id: 'e-scene5-scene6', source: 'scene-5', target: 'scene-6', className: 'pw-edge-sequence' },
  { id: 'e-beat2-scene6', source: 'beat-2', target: 'scene-6', className: 'pw-edge-sequence' },
  {
    id: 'e-scene6-shot3',
    source: 'scene-6',
    sourceHandle: SCENE_SHOT_HANDLE,
    target: 'shot-3',
    className: 'pw-edge-attach',
  },
  // 结局分支：双结局
  { id: 'e-scene6-branch2', source: 'scene-6', target: 'branch-2', className: 'pw-edge-sequence' },
  {
    id: 'e-branch2-forgive',
    source: 'branch-2',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}0`,
    target: 'scene-7',
    type: 'branch',
    data: { optionLabel: '原谅' },
  },
  {
    id: 'e-branch2-leave',
    source: 'branch-2',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}1`,
    target: 'scene-8',
    type: 'branch',
    data: { optionLabel: '不原谅' },
  },
]

interface EditorViewProps {
  /** 项目名，展示在统一工具栏中区（内联重命名随编辑器工具栏落地）。 */
  projectName: string
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  onBackHome: () => void
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
 * （§3.3 撤销重做、§4.3 删除可撤销）；持久化随后续任务落地。
 */
function EditorWindow({ projectName, onBackHome }: EditorViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)

  // 状态镜像：命令的 undo/redo 需要读取「当前」状态计算逆操作；
  // StrictMode 下 setState updater 会双调，副作用必须在 updater 外完成。
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

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
          {projectName}
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
          projectName={projectName}
          text={buildScriptMarkdown(projectName, nodes, edges)}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
    </NodeEditContext.Provider>
  )
}
