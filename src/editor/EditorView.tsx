import { useCallback, useState } from 'react'
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
import SceneNode, { SCENE_SHOT_HANDLE } from './nodes/SceneNode'
import DialogueNode from './nodes/DialogueNode'
import BeatNode from './nodes/BeatNode'
import BranchNode, { BRANCH_OPTION_HANDLE_PREFIX } from './nodes/BranchNode'
import ShotNode from './nodes/ShotNode'
import BranchEdge from './edges/BranchEdge'
import LeftPanel from './panels/LeftPanel'
import RightPanel, { type RightTab } from './panels/RightPanel'
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
      shotCount: 2,
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
      shotCount: 0,
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
      shotCount: 1,
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
      shotCount: 0,
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
      shotCount: 0,
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

/**
 * 剧本画布编辑器：顶部统一工具栏（左 = 返回首页，中 = 项目名），
 * 下方为节点画布。工具栏右区（＋节点 / 导出 / 检查器 / ✦AI）
 * 与撤销重做随对应功能落地（docs/ui-design.md §3.3）。
 */
export default function EditorView({ projectName, onBackHome }: EditorViewProps) {
  const [nodes, , onNodesChange] = useNodesState<CanvasNode>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // 三栏面板状态（§3.4：220–320pt 可调，显隐会话内记忆——组件态即会话态）
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftWidth, setLeftWidth] = useState(248)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightWidth, setRightWidth] = useState(264)
  const [rightTab, setRightTab] = useState<RightTab>('inspector')
  const selectedNode = nodes.find((n) => n.selected)

  // 从分支选项端口拉出的连线建成 branch 边；从索引卡底部端口拉出的建成
  // attach 派生边（垂直下挂分镜卡）；其余为 sequence（§4.4）。
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
    },
    [setEdges],
  )

  return (
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
          className="editor-back"
          onClick={onBackHome}
          aria-label="返回首页"
        >
          ‹ 首页
        </button>
        <span className="editor-title" data-tauri-drag-region>
          {projectName}
        </span>
        <button
          type="button"
          className={`editor-tbtn io${rightOpen && rightTab === 'inspector' ? ' on' : ''}`}
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
        />
        <div className="canvas-root">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            proOptions={{ hideAttribution: true }}
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
        />
      </div>
    </div>
  )
}
