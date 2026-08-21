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

/** 应用根组件：承载剧本画布，提供节点拖拽、连线与缩放导航能力。 */
export default function App() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  )

  return (
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
  )
}
