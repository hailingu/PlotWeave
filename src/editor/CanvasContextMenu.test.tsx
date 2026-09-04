// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CanvasContextMenu, { type CanvasContextMenuProps } from './CanvasContextMenu'

afterEach(cleanup)

function setup(overrides: Partial<CanvasContextMenuProps> = {}) {
  const props: CanvasContextMenuProps = {
    x: 100,
    y: 200,
    onToggleSettings: vi.fn(),
    onDuplicate: vi.fn(),
    onDeleteNode: vi.fn(),
    onDeleteEdge: vi.fn(),
    onCreate: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<CanvasContextMenu {...props} />)
  return props
}

describe('CanvasContextMenu（§4.3 右键菜单三形态）', () => {
  it('节点菜单：设置/复制/删除三项，动作后统一 onClose', () => {
    const p = setup({ nodeId: 'n1' })
    fireEvent.click(screen.getByText('⚙️ 打开设置'))
    expect(p.onToggleSettings).toHaveBeenCalledWith('n1')
    expect(p.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('⧉ 复制'))
    expect(p.onDuplicate).toHaveBeenCalledWith('n1')
    fireEvent.click(screen.getByText('🗑 删除'))
    expect(p.onDeleteNode).toHaveBeenCalledWith('n1')
    expect(p.onClose).toHaveBeenCalledTimes(3)
  })

  it('连线菜单：仅 ✂️ 删除连线', () => {
    const p = setup({ edgeId: 'e1' })
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(1)
    fireEvent.click(items[0])
    expect(p.onDeleteEdge).toHaveBeenCalledWith('e1')
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('空白菜单：六类新增（含图片节点），点击回调类型并收起', () => {
    const p = setup()
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(6)
    fireEvent.click(screen.getByText('＋ 分镜卡'))
    expect(p.onCreate).toHaveBeenCalledWith('shot')
    fireEvent.click(screen.getByText('＋ 图片节点'))
    expect(p.onCreate).toHaveBeenCalledWith('image')
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })

  it('定位：左缘收敛在窗口内（window.innerWidth - 150）', () => {
    setup({ x: 99999, y: 50 })
    const menu = screen.getByRole('menu', { name: '画布上下文菜单' })
    expect(menu.style.left).toBe(`${window.innerWidth - 150}px`)
    expect(menu.style.top).toBe('50px')
  })
})
