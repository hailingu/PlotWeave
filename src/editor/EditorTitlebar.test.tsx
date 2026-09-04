// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EditorTitlebar, { type EditorTitlebarProps } from './EditorTitlebar'

afterEach(cleanup)

function setup(overrides: Partial<EditorTitlebarProps> = {}) {
  const props: EditorTitlebarProps = {
    projectName: '夜航',
    onRenameProject: vi.fn(),
    leftOpen: true,
    onToggleLeft: vi.fn(),
    canUndo: true,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onBackHome: vi.fn(),
    plusOpen: false,
    onTogglePlus: vi.fn(),
    onCreateNode: vi.fn(),
    onOpenExport: vi.fn(),
    inspectorOn: true,
    aiOn: false,
    onToggleRight: vi.fn(),
    ...overrides,
  }
  render(<EditorTitlebar {...props} />)
  return props
}

describe('EditorTitlebar（§3.3 顶部工具栏）', () => {
  it('边栏/撤销/重做/首页按钮各自回调；禁用态跟随 canUndo/canRedo', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('切换边栏'))
    expect(p.onToggleLeft).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('撤销'))
    expect(p.onUndo).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('重做')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('返回首页'))
    expect(p.onBackHome).toHaveBeenCalledTimes(1)
  })

  it('激活态高亮：leftOpen / inspectorOn / aiOn 决定 on 类与 aria-pressed', () => {
    setup({ leftOpen: true, inspectorOn: false, aiOn: true })
    expect(screen.getByLabelText('切换边栏').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('切换检查器').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('切换 AI 面板').getAttribute('aria-pressed')).toBe('true')
  })

  it('右栏两个页切换统一走 onToggleRight', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('切换检查器'))
    expect(p.onToggleRight).toHaveBeenCalledWith('inspector')
    fireEvent.click(screen.getByLabelText('切换 AI 面板'))
    expect(p.onToggleRight).toHaveBeenCalledWith('ai')
  })

  it('导出按钮回调 onOpenExport', () => {
    const p = setup()
    fireEvent.click(screen.getByLabelText('导出剧本'))
    expect(p.onOpenExport).toHaveBeenCalledTimes(1)
  })

  it('项目名单击进入内联重命名，提交回调 onRenameProject', () => {
    const p = setup()
    fireEvent.click(screen.getByText('夜航'))
    const input = screen.getByLabelText('项目名')
    fireEvent.change(input, { target: { value: '改名后' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(p.onRenameProject).toHaveBeenCalledWith('改名后')
  })

  it('＋节点下拉：plusOpen 时列出六类创建项（含图片节点），点击回调类型', () => {
    const p = setup({ plusOpen: true })
    const menu = screen.getByRole('menu', { name: '节点类型' })
    const items = menu.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(6)
    fireEvent.click(items[2])
    expect(p.onCreateNode).toHaveBeenCalledWith('dialogue')
    fireEvent.click(screen.getByLabelText('新增节点'))
    expect(p.onTogglePlus).toHaveBeenCalledTimes(1)
  })

  it('plusOpen=false 时不渲染创建菜单', () => {
    setup({ plusOpen: false })
    expect(screen.queryByRole('menu', { name: '节点类型' })).toBeNull()
  })
})
