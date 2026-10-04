// @vitest-environment happy-dom
/** 对齐与吸附经真实编辑器和 React Flow 生效；可见位置、历史与保存互相一致。 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'
import type { ProjectContent } from '../model/content'
import { toStoryNode } from '../model/serialize'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 不同尺寸与负坐标使按左上角代替边缘/中心计算的实现无法误过。 */
function project(): EditorProjectContent {
  const nodes: CanvasNode[] = [
    {
      id: 'a',
      type: 'beat',
      position: { x: -20, y: 10 },
      width: 100,
      height: 80,
      selected: true,
      data: { name: '开场', tone: '平静' },
    },
    {
      id: 'b',
      type: 'beat',
      position: { x: 180, y: 210 },
      width: 60,
      height: 40,
      selected: true,
      data: { name: '转折', tone: '紧张' },
    },
    {
      id: 'c',
      type: 'beat',
      position: { x: 500, y: 500 },
      width: 100,
      height: 80,
      data: { name: '未选中', tone: '' },
    },
  ]
  return {
    id: 'alignment',
    name: '对齐测试',
    nodes,
    edges: [],
    settings: { characters: [], locations: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

/** 保留真实编辑器动作和保存通道，只以数组收集外部持久化边界的载荷。 */
function mount(initial = project()) {
  const saved: ProjectContent[] = []
  const view = render(
    <EditorView
      project={initial}
      onBackHome={() => undefined}
      onRenameProject={() => undefined}
      onSave={(content) => {
        saved.push(content)
      }}
    />,
  )
  return { ...view, saved }
}

/** 读取真实 React Flow 节点的可见落点，不从几何计算器生成期望值。 */
function position(container: HTMLElement, id: string): string {
  const node = container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  )
  if (!node) throw new Error(`缺失画布节点 ${id}`)
  return node.style.transform
}

/** 通过原生鼠标事件驱动 XYFlow 拖动，不绕开其网格位置计算或历史事件顺序。 */
async function dragNode(
  container: HTMLElement,
  id: string,
  delta: number,
): Promise<void> {
  const node = container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  )
  if (!node) throw new Error(`缺失拖动节点 ${id}`)
  await dragElement(node, delta)
}

/** 拖动节点或框选矩形，共用框架原生事件入口。 */
async function dragElement(element: HTMLElement, delta: number): Promise<void> {
  fireEvent.mouseDown(element, {
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
    clientX: 12 + delta,
    clientY: 12 + delta,
    buttons: 1,
    view: window,
  })
  fireEvent.mouseUp(window, {
    clientX: 12 + delta,
    clientY: 12 + delta,
    button: 0,
    view: window,
  })
  // d3 在松手后的同一 tick 抑制合成 click；下个真实交互发生前释放该守卫。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('对齐控件语义（issue #500）', () => {
  it('六个对齐按钮属于有可访问名称的分组', () => {
    mount()
    const group = screen.getByRole('group', { name: '选中节点对齐' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      '左对齐',
      '水平居中',
      '右对齐',
      '顶部对齐',
      '垂直居中',
      '底部对齐',
    ])
  })
})

describe('选中节点对齐', () => {
  it.each([
    ['左对齐', [-20, 10], [-20, 210]],
    ['水平居中', [60, 10], [80, 210]],
    ['右对齐', [140, 10], [180, 210]],
    ['顶部对齐', [-20, 10], [180, 10]],
    ['垂直居中', [-20, 90], [180, 110]],
    ['底部对齐', [-20, 170], [180, 210]],
  ])('%s 按选中包围盒对齐且不移动其他节点', (label, a, b) => {
    const { container } = mount()
    fireEvent.click(screen.getByRole('button', { name: label as string }))
    expect(position(container, 'a')).toBe(`translate(${a[0]}px,${a[1]}px)`)
    expect(position(container, 'b')).toBe(`translate(${b[0]}px,${b[1]}px)`)
    expect(position(container, 'c')).toBe('translate(500px,500px)')
  })

  it('对齐和重复点击只产生一步历史，保存与撤销重做保持同一落点', async () => {
    vi.useFakeTimers()
    const { container, saved } = mount()
    fireEvent.click(screen.getByRole('button', { name: '左对齐' }))
    fireEvent.click(screen.getByRole('button', { name: '左对齐' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    const content = saved[saved.length - 1]!
    expect(
      content.nodes.map(toStoryNode).map((n) => n.layout.position),
    ).toEqual([
      { x: -20, y: 10 },
      { x: -20, y: 210 },
      { x: 500, y: 500 },
    ])
    expect(content.nodes.map((n) => n.data)).toEqual(
      project().nodes.map((n) => n.data),
    )
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(position(container, 'b')).toBe('translate(180px,210px)')
    expect(
      (
        screen.getByRole('button', {
          name: '撤销',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(position(container, 'b')).toBe('translate(-20px,210px)')
  })

  it('不足两个选中节点时对齐不可用', () => {
    const initial = project()
    initial.nodes = initial.nodes.map((n) => ({ ...n, selected: n.id === 'a' }))
    const { container } = mount(initial)
    const button = screen.getByRole('button', {
      name: '左对齐',
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(position(container, 'b')).toBe('translate(180px,210px)')
  })

  it('尺寸未知时保留布局并给出可重试反馈', () => {
    const initial = project()
    delete initial.nodes[0]!.width
    const { container } = mount(initial)
    fireEvent.click(screen.getByRole('button', { name: '右对齐' }))
    expect(screen.getByRole('alert').textContent).toContain('尺寸测量')
    expect(position(container, 'b')).toBe('translate(180px,210px)')
    expect(
      (
        screen.getByRole('button', {
          name: '撤销',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
})

describe('网格吸附', () => {
  it('开启、关闭与再次开启时名称、悬停提示和按下状态同步', () => {
    mount()
    const toggle = screen.getByRole('button', { name: /^网格吸附/ })
    expect(screen.getByRole('button', { name: '网格吸附：开' })).toBe(toggle)
    expect(toggle.getAttribute('title')).toBe('网格吸附：开')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '网格吸附：关' })).toBe(toggle)
    expect(toggle.getAttribute('title')).toBe('网格吸附：关')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '网格吸附：开' })).toBe(toggle)
    expect(toggle.getAttribute('title')).toBe('网格吸附：开')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('默认吸附到点阵，关闭后自由拖动；每段拖动可一步撤销重做', async () => {
    vi.useFakeTimers()
    const initial = project()
    initial.nodes = [{ ...initial.nodes[0]!, position: { x: 0, y: 0 } }]
    const { container } = mount(initial)
    await dragNode(container, 'a', 37)
    expect(position(container, 'a')).toBe('translate(44px,44px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(position(container, 'a')).toBe('translate(0px,0px)')
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(position(container, 'a')).toBe('translate(44px,44px)')
    const toggle = screen.getByRole('button', { name: '网格吸附：开' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await dragNode(container, 'a', 15)
    expect(position(container, 'a')).toBe('translate(59px,59px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(position(container, 'a')).toBe('translate(44px,44px)')
  })

  it('多选节点吸附保持相对间距，整组只占一步撤销', async () => {
    vi.useFakeTimers()
    const { container } = mount()
    await dragNode(container, 'a', 37)
    expect(position(container, 'a')).toBe('translate(22px,44px)')
    expect(position(container, 'b')).toBe('translate(222px,244px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(position(container, 'a')).toBe('translate(-20px,10px)')
    expect(position(container, 'b')).toBe('translate(180px,210px)')
    expect(
      (
        screen.getByRole('button', {
          name: '撤销',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
})

describe('框选组吸附', () => {
  it('框选矩形拖动复用节点历史入口，不漏记或重复入栈', async () => {
    vi.useFakeTimers()
    const initial = project()
    // headless DOM 无布局测量，使用框架支持的预设尺寸/端口描述。
    initial.nodes = initial.nodes.map((node) => ({
      ...node,
      selected: false,
      handles: [],
    }))
    const { container } = mount(initial)
    const pane = container.querySelector<HTMLElement>('.react-flow__pane')!
    fireEvent.keyDown(window, {
      key: 'Shift',
      code: 'ShiftLeft',
      shiftKey: true,
    })
    fireEvent.pointerDown(pane, {
      clientX: -30,
      clientY: 0,
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
    const selection = container.querySelector<HTMLElement>(
      '.react-flow__nodesselection-rect',
    )
    expect(selection).not.toBeNull()
    expect(
      [...container.querySelectorAll('.react-flow__node.selected')].map((n) =>
        n.getAttribute('data-id'),
      ),
    ).toEqual(['a', 'b'])
    await dragElement(selection!, 37)
    expect(position(container, 'a')).toBe('translate(22px,44px)')
    expect(position(container, 'b')).toBe('translate(222px,244px)')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(position(container, 'a')).toBe('translate(-20px,10px)')
    expect(position(container, 'b')).toBe('translate(180px,210px)')
    expect(
      (
        screen.getByRole('button', {
          name: '撤销',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
  })
})
