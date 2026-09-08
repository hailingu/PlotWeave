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
