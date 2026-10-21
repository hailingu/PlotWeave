import { Component, type ErrorInfo, type ReactNode } from 'react'
import './editorRegionBoundary.css'
import { createDiagnostic } from '../diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  editorRegionRenderFailed: createDiagnostic(
    'ERROR',
    'plotweave::frontend::editor',
    'EDITOR_REGION_RENDER_FAILED',
  ),
}

/** 编辑器独立展示域；文档、历史与保存所有者必须位于边界之外。 */
type EditorRegion = 'left' | 'canvas' | 'right' | 'overlays'

/** 失败区域的手动恢复入口，不自动重放动作或随文档更新重试。 */
interface RegionBoundaryProps {
  readonly region: EditorRegion
  readonly children: ReactNode
  /** 上层持有的读写诊断在失败子树卸载后仍随最新状态显示。 */
  readonly persistentError?: string | null
  /** 重试前结束已卸载的区域模态会话；不修改文档。 */
  readonly beforeRetry?: () => void
  /** 浮层关闭时清理所有者持有的挂载标记。 */
  readonly onDismiss?: () => void
}

const REGION_LABELS: Readonly<Record<EditorRegion, string>> = {
  left: '左侧面板',
  canvas: '画布',
  right: '右侧面板',
  overlays: '浮层',
}

/** 隔离展示子树的渲染异常；正常路径不添加 DOM，也不拥有业务状态。 */
class RegionFailureBoundary extends Component<
  RegionBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false }

  /** 不依赖抛出值的真假性；任何被 React 捕获的渲染失败都显示降级界面。 */
  static getDerivedStateFromError() {
    return { failed: true }
  }

  /** 保留原始错误对象与完整组件栈，同时标识具体失败区域。 */
  componentDidCatch(error: unknown, info: ErrorInfo) {
    logEvents.editorRegionRenderFailed(
      '[PlotWeave] 区域渲染失败',
      { code: 'EDITOR_REGION_RENDER_FAILED', region: this.props.region },
      error,
      info.componentStack,
    )
  }

  /** 只重挂当前展示域；已卸载的模态会话先由其所有者清理。 */
  private readonly retry = () => {
    this.props.beforeRetry?.()
    this.setState({ failed: false })
  }

  /** 用户显式关闭失败浮层时同步释放其上层模态标记。 */
  private readonly dismiss = () => {
    this.props.onDismiss?.()
    this.setState({ failed: false })
  }

  /** 隐藏的原生 AI 展示域同样返回可见错误，避免无声失去能力。 */
  render() {
    if (!this.state.failed) return this.props.children
    const { region, onDismiss, persistentError } = this.props
    const label = REGION_LABELS[region]
    return (
      <div
        className={`editor-region-error editor-region-error--${region}`}
        role="alert"
      >
        <b>{label}暂时不可用</b>
        <p>此区域的界面发生错误。重试会重新打开此区域。</p>
        {persistentError != null && <p>{persistentError}</p>}
        <button type="button" onClick={this.retry} aria-label={`重试${label}`}>
          重试此区域
        </button>
        {onDismiss && (
          <button type="button" onClick={this.dismiss}>
            关闭浮层
          </button>
        )}
      </div>
    )
  }
}

/** 项目身份切换才自动清除失败状态；普通编辑/保存更新保留手动恢复语义。 */
export function EditorRegionBoundary({
  projectId,
  ...props
}: RegionBoundaryProps & { readonly projectId: string }) {
  return <RegionFailureBoundary key={projectId} {...props} />
}
