// @vitest-environment happy-dom
/**
 * EditorView 装配冒烟测试（issue #35 拆分的回归网）：真实渲染 Provider 薄壳
 * → 装配层 → 布局层，验证三栏装配、＋节点创建与撤销/重做端到端仍走同一
 * 命令栈。此前 EditorView 被 App.test.tsx mock，拆分后需要这条装配守护。
 * 断言作用域收敛到左栏大纲，避免与画布节点同名文案互相干扰。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EditorView from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

afterEach(cleanup)

const sceneNode = {
  id: 'sc1',
  type: 'scene',
  position: { x: 0, y: 0 },
  data: {
    name: '天台',
    sceneNo: 1,
    interior: false,
    time: '🌙 夜',
    synopsis: '开场',
    characterIds: [],
    locationId: null,
  },
} as unknown as CanvasNode

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '装配冒烟',
  nodes: [sceneNode],
  edges: [],
  settings: { characters: [], locations: [] },
}

function renderEditor() {
  render(
    <EditorView
      project={PROJECT}
      onBackHome={vi.fn()}
      onRenameProject={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  return { outline: () => within(screen.getByLabelText('故事大纲')) }
}

const undoButton = () => screen.getByLabelText('撤销') as HTMLButtonElement

describe('EditorView 装配（issue #35）', () => {
  it('装配标题栏、三栏与画布，并渲染左栏大纲', () => {
    const { outline } = renderEditor()
    expect(screen.getByText('装配冒烟')).toBeTruthy()
    expect(screen.getByLabelText('切换边栏')).toBeTruthy()
    expect(screen.getByLabelText('切换检查器')).toBeTruthy()
    expect(outline().getByText('场 01 · 天台')).toBeTruthy()
  })

  it('＋节点创建仍入命令栈：创建后大纲出现新节点，撤销移除、重做恢复', () => {
    const { outline } = renderEditor()
    expect(undoButton().disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))

    expect(outline().getByText('场 02 · 新场景')).toBeTruthy()
    expect(undoButton().disabled).toBe(false)

    fireEvent.click(undoButton())
    expect(outline().queryByText('场 02 · 新场景')).toBeNull()

    fireEvent.click(screen.getByLabelText('重做'))
    expect(outline().getByText('场 02 · 新场景')).toBeTruthy()
  })

  it('边栏开关仍由面板状态驱动（点击后左栏折叠）', () => {
    renderEditor()
    const panelOf = () => screen.getByLabelText('故事大纲').closest('.pw-panel-left')
    expect(panelOf()?.className).not.toContain('pw-panel-closed')
    fireEvent.click(screen.getByLabelText('切换边栏'))
    expect(panelOf()?.className).toContain('pw-panel-closed')
  })
})

/**
 * 记录 React 对受控 input 的 DOM 回写：包装实例上的 value 描述符
 * （React value tracker）。testing-library 的 fireEvent 走原型 setter，
 * 因此这里只捕获框架回写，不混入模拟按键本身。
 */
function trackControlledWrites(input: HTMLInputElement): string[] {
  const writes: string[] = []
  let descriptor: PropertyDescriptor | undefined
  for (let node: object | null = input; node !== null; node = Object.getPrototypeOf(node)) {
    descriptor = Object.getOwnPropertyDescriptor(node, 'value')
    if (descriptor) break
  }
  const read = descriptor?.get
  const write = descriptor?.set
  if (!read || !write) throw new Error('input 缺少 value 访问器，无法观测受控回写')
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => read.call(input) as string,
    set: (next: string) => {
      writes.push(String(next))
      write.call(input, next)
    },
  })
  return writes
}

const beatNode = {
  id: 'bt1',
  type: 'beat',
  position: { x: 0, y: 0 },
  data: { name: '真相逼近', tone: '' },
} as unknown as CanvasNode

describe('IME 组合输入（issue #42 真实更新链路）', () => {
  const IME_PROJECT: EditorProjectContent = {
    id: 'p-ime',
    name: '组合输入',
    nodes: [beatNode],
    edges: [],
    settings: { characters: [], locations: [] },
  }

  it('组合期间不回写受控值；上屏后中文保留且输入框未重挂载', () => {
    render(
      <EditorView
        project={IME_PROJECT}
        onBackHome={vi.fn()}
        onRenameProject={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    // happy-dom 画布无尺寸，React Flow 给节点挂 visibility:hidden——
    // getByRole 会把节点子树判为不可访问，按标签取（节点仍在 DOM 中）
    fireEvent.click(screen.getByLabelText('节奏卡设置'))
    const tone = screen.getByLabelText('基调') as HTMLInputElement
    const writes = trackControlledWrites(tone)

    fireEvent.compositionStart(tone)
    for (const pinyin of ['q', 'qi', 'qin', 'qing']) {
      fireEvent.input(tone, { target: { value: pinyin }, isComposing: true })
    }
    // 节点补丁经 React Flow 内部仓库在 effect 中同步，受控值天然滞后一帧；
    // 组合期间任何回写（哪怕写回旧值）都会在 WebKit 打断组合、残留拼音
    expect(writes).toEqual([])

    fireEvent.input(tone, { target: { value: '清冷' } })
    fireEvent.compositionEnd(tone, { data: '清冷' })

    expect(screen.getByLabelText('基调')).toBe(tone)
    expect(tone.value).toBe('清冷')
    expect(screen.getByText('基调：清冷')).toBeTruthy()
  })
})
