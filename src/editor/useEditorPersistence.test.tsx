// @vitest-environment happy-dom
/**
 * 防抖落盘装配 hook（从 EditorWindow 搬迁，§3/§10.2）：视口标脏落盘与保存
 * 失败横幅上浮/重试成功后清除。防抖节律本身由 useDebouncedSave 单测覆盖，
 * 这里只守护装配语义（视口 ref、文档构建与诊断通道）。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useEditorPersistence } from './useEditorPersistence'
import type { ProjectContent } from '../model/content'

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
}

function setup() {
  const onSave = vi.fn<(doc: ProjectContent) => void | Promise<void>>()
  const { result } = renderHook(() => {
    const doc = useEditorDocument(PROJECT)
    return { doc, persistence: useEditorPersistence(PROJECT, doc, onSave) }
  })
  return { result, onSave }
}

/** 推进防抖窗口并让在途保存的 Promise 结算。 */
const flush = async () => {
  await act(async () => {
    vi.advanceTimersByTime(700)
    await Promise.resolve()
  })
}

describe('useEditorPersistence（§3/§10.2）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('onMoveEnd 更新视口 ref，并按最新视口构建文档落盘', async () => {
    const { result, onSave } = setup()
    act(() => result.current.persistence.onMoveEnd(null, { x: 5, y: 6, zoom: 2 }))
    expect(result.current.doc.viewportRef.current).toEqual({ x: 5, y: 6, zoom: 2 })

    await flush()
    expect(onSave).toHaveBeenCalled()
    const saved = onSave.mock.calls[onSave.mock.calls.length - 1][0]
    expect(saved).toMatchObject({ name: '测试项目', viewport: { x: 5, y: 6, zoom: 2 } })
  })

  it('保存失败上浮横幅文案，自动重试成功后清除', async () => {
    const { result, onSave } = setup()
    onSave.mockRejectedValueOnce(new Error('磁盘已满'))
    act(() => result.current.persistence.onMoveEnd(null, { x: 0, y: 0, zoom: 1 }))

    await flush()
    expect(result.current.persistence.saveError).toBe('磁盘已满')

    await flush()
    expect(result.current.persistence.saveError).toBeNull()
  })
})
