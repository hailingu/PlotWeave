// @vitest-environment happy-dom
/**
 * 画布区域渲染隔离回归（issue #103）：面板状态变化（边栏开合、＋菜单、
 * 右栏切页）不得连带执行 EditorCanvasRegion——与画布输入无关的状态只在
 * 消费它的区域产生工作。复现 issue 审计手法：真实 Provider → 装配层 →
 * 布局层全链渲染，仅将 EditorCanvasRegion 替换为渲染计数探针（与真实
 * 组件同样以 memo 包裹，度量的是「布局层下传的画布输入是否引用稳定 +
 * 边界是否隔离」这一组合契约）；文档变化仍必须驱动画布区域重新执行，
 * 隔离不得冻结画布输入（反 stale 断言）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditorView from './EditorView'
import type { EditorProjectContent } from './useEditorDocument'
import type { CanvasNode } from './nodes/types'

/** 探针执行计数（vi.hoisted 供 mock 工厂引用，beforeEach 复位）。 */
const probe = vi.hoisted(() => ({ executions: 0 }))

vi.mock('./EditorCanvasRegion', async () => {
  const { memo } = await import('react')
  return {
    default: memo(function EditorCanvasRegionRenderProbe() {
      probe.executions += 1
      return null
    }),
  }
})

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
  name: '渲染隔离',
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
}

/** 面板交互落地的可见证据（防止「没点到按钮」造成的假绿）。 */
function expectPanelsReacted(): void {
  const leftToggle = screen.getByLabelText('切换边栏') as HTMLButtonElement
  expect(leftToggle.getAttribute('aria-pressed')).toBe('false')
  expect(
    (screen.getByLabelText('切换检查器') as HTMLButtonElement).getAttribute(
      'aria-pressed',
    ),
  ).toBe('false')
}

describe('画布区域渲染隔离（issue #103）', () => {
  beforeEach(() => {
    probe.executions = 0
  })

  it('面板状态变化不连带执行画布区域', () => {
    renderEditor()
    expect(probe.executions).toBe(1)

    fireEvent.click(screen.getByLabelText('切换边栏'))
    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByLabelText('切换检查器'))
    fireEvent.click(screen.getByLabelText('切换检查器'))
    fireEvent.click(screen.getByLabelText('切换 AI 面板'))

    expectPanelsReacted()
    expect(probe.executions).toBe(1)
  })

  it('文档变化仍驱动画布区域执行，其后的面板变化不再连带', () => {
    renderEditor()
    expect(probe.executions).toBe(1)

    fireEvent.click(screen.getByLabelText('新增节点'))
    fireEvent.click(screen.getByRole('menuitem', { name: '场景' }))
    expect(probe.executions).toBe(2)

    fireEvent.click(screen.getByLabelText('切换边栏'))
    expect(probe.executions).toBe(2)
  })
})
