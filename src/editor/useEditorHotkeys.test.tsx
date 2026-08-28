// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useEditorHotkeys, type EditorHotkeyActions } from './useEditorHotkeys'

function mkActions(overrides: Partial<EditorHotkeyActions> = {}): EditorHotkeyActions {
  return {
    onEscape: vi.fn(),
    onCloseTransient: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    selectedNodeIds: () => [],
    selectedEdgeIds: () => [],
    onDeleteNodes: vi.fn(),
    onDeleteEdges: vi.fn(),
    ...overrides,
  }
}

describe('useEditorHotkeys（全局快捷键 + 失焦收起）', () => {
  it('⌘Z 撤销、⇧⌘Z 与 ⌘Y 重做（ctrl 等价 meta）', () => {
    const a = mkActions()
    renderHook(() => useEditorHotkeys(a))
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(a.onUndo).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Z', metaKey: true, shiftKey: true })
    expect(a.onRedo).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })
    expect(a.onRedo).toHaveBeenCalledTimes(2)
  })

  it('输入态（input 内）拦截除 Escape 外的快捷键', () => {
    const a = mkActions()
    renderHook(() => useEditorHotkeys(a))
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'z', metaKey: true })
    fireEvent.keyDown(input, { key: 'Delete' })
    expect(a.onUndo).not.toHaveBeenCalled()
    expect(a.onDeleteNodes).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(a.onEscape).toHaveBeenCalledTimes(1)
    input.remove()
  })

  it('Delete 删除选中：节点优先于连线；无选中不动作', () => {
    const a = mkActions({ selectedNodeIds: () => ['n1', 'n2'], selectedEdgeIds: () => ['e1'] })
    renderHook(() => useEditorHotkeys(a))
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(a.onDeleteNodes).toHaveBeenCalledWith(['n1', 'n2'])
    expect(a.onDeleteEdges).not.toHaveBeenCalled()
  })

  it('Backspace 在仅选中连线时删除连线', () => {
    const a = mkActions({ selectedEdgeIds: () => ['e1'] })
    renderHook(() => useEditorHotkeys(a))
    fireEvent.keyDown(document.body, { key: 'Backspace' })
    expect(a.onDeleteEdges).toHaveBeenCalledWith(['e1'])
    expect(a.onDeleteNodes).not.toHaveBeenCalled()
  })

  it('画布外 pointerdown 触发失焦收起；浮层区域内不触发', () => {
    const a = mkActions()
    renderHook(() => useEditorHotkeys(a))
    fireEvent.pointerDown(document.body)
    expect(a.onCloseTransient).toHaveBeenCalledTimes(1)

    const plus = document.createElement('div')
    plus.className = 'editor-plus'
    document.body.appendChild(plus)
    fireEvent.pointerDown(plus)
    expect(a.onCloseTransient).toHaveBeenCalledTimes(1)

    const settings = document.createElement('div')
    settings.setAttribute('data-pw-settings', '')
    document.body.appendChild(settings)
    fireEvent.pointerDown(settings)
    expect(a.onCloseTransient).toHaveBeenCalledTimes(1)
    plus.remove()
    settings.remove()
  })

  it('卸载后移除监听，不再响应', () => {
    const a = mkActions()
    const { unmount } = renderHook(() => useEditorHotkeys(a))
    unmount()
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true })
    expect(a.onUndo).not.toHaveBeenCalled()
  })
})
