// @vitest-environment happy-dom
/** 键盘位置历史回归（issue #496）：真实 React Flow 移动、命令栈回放与保存同源。 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { ProjectContent } from '../model/content'
import { toStoryNode } from '../model/serialize'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 显式尺寸使无布局 DOM 下的框架选择与位置行为可计算，三个节点独立定位。 */
function project(): EditorProjectContent {
  return {
    id: 'keyboard',
    name: '键盘移动',
    nodes: [
      {
        id: 'a',
        type: 'beat',
        position: { x: 0, y: 0 },
        width: 100,
        height: 80,
        data: { name: '开场', tone: '平静' },
      },
      {
        id: 'b',
        type: 'beat',
        position: { x: 220, y: 220 },
        width: 60,
        height: 40,
        data: { name: '转折', tone: '紧张' },
      },
      {
        id: 'c',
        type: 'beat',
        position: { x: 440, y: 440 },
        width: 100,
        height: 80,
        data: { name: '未选中', tone: '' },
      },
    ],
    edges: [],
    settings: { characters: [], locations: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

/** 收集真实保存边界载荷；可注入一次外部失败验证后续恢复，不替换编辑器。 */
function mount(
  initial = project(),
  failFirstSave = false,
  onSave?: (content: ProjectContent) => void | Promise<void>,
) {
  const saved: ProjectContent[] = []
  render(
    <StrictMode>
      <EditorView
        project={initial}
        onBackHome={() => undefined}
        onRenameProject={() => undefined}
        onSave={(content) => {
          if (failFirstSave) {
            failFirstSave = false
            return Promise.reject(new Error('磁盘暂不可用'))
          }
          saved.push(content)
          return onSave?.(content)
        }}
      />
    </StrictMode>,
  )
  return saved
}

/** 框架节点包装元素是焦点与可见坐标的载体。 */
function node(id = 'a'): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  )
  if (!element) throw new Error(`缺失画布节点 ${id}`)
  return element
}

/** 用户通过 Enter 选中当前聚焦节点，保持真实框架键盘入口。 */
function selectNode() {
  act(() => node().focus())
  fireEvent.keyDown(node(), { key: 'Enter' })
}

/** 历史条目数经逐步撤销及按钮可用性验证，无需窥探栈的私有实现。 */
function historyDisabled(name: '撤销' | '重做'): boolean {
  return (screen.getByRole('button', { name }) as HTMLButtonElement).disabled
}

/** 取保存边界最近接收的载荷，未发生保存时给出明确测试失败。 */
function latestSave(saved: ProjectContent[]): ProjectContent {
  const content = saved[saved.length - 1]
  if (!content) throw new Error('未收到保存载荷')
  return content
}

/** 推进既有防抖窗口并等待保存完成。 */
async function saveTick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
}

/** 通过真实框选手势选择前两个节点，使选择框成为第二个键盘移动入口。 */
function boxSelect() {
  const pane = document.querySelector<HTMLElement>('.react-flow__pane')!
  fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
  fireEvent.pointerDown(pane, {
    clientX: -10,
    clientY: -10,
    button: 0,
    isPrimary: true,
    pointerId: 1,
  })
  fireEvent.pointerMove(pane, {
    clientX: 300,
    clientY: 300,
    isPrimary: true,
    pointerId: 1,
  })
  fireEvent.pointerUp(pane, {
    clientX: 300,
    clientY: 300,
    button: 0,
    pointerId: 1,
  })
  fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft' })
  const selection = document.querySelector<HTMLElement>(
    '.react-flow__nodesselection-rect',
  )
  if (!selection) throw new Error('缺失框选选择框')
  act(() => selection.focus())
  return selection
}

describe('键盘移动历史（issue #496）', () => {
  it('方向键一次位移恰好一步撤销，重做恢复同一位置', () => {
    mount()
    selectNode()
    expect(historyDisabled('撤销')).toBe(true)
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    expect(node().style.transform).toBe('translate(22px,0px)')
    expect(historyDisabled('撤销')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node().style.transform).toBe('translate(0px,0px)')
    expect(historyDisabled('撤销')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(node().style.transform).toBe('translate(22px,0px)')
    expect(historyDisabled('重做')).toBe(true)
  })

  it.each([
    ['ArrowLeft', false, true, 'translate(-22px,0px)'],
    ['ArrowUp', false, true, 'translate(0px,-22px)'],
    ['ArrowDown', false, true, 'translate(0px,22px)'],
    ['ArrowRight', true, true, 'translate(88px,0px)'],
    ['ArrowRight', false, false, 'translate(5px,0px)'],
    ['ArrowDown', true, false, 'translate(0px,20px)'],
  ])(
    '%s、Shift=%s、吸附=%s 的位移完整回放',
    (key, shiftKey, snap, expected) => {
      mount()
      selectNode()
      if (!snap)
        fireEvent.click(screen.getByRole('button', { name: '网格吸附：开' }))
      fireEvent.keyDown(node(), { key, shiftKey })
      expect(node().style.transform).toBe(expected)
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
      expect(node().style.transform).toBe('translate(0px,0px)')
      expect(historyDisabled('撤销')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: '重做' }))
      expect(node().style.transform).toBe(expected)
    },
  )

  it('网格取整同时改变两轴时，撤销恢复原来的非网格坐标', () => {
    const initial = project()
    initial.nodes[0]!.position = { x: 3, y: 7 }
    mount(initial)
    selectNode()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    expect(node().style.transform).toBe('translate(22px,0px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node().style.transform).toBe('translate(3px,7px)')
    expect(historyDisabled('撤销')).toBe(true)
  })
})

describe('多选键盘历史（issue #496）', () => {
  it.each(['节点', '框选选择框'])(
    '%s 聚焦的多选连续按键每次独立成条',
    (entry) => {
      const initial = project()
      initial.nodes = initial.nodes.map((n) => ({
        ...n,
        handles: [],
        selected: entry === '节点' && n.id !== 'c',
      }))
      mount(initial)
      const target = entry === '节点' ? node() : boxSelect()
      act(() => target.focus())
      fireEvent.keyDown(target, { key: 'ArrowRight' })
      fireEvent.keyDown(target, { key: 'ArrowRight', repeat: true })
      expect(node().style.transform).toBe('translate(44px,0px)')
      expect(node('b').style.transform).toBe('translate(264px,220px)')
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
      expect(node().style.transform).toBe('translate(22px,0px)')
      expect(node('b').style.transform).toBe('translate(242px,220px)')
      expect(historyDisabled('撤销')).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))
      expect(node().style.transform).toBe('translate(0px,0px)')
      expect(node('b').style.transform).toBe('translate(220px,220px)')
      expect(historyDisabled('撤销')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: '重做' }))
      fireEvent.click(screen.getByRole('button', { name: '重做' }))
      expect(node().style.transform).toBe('translate(44px,0px)')
      expect(node('b').style.transform).toBe('translate(264px,220px)')
      expect(node('c').style.transform).toBe('translate(440px,440px)')
      expect(historyDisabled('重做')).toBe(true)
    },
  )

  it('撤销后另一次键盘移动替换重做分支', () => {
    mount()
    selectNode()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    fireEvent.keyDown(node(), { key: 'ArrowDown' })
    expect(node().style.transform).toBe('translate(0px,22px)')
    expect(historyDisabled('重做')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node().style.transform).toBe('translate(0px,0px)')
    expect(historyDisabled('撤销')).toBe(true)
  })
})

describe('无位移键盘输入（issue #496）', () => {
  it('未选中节点、输入框与锁定画布的方向键不产生位置历史', () => {
    mount()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    expect(node().style.transform).toBe('translate(0px,0px)')
    selectNode()
    fireEvent.doubleClick(screen.getByRole('button', { name: '开场' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: '节奏卡内容' }), {
      key: 'ArrowRight',
    })
    expect(node().style.transform).toBe('translate(0px,0px)')
    fireEvent.click(
      document.querySelector<HTMLElement>('.react-flow__controls-interactive')!,
    )
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    expect(node().style.transform).toBe('translate(0px,0px)')
    expect(historyDisabled('撤销')).toBe(true)
  })
})

describe('键盘历史保存（issue #496）', () => {
  it('移动、撤销与重做后的保存载荷与画布坐标一致', async () => {
    vi.useFakeTimers()
    const saved = mount()
    selectNode()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    await saveTick()
    expect(toStoryNode(latestSave(saved).nodes[0]!).layout.position).toEqual({
      x: 22,
      y: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await saveTick()
    expect(toStoryNode(latestSave(saved).nodes[0]!).layout.position).toEqual({
      x: 0,
      y: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    await saveTick()
    expect(toStoryNode(latestSave(saved).nodes[0]!).layout.position).toEqual({
      x: 22,
      y: 0,
    })
    expect(latestSave(saved).nodes.map((n) => n.data)).toEqual(
      project().nodes.map((n) => n.data),
    )
    expect(
      latestSave(saved)
        .nodes.slice(1)
        .map((n) => n.position),
    ).toEqual([
      { x: 220, y: 220 },
      { x: 440, y: 440 },
    ])
  })
})

describe('键盘历史保存恢复（issue #496）', () => {
  it('保存失败后撤销，重试保存撤销后的位置', async () => {
    vi.useFakeTimers()
    const saved = mount(project(), true)
    selectNode()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    await saveTick()
    expect(screen.getByRole('alert').textContent).toContain('磁盘暂不可用')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(node().style.transform).toBe('translate(0px,0px)')
    await saveTick()
    expect(toStoryNode(latestSave(saved).nodes[0]!).layout.position).toEqual({
      x: 0,
      y: 0,
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(historyDisabled('撤销')).toBe(true)
  })

  it('移动保存仍在途时撤销，旧请求结束后串行保存撤销坐标', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const saved = mount(project(), false, () => {
      if (!first) return
      first = false
      return pending
    })
    selectNode()
    fireEvent.keyDown(node(), { key: 'ArrowRight' })
    await saveTick()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await saveTick()
    expect(node().style.transform).toBe('translate(0px,0px)')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.nodes[0]!.position).toEqual({ x: 22, y: 0 })
    await act(async () => release())
    await saveTick()
    expect(toStoryNode(latestSave(saved).nodes[0]!).layout.position).toEqual({
      x: 0,
      y: 0,
    })
    expect(historyDisabled('撤销')).toBe(true)
  })
})
