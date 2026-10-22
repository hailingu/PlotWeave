/** 诊断的 React 接线：关闭时保留原回调引用，开启时仅在段末更新报告。 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ProfilerOnRenderCallback,
  type RefObject,
} from 'react'
import type { OnNodeDrag, OnNodesChange } from '@xyflow/react'
import {
  createCanvasPerformanceRecorder,
  type CanvasPerformanceReport,
} from './canvasPerformance'
import type { CanvasNode } from './nodes/types'
import { EditorPerformanceContext } from './editorPerformanceContext'

/** 图规模与既有回调来自装配入口，诊断不会持有或修改节点内容。 */
interface CanvasPerformanceInputs {
  canvas: CanvasPerformanceReport['canvas']
  nodeCount: number
  edgeCount: number
  onNodesChange: OnNodesChange<CanvasNode>
  onNodeDragStart?: OnNodeDrag<CanvasNode>
  onNodeDragStop?: OnNodeDrag<CanvasNode>
  onNodeDrag?: OnNodeDrag<CanvasNode>
  canvasRef?: RefObject<HTMLDivElement | null>
}

/** 仅主节点的平移坐标可直接比较；不拼接选择器或保留节点标识。 */
function primaryElement(
  canvasRef: CanvasPerformanceInputs['canvasRef'],
  node: CanvasNode,
): HTMLElement | null {
  if (node.parentId || node.origin?.some((value) => value !== 0)) return null
  return (
    Array.from(
      canvasRef?.current?.querySelectorAll<HTMLElement>('.react-flow__node') ??
        [],
    ).find((element) => element.dataset.id === node.id) ?? null
  )
}

/** 关闭时维持原 drag 回调身份；开启时保留业务执行及原异常。 */
function useMeasuredPositionCallback(
  input: CanvasPerformanceInputs,
  enabled: boolean,
  recorder: ReturnType<typeof createCanvasPerformanceRecorder>,
) {
  const onNodeDrag = input.onNodeDrag
  const drag = useCallback<OnNodeDrag<CanvasNode>>(
    (event, node, nodes) => {
      recorder.drag(event, node.position)
      try {
        onNodeDrag?.(event, node, nodes)
      } catch (error) {
        recorder.finish('interrupted')
        throw error
      }
    },
    [onNodeDrag, recorder],
  )
  return enabled ? drag : onNodeDrag
}

/** 只在开启时监听中断，卸载取消资源而不向 React 发布结果。 */
function useSamplingLifecycle(
  enabled: boolean,
  recorder: ReturnType<typeof createCanvasPerformanceRecorder>,
): void {
  useEffect(() => () => recorder.dispose(), [recorder])
  useEffect(() => {
    if (!enabled) return
    const interrupt = () => recorder.finish('interrupted')
    const visibility = () => {
      if (document.hidden) interrupt()
    }
    window.addEventListener('blur', interrupt)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', interrupt)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled, recorder])
}

/** 起止只依赖图规模、稳定 ref 与业务回调，节点位置帧不改变回调身份。 */
function useMeasuredDragLifecycle(
  input: CanvasPerformanceInputs,
  recorder: ReturnType<typeof createCanvasPerformanceRecorder>,
  renderingMode: CanvasPerformanceReport['renderingMode'],
) {
  const { nodeCount, edgeCount, onNodeDragStart, onNodeDragStop, canvasRef } =
    input
  const start = useCallback<OnNodeDrag<CanvasNode>>(
    (event, node, nodes) => {
      const callbackAt = performance.now()
      recorder.start(
        { nodeCount, edgeCount, draggedNodeCount: nodes.length },
        renderingMode,
        primaryElement(canvasRef, node),
      )
      const readyAt = performance.now()
      try {
        try {
          onNodeDragStart?.(event, node, nodes)
        } finally {
          recorder.recordStartup(
            event.timeStamp,
            callbackAt,
            readyAt,
            performance.now(),
          )
        }
      } catch (error) {
        recorder.finish('interrupted')
        throw error
      }
    },
    [recorder, nodeCount, edgeCount, onNodeDragStart, renderingMode, canvasRef],
  )
  const stop = useCallback<OnNodeDrag<CanvasNode>>(
    (event, node, nodes) => {
      try {
        onNodeDragStop?.(event, node, nodes)
      } catch (error) {
        recorder.finish('interrupted')
        throw error
      }
      recorder.finish('completed')
    },
    [recorder, onNodeDragStop],
  )
  return { start, stop }
}

/** 适配框架回调；原业务回调始终执行，错误保留原对象并结束诊断段。 */
function useMeasuredDragCallbacks(
  input: CanvasPerformanceInputs,
  enabled: boolean,
  recorder: ReturnType<typeof createCanvasPerformanceRecorder>,
  renderingMode: CanvasPerformanceReport['renderingMode'],
) {
  const { onNodesChange, onNodeDragStart, onNodeDragStop } = input
  const { start, stop } = useMeasuredDragLifecycle(
    input,
    recorder,
    renderingMode,
  )
  const measuredChanges = useCallback<OnNodesChange<CanvasNode>>(
    (changes) => recorder.measureChanges(changes, () => onNodesChange(changes)),
    [recorder, onNodesChange],
  )
  const onRender = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actual, base) => {
      if (enabled) recorder.render(actual, base)
    },
    [enabled, recorder],
  )
  return {
    onRender,
    onNodeDrag: useMeasuredPositionCallback(input, enabled, recorder),
    onNodesChange: enabled ? measuredChanges : onNodesChange,
    onNodeDragStart: enabled ? start : onNodeDragStart,
    onNodeDragStop: enabled ? stop : onNodeDragStop,
  }
}

/** 在两个 React Flow 入口共享开关和段末报告，不逐帧 setState。 */
export function useCanvasPerformance(input: CanvasPerformanceInputs) {
  const subscribe = useContext(EditorPerformanceContext)
  const [enabled, setEnabled] = useState(false)
  const [renderingMode, setRenderingMode] =
    useState<CanvasPerformanceReport['renderingMode']>('standard')
  const [report, setReport] = useState<CanvasPerformanceReport | null>(null)
  const recorder = useMemo(
    () =>
      createCanvasPerformanceRecorder(input.canvas, (next) => {
        console.info('[CanvasPerf]', next)
        setReport(next)
      }),
    [input.canvas],
  )
  useSamplingLifecycle(enabled, recorder)
  useEffect(
    () =>
      subscribe?.((actual, base) => recorder.render(actual, base, 'editor')),
    [subscribe, recorder],
  )
  const toggle = useCallback(() => {
    recorder.finish('disabled')
    if (enabled) setRenderingMode('standard')
    setEnabled(!enabled)
  }, [enabled, recorder])
  const toggleEffects = useCallback(() => {
    if (!enabled) return
    recorder.finish('interrupted')
    setRenderingMode((mode) =>
      mode === 'standard' ? 'reduced-effects' : 'standard',
    )
  }, [enabled, recorder])
  const callbacks = useMeasuredDragCallbacks(
    input,
    enabled,
    recorder,
    renderingMode,
  )
  return { enabled, report, toggle, renderingMode, toggleEffects, ...callbacks }
}
