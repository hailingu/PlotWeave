// @vitest-environment happy-dom
/**
 * 面板与瞬态浮层状态 hook（从 EditorWindow 搬迁，§3.4/§4.3）：右栏页切换
 * 语义与两级失焦收起范围（画布外 pointerdown vs Escape）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEditorPanels } from './useEditorPanels'

describe('useEditorPanels（§3.4/§4.3）', () => {
  it('toggleRight：异页切换并展开，同页再点收起，收起后点同页重新展开', () => {
    const { result } = renderHook(() => useEditorPanels())
    expect(result.current.rightTab).toBe('inspector')
    expect(result.current.rightOpen).toBe(true)

    act(() => result.current.toggleRight('ai'))
    expect(result.current.rightTab).toBe('ai')
    expect(result.current.rightOpen).toBe(true)

    act(() => result.current.toggleRight('ai'))
    expect(result.current.rightOpen).toBe(false)

    act(() => result.current.toggleRight('ai'))
    expect(result.current.rightOpen).toBe(true)
  })

  it('toggleSettings 同 id 再点收起，closeSettings 直接收起', () => {
    const { result } = renderHook(() => useEditorPanels())
    act(() => result.current.toggleSettings('n1'))
    expect(result.current.openSettingsId).toBe('n1')
    act(() => result.current.toggleSettings('n1'))
    expect(result.current.openSettingsId).toBeNull()

    act(() => result.current.toggleSettings('n2'))
    act(() => result.current.closeSettings())
    expect(result.current.openSettingsId).toBeNull()
  })

  it('closeTransient 收起设置/＋菜单/右键菜单但保留导出对话框', () => {
    const { result } = renderHook(() => useEditorPanels())
    act(() => {
      result.current.toggleSettings('n1')
      result.current.setPlusOpen(true)
      result.current.setCtxMenu({ x: 1, y: 2 })
      result.current.setExportOpen(true)
    })
    act(() => result.current.closeTransient())
    expect(result.current.openSettingsId).toBeNull()
    expect(result.current.plusOpen).toBe(false)
    expect(result.current.ctxMenu).toBeNull()
    expect(result.current.exportOpen).toBe(true)
  })

  it('closeAllTransient 连导出对话框一起收起', () => {
    const { result } = renderHook(() => useEditorPanels())
    act(() => result.current.setExportOpen(true))
    act(() => result.current.closeAllTransient())
    expect(result.current.exportOpen).toBe(false)
  })
})
