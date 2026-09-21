// @vitest-environment happy-dom
/**
 * 应用级错误边界测试（issue #233）：
 * 正常子树直通、子树渲染抛错后 role=alert 降级界面（含堆栈缺失回退）、
 * componentDidCatch 的结构化上下文日志，以及重载按钮触发
 * window.location.reload。只断言用户可见状态与日志上下文，
 * 不打印真实用户数据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

/** 定向抛错的子树：boom 非空时在渲染期抛出该错误实例。 */
function Bomb({ boom }: { boom: Error | null }) {
  if (boom) throw boom
  return <p>正常子树</p>
}

/** 抑制 React/边界在崩溃用例中的控制台噪音，返回 error 调用记录。 */
function spyConsoleError() {
  const calls: unknown[][] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    calls.push(args)
  })
  return { spy, calls }
}

/** 从 console.error 记录中取出边界的结构化日志调用。 */
function boundaryLogCall(calls: unknown[][]) {
  return calls.find(([prefix]) => prefix === '[PlotWeave] 界面崩溃')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary（渲染崩溃降级与重载）', () => {
  it('正常子树直通：不出现降级界面', () => {
    render(
      <ErrorBoundary>
        <Bomb boom={null} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('正常子树')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('子树渲染抛错：显示 role=alert 降级界面与堆栈，子树不再渲染', () => {
    const { spy, calls } = spyConsoleError()
    render(
      <ErrorBoundary>
        <Bomb boom={new Error('渲染崩溃')} />
      </ErrorBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('界面出错了')
    expect(alert.querySelector('pre')?.textContent).toContain('渲染崩溃')
    expect(alert.querySelector('pre')?.textContent).toMatch(/at |in /)
    expect(screen.queryByText('正常子树')).toBeNull()
    expect(boundaryLogCall(calls)).toBeTruthy()
    spy.mockRestore()
  })

  it('componentDidCatch 结构化日志：前缀、错误实例与组件栈上下文', () => {
    const boom = new Error('渲染崩溃')
    const { spy, calls } = spyConsoleError()
    render(
      <ErrorBoundary>
        <Bomb boom={boom} />
      </ErrorBoundary>,
    )
    const call = boundaryLogCall(calls)
    expect(call).toBeTruthy()
    expect(call![1]).toBe(boom)
    expect(call![2]).toEqual(expect.stringContaining('Bomb'))
    spy.mockRestore()
  })

  it('堆栈缺失：降级界面回退显示 String(error) 消息', () => {
    const boom = new Error('无栈崩溃')
    delete boom.stack
    const { spy } = spyConsoleError()
    render(
      <ErrorBoundary>
        <Bomb boom={boom} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert').querySelector('pre')?.textContent).toBe(
      'Error: 无栈崩溃',
    )
    spy.mockRestore()
  })

  it('点击重新加载：触发一次 window.location.reload', () => {
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {})
    const { spy } = spyConsoleError()
    render(
      <ErrorBoundary>
        <Bomb boom={new Error('渲染崩溃')} />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(reload).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
