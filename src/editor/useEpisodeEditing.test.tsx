// @vitest-environment happy-dom
/**
 * 集标题与集聚焦编辑 hook（从 EditorWindow 搬迁，§3.5）：改名入栈并按同键
 * 合并、清空 = 移除命名、撤销还原；集聚焦是纯视图态。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useEditorDocument, type EditorProjectContent } from './useEditorDocument'
import { useEpisodeEditing } from './useEpisodeEditing'
import type { HistoryCommand } from './history'

const PROJECT: EditorProjectContent = {
  id: 'p1',
  name: '测试项目',
  nodes: [],
  edges: [],
  settings: { characters: [], locations: [] },
  episodeTitles: { 1: '初遇' },
}

function setup() {
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => {
    const doc = useEditorDocument(PROJECT)
    return { doc, episodes: useEpisodeEditing(doc, pushHistory) }
  })
  return { result, commands }
}

describe('useEpisodeEditing（§3.5 集标题）', () => {
  it('改名按「episode-title:<no>」合并入栈，undo 还原原标题', () => {
    const { result, commands } = setup()
    act(() => result.current.episodes.renameEpisode(1, '重逢'))
    expect(result.current.doc.episodeTitles[1]).toBe('重逢')
    expect(commands).toHaveLength(1)
    expect(commands[0].coalesceKey).toBe('episode-title:1')

    act(() => commands[0].undo())
    expect(result.current.doc.episodeTitles[1]).toBe('初遇')
    act(() => commands[0].redo())
    expect(result.current.doc.episodeTitles[1]).toBe('重逢')
  })

  it('标题清空 = 移除该集命名', () => {
    const { result, commands } = setup()
    act(() => result.current.episodes.renameEpisode(1, '   '))
    expect(result.current.doc.episodeTitles[1]).toBeUndefined()
    act(() => commands[0].undo())
    expect(result.current.doc.episodeTitles[1]).toBe('初遇')
  })

  it('toggleEpisodeFocus：同集再点取消，异集直接切换（不入栈）', () => {
    const { result, commands } = setup()
    act(() => result.current.episodes.toggleEpisodeFocus(1))
    expect(result.current.doc.focusedEpisode).toBe(1)
    act(() => result.current.episodes.toggleEpisodeFocus(1))
    expect(result.current.doc.focusedEpisode).toBeNull()
    act(() => result.current.episodes.toggleEpisodeFocus(2))
    expect(result.current.doc.focusedEpisode).toBe(2)
    expect(commands).toHaveLength(0)
  })
})
