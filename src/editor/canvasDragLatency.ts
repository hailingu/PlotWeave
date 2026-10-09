/** 只读主拖动节点的内联 transform；固定空间区分事件回调与 DOM 追赶，未测屏幕绘制。 */

/** 常量空间的有效计时；无效事件时间单独计数，不伪装为零延迟。 */
interface Timing {
  samples: number
  totalMs: number
  maxMs: number
}

/** DOM 比较只暂存当前坐标，不输出坐标、事件、节点或内容。 */
interface Position {
  readonly x: number
  readonly y: number
}

/** 数值报告的输入层和 DOM 层独立；DOM 匹配没有绘制完成的含义。 */
export interface CanvasDragLatencyReport {
  input:
    | (Timing & {
        events: number
        invalidTimestamps: number
        over32Ms: number
        intervals: Timing & { over32Ms: number }
      })
    | null
  dom: {
    updates: number
    superseded: number
    matched: Timing
    frameSamples: number
    behindFrames: number
    unreadableFrames: number
    maxPositionGap: number
    pendingAtStop: boolean
  } | null
}

/** 独立新段不复用可变汇总对象。 */
function timing(): Timing {
  return { samples: 0, totalMs: 0, maxMs: 0 }
}

/** 调用方筛选有效时钟后再累加。 */
function addTiming(summary: Timing, duration: number): void {
  summary.samples += 1
  summary.totalMs += duration
  summary.maxMs = Math.max(summary.maxMs, duration)
}

/** 读内联属性避免 getComputedStyle／几何查询；仅支持平面平移。 */
function readPosition(element: HTMLElement | null): Position | null {
  if (!element?.isConnected || !element.style.transform) return null
  try {
    const matrix = new DOMMatrixReadOnly(element.style.transform)
    if (
      !matrix.is2D ||
      matrix.a !== 1 ||
      matrix.b !== 0 ||
      matrix.c !== 0 ||
      matrix.d !== 1 ||
      !Number.isFinite(matrix.e) ||
      !Number.isFinite(matrix.f)
    )
      return null
    return { x: matrix.e, y: matrix.f }
  } catch {
    return null
  }
}

/** 一段仅拥有一个 DOM observer，结束即清除元素、事件与坐标引用。 */
class CanvasDragLatency {
  private readonly input = {
    ...timing(),
    events: 0,
    invalidTimestamps: 0,
    over32Ms: 0,
    intervals: { ...timing(), over32Ms: 0 },
  }
  private readonly report: CanvasDragLatencyReport = { input: null, dom: null }
  private observer: MutationObserver | null = null
  private expected: Position | null = null
  private pendingAt: number | null = null
  private lastEvent: MouseEvent | TouchEvent | null = null
  private previousEventAt: number | null = null
  private closed = false

  /** 缺失或不支持的 DOM 能力明确降级，输入采样仍然可用。 */
  constructor(private element: HTMLElement | null) {
    if (
      !element ||
      typeof MutationObserver === 'undefined' ||
      typeof DOMMatrixReadOnly === 'undefined' ||
      !readPosition(element)
    )
      return
    try {
      this.observer = new MutationObserver(() => {
        if (!this.closed) this.match()
      })
      this.observer.observe(element, {
        attributes: true,
        attributeFilter: ['style'],
      })
      this.report.dom = {
        updates: 0,
        superseded: 0,
        matched: timing(),
        frameSamples: 0,
        behindFrames: 0,
        unreadableFrames: 0,
        maxPositionGap: 0,
        pendingAtStop: false,
      }
    } catch {
      this.observer?.disconnect()
      this.observer = null
      console.warn('[CanvasPerf]', { code: 'DOM_LATENCY_OBSERVER_UNAVAILABLE' })
    }
  }

  /** auto-pan 复用源事件只计一次输入，但每次新位置都更新 DOM 期望。 */
  move(event: MouseEvent | TouchEvent, position: Position): void {
    if (this.closed) return
    const at = performance.now()
    this.recordInput(event, at)
    const dom = this.report.dom
    if (!dom || !Number.isFinite(position.x) || !Number.isFinite(position.y))
      return
    this.match()
    if (this.pendingAt !== null) dom.superseded += 1
    dom.updates += 1
    this.expected = { x: position.x, y: position.y }
    this.pendingAt = at
    this.match()
  }

  /** 每次已有 rAF 比较最新主节点坐标；位置差使用画布单位，未转换为屏幕像素。 */
  frame(): void {
    if (this.closed || !this.expected || !this.report.dom) return
    const actual = readPosition(this.element)
    const dom = this.report.dom
    if (!actual) {
      dom.unreadableFrames += 1
      return
    }
    dom.frameSamples += 1
    const gap = Math.hypot(
      actual.x - this.expected.x,
      actual.y - this.expected.y,
    )
    dom.maxPositionGap = Math.max(dom.maxPositionGap, gap)
    if (gap > 0.01) dom.behindFrames += 1
    this.match()
  }

  /** 排空末批通知并读取当前样式，未匹配终帧明确报告；重复结束不再变更数据。 */
  finish(): CanvasDragLatencyReport {
    if (!this.closed) {
      this.observer?.takeRecords()
      this.match()
      if (this.report.dom && this.expected) {
        const actual = readPosition(this.element)
        this.report.dom.pendingAtStop =
          !actual ||
          Math.hypot(actual.x - this.expected.x, actual.y - this.expected.y) >
            0.01
      }
      this.dispose()
    }
    return this.report
  }

  /** 静默卸载，过期观察通知不得改写已发布报告。 */
  dispose(): void {
    this.closed = true
    this.observer?.disconnect()
    this.observer = null
    this.element = null
    this.lastEvent = null
    this.expected = null
    this.pendingAt = null
  }

  /** 只接受同一 performance 时间原点的事件；不推测 epoch 或硬件采样时间。 */
  private recordInput(event: MouseEvent | TouchEvent, at: number): void {
    if (event === this.lastEvent) return
    this.lastEvent = event
    this.report.input = this.input
    this.input.events += 1
    if (this.previousEventAt !== null) {
      const interval = Math.max(0, at - this.previousEventAt)
      addTiming(this.input.intervals, interval)
      if (interval > 32) this.input.intervals.over32Ms += 1
    }
    this.previousEventAt = at
    if (
      !Number.isFinite(event.timeStamp) ||
      event.timeStamp < 0 ||
      event.timeStamp > at
    ) {
      this.input.invalidTimestamps += 1
      return
    }
    const delay = at - event.timeStamp
    addTiming(this.input, delay)
    if (delay > 32) this.input.over32Ms += 1
  }

  /** observer／刷新／下一回调共同识别匹配，首次匹配后不能重复计时。 */
  private match(): void {
    if (this.pendingAt === null || !this.expected || !this.report.dom) return
    const actual = readPosition(this.element)
    if (
      !actual ||
      Math.hypot(actual.x - this.expected.x, actual.y - this.expected.y) > 0.01
    )
      return
    addTiming(
      this.report.dom.matched,
      Math.max(0, performance.now() - this.pendingAt),
    )
    this.pendingAt = null
  }
}

/** 每个拖动段创建独立输入／DOM 采样器；只有受支持的主节点才注册观察器。 */
export function createCanvasDragLatency(element: HTMLElement | null) {
  return new CanvasDragLatency(element)
}
