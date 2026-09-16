/**
 * 画布区域（EditorLayout 三栏的中区）：ReactFlow 画布本体、节点/连线类型
 * 注册与背景控件。交互回调与视口持久化全部来自装配层，本组件不持状态。
 * 渲染隔离（issue #103）：输入按真实消费字段收窄为 EditorCanvasRegionProps
 * 并以 memo 包裹——面板状态（边栏开合/＋菜单/右栏切页/对话框）变化时，
 * 布局层下传的这些成员引用保持稳定，整个 ReactFlow 子树跳过执行；节点/
 * 连线/选中变化仍经 doc 与 displayNodes 正常触发改区。
 */
import { memo, type RefObject } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import { SceneNode } from './nodes/SceneNode'
import { DialogueNode } from './nodes/DialogueNode'
import { BeatNode } from './nodes/BeatNode'
import { BranchNode } from './nodes/BranchNode'
import { ShotNode } from './nodes/ShotNode'
import { ImageNode } from './nodes/ImageNode'
import { BranchEdge } from './edges/BranchEdge'
import type { EditorGraphActions } from './useEditorGraphActions'
import type { EditorPersistence } from './useEditorPersistence'
import type { CanvasView } from './useCanvasView'
import type { EditorDocument, EditorProjectContent } from './useEditorDocument'

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

/**
 * 画布区域的收窄输入（issue #103 渲染隔离）：只声明本区域真实消费的字段，
 * 不再接整包 EditorLayoutProps。各成员在面板状态变化下引用稳定（装配层
 * 回调均 useCallback、doc 按字段 memo），布局层经 toCanvasRegionProps 挑选
 * 下传，memo 浅比较命中即跳过本区域执行；新增画布消费字段时在此与挑选
 * 函数同步登记。
 */
export interface EditorCanvasRegionProps {
  /** 打开的项目：视口决定首开 fitView 与 defaultViewport。 */
  readonly project: EditorProjectContent
  /** 画布容器：ReactFlow 挂载点。 */
  readonly canvasRef: RefObject<HTMLDivElement>
  /** 会话文档：节点/连线状态与写通道（useEditorDocument 按字段 memo）。 */
  readonly doc: EditorDocument
  /** 集聚焦投影后的展示节点（useCanvasView 按文档状态 memo）。 */
  readonly displayNodes: CanvasView['displayNodes']
  /** 画布拖放（useCanvasDrop）：dragover 放行与 drop 落点处理。 */
  readonly onCanvasDragOver: EditorGraphActions['drop']['onCanvasDragOver']
  readonly onCanvasDrop: EditorGraphActions['drop']['onCanvasDrop']
  /** 连线实时校验与落线（useConnectionRules）。 */
  readonly isValidConnection: EditorGraphActions['connection']['isValidConnection']
  readonly onConnect: EditorGraphActions['connection']['onConnect']
  /** 节点拖拽历史（useNodeDragHistory）：整段拖拽记一步撤销。 */
  readonly onNodeDragStart: EditorGraphActions['drag']['onNodeDragStart']
  readonly onNodeDragStop: EditorGraphActions['drag']['onNodeDragStop']
  /** 右键菜单触发（useEditorContextMenu）：节点/连线/空白画布。 */
  readonly onNodeContextMenu: EditorGraphActions['menu']['onNodeContextMenu']
  readonly onEdgeContextMenu: EditorGraphActions['menu']['onEdgeContextMenu']
  readonly onPaneContextMenu: EditorGraphActions['menu']['onPaneContextMenu']
  /** 自动排布（issue #94，useAutoLayout）：整图位置整理入命令栈。 */
  readonly onAutoLayout: EditorGraphActions['layout']['onAutoLayout']
  /** 视口落定持久化（useEditorPersistence，§3 视口随文档落盘）。 */
  readonly onMoveEnd: EditorPersistence['onMoveEnd']
}

/** 画布容器与 ReactFlow 装配；文档变化经 doc/displayNodes 穿透 memo 边界。 */
function EditorCanvasRegionImpl(props: EditorCanvasRegionProps) {
  const {
    project,
    canvasRef,
    doc,
    displayNodes,
    onCanvasDragOver,
    onCanvasDrop,
    isValidConnection,
    onConnect,
    onNodeDragStart,
    onNodeDragStop,
    onNodeContextMenu,
    onEdgeContextMenu,
    onPaneContextMenu,
    onAutoLayout,
    onMoveEnd,
  } = props
  return (
    <div
      className="canvas-root"
      ref={canvasRef}
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={doc.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        onNodesChange={doc.onNodesChange}
        onEdgesChange={doc.onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        isValidConnection={isValidConnection}
        /* 删除统一走命令栈（含连线清理），禁用内置 Delete 行为 */
        deleteKeyCode={null}
        /* 有持久化视口则恢复，否则首开 fitView（§3 视口随文档持久化） */
        defaultViewport={project.viewport}
        fitView={!project.viewport}
        onMoveEnd={onMoveEnd}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={CANVAS_DOT_GAP}
          size={1}
          color="var(--canvas-dot)"
        />
        <Controls>
          {/* 自动排布（issue #94）：复用控件按钮样式保证暗/浅色可辨认；
              空画布禁用。整图位置整理入命令栈，动作语义在 useAutoLayout。 */}
          <button
            type="button"
            className="react-flow__controls-button"
            title="自动排布"
            aria-label="自动排布"
            disabled={doc.nodes.length === 0}
            onClick={onAutoLayout}
          >
            <AutoLayoutIcon />
          </button>
        </Controls>
      </ReactFlow>
    </div>
  )
}

/** memo 隔离边界（issue #103）：与画布输入无关的状态变化不重执行本区域。
 * 命名导出（issue #164）：内部实现与导出名分离，消费方仍按
 * EditorCanvasRegion 引用。 */
export const EditorCanvasRegion = memo(EditorCanvasRegionImpl)

/** 自动排布按钮图标：三卡对齐 + 归位箭头，表达「整理布局」。 */
function AutoLayoutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="6" rx="1.2" />
      <rect x="3" y="12" width="7" height="6" rx="1.2" />
      <path d="M14 5h7M14 9h4" strokeLinecap="round" />
      <path d="M14 14h7M14 18h4" strokeLinecap="round" />
    </svg>
  )
}
