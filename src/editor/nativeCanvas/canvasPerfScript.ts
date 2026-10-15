/**
 * M15 脚本化持续操作驱动（docs/swiftui-react-flow-migration-plan.md §7.2，
 * issue #523）：在已挂载的画布页面上按固定脚本派生真实鼠标/滚轮事件，
 * 驱动 React Flow 的拖拽、平移、缩放与画布控件，并采样 rAF 帧间隔、
 * 长任务与操作效果；拖拽目标优先选视口内可见节点，保证测量代表用户
 * 可执行的交互。报告只含数值统计（脱敏），不携带节点 id 或文案；
 * 由验证页（#perf:N）装配并经 `window.__pwRunCanvasPerf` 供宿主调用。
 */

/** 一轮脚本运行的参数：步数与节奏决定时长，全部显式无默认值。 */
export interface CanvasPerfScriptOptions {
  dragRounds: number
  dragSteps: number
  panRounds: number
  panSteps: number
  zoomRounds: number
  zoomSteps: number
  stepMs: number
  settleMs: number
}

/** 帧间隔统计；无样本时平均值与分位数为 null，其余字段仍有意义。 */
export interface CanvasPerfFrameStats {
  samples: number
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number
  over16Ms: number
  over33Ms: number
}

/** 单个操作阶段的帧统计与墙钟时长。 */
export interface CanvasPerfPhaseResult {
  kind: 'drag' | 'pan' | 'zoom' | 'panel'
  wallMs: number
  frames: CanvasPerfFrameStats
}

/** 宿主可见的脱敏测量结果；数值以外只有规模与视口事实。 */
export interface CanvasPerfScriptResult {
  version: 1
  nodeCount: number
  edgeCount: number
  visibleNodeCount: number
  viewport: { width: number; height: number; devicePixelRatio: number }
  phases: CanvasPerfPhaseResult[]
  total: CanvasPerfFrameStats
  effects: {
    draggedNodeMovedPx: number
    panTranslatePx: number
    zoomTravel: number
  }
  longTasks: { samples: number; totalMs: number; maxMs: number } | null
  durationMs: number
}

/** 携带宿主调用入口的窗口形状（验证页装配，页面生命周期内常驻）。 */
type CanvasPerfRunnerWindow = Window & {
  __pwRunCanvasPerf?: (
    options: CanvasPerfScriptOptions,
  ) => Promise<CanvasPerfScriptResult>
}

/** 帧样本：时间戳与相邻帧间隔；只在脚本运行期存在。 */
interface FrameSample {
  at: number
  dt: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 目标元素缺失是脚本前置条件破坏，显式失败而不是静默空转。 */
function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) throw new Error(`PW_PERF_TARGET_MISSING: ${selector}`)
  return element
}

/** 解析 React Flow 视口变换（translate(Xpx, Ypx) scale(Z)）。 */
function viewportTransform(): { x: number; y: number; z: number } {
  const transform = requireElement('.react-flow__viewport').style.transform
  // 无布局环境（happy-dom）可能产出 NaN 分量；按原样解析，由消费方过滤。
  const match =
    /translate\((-?(?:[\d.]+|NaN))px,\s*(-?(?:[\d.]+|NaN))px\)\s*scale\(([\d.]+|NaN)\)/.exec(
      transform,
    )
  if (!match)
    throw new Error(
      `PW_PERF_VIEWPORT_TRANSFORM_UNPARSED: ${transform || 'empty'}`,
    )
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }
}

/** 无样本的帧统计骨架。 */
function emptyStats(): CanvasPerfFrameStats {
  return {
    samples: 0,
    avgMs: null,
    p50Ms: null,
    p95Ms: null,
    maxMs: 0,
    over16Ms: 0,
    over33Ms: 0,
  }
}

/** 按时间窗过滤帧样本并计算统计；分位数取最近秩，空窗保持 null。 */
function statsFor(
  samples: FrameSample[],
  from: number,
  to: number,
): CanvasPerfFrameStats {
  const stats = emptyStats()
  const windowDeltas: number[] = []
  for (const sample of samples) {
    if (sample.at < from || sample.at >= to) continue
    windowDeltas.push(sample.dt)
    stats.samples += 1
    stats.maxMs = Math.max(stats.maxMs, sample.dt)
    if (sample.dt > 16) stats.over16Ms += 1
    if (sample.dt > 33) stats.over33Ms += 1
  }
  if (windowDeltas.length === 0) return stats
  const total = windowDeltas.reduce((sum, value) => sum + value, 0)
  stats.avgMs = total / windowDeltas.length
  const sorted = [...windowDeltas].sort((a, b) => a - b)
  stats.p50Ms =
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.5) - 1)] ??
    null
  stats.p95Ms =
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ??
    null
  return stats
}

/** rAF 帧采样器：立即启动，stop 返回全部样本并停止调度。 */
function startFrameSampler(): { stop: () => FrameSample[] } {
  const samples: FrameSample[] = []
  let previousAt = performance.now()
  let frameId = 0
  let stopped = false
  const tick = (at: number): void => {
    if (stopped) return
    samples.push({ at, dt: Math.max(0, at - previousAt) })
    previousAt = at
    frameId = requestAnimationFrame(tick)
  }
  frameId = requestAnimationFrame(tick)
  return {
    stop: () => {
      stopped = true
      cancelAnimationFrame(frameId)
      return samples
    },
  }
}

/** 长任务观察器：不支持或注册失败时能力字段整体为 null。 */
function startLongTaskObserver(): {
  stop: () => { samples: number; totalMs: number; maxMs: number } | null
} {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    return { stop: () => null }
  }
  const entries: PerformanceEntry[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      entries.push(...list.getEntries())
    })
    observer.observe({ type: 'longtask' })
  } catch {
    observer?.disconnect()
    return { stop: () => null }
  }
  return {
    stop: () => {
      entries.push(...observer!.takeRecords())
      observer!.disconnect()
      if (entries.length === 0) return { samples: 0, totalMs: 0, maxMs: 0 }
      return {
        samples: entries.length,
        totalMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
        maxMs: entries.reduce((max, entry) => Math.max(max, entry.duration), 0),
      }
    },
  }
}

/** 派生真实鼠标事件；与用户手势同源事件模型，React Flow 正常消费。 */
function fireMouse(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  buttons: number,
): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
    }),
  )
}

/** 节点矩形与窗口视口相交（§7.2 记录口径：可见节点数与视口）。 */
function intersectsViewport(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

/** 与窗口视口相交的节点数（§7.2 记录口径：可见节点数与视口）。 */
function countVisibleNodes(): number {
  let count = 0
  for (const node of document.querySelectorAll<HTMLElement>(
    '.react-flow__node',
  )) {
    if (intersectsViewport(node.getBoundingClientRect())) count += 1
  }
  return count
}

/**
 * 拖拽目标：优先取与视口相交的节点——夹具远宽于视口且 fitView 受默认
 * minZoom 限制时，DOM 首个节点可能在屏外；直接对屏外元素派发事件绕过了
 * 命中测试，不能代表用户可执行的交互（issue #523 评审 5521422435）。
 * 无布局环境（happy-dom，全部矩形为零）回退到首个节点。
 */
function selectDragTargetNode(): HTMLElement {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('.react-flow__node'),
  )
  const visible = nodes.find((node) =>
    intersectsViewport(node.getBoundingClientRect()),
  )
  const target = visible ?? nodes[0]
  if (!target) throw new Error('PW_PERF_TARGET_MISSING: .react-flow__node')
  return target
}

/** 解析节点自身的 inline 位移（translate(Xpx, Ypx)）；状态驱动，不依赖布局。 */
function elementTranslate(element: HTMLElement): { x: number; y: number } {
  const match =
    /translate\((-?(?:[\d.]+|NaN))px,\s*(-?(?:[\d.]+|NaN))px\)/.exec(
      element.style.transform,
    )
  if (!match) return { x: Number.NaN, y: Number.NaN }
  return { x: Number(match[1]), y: Number(match[2]) }
}

/** 拖拽阶段：按下节点→逐步移动→松手；返回节点位移（px，图坐标）。
 * 每轮重取节点矩形：上一轮拖动已移动节点，旧坐标处再按下会再次绕过
 * 命中测试（PR #574 评审）。 */
async function dragPhase(options: CanvasPerfScriptOptions): Promise<number> {
  const node = selectDragTargetNode()
  const before = elementTranslate(node)
  const stepPx = 12
  for (let round = 0; round < options.dragRounds; round += 1) {
    const rect = node.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    const startY = rect.top + rect.height / 2
    fireMouse(node, 'mousedown', startX, startY, 1)
    for (let step = 1; step <= options.dragSteps; step += 1) {
      fireMouse(
        window,
        'mousemove',
        startX + step * stepPx,
        startY + step * 2,
        1,
      )
      await sleep(options.stepMs)
    }
    const endX = startX + options.dragSteps * stepPx
    const endY = startY + options.dragSteps * 2
    fireMouse(window, 'mouseup', endX, endY, 0)
    await sleep(options.settleMs)
  }
  const after = elementTranslate(node)
  if (!Number.isFinite(before.x) || !Number.isFinite(after.x)) return 0
  return Math.hypot(after.x - before.x, after.y - before.y)
}

/** 平移阶段：按下画布底板→反向移动→松手；返回视口平移距离（px）。 */
async function panPhase(options: CanvasPerfScriptOptions): Promise<number> {
  const pane = requireElement('.react-flow__pane')
  const rect = pane.getBoundingClientRect()
  const startX = rect.left + rect.width / 2
  const startY = rect.top + rect.height / 2
  const before = viewportTransform()
  const stepPx = 14
  for (let round = 0; round < options.panRounds; round += 1) {
    fireMouse(pane, 'mousedown', startX, startY, 1)
    for (let step = 1; step <= options.panSteps; step += 1) {
      fireMouse(
        window,
        'mousemove',
        startX - step * stepPx,
        startY - step * 4,
        1,
      )
      await sleep(options.stepMs)
    }
    const endX = startX - options.panSteps * stepPx
    const endY = startY - options.panSteps * 4
    fireMouse(window, 'mouseup', endX, endY, 0)
    await sleep(options.settleMs)
  }
  const after = viewportTransform()
  return Math.hypot(after.x - before.x, after.y - before.y)
}

/** 缩放阶段：滚轮正负交替；返回缩放行程（逐步 |Δscale| 累计）。 */
async function zoomPhase(options: CanvasPerfScriptOptions): Promise<number> {
  const pane = requireElement('.react-flow__pane')
  const rect = pane.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  let previous = viewportTransform().z
  let travel = 0
  for (let round = 0; round < options.zoomRounds; round += 1) {
    for (let step = 0; step < options.zoomSteps; step += 1) {
      pane.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          deltaY: step % 2 === 0 ? -120 : 120,
        }),
      )
      await sleep(options.stepMs)
      const current = viewportTransform().z
      if (Number.isFinite(previous) && Number.isFinite(current)) {
        travel += Math.abs(current - previous)
      }
      previous = current
    }
    await sleep(options.settleMs)
  }
  return travel
}

/** 画布控件阶段：依次点击控件按钮（页面内面板操作）。 */
async function panelPhase(options: CanvasPerfScriptOptions): Promise<void> {
  const buttons = document.querySelectorAll<HTMLElement>(
    '.react-flow__controls-button',
  )
  for (const button of buttons) {
    button.click()
    await sleep(options.settleMs)
  }
}

/** 执行整段脚本并返回脱敏报告；前置条件破坏显式抛出稳定错误码。 */
export async function runCanvasPerfScript(
  options: CanvasPerfScriptOptions,
): Promise<CanvasPerfScriptResult> {
  const startedAt = performance.now()
  const nodes = document.querySelectorAll('.react-flow__node').length
  const edges = document.querySelectorAll('.react-flow__edge').length
  if (nodes === 0) throw new Error('PW_PERF_CANVAS_NOT_MOUNTED')
  const sampler = startFrameSampler()
  const longTasks = startLongTaskObserver()
  const phaseBounds: Array<{
    kind: CanvasPerfPhaseResult['kind']
    from: number
  }> = []
  const effects = { draggedNodeMovedPx: 0, panTranslatePx: 0, zoomTravel: 0 }
  let samples: FrameSample[] = []
  let taskStats: CanvasPerfScriptResult['longTasks'] = null

  // finally 单点回收采样资源：异常路径同样不留常驻 rAF/observer。
  try {
    phaseBounds.push({ kind: 'drag', from: performance.now() })
    effects.draggedNodeMovedPx = await dragPhase(options)
    phaseBounds.push({ kind: 'pan', from: performance.now() })
    effects.panTranslatePx = await panPhase(options)
    phaseBounds.push({ kind: 'zoom', from: performance.now() })
    effects.zoomTravel = await zoomPhase(options)
    phaseBounds.push({ kind: 'panel', from: performance.now() })
    await panelPhase(options)
  } finally {
    samples = sampler.stop()
    taskStats = longTasks.stop()
  }

  const endAt = performance.now()
  const phases: CanvasPerfPhaseResult[] = []
  for (let index = 0; index < phaseBounds.length; index += 1) {
    const bound = phaseBounds[index]
    if (!bound) continue
    const to =
      index + 1 < phaseBounds.length
        ? (phaseBounds[index + 1]?.from ?? endAt)
        : endAt
    phases.push({
      kind: bound.kind,
      wallMs: to - bound.from,
      frames: statsFor(samples, bound.from, to),
    })
  }
  return {
    version: 1,
    nodeCount: nodes,
    edgeCount: edges,
    visibleNodeCount: countVisibleNodes(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    phases,
    total: statsFor(samples, startedAt, endAt),
    effects,
    longTasks: taskStats,
    durationMs: endAt - startedAt,
  }
}

/** 验证页装配宿主调用入口；重复装配覆盖前一个引用，不产生第二会话。 */
export function installCanvasPerfScriptRunner(): void {
  ;(window as CanvasPerfRunnerWindow).__pwRunCanvasPerf = (options) =>
    runCanvasPerfScript(options)
}
