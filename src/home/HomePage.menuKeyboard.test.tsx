// @vitest-environment happy-dom
/** #603: DOM position and focus ownership for keyboard versus pointer project menus.
 * #803: the delete confirm dialog owns keyboard focus (entry, Tab wrap, return). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HomePage } from './HomePage'

afterEach(cleanup)

/** Render two cards so a stale trigger or focus on a later card is observable. */
function setup() {
  const actions = {
    onOpenProject: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
  }
  const view = render(
    <HomePage
      projects={['one', 'two'].map((id) => ({
        id,
        name: id,
        sceneCount: 1,
        updatedAt: '2026-10-19T00:00:00Z',
      }))}
      {...actions}
    />,
  )
  const trigger = screen.getByRole('button', { name: '项目菜单 one' })
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    left: 240,
    bottom: 180,
    top: 150,
    right: 270,
    x: 240,
    y: 150,
    width: 30,
    height: 30,
    toJSON: () => ({}),
  })
  return { ...view, actions, trigger }
}

it('keyboard click anchors to the trigger, enters the first item, and Escape restores it', () => {
  const { trigger } = setup()
  trigger.focus()
  fireEvent.click(trigger, { detail: 0 })
  const menu = screen.getByRole('menu')
  expect(menu.style.left).toBe('240px')
  expect(menu.style.top).toBe('180px')
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: '打开' }),
  )
  expect(fireEvent.keyDown(document.activeElement!, { key: 'Escape' })).toBe(
    false,
  )
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it.each(['click', 'contextmenu'])(
  'pointer %s preserves coordinates and focus',
  (type) => {
    const { trigger } = setup()
    trigger.focus()
    fireEvent(
      type === 'click'
        ? trigger
        : screen.getByRole('button', { name: '打开项目 one' }),
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        detail: type === 'click' ? 1 : 0,
        clientX: 360,
        clientY: 210,
      }),
    )
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('360px')
    expect(menu.style.top).toBe('210px')
    expect(document.activeElement).toBe(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  },
)

it('keyboard menu replacement restores the current trigger, and rename owns its input focus', () => {
  const { trigger } = setup()
  fireEvent.click(trigger)
  const second = screen.getByRole('button', { name: '项目菜单 two' })
  fireEvent.click(second)
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: '打开' }),
  )
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(document.activeElement).toBe(second)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
  expect(document.activeElement).toBe(
    screen.getByRole('textbox', { name: '项目名' }),
  )
})

it('outside pointer dismissal keeps the new focus and unmount removes keyboard listeners', () => {
  const { trigger, unmount } = setup()
  fireEvent.click(trigger)
  const outside = screen.getByRole('button', { name: '＋ 新建项目' })
  outside.focus()
  fireEvent.pointerDown(outside)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(outside)
  fireEvent.click(trigger)
  unmount()
  const focus = vi.spyOn(trigger, 'focus')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(focus).not.toHaveBeenCalled()
})

it('removed triggers are not focused when Escape dismisses stale menu state', () => {
  const { trigger, rerender, actions } = setup()
  fireEvent.click(trigger)
  rerender(<HomePage projects={[]} {...actions} />)
  const focus = vi.spyOn(trigger, 'focus')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(focus).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('keyboard anchors retain the existing right-edge position limit', () => {
  const { trigger } = setup()
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    left: window.innerWidth - 30,
    bottom: 180,
    top: 150,
    right: window.innerWidth,
    x: window.innerWidth - 30,
    y: 150,
    width: 30,
    height: 30,
    toJSON: () => ({}),
  })
  fireEvent.click(trigger)
  expect(screen.getByRole('menu').style.left).toBe(
    `${window.innerWidth - 150}px`,
  )
})

/** #803: keyboard-open a project's delete confirm dialog from the menu. */
function openDeleteDialog(trigger: ReturnType<typeof setup>['trigger']) {
  trigger.focus()
  fireEvent.click(trigger, { detail: 0 })
  fireEvent.click(screen.getByRole('menuitem', { name: '🗑 删除' }))
  return {
    dialog: screen.getByRole('dialog', { name: '删除项目' }),
    cancel: screen.getByRole('button', { name: '取消' }),
    confirm: screen.getByRole('button', { name: '删除' }),
  }
}

describe('HomePage 删除确认对话框键盘焦点（issue #803）', () => {
  it('keyboard entry moves focus into the dialog and Tab wraps within it', () => {
    const { trigger } = setup()
    const { dialog, cancel, confirm } = openDeleteDialog(trigger)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })

  it('Escape closes the dialog and returns focus to the menu trigger', () => {
    const { trigger } = setup()
    openDeleteDialog(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('confirming deletion returns focus safely when the card is already gone', () => {
    const { trigger, rerender, actions } = setup()
    openDeleteDialog(trigger)
    rerender(<HomePage projects={[]} {...actions} />)
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(actions.onDeleteProject).toHaveBeenCalledExactlyOnceWith('one')
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('Escape after external card removal never focuses the detached trigger', () => {
    const { trigger, rerender, actions } = setup()
    openDeleteDialog(trigger)
    rerender(<HomePage projects={[]} {...actions} />)
    const focus = vi.spyOn(trigger, 'focus')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(focus).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('pointer-opened dialog still takes focus and Escape returns the pre-open focus', () => {
    const { trigger } = setup()
    // 指针流不登记触发钮（menu.keyboard=false）：归还打开前焦点所在
    // （这里显式聚焦搜索框，模拟指针与键盘混用时的打开前焦点）
    const search = screen.getByRole('searchbox', { name: '搜索项目' })
    search.focus()
    fireEvent.click(trigger, { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '🗑 删除' }))
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '取消' }),
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
    expect(document.activeElement).toBe(search)
  })
})
