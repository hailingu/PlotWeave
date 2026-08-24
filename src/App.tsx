import { useCallback, useState } from 'react'
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
import HomePage from './home/HomePage'
import {
  createSampleProjects,
  type ProjectSummary,
} from './home/projects'

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

/** 剧本画布编辑器：节点拖拽、连线与缩放导航。 */
function EditorView() {
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

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）——
 * 项目首页与编辑器是同一窗口的两种状态，`openProjectId` 非空即编辑器。
 * 项目数据目前为内存占位，持久化命令（list_projects 等）落地后改由后端驱动。
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>(() =>
    createSampleProjects(),
  )
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

  const handleCreateProject = useCallback(() => {
    const project: ProjectSummary = {
      id: `local-${Date.now()}`,
      name: '未命名短剧',
      sceneCount: 0,
      updatedAt: new Date().toISOString(),
    }
    setProjects((list) => [project, ...list])
    setOpenProjectId(project.id)
  }, [])

  if (openProjectId !== null) {
    return <EditorView />
  }
  return (
    <HomePage
      projects={projects}
      onOpenProject={setOpenProjectId}
      onCreateProject={handleCreateProject}
    />
  )
}
