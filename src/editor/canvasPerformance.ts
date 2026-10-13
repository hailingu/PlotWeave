/** 单个画布挂载会话的有界拖动采样；只汇总数值，不接触文档内容或标识。 */
import type { NodeChange } from '@xyflow/react'
import {
  createCanvasDragLatency,
  type CanvasDragLatencyReport,
} from './canvasDragLatency'

/** 时间样本的常量空间汇总，避免逐帧存储或排序。 */
interface TimingSummary {
  samples: number
  totalMs: number
  maxMs: number
}

/** 拖动开始时的图规模快照，采样器不持有节点或边。 */
interface CanvasSize {
  nodeCount: number
  edgeCount: number
  draggedNodeCount: number
}

/** 消费者可见的脱敏报告；null 明确表示能力不可用或没有 React 样本。 */
export interface CanvasPerformanceReport extends CanvasSize {
  version: 5
  canvas: 'editor' | 'demo'
  renderingMode: 'standard' | 'reduced-effects'
  outcome: 'completed' | 'interrupted' | 'disabled'
  durationMs: number
  handlerFailures: number
  changes: Record<NodeChange['type'], number>
  handler: TimingSummary
  frames: TimingSummary & { over32Ms: number }
  react: (TimingSummary & { maxBaseMs: number }) | null
  reactEditor: (TimingSummary & { maxBaseMs: number }) | null
  longTasks: TimingSummary | null
  input: CanvasDragLatencyReport['input']
  dom: CanvasDragLatencyReport['dom']
  /** 仅开始回调的阶段计时；首位置包含后续用户停顿，不等同 CPU 耗时。 */
  startup: {
    inputDelayMs: number | null
    diagnosticsMs: number
    handlerMs: number
    firstPositionMs: number | null
  } | null
}

/** 一段采样独占其 rAF 与 observer，过期回调通过会话身份隔离。 */
interface DragSession {
  report: CanvasPerformanceReport
  startedAt: number
  previousFrameAt: number
  frameId: number | null
  observer: PerformanceObserver | null
  latency: ReturnType<typeof createCanvasDragLatency>
  startupAt: number | null
}

/** 创建无样本的时间汇总。 */
function timing(): TimingSummary {
  return { samples: 0, totalMs: 0, maxMs: 0 }
}

/** 累加有效的单个时间样本；未知或异常时钟值不污染报告。 */
function addTiming(summary: TimingSummary, duration: number): void {
  if (!Number.isFinite(duration) || duration < 0) return
  summary.samples += 1
  summary.totalMs += duration
  summary.maxMs = Math.max(summary.maxMs, duration)
}

/** 从固定字段构建新段，避免跨段复用可变计数或内容。 */
function newReport(
  canvas: CanvasPerformanceReport['canvas'],
  size: CanvasSize,
  renderingMode: CanvasPerformanceReport['renderingMode'],
): CanvasPerformanceReport {
  return {
    version: 5,
    canvas,
    renderingMode,
    nodeCount: size.nodeCount,
    edgeCount: size.edgeCount,
    draggedNodeCount: size.draggedNodeCount,
    outcome: 'completed',
    durationMs: 0,
    handlerFailures: 0,
    changes: {
      position: 0,
      dimensions: 0,
      select: 0,
      add: 0,
      remove: 0,
      replace: 0,
    },
    handler: timing(),
    frames: { ...timing(), over32Ms: 0 },
    react: null,
    reactEditor: null,
    longTasks: null,
    input: null,
    dom: null,
    startup: null,
  }
}

/** 只计与当前拖动时间范围相交的长任务，包含 observer 尚未投递的末批。 */
function recordLongTasks(
  session: DragSession,
  entries: PerformanceEntry[],
): void {
  const summary = session.report.longTasks
  if (!summary) return
  const end = performance.now()
  for (const entry of entries) {
    if (
      entry.startTime + entry.duration <= session.startedAt ||
      entry.startTime >= end
    )
      continue
    addTiming(summary, entry.duration)
  }
}

/** 实例仅由使用它的画布 hook 持有，所有资源随挂载生命周期释放。 */
class CanvasPerformanceRecorder {
  private session: DragSession | null = null
  private readonly measureName: string

  /** 发布器只在一段结束时调用，热路径不触发 React 状态更新或 console。 */
  constructor(
    private readonly canvas: CanvasPerformanceReport['canvas'],
    private readonly publish: (report: CanvasPerformanceReport) => void,
  ) {
    this.measureName = `plotweave.canvas.node-drag.${canvas}`
  }

  /** 开始独立拖动；异常重入先结束旧段，避免资源与样本串段。 */
  start(
    size: CanvasSize,
    renderingMode: CanvasPerformanceReport['renderingMode'] = 'standard',
    primaryElement: HTMLElement | null = null,
  ): void {
    this.finish('interrupted')
    const startedAt = performance.now()
    const session: DragSession = {
      report: newReport(this.canvas, size, renderingMode),
      startedAt,
      previousFrameAt: startedAt,
      frameId: null,
      observer: null,
      latency: createCanvasDragLatency(primaryElement),
      startupAt: null,
    }
    this.session = session
    this.observeLongTasks(session)
    this.scheduleFrame(session)
  }

  /** hook 在业务 start 的 finally 中记录阶段，异常报告也保留耗时且不留源事件。 */
  recordStartup(
    eventAt: number,
    callbackAt: number,
    readyAt: number,
    handlerEndedAt: number,
  ): void {
    const session = this.session
    if (!session) return
    session.startupAt = callbackAt
    session.report.startup = {
      inputDelayMs:
        Number.isFinite(eventAt) && eventAt >= 0 && eventAt <= callbackAt
          ? callbackAt - eventAt
          : null,
      diagnosticsMs: Math.max(0, readyAt - callbackAt),
      handlerMs: Math.max(0, handlerEndedAt - readyAt),
      firstPositionMs: null,
    }
  }

  /** 框架拖动回调带来真实事件时间与最新坐标，只读主节点，不改变更新调度。 */
  drag(
    event: MouseEvent | TouchEvent,
    position: { x: number; y: number },
  ): void {
    const session = this.session
    if (!session) return
    if (session.report.startup && session.startupAt !== null) {
      session.report.startup.firstPositionMs ??= Math.max(
        0,
        performance.now() - session.startupAt,
      )
    }
    session.latency.move(event, position)
  }

  /** 同步计时保留原回调的结果与异常；没有活动段时完全直通。 */
  measureChanges(changes: NodeChange[], apply: () => void): void {
    const session = this.session
    if (!session) {
      apply()
      return
    }
    for (const change of changes) session.report.changes[change.type] += 1
    const startedAt = performance.now()
    try {
      apply()
    } catch (error) {
      session.report.handlerFailures += 1
      throw error
    } finally {
      addTiming(session.report.handler, performance.now() - startedAt)
    }
  }

  /** 两层 Profiler 分开汇总，嵌套时间不能相加；无活动段或回调时保持 null。 */
  render(
    actualDuration: number,
    baseDuration: number,
    scope: 'canvas' | 'editor' = 'canvas',
  ): void {
    const report = this.session?.report
    if (!report) return
    const key = scope === 'editor' ? 'reactEditor' : 'react'
    const summary = (report[key] ??= { ...timing(), maxBaseMs: 0 })
    addTiming(summary, actualDuration)
    summary.maxBaseMs = Math.max(summary.maxBaseMs, baseDuration)
  }

  /** 松手或中断时结束一次；重复结束不发布，诊断资源不进入下一段。 */
  finish(outcome: CanvasPerformanceReport['outcome']): void {
    const session = this.session
    if (!session) return
    session.report.durationMs = Math.max(
      0,
      performance.now() - session.startedAt,
    )
    session.report.outcome = outcome
    Object.assign(session.report, session.latency.finish())
    this.release(session)
    this.session = null
    this.writeMeasure(session)
    this.publish(session.report)
  }

  /** 卸载时静默取消，禁止向卸载消费者发布；允许 StrictMode 后重新挂载。 */
  dispose(): void {
    if (this.session) this.release(this.session)
    this.session = null
    this.clearMeasure()
  }

  /** rAF 只更新固定统计字段；会话身份拒绝取消后到达的旧回调。 */
  private scheduleFrame(session: DragSession): void {
    session.frameId = requestAnimationFrame((at) => {
      if (this.session !== session) return
      const interval = at - session.previousFrameAt
      addTiming(session.report.frames, interval)
      if (interval > 32) session.report.frames.over32Ms += 1
      session.previousFrameAt = at
      session.latency.frame()
      this.scheduleFrame(session)
    })
  }

  /** 可选 API 按能力探测；不支持或注册失败仅降级该字段。 */
  private observeLongTasks(session: DragSession): void {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('longtask')
    )
      return
    try {
      session.observer = new PerformanceObserver((list) => {
        if (this.session === session)
          recordLongTasks(session, list.getEntries())
      })
      session.observer.observe({ type: 'longtask' })
      session.report.longTasks = timing()
    } catch {
      session.observer?.disconnect()
      session.observer = null
      console.warn('[CanvasPerf]', { code: 'LONG_TASK_OBSERVER_UNAVAILABLE' })
    }
  }

  /** 结束前排空 observer，随后取消浏览器资源；不改变编辑器事件状态。 */
  private release(session: DragSession): void {
    session.latency.dispose()
    if (session.frameId !== null) cancelAnimationFrame(session.frameId)
    if (!session.observer) return
    recordLongTasks(session, session.observer.takeRecords())
    session.observer.disconnect()
  }

  /** 每个画布仅保留最新一条命名 measure，时间线能力失败不影响报告。 */
  private writeMeasure(session: DragSession): void {
    if (!this.clearMeasure()) return
    if (typeof performance.measure !== 'function') return
    try {
      performance.measure(this.measureName, {
        start: session.startedAt,
        duration: session.report.durationMs,
      })
    } catch {
      console.warn('[CanvasPerf]', { code: 'PERFORMANCE_MEASURE_UNAVAILABLE' })
    }
  }

  /** 只删除实例拥有的命名 measure，不清空其他性能记录。 */
  private clearMeasure(): boolean {
    if (typeof performance.clearMeasures !== 'function') return false
    try {
      performance.clearMeasures(this.measureName)
      return true
    } catch {
      console.warn('[CanvasPerf]', {
        code: 'PERFORMANCE_MEASURE_CLEANUP_UNAVAILABLE',
      })
      return false
    }
  }
}

/** 为生产与演示入口创建各自的采样 owner，不引入全局可变单例。 */
export function createCanvasPerformanceRecorder(
  canvas: CanvasPerformanceReport['canvas'],
  publish: (report: CanvasPerformanceReport) => void,
) {
  return new CanvasPerformanceRecorder(canvas, publish)
}
