import { useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

/**
 * 占位初始节点：演示「场景 → 对白 → 分支」三类叙事单元的连线关系，
 * 后续由真实的剧本数据模型替换。
 */
const initialNodes: Node[] = [
  {
    id: 'scene-1',
    position: { x: 0, y: 0 },
    data: { label: '场景：雨夜天台' },
  },
  {
    id: 'dialog-1',
    position: { x: 240, y: 120 },
    data: { label: '对白：真相逼近' },
  },
  {
    id: 'branch-1',
    position: { x: 480, y: 0 },
    data: { label: '分支：坦白 / 隐瞒' },
  },
]

/** 占位初始连线：表达剧情流向与分支走向。 */
const initialEdges: Edge[] = [
  { id: 'e-scene-dialog', source: 'scene-1', target: 'dialog-1' },
  { id: 'e-dialog-branch', source: 'dialog-1', target: 'branch-1' },
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
  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
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
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}
