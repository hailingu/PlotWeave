/**
 * 画布区域（EditorLayout 三栏的中区）：ReactFlow 画布本体、节点/连线类型
 * 注册与背景控件。交互回调与视口持久化全部来自装配层，本组件不持状态。
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import SceneNode from './nodes/SceneNode'
import DialogueNode from './nodes/DialogueNode'
import BeatNode from './nodes/BeatNode'
import BranchNode from './nodes/BranchNode'
import ShotNode from './nodes/ShotNode'
import ImageNode from './nodes/ImageNode'
import BranchEdge from './edges/BranchEdge'
import type { EditorLayoutProps } from './editorLayoutProps'

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

/** 背景点阵间距（像素），与画布网格视觉密度一致。 */
const CANVAS_DOT_GAP = 22

/** 画布容器与 ReactFlow 装配；拖放命中、右键菜单与连线校验经 graph 下传。 */
export default function EditorCanvasRegion(props: EditorLayoutProps) {
  const { project, doc, view, canvasRef, graph, persistence } = props
  return (
    <div
      className="canvas-root"
      ref={canvasRef}
      onDragOver={graph.drop.onCanvasDragOver}
      onDrop={graph.drop.onCanvasDrop}
    >
      <ReactFlow
        nodes={view.displayNodes}
        edges={doc.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        onNodesChange={doc.onNodesChange}
        onEdgesChange={doc.onEdgesChange}
        onConnect={graph.connection.onConnect}
        onNodeDragStart={graph.drag.onNodeDragStart}
        onNodeDragStop={graph.drag.onNodeDragStop}
        onNodeContextMenu={graph.menu.onNodeContextMenu}
        onEdgeContextMenu={graph.menu.onEdgeContextMenu}
        onPaneContextMenu={graph.menu.onPaneContextMenu}
        isValidConnection={graph.connection.isValidConnection}
        /* 删除统一走命令栈（含连线清理），禁用内置 Delete 行为 */
        deleteKeyCode={null}
        /* 有持久化视口则恢复，否则首开 fitView（§3 视口随文档持久化） */
        defaultViewport={project.viewport}
        fitView={!project.viewport}
        onMoveEnd={persistence.onMoveEnd}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={CANVAS_DOT_GAP}
          size={1}
          color="var(--canvas-dot)"
        />
        <Controls />
      </ReactFlow>
    </div>
  )
}
