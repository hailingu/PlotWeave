/**
 * 画布区域（EditorLayout 三栏的中区）：ReactFlow 画布本体、节点/连线类型
 * 注册与背景控件。文档交互与持久化来自装配层，仅持有会话内网格吸附开关。
 * 渲染隔离（issue #103）：输入按真实消费字段收窄为 EditorCanvasRegionProps
 * 并以 memo 包裹——面板状态（边栏开合/＋菜单/右栏切页/对话框）变化时，
 * 布局层下传的这些成员引用保持稳定，整个 ReactFlow 子树跳过执行；节点/
 * 连线/选中变化仍经 doc 与 displayNodes 正常触发改区。
 */
import {
  memo,
  Profiler,
  useCallback,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import { isSwiftHost } from '../platform/hostEnvironment'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
} from '@xyflow/react'
import { canvasNodeTypes, canvasEdgeTypes } from './canvasRegistry'
import { CanvasAlignmentControls } from './CanvasAlignmentControls'
import { CANVAS_GRID_SIZE } from './canvasAlignment'
import type { EditorGraphActions } from './useEditorGraphActions'
import type { EditorPersistence } from './useEditorPersistence'
import type { CanvasView } from './useCanvasView'
import type { EditorDocument } from './useEditorDocument'
import { useCanvasPerformance } from './useCanvasPerformance'
import {
  CanvasPerformancePanel,
  CanvasPerformanceToggle,
} from './CanvasPerformancePanel'
import './canvasControls.css'

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
  /** 打开时的视口种子；项目名等无关元数据不进入画布 memo 边界。 */
  readonly viewport: EditorDocument['viewport']
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
  /** 原生版普通节点点击：请求对应属性，不接管框架选择或视口。 */
  readonly onInspectNode: (id: string) => void
  /** 原生版空白点击：清理属性目标，不展开或切换右栏。 */
  readonly onClearNodeInspector: () => void
}

/** 画布容器与 ReactFlow 装配；文档变化经 doc/displayNodes 穿透 memo 边界。 */
function EditorCanvasRegionImpl(props: EditorCanvasRegionProps) {
  const [snapToGrid, setSnapToGrid] = useState(true)
  const swiftHost = isSwiftHost()
  const perf = useCanvasPerformance({
    canvas: 'editor',
    nodeCount: props.displayNodes.length,
    edgeCount: props.doc.edges.length,
    onNodesChange: props.onNodesChange,
    onNodeDragStart: props.onNodeDragStart,
    onNodeDragStop: props.onNodeDragStop,
    canvasRef: props.canvasRef,
  })
  const inspection = useCanvasInspectionHandlers(
    props.onInspectNode,
    props.onClearNodeInspector,
  )
  return (
    <div
      className={swiftHost ? 'canvas-root is-swift' : 'canvas-root'}
      data-canvas-effects={perf.renderingMode}
      ref={props.canvasRef}
      onDragOver={props.onCanvasDragOver}
      onDrop={props.onCanvasDrop}
    >
      <Profiler id="canvas" onRender={perf.onRender}>
        <CanvasFlow
          viewport={props.viewport}
          doc={props.doc}
          displayNodes={props.displayNodes}
          inspection={inspection}
          onConnect={props.onConnect}
          onNodeContextMenu={props.onNodeContextMenu}
          onEdgeContextMenu={props.onEdgeContextMenu}
          onPaneContextMenu={props.onPaneContextMenu}
          isValidConnection={props.isValidConnection}
          onMoveEnd={props.onMoveEnd}
          onAutoLayout={props.onAutoLayout}
          onAlignNodes={props.onAlignNodes}
          snapToGrid={snapToGrid}
          swiftHost={swiftHost}
          onToggleSnap={() => setSnapToGrid((enabled) => !enabled)}
          perf={perf}
        />
      </Profiler>
    </div>
  )
}

/** ReactFlow 实际消费的输入；类型声明独立于组件执行体。 */
type CanvasFlowProps = Pick<
  EditorCanvasRegionProps,
  | 'viewport'
  | 'doc'
  | 'displayNodes'
  | 'onConnect'
  | 'onNodeContextMenu'
  | 'onEdgeContextMenu'
  | 'onPaneContextMenu'
  | 'isValidConnection'
  | 'onMoveEnd'
  | 'onAutoLayout'
  | 'onAlignNodes'
> & {
  readonly inspection: ReturnType<typeof useCanvasInspectionHandlers>
  readonly snapToGrid: boolean
  readonly swiftHost: boolean
  readonly onToggleSnap: () => void
  readonly perf: ReturnType<typeof useCanvasPerformance>
}

/** 框架接线与装饰分开，采样开关不会改变 React Flow 的挂载身份。 */
function CanvasFlow({
  viewport,
  doc,
  displayNodes,
  inspection,
  onConnect,
  onNodeContextMenu,
  onEdgeContextMenu,
  onPaneContextMenu,
  isValidConnection,
  onMoveEnd,
  onAutoLayout,
  onAlignNodes,
  snapToGrid,
  swiftHost,
  onToggleSnap,
  perf,
}: CanvasFlowProps) {
  return (
    <ReactFlow
      nodes={displayNodes}
      snapToGrid={snapToGrid}
      snapGrid={CANVAS_SNAP_GRID}
      edges={doc.edges}
      nodeTypes={canvasNodeTypes}
      edgeTypes={canvasEdgeTypes}
      proOptions={{ hideAttribution: true }}
      onNodeClick={inspection.onNodeClick}
      onPaneClick={inspection.onPaneClick}
      onNodesChange={perf.onNodesChange}
      onEdgesChange={doc.onEdgesChange}
      onConnect={onConnect}
      {...(perf.onNodeDragStart && { onNodeDragStart: perf.onNodeDragStart })}
      {...(perf.onNodeDragStop && { onNodeDragStop: perf.onNodeDragStop })}
      {...(perf.onNodeDrag && { onNodeDrag: perf.onNodeDrag })}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onPaneContextMenu={onPaneContextMenu}
      isValidConnection={isValidConnection}
      /* 删除统一走命令栈（含连线清理），禁用内置 Delete 行为 */
      deleteKeyCode={null}
      /* 有持久化视口则恢复，否则首开 fitView（§3 视口随文档持久化） */
      {...(viewport !== undefined && {
        defaultViewport: viewport,
      })}
      fitView={!viewport}
      onMoveEnd={onMoveEnd}
    >
      <CanvasDecorations
        doc={doc}
        onAutoLayout={onAutoLayout}
        onAlignNodes={onAlignNodes}
        snapToGrid={snapToGrid}
        swiftHost={swiftHost}
        onToggleSnap={onToggleSnap}
        perf={perf}
      />
    </ReactFlow>
  )
}

/** 控件与诊断面板只消费展示所需值，不接管文档或持久化。 */
function CanvasDecorations({
  doc,
  onAutoLayout,
  onAlignNodes,
  snapToGrid,
  swiftHost,
  onToggleSnap,
  perf,
}: Pick<EditorCanvasRegionProps, 'doc' | 'onAutoLayout' | 'onAlignNodes'> & {
  readonly snapToGrid: boolean
  readonly swiftHost: boolean
  readonly onToggleSnap: () => void
  readonly perf: ReturnType<typeof useCanvasPerformance>
}) {
  return (
    <>
      <Background
        variant={BackgroundVariant.Dots}
        gap={CANVAS_GRID_SIZE}
        size={1}
        color="var(--canvas-dot)"
      />
      <CanvasAlignmentControls
        selectedCount={doc.nodes.filter((node) => node.selected).length}
        autoLayoutDisabled={doc.nodes.length === 0}
        onAutoLayout={onAutoLayout}
        onAlignNodes={onAlignNodes}
      />
      <CanvasLayoutControl
        nativeZoom={swiftHost}
        snapToGrid={snapToGrid}
        onToggleSnap={onToggleSnap}
        performanceEnabled={perf.enabled}
        onTogglePerformance={perf.toggle}
      />
      <CanvasPerformancePanel
        enabled={perf.enabled}
        report={perf.report}
        renderingMode={perf.renderingMode}
        onToggleEffects={perf.toggleEffects}
      />
    </>
  )
}

/** 点击接线不随位置帧换引用，避免 React Flow 重渲染全部节点；动作变化仍更新闭包。 */
function useCanvasInspectionHandlers(
  inspect: EditorCanvasRegionProps['onInspectNode'],
  clear: EditorCanvasRegionProps['onClearNodeInspector'],
) {
  const onNodeClick = useCallback(
    (event: MouseEvent, node: { readonly id: string }) =>
      requestNodeInspector(event, node.id, inspect),
    [inspect],
  )
  const onPaneClick = useCallback(() => {
    if (isSwiftHost()) clear()
  }, [clear])
  return { onNodeClick, onPaneClick }
}

/** 普通原生主体点击打开属性；多选、文本编辑和连接端口仍由原交互所有者处理。 */
function requestNodeInspector(
  event: MouseEvent,
  id: string,
  inspect: (id: string) => void,
): void {
  if (!isSwiftHost() || event.metaKey || event.ctrlKey || event.shiftKey) return
  const target = event.target
  if (
    target instanceof Element &&
    target.closest(
      'input,textarea,select,[contenteditable="true"],.react-flow__handle,button:not(.pw-editable)',
    )
  )
    return
  inspect(id)
}

/** memo 隔离边界（issue #103）：与画布输入无关的状态变化不重执行本区域。
 * 命名导出（issue #164）：内部实现与导出名分离，消费方仍按
 * EditorCanvasRegion 引用。 */
export const EditorCanvasRegion = memo(EditorCanvasRegionImpl)

/** 原生底栏拥有缩放与适配；锁定和吸附仍复用 React Flow 的会话交互。 */
function CanvasLayoutControl({
  nativeZoom,
  snapToGrid,
  onToggleSnap,
  performanceEnabled,
  onTogglePerformance,
}: {
  /** 仅 Swift 底栏提供缩放，其他宿主保留 Web 入口。 */
  readonly nativeZoom: boolean
  readonly snapToGrid: boolean
  readonly onToggleSnap: () => void
  readonly performanceEnabled: boolean
  readonly onTogglePerformance: () => void
}) {
  const snapLabel = `网格吸附：${snapToGrid ? '开' : '关'}`
  return (
    /* Controls 不转发 role；清空其无 role 容器的默认标签，保留各按钮名称。 */
    <Controls
      aria-label=""
      showZoom={!nativeZoom}
      showFitView={!nativeZoom}
      orientation={nativeZoom ? 'horizontal' : 'vertical'}
    >
      <button
        type="button"
        className="react-flow__controls-button"
        title={snapLabel}
        aria-label={snapLabel}
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
      <CanvasPerformanceToggle
        enabled={performanceEnabled}
        onToggle={onTogglePerformance}
      />
    </Controls>
  )
}
