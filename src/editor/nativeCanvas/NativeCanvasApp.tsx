import { Profiler, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
} from '@xyflow/react'
import { NodeEditContext } from '../nodeEdit'
import { ImageGenContext, type ImageGenApi } from '../imagegen/context'
import {
  CANVAS_DOT_GAP,
  canvasEdgeTypes,
  canvasNodeTypes,
} from '../canvasRegistry'
import { useDemoEditor } from './useDemoEditor'
import { DEMO_GRAPH_LABEL, type DemoGraph } from './demoGraph'
import { CANVAS_PERF_LABEL } from './canvasPerfFixture'
import { isSwiftHost } from '../../platform/hostEnvironment'
import { useNativeCanvasLifecycle } from './useNativeCanvasLifecycle'
import { useCanvasPerformance } from '../useCanvasPerformance'
import {
  CanvasPerformancePanel,
  CanvasPerformanceToggle,
} from '../CanvasPerformancePanel'

/**
 * P1 原生视觉首片的画布演示页（docs/swiftui-react-flow-migration-plan.md
 * §5 第 3 项）：复用生产节点/连线注册与编辑上下文，加载确定性脱敏夹具，
 * 支持拖拽、连线、平移与缩放；徽标常驻标明内存演示数据，挂载后向
 * WKWebView 宿主发送就绪握手（§4.1）。
 */

/** 徽标定位样式：常驻画布顶部居中，不拦截指针（画布交互不受影响）。 */
const BADGE_STYLE = {
  position: 'absolute',
  top: 10,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '2px 12px',
  borderRadius: 999,
  fontSize: 12,
  color: 'var(--text-secondary)',
  background: 'var(--surface-window)',
  border: '1px solid var(--border-hairline)',
  pointerEvents: 'none',
  zIndex: 10,
  whiteSpace: 'nowrap',
} as const

/** 演示页满幅容器：复用应用级 .canvas-root 的弹性填充规则。 */
const VIEWPORT_STYLE = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
} as const

/**
 * 演示页的生成调度 stub（§4.1 未接通能力显式禁用，不返回假成功）：
 * 显式隔离夹具不接真实模型服务——jobOf 恒空闲、start 仅留可观察提示，
 * 不伪造 running/产物（生产实现在 editor/imagegen，由 EditorView 装配）。
 */
const DEMO_IMAGE_GEN_API: ImageGenApi = {
  jobOf: () => null,
  start: () => {
    console.info('[demo] 隔离演示夹具未接生成服务，请使用生产编辑入口')
  },
  cancel: () => undefined,
}

/** 验证页装配入参：注入固定规模性能夹具时徽标改为测量口径。 */
interface NativeCanvasAppProps {
  readonly graph?: DemoGraph
}

/** 装配演示会话、宿主握手与外观同步，复用编辑器画布能力。 */
export function NativeCanvasApp({ graph }: NativeCanvasAppProps) {
  const editor = useDemoEditor(graph)
  const canvasRef = useRef<HTMLDivElement>(null)
  const perf = useCanvasPerformance({
    canvas: 'demo',
    nodeCount: editor.nodes.length,
    edgeCount: editor.edges.length,
    onNodesChange: editor.onNodesChange,
    canvasRef,
  })

  useNativeCanvasLifecycle()

  return (
    <div style={VIEWPORT_STYLE}>
      <div
        className={isSwiftHost() ? 'canvas-root is-swift' : 'canvas-root'}
        ref={canvasRef}
        data-canvas-effects={perf.renderingMode}
        style={{ position: 'relative' }}
      >
        <ImageGenContext.Provider value={DEMO_IMAGE_GEN_API}>
          <NodeEditContext.Provider value={editor.nodeEditApi}>
            <Profiler id="demo-canvas" onRender={perf.onRender}>
              <DemoCanvas editor={editor} perf={perf} />
            </Profiler>
          </NodeEditContext.Provider>
        </ImageGenContext.Provider>
        <div style={BADGE_STYLE}>
          {graph
            ? `${DEMO_GRAPH_LABEL} · ${CANVAS_PERF_LABEL} · 不落盘`
            : `${DEMO_GRAPH_LABEL} · 隔离演示夹具 · 不落盘`}
        </div>
      </div>
    </div>
  )
}

/** 演示入口的框架接线与诊断共用同一挂载树，开关不重新创建画布。 */
function DemoCanvas({
  editor,
  perf,
}: {
  readonly editor: ReturnType<typeof useDemoEditor>
  readonly perf: ReturnType<typeof useCanvasPerformance>
}) {
  return (
    <ReactFlow
      nodes={editor.nodes}
      edges={editor.edges}
      nodeTypes={canvasNodeTypes}
      edgeTypes={canvasEdgeTypes}
      proOptions={{ hideAttribution: true }}
      onNodesChange={perf.onNodesChange}
      {...(perf.onNodeDragStart && { onNodeDragStart: perf.onNodeDragStart })}
      {...(perf.onNodeDragStop && { onNodeDragStop: perf.onNodeDragStop })}
      {...(perf.onNodeDrag && { onNodeDrag: perf.onNodeDrag })}
      onEdgesChange={editor.onEdgesChange}
      onConnect={editor.onConnect}
      isValidConnection={editor.isValidConnection}
      /* 演示页无命令栈，禁用内置 Delete（删除走节点设置面板 ⧉/🗑） */
      deleteKeyCode={null}
      fitView
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={CANVAS_DOT_GAP}
        size={1}
        color="var(--canvas-dot)"
      />
      <Controls showInteractive={false}>
        <CanvasPerformanceToggle
          enabled={perf.enabled}
          onToggle={perf.toggle}
        />
      </Controls>
      <CanvasPerformancePanel
        enabled={perf.enabled}
        report={perf.report}
        renderingMode={perf.renderingMode}
        onToggleEffects={perf.toggleEffects}
      />
    </ReactFlow>
  )
}
