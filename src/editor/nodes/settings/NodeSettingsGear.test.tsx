// @vitest-environment happy-dom
/**
 * 节点设置齿轮按钮（NodeSettingsGear）行为测试：可访问名称、aria-expanded
 * 与打开状态一致、点击切换且不冒泡到画布容器、light 外观变体。
 * 六类节点（beat/dialogue/scene/branch/shot/image）复用本组件（issue #105）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import NodeSettingsGear from './NodeSettingsGear'

afterEach(cleanup)

function setup(options?: { open?: boolean; light?: boolean }) {
  const onToggle = vi.fn()
  const onParentClick = vi.fn()
  const { container } = render(
    <div onClick={onParentClick}>
      <NodeSettingsGear
        ariaLabel="节奏卡设置"
        open={options?.open ?? false}
        onToggle={onToggle}
        light={options?.light}
      />
    </div>,
  )
  return { onToggle, onParentClick, container }
}

describe('NodeSettingsGear（节点设置齿轮按钮）', () => {
  it('以传入的可访问名称渲染按钮角色', () => {
    setup()
    const button = screen.getByRole('button', { name: '节奏卡设置' })
    expect(button.getAttribute('data-pw-gear')).not.toBeNull()
    expect(button.textContent).toBe('⚙️')
  })

  it('面板关闭时 aria-expanded 为 false 且不带打开态类名', () => {
    const { container } = setup({ open: false })
    const button = screen.getByRole('button', { name: '节奏卡设置' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.className).not.toContain('pw-gear-open')
    expect(container.querySelector('[data-pw-gear].pw-gear-open')).toBeNull()
  })

  it('面板打开时 aria-expanded 为 true 且带打开态类名', () => {
    setup({ open: true })
    const button = screen.getByRole('button', { name: '节奏卡设置' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.className).toContain('pw-gear-open')
  })

  it('点击调用一次切换回调，且点击不冒泡到画布容器', () => {
    const { onToggle, onParentClick } = setup()
    fireEvent.click(screen.getByRole('button', { name: '节奏卡设置' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('键盘可用：原生 button 元素保证 Enter/Space 激活路径', () => {
    setup()
    const button = screen.getByRole('button', { name: '节奏卡设置' })
    // 键盘可达性由原生 <button> 语义承担；断言元素本体而非合成键盘事件
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('tabindex')).toBeNull()
  })

  it('light 变体带 pw-gear-light 类；默认变体不带', () => {
    const { container } = setup({ light: true })
    expect(container.querySelector('[data-pw-gear]')?.className).toContain(
      'pw-gear-light',
    )
  })

  it('默认变体（深色石板节点）不带 pw-gear-light 类', () => {
    const { container } = setup({ light: false })
    expect(container.querySelector('[data-pw-gear]')?.className).not.toContain(
      'pw-gear-light',
    )
  })
})
