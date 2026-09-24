// @vitest-environment happy-dom
/**
 * 编辑器键盘流程验证（issue #238）：真实 EditorView + React Flow 装配上
 * 执行完整键盘操作流，断言可见状态与焦点，不以 onKeyDown 存在性代替：
 * 节点键盘聚焦（xyflow nodesFocusable）与 Enter 选中、工具栏项目名纯
 * 键盘改名、应用级 Delete 删除选中节点与 ⌘Z 撤销（仓库已禁用库内建
 * deleteKeyCode，删除走 useEditorHotkeys）、导出弹窗 Escape 关闭。
 * 发现①（弹窗打开后焦点不移入弹窗）已由 issue #263 修复并翻转断言：
 * 打开即移入焦点、Escape 关闭后归还触发按钮。发现②仍固化现状：
 * 键盘单选节点无方向键移动——xyflow 12.11.3 的方向键移动仅绑定在
 * 框选手势挂载的选择框（nodesSelectionActive），单选不产生该框。
 */
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

afterEach(cleanup)

const sceneNode = {
  id: 'sc1',
  type: 'scene',
  position: { x: 0, y: 0 },
  // 合成 DOM 无布局测量：显式尺寸使选中框可计算 bounds 并渲染
  width: 120,
  height: 60,
  data: {
    name: '天台',
    sceneNo: 1,
    interior: false,
    time: '夜',
    synopsis: '开场',
    characterIds: [],
  },
} as unknown as CanvasNode

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '键盘流程',
  nodes: [sceneNode],
  edges: [],
  settings: { characters: [], locations: [] },
}

function renderEditor() {
  const onRenameProject = vi.fn()
  render(
    <EditorView
      project={PROJECT}
      onBackHome={vi.fn()}
      onRenameProject={onRenameProject}
      onSave={vi.fn()}
    />,
  )
  return { onRenameProject }
}

/** 画布上 sc1 节点的包装元素（xyflow data-testid，tabIndex/role 载体）。 */
const canvasNode = () =>
  document.querySelector<HTMLElement>('[data-testid="rf__node-sc1"]')!

/** 选中节点后 xyflow 渲染的可聚焦选择框（方向键移动的键盘载体）。 */
const selectionRect = () =>
  document.querySelector<HTMLElement>('.react-flow__nodesselection-rect')

/** 大纲中的场景行（删除/撤销的可见状态断言入口）。 */
const outlineRow = () =>
  within(screen.getByLabelText('故事大纲')).queryByText('场 01 · 天台')

/** 键盘选中节点：聚焦画布节点 + Enter（xyflow 选择键）。 */
function selectNodeByKeyboard() {
  const node = canvasNode()
  act(() => {
    node.focus()
  })
  fireEvent.keyDown(node, { key: 'Enter' })
}

describe('编辑器键盘流程（issue #238）', () => {
  it('节点可键盘聚焦与选中：Enter 后进入选中态且焦点保持', () => {
    renderEditor()
    const node = canvasNode()
    expect(node.tabIndex).toBe(0)
    expect(node.getAttribute('aria-roledescription')).toBe('node')
    act(() => {
      node.focus()
    })
    expect(document.activeElement).toBe(node)
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(node.className).toContain('selected')
    // 焦点保持在节点上（单选不产生接管焦点的框选选择框）
    expect(document.activeElement).toBe(node)
    // 现状固化（发现②，见模块头）：单选无方向键移动——框选选择框
    // （方向键载体）不因键盘单选挂载，修复时翻转此断言
    expect(selectionRect()).toBeNull()
  })

  it('工具栏项目名纯键盘改名：Enter 进入、输入、Enter 提交', () => {
    const { onRenameProject } = renderEditor()
    const nameButton = screen.getByRole('button', { name: '键盘流程' })
    act(() => {
      nameButton.focus()
    })
    expect(document.activeElement).toBe(nameButton)
    fireEvent.keyDown(nameButton, { key: 'Enter' })
    const input = screen.getByLabelText('项目名') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '键盘流程·二稿' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRenameProject).toHaveBeenCalledWith('键盘流程·二稿')
    // 提交即退出编辑态；标题更新由父级（App）回灌 prop，此处 mock 不回灌
    expect(screen.getByRole('button', { name: '键盘流程' })).toBeTruthy()
    expect(screen.queryByLabelText('项目名')).toBeNull()
  })

  it('Delete 删除选中节点（应用级快捷键），⌘Z 撤销恢复', () => {
    renderEditor()
    expect(outlineRow()).toBeTruthy()
    selectNodeByKeyboard()
    // 真实浏览器的 keydown target 是元素（焦点元素或 body），body 派发同构
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(outlineRow()).toBeNull()
    expect(document.querySelector('[data-testid="rf__node-sc1"]')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(outlineRow()).toBeTruthy()
  })

  it('导出弹窗：打开焦点移入弹窗，Escape 关闭后归还触发按钮（issue #263）', () => {
    renderEditor()
    const exportButton = screen.getByLabelText('导出剧本')
    act(() => {
      exportButton.focus()
    })
    fireEvent.click(exportButton)
    const dialog = screen.getByRole('dialog', { name: '导出剧本' })
    expect(dialog).toBeTruthy()
    // issue #263 修复：打开即把焦点移入弹窗（翻转自 issue #238 的现状固化）
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // 关闭后焦点归还打开时的触发按钮
    expect(document.activeElement).toBe(exportButton)
  })
})
