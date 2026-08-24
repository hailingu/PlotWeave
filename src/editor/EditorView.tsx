import { useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import SceneNode from './nodes/SceneNode'
import DialogueNode from './nodes/DialogueNode'
import BeatNode from './nodes/BeatNode'
import BranchNode, { BRANCH_OPTION_HANDLE_PREFIX } from './nodes/BranchNode'
import ShotNode from './nodes/ShotNode'
import BranchEdge from './edges/BranchEdge'
import type { CanvasNode, NodeAvatar } from './nodes/types'

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

/** 示例角色头像（占位期直接存渐变串，后续由设定集头像派生）。 */
const LIN_WAN: NodeAvatar = {
  label: '晚',
  gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
}
const CHEN_MO: NodeAvatar = {
  label: '默',
  gradient: 'linear-gradient(135deg,#00b3d8,#5e5ce6)',
}

/**
 * 示例画布：按生产管线的上下游排布——节奏卡（节拍表）在最上游，
 * 向下游依次展开为索引卡（场景）→ 对白 → 分支 → 两条支线的后续场景；
 * 索引卡下游挂一张分镜卡（AI 燃料占位）。随后由真实剧本数据替换。
 */
const initialNodes: CanvasNode[] = [
  {
    id: 'beat-1',
    type: 'beat',
    position: { x: 0, y: 80 },
    data: { name: '雨夜对峙', tone: '压抑渐强' },
  },
  {
    id: 'scene-1',
    type: 'scene',
    position: { x: 300, y: 40 },
    selected: true,
    data: {
      name: '雨夜天台',
      sceneNo: 3,
      shotCount: 1,
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
    position: { x: 320, y: 420 },
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
    id: 'dialogue-1',
    type: 'dialogue',
    position: { x: 730, y: 60 },
    data: {
      name: '真相逼近',
      lines: [
        { kind: 'line', speaker: LIN_WAN, side: 'left', text: '你早就知道，对吗？' },
        { kind: 'action', text: '陈默沉默，雨声渐大' },
        {
          kind: 'line',
          speaker: CHEN_MO,
          side: 'right',
          text: '……我是为了保护你。',
        },
      ],
    },
  },
  {
    id: 'branch-1',
    type: 'branch',
    position: { x: 1180, y: 60 },
    data: { prompt: '林晚是否发现真相？', options: ['坦白', '隐瞒'] },
  },
  {
    id: 'scene-2',
    type: 'scene',
    position: { x: 1600, y: 0 },
    data: {
      name: '天台摊牌',
      sceneNo: 4,
      shotCount: 0,
      interior: false,
      location: '天台',
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默坦白当年真相，林晚在雨中久久无言。',
      characters: [LIN_WAN, CHEN_MO],
    },
  },
  {
    id: 'scene-3',
    type: 'scene',
    position: { x: 1600, y: 240 },
    data: {
      name: '独自离开',
      sceneNo: 5,
      shotCount: 0,
      interior: false,
      location: '天台',
      time: '🌙 夜',
      weather: '🌧 雨',
      synopsis: '陈默选择隐瞒，林晚转身离开，雨幕吞没背影。',
      characters: [LIN_WAN],
    },
  },
]

/** 示例连线：sequence 中性灰；branch 从分支选项端口出发、带选项胶囊。 */
const initialEdges: Edge[] = [
  {
    id: 'e-beat-scene',
    source: 'beat-1',
    target: 'scene-1',
    className: 'pw-edge-sequence',
  },
  {
    id: 'e-scene-shot',
    source: 'scene-1',
    target: 'shot-1',
    className: 'pw-edge-sequence',
  },
  {
    id: 'e-scene-dialogue',
    source: 'scene-1',
    target: 'dialogue-1',
    className: 'pw-edge-sequence',
  },
  {
    id: 'e-dialogue-branch',
    source: 'dialogue-1',
    target: 'branch-1',
    className: 'pw-edge-sequence',
  },
  {
    id: 'e-branch-confess',
    source: 'branch-1',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}0`,
    target: 'scene-2',
    type: 'branch',
    data: { optionLabel: '坦白' },
  },
  {
    id: 'e-branch-hide',
    source: 'branch-1',
    sourceHandle: `${BRANCH_OPTION_HANDLE_PREFIX}1`,
    target: 'scene-3',
    type: 'branch',
    data: { optionLabel: '隐瞒' },
  },
]

interface EditorViewProps {
  /** 项目名，展示在统一工具栏中区（内联重命名随编辑器工具栏落地）。 */
  projectName: string
  /** 返回项目首页：同一窗口从编辑器状态切回文档浏览器（§3.1）。 */
  onBackHome: () => void
}

/**
 * 剧本画布编辑器：顶部统一工具栏（左 = 返回首页，中 = 项目名），
 * 下方为节点画布。工具栏右区（＋节点 / 导出 / 检查器 / ✦AI）
 * 与撤销重做随对应功能落地（docs/ui-design.md §3.3）。
 */
export default function EditorView({ projectName, onBackHome }: EditorViewProps) {
  const [nodes, , onNodesChange] = useNodesState<CanvasNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // 从分支选项端口拉出的连线建成 branch 边，其余为 sequence（§4.4）。
  const onConnect = useCallback(
    (connection: Connection) => {
      const fromBranchOption = connection.sourceHandle?.startsWith(
        BRANCH_OPTION_HANDLE_PREFIX,
      )
      const edge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`,
        ...(fromBranchOption
          ? { type: 'branch' }
          : { className: 'pw-edge-sequence' }),
      }
      setEdges((eds) => addEdge(edge, eds))
    },
    [setEdges],
  )

  return (
    <div className="editor-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；返回按钮可点击。 */}
      <header className="editor-titlebar" data-tauri-drag-region>
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
      </header>
      <div className="canvas-root">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
    </div>
  )
}
