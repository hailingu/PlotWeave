/**
 * 集标题与集聚焦编辑（EditorView 拆出的大纲写域，docs/ui-design.md §3.5）：
 * 集 = 编号 + 大纲行内标题（不建集实体表），改名即命令、连续输入按同键合并
 * 为一步撤销，标题清空 = 移除该集命名；集聚焦是纯视图态，不进命令栈。
 */
import { useCallback } from 'react'
import { applyEpisodeTitle } from './episodeTitle'
import type { EditorDocument } from './useEditorDocument'
import type { HistoryCommand } from './history'

/** 大纲集编辑动作组：改名入栈，聚焦仅改视图态。 */
export interface EpisodeEditing {
  renameEpisode: (episode: number, title: string) => void
  toggleEpisodeFocus: (episode: number | null) => void
}

/** 以文档写通道与命令栈实现集标题编辑。 */
export function useEpisodeEditing(
  doc: EditorDocument,
  pushHistory: (cmd: HistoryCommand) => void,
): EpisodeEditing {
  const { episodeTitlesRef, setEpisodeTitles, setFocusedEpisode } = doc

  const renameEpisode = useCallback(
    (no: number, title: string) => {
      const before = episodeTitlesRef.current[no] ?? ''
      setEpisodeTitles((t) => applyEpisodeTitle(t, no, title))
      pushHistory({
        coalesceKey: `episode-title:${no}`,
        undo: () => setEpisodeTitles((t) => applyEpisodeTitle(t, no, before)),
        redo: () => setEpisodeTitles((t) => applyEpisodeTitle(t, no, title)),
      })
    },
    [episodeTitlesRef, pushHistory, setEpisodeTitles],
  )

  const toggleEpisodeFocus = useCallback(
    (no: number | null) => setFocusedEpisode((cur) => (cur === no ? null : no)),
    [setFocusedEpisode],
  )

  return { renameEpisode, toggleEpisodeFocus }
}
