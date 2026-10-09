/** 诊断开关与段末报告；复用 React Flow 控件，提供原生 WebView 内的可见证据。 */
import { memo } from 'react'
import { Panel } from '@xyflow/react'
import type { CanvasPerformanceReport } from './canvasPerformance'
import './canvasPerformance.css'

/** 标准控制按钮，不另注册快捷键或拦截节点手势。 */
export function CanvasPerformanceToggle({
  enabled,
  onToggle,
}: {
  readonly enabled: boolean
  readonly onToggle: () => void
}) {
  const label = `性能诊断：${enabled ? '开' : '关'}`
  return (
    <button
      type="button"
      className="react-flow__controls-button canvas-performance-toggle"
      aria-label={label}
      title={label}
      aria-pressed={enabled}
      onClick={onToggle}
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
        <path d="M3 12h4l3-7 4 14 3-7h4" />
      </svg>
    </button>
  )
}

/** 无样本不显示零耗时；生产 profiling 是独立构建选择。 */
function renderTiming(timing: CanvasPerformanceReport['react']): string {
  return timing
    ? `${timing.samples} 次提交 · 最大 ${timing.maxMs.toFixed(1)}ms`
    : '未采到（可使用 profiling 构建）'
}

/** 整体包含画布，不将两层耗时相加；演示页仅拥有画布边界。 */
function ReactPerformanceSummary({
  report,
}: {
  readonly report: CanvasPerformanceReport
}) {
  return (
    <>
      {report.canvas === 'editor' && (
        <p>React 整体 {renderTiming(report.reactEditor)}</p>
      )}
      <p>React 画布 {renderTiming(report.react)}</p>
    </>
  )
}

/** 分开显示事件到回调和回调到 DOM；无有效时钟样本不显示零延迟。 */
function DragLatencySummary({
  report,
}: {
  readonly report: CanvasPerformanceReport
}) {
  const input = report.input
  const dom = report.dom
  return (
    <>
      <p>
        输入到回调最大{' '}
        {input?.samples ? `${input.maxMs.toFixed(1)}ms` : '未采到'}
      </p>
      <p>
        回调到 DOM 最大{' '}
        {dom?.matched.samples ? `${dom.matched.maxMs.toFixed(1)}ms` : '未采到'}
      </p>
      {dom && (
        <p>
          DOM 落后 {dom.behindFrames}/{dom.frameSamples} 次刷新采样 · 最大差{' '}
          {dom.maxPositionGap.toFixed(1)} 画布单位
          {dom.pendingAtStop && ' · 松手时仍待匹配'}
        </p>
      )}
    </>
  )
}

/** 面板只依赖开关和最近报告，节点位置帧不能带来 JSON 序列化工作。 */
function CanvasPerformancePanelImpl({
  enabled,
  report,
  renderingMode,
  onToggleEffects,
}: {
  readonly enabled: boolean
  readonly report: CanvasPerformanceReport | null
  readonly renderingMode: CanvasPerformanceReport['renderingMode']
  readonly onToggleEffects: () => void
}) {
  if (!enabled) return null
  return (
    <Panel
      position="top-right"
      className="canvas-performance nodrag nopan nowheel"
    >
      <section aria-label="画布性能诊断">
        <strong>画布性能诊断</strong>
        <CanvasEffectsToggle mode={renderingMode} onToggle={onToggleEffects} />
        {report ? (
          <>
            <p>
              拖动 {report.durationMs.toFixed(1)}ms · {report.draggedNodeCount}/
              {report.nodeCount} 节点 · {report.edgeCount} 连线
            </p>
            <p>
              本次特效：{report.renderingMode === 'standard' ? '标准' : '简化'}
            </p>
            <p>
              更新 {report.handler.samples} 批 · 同步最大{' '}
              {report.handler.maxMs.toFixed(1)}ms
            </p>
            <p>
              帧间隔最大{' '}
              {report.frames.samples
                ? `${report.frames.maxMs.toFixed(1)}ms`
                : '未采到'}{' '}
              · 超过 32ms：{report.frames.over32Ms}
            </p>
            <ReactPerformanceSummary report={report} />
            <DragLatencySummary report={report} />
            <details>
              <summary>查看 / 复制 JSON</summary>
              <pre aria-label="拖动性能 JSON">
                {JSON.stringify(report, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <p>拖动节点并松手后显示报告。</p>
        )}
      </section>
    </Panel>
  )
}

/** 可撤销的绘制对照；只改变当前画布特效，不修改几何或业务状态。 */
function CanvasEffectsToggle({
  mode,
  onToggle,
}: {
  readonly mode: CanvasPerformanceReport['renderingMode']
  readonly onToggle: () => void
}) {
  const reduced = mode === 'reduced-effects'
  return (
    <p>
      <button
        type="button"
        className="canvas-effects-toggle"
        aria-pressed={reduced}
        onClick={onToggle}
        title="简化节点阴影、内容过渡与控件背景模糊"
      >
        绘制特效：{reduced ? '简化' : '标准'}
      </button>
    </p>
  )
}

/** memo 确保拖动热路径不重复绘制诊断报告。 */
export const CanvasPerformancePanel = memo(CanvasPerformancePanelImpl)
