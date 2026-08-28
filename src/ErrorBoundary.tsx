import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 应用级错误边界：渲染崩溃时显示错误与重载入口，而不是无声黑屏。
 * 错误同时打 console（开发期 devtools 可见），不隐瞒失败。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PlotWeave] 界面崩溃', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen" role="alert">
          <b>界面出错了</b>
          <pre>{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
