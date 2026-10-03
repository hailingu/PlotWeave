/**
 * 画布区域（EditorLayout 三栏的中区）：ReactFlow 画布本体、节点/连线类型
 * 注册与背景控件。文档交互与持久化来自装配层，仅持有会话内网格吸附开关。
 * 渲染隔离（issue #103）：输入按真实消费字段收窄为 EditorCanvasRegionProps
 * 并以 memo 包裹——面板状态（边栏开合/＋菜单/右栏切页/对话框）变化时，
 * 布局层下传的这些成员引用保持稳定，整个 ReactFlow 子树跳过执行；节点/
 * 连线/选中变化仍经 doc 与 displayNodes 正常触发改区。
 */
import { memo, useState, type RefObject } from 'react'
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
import { CanvasAlignmentControls } from './CanvasAlignmentControls'
import { CANVAS_GRID_SIZE } from './canvasAlignment'
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

/** 横纵轴吸附间距与背景点阵共用画布单位，缩放时保持同一网格。 */
const CANVAS_SNAP_GRID: [number, number] = [CANVAS_GRID_SIZE, CANVAS_GRID_SIZE]

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
  /** 框架节点变更统一经过位置历史入口，键盘移动每批一步。 */
  readonly onNodesChange: EditorGraphActions['drag']['onNodesChange']
  /** 节点拖拽历史（useNodeDragHistory）：整段拖拽记一步撤销。 */
  readonly onNodeDragStart: EditorGraphActions['drag']['onNodeDragStart']
  readonly onNodeDragStop: EditorGraphActions['drag']['onNodeDragStop']
  /** 右键菜单触发（useEditorContextMenu）：节点/连线/空白画布。 */
  readonly onNodeContextMenu: EditorGraphActions['menu']['onNodeContextMenu']
  readonly onEdgeContextMenu: EditorGraphActions['menu']['onEdgeContextMenu']
  readonly onPaneContextMenu: EditorGraphActions['menu']['onPaneContextMenu']
  /** 自动排布（issue #94，useAutoLayout）：整图位置整理入命令栈。 */
  readonly onAutoLayout: EditorGraphActions['layout']['onAutoLayout']
  /** 选中节点对齐：只改位置，整批一次撤销。 */
  readonly onAlignNodes: EditorGraphActions['alignment']['onAlignNodes']
  /** 视口落定持久化（useEditorPersistence，§3 视口随文档落盘）。 */
  readonly onMoveEnd: EditorPersistence['onMoveEnd']
}

/** 画布容器与 ReactFlow 装配；文档变化经 doc/displayNodes 穿透 memo 边界。 */
function EditorCanvasRegionImpl(props: EditorCanvasRegionProps) {
  const { project, doc } = props
  const [snapToGrid, setSnapToGrid] = useState(true)
  return (
    <div
      className="canvas-root"
      ref={props.canvasRef}
      onDragOver={props.onCanvasDragOver}
      onDrop={props.onCanvasDrop}
    >
      <ReactFlow
        nodes={props.displayNodes}
        snapToGrid={snapToGrid}
        snapGrid={CANVAS_SNAP_GRID}
        edges={doc.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        onNodesChange={props.onNodesChange}
        onEdgesChange={doc.onEdgesChange}
        onConnect={props.onConnect}
        onNodeDragStart={props.onNodeDragStart}
        onNodeDragStop={props.onNodeDragStop}
        onNodeContextMenu={props.onNodeContextMenu}
        onEdgeContextMenu={props.onEdgeContextMenu}
        onPaneContextMenu={props.onPaneContextMenu}
        isValidConnection={props.isValidConnection}
        /* 删除统一走命令栈（含连线清理），禁用内置 Delete 行为 */
        deleteKeyCode={null}
        /* 有持久化视口则恢复，否则首开 fitView（§3 视口随文档持久化） */
        {...(project.viewport !== undefined && {
          defaultViewport: project.viewport,
        })}
        fitView={!project.viewport}
        onMoveEnd={props.onMoveEnd}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={CANVAS_GRID_SIZE}
          size={1}
          color="var(--canvas-dot)"
        />
        <CanvasAlignmentControls
          selectedCount={doc.nodes.filter((node) => node.selected).length}
          onAlignNodes={props.onAlignNodes}
        />
        <CanvasLayoutControl
          disabled={doc.nodes.length === 0}
          onAutoLayout={props.onAutoLayout}
          snapToGrid={snapToGrid}
          onToggleSnap={() => setSnapToGrid((enabled) => !enabled)}
        />
      </ReactFlow>
    </div>
  )
}

/** memo 隔离边界（issue #103）：与画布输入无关的状态变化不重执行本区域。
 * 命名导出（issue #164）：内部实现与导出名分离，消费方仍按
 * EditorCanvasRegion 引用。 */
export const EditorCanvasRegion = memo(EditorCanvasRegionImpl)

/** 自动排布入口独立于对齐工具条；空画布禁用。 */
function CanvasLayoutControl({
  disabled,
  onAutoLayout,
  snapToGrid,
  onToggleSnap,
}: {
  readonly disabled: boolean
  readonly onAutoLayout: () => void
  readonly snapToGrid: boolean
  readonly onToggleSnap: () => void
}) {
  return (
    <Controls>
      <button
        type="button"
        className="react-flow__controls-button"
        title="网格吸附"
        aria-label="网格吸附"
        aria-pressed={snapToGrid}
        onClick={onToggleSnap}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />
        </svg>
      </button>
      <button
        type="button"
        className="react-flow__controls-button"
        title="自动排布"
        aria-label="自动排布"
        disabled={disabled}
        onClick={onAutoLayout}
      >
        <AutoLayoutIcon />
      </button>
    </Controls>
  )
}

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
