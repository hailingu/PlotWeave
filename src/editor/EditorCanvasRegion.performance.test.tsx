// @vitest-environment happy-dom
/** 诊断必须经真实 React Flow 手势输出脱敏报告，并保留坐标与撤销行为。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** 私密文本与标识作为哨兵，确保汇总仅允许数值和固定诊断字段。 */
const PROJECT: EditorProjectContent = {
  id: 'private-project-id',
  name: '私密项目标题',
  nodes: [
    {
      id: 'private-node-id',
      type: 'beat',
      position: { x: 0, y: 0 },
      width: 100,
      height: 80,
      data: { name: '私密剧本内容', tone: '平静' },
    },
  ],
  edges: [],
  settings: { characters: [], locations: [] },
  viewport: { x: 0, y: 0, zoom: 1 },
}

/** 用浏览器事件驱动 d3/React Flow 的真实拖动链路，不替换画布。 */
async function drag(container: HTMLElement, during?: () => void) {
  const node = container.querySelector<HTMLElement>('.react-flow__node')!
  fireEvent.mouseDown(node, {
    clientX: 10,
    clientY: 10,
    button: 0,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 12,
    clientY: 12,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseMove(window, {
    clientX: 49,
    clientY: 49,
    buttons: 1,
    view: window,
  })
  during?.()
  fireEvent.mouseUp(window, {
    clientX: 49,
    clientY: 49,
    button: 0,
    view: window,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  return node
}

describe('生产画布性能诊断', () => {
  it('拖动中切换特效不漏业务 stop，旧报告保留旧模式且历史仍整段一步', async () => {
    vi.useFakeTimers()
    const { container } = render(
      <EditorView
        project={PROJECT}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
    const node = await drag(container, () => {
      fireEvent.click(screen.getByRole('button', { name: '绘制特效：标准' }))
    })
    const report = JSON.parse(
      screen.getByLabelText('拖动性能 JSON').textContent!,
    )
    expect(report).toMatchObject({
      outcome: 'interrupted',
      renderingMode: 'standard',
    })
    expect(
      container
        .querySelector('.canvas-root')
        ?.getAttribute('data-canvas-effects'),
    ).toBe('reduced-effects')
    expect(node.style.transform).toBe('translate(44px,44px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node.style.transform).toBe('translate(0px,0px)')
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('绘制简化不重挂载或改变坐标与历史，关闭诊断恢复标准外观', async () => {
    vi.useFakeTimers()
    const { container } = render(
      <EditorView
        project={PROJECT}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={() => undefined}
      />,
    )
    const node = container.querySelector<HTMLElement>('.react-flow__node')!
    const root = container.querySelector('.canvas-root')!
    expect(root.getAttribute('data-canvas-effects')).toBe('standard')
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
    fireEvent.click(screen.getByRole('button', { name: '绘制特效：标准' }))
    expect(root.getAttribute('data-canvas-effects')).toBe('reduced-effects')
    expect(container.querySelector('.react-flow__node')).toBe(node)
    expect(node.style.transform).toBe('translate(0px,0px)')
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await drag(container)
    const report = JSON.parse(
      screen.getByLabelText('拖动性能 JSON').textContent!,
    )
    expect(report.renderingMode).toBe('reduced-effects')
    expect(node.style.transform).toBe('translate(44px,44px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node.style.transform).toBe('translate(0px,0px)')
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：开' }))
    expect(root.getAttribute('data-canvas-effects')).toBe('standard')
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
    expect(
      screen
        .getByRole('button', { name: '绘制特效：标准' })
        .getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('默认关闭时拖动不输出诊断；开关不改变当前节点或选中状态', async () => {
    vi.useFakeTimers()
    const logs = vi.spyOn(console, 'info')
    const { container } = render(
      <EditorView
        project={PROJECT}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={() => undefined}
      />,
    )
    const node = await drag(container)
    expect(node.style.transform).toBe('translate(44px,44px)')
    expect(screen.queryByLabelText('拖动性能 JSON')).toBeNull()
    expect(logs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
    expect(container.querySelector('.react-flow__node')).toBe(node)
    expect(node.classList.contains('selected')).toBe(true)
    expect(node.style.transform).toBe('translate(44px,44px)')
  })

  it('可开启诊断，松手输出一份脱敏报告且仍能一步撤销', async () => {
    vi.useFakeTimers()
    const { container } = render(
      <EditorView
        project={PROJECT}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={() => undefined}
      />,
    )
    const toggle = screen.getByRole('button', { name: '性能诊断：关' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    const logs = vi.spyOn(console, 'info')
    const node = await drag(container, () => {
      expect(screen.queryByLabelText('拖动性能 JSON')).toBeNull()
      expect(logs).not.toHaveBeenCalled()
    })
    expect(node.style.transform).toBe('translate(44px,44px)')
    const report = JSON.parse(
      screen.getByLabelText('拖动性能 JSON').textContent!,
    )
    expect(report).toMatchObject({
      nodeCount: 1,
      edgeCount: 0,
      draggedNodeCount: 1,
      outcome: 'completed',
    })
    expect(report.changes.position).toBeGreaterThan(0)
    expect(report.handler.samples).toBeGreaterThan(0)
    expect(report.input?.events).toBeGreaterThan(0)
    expect(report.dom?.updates).toBeGreaterThan(0)
    expect(report.version).toBe(5)
    expect(report.startup?.diagnosticsMs).toBeGreaterThanOrEqual(0)
    expect(report.startup?.handlerMs).toBeGreaterThanOrEqual(0)
    expect(report.startup?.firstPositionMs).toBeGreaterThanOrEqual(0)
    expect(screen.getByText(/诊断初始化/)).toBeTruthy()
    expect(report.react?.samples).toBeGreaterThan(0)
    expect(report.reactEditor?.samples).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toMatch(/private-|私密/)
    expect(logs).toHaveBeenCalledExactlyOnceWith('[CanvasPerf]', report)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node.style.transform).toBe('translate(0px,0px)')
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('多选拖动只输出一段报告，保留整组坐标和一步历史', async () => {
    vi.useFakeTimers()
    const initial = {
      ...PROJECT,
      nodes: [
        { ...PROJECT.nodes[0]!, selected: true },
        {
          ...PROJECT.nodes[0]!,
          id: 'b',
          selected: true,
          position: { x: 220, y: 220 },
        },
      ],
    }
    const { container } = render(
      <EditorView
        project={initial}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '性能诊断：关' }))
    await drag(container)
    const report = JSON.parse(
      screen.getByLabelText('拖动性能 JSON').textContent!,
    )
    expect(report).toMatchObject({ draggedNodeCount: 2, nodeCount: 2 })
    const positions = () =>
      [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map(
        (node) => node.style.transform,
      )
    expect(positions()).toEqual([
      'translate(44px,44px)',
      'translate(264px,264px)',
    ])
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(positions()).toEqual([
      'translate(0px,0px)',
      'translate(220px,220px)',
    ])
    expect(
      (screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
