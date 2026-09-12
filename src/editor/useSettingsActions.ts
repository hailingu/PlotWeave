/**
 * 设定集编辑动作（docs/ui-design.md §5）：新增用占位名，改名经 Map 替换，
 * 删除不自动清除节点引用（失效引用由展示层兜底）。每个动作 = 一条
 * patchSettings 命令（before/after 整体替换 settings，入栈可撤销）。
 * 文档动作（issue 56）：新建占位、编辑保存整体 patch、删除——只触碰
 * documents 桶，props 与未参与编辑的桶透传保真。
 */
import { useCallback, useMemo } from 'react'
import type { HistoryCommand } from './history'
import type { SettingsActions } from './panels/LeftPanel'
import {
  createCharacter,
  createDocument,
  createLocation,
  type DocumentEntity,
  type ProjectSettings,
} from './settings'

/** 文档编辑保存的补丁：标题/正文/关联整体替换写到的键。 */
export type DocumentPatch = {
  title?: string
  body?: string
  relatedIds?: DocumentEntity['relatedIds']
}

/** 设定集编辑动作组：patchSettings 供外部直接打补丁，settingsActions 供左栏设定页。 */
export interface SettingsActionBundle {
  patchSettings: (before: ProjectSettings, after: ProjectSettings) => void
  settingsActions: SettingsActions
}

export function useSettingsActions(
  settings: ProjectSettings,
  setSettings: (next: ProjectSettings) => void,
  pushHistory: (cmd: HistoryCommand) => void,
): SettingsActionBundle {
  /** 设定集补丁命令：立即应用 after；undo/redo 闭包整体替换 settings。 */
  const patchSettings = useCallback(
    (before: ProjectSettings, after: ProjectSettings) => {
      setSettings(after)
      pushHistory({ undo: () => setSettings(before), redo: () => setSettings(after) })
    },
    [setSettings, pushHistory],
  )

  const settingsActions = useMemo<SettingsActions>(
    () => ({
      addCharacter: () => {
        const entity = createCharacter('新角色')
        patchSettings(settings, { ...settings, characters: [...settings.characters, entity] })
      },
      renameCharacter: (id: string, name: string) =>
        patchSettings(settings, {
          ...settings,
          characters: settings.characters.map((c) => (c.id === id ? { ...c, name } : c)),
        }),
      deleteCharacter: (id: string) =>
        patchSettings(settings, {
          ...settings,
          characters: settings.characters.filter((c) => c.id !== id),
        }),
      addLocation: () => {
        const entity = createLocation('新地点')
        patchSettings(settings, { ...settings, locations: [...settings.locations, entity] })
      },
      renameLocation: (id: string, name: string) =>
        patchSettings(settings, {
          ...settings,
          locations: settings.locations.map((l) => (l.id === id ? { ...l, name } : l)),
        }),
      deleteLocation: (id: string) =>
        patchSettings(settings, {
          ...settings,
          locations: settings.locations.filter((l) => l.id !== id),
        }),
      addDocument: () => {
        const doc = createDocument()
        patchSettings(settings, { ...settings, documents: [...(settings.documents ?? []), doc] })
      },
      updateDocument: (id: string, patch: DocumentPatch) => {
        if (!settings.documents?.some((d) => d.id === id)) return
        patchSettings(settings, {
          ...settings,
          documents: settings.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        })
      },
      deleteDocument: (id: string) => {
        if (!settings.documents) return
        patchSettings(settings, {
          ...settings,
          documents: settings.documents.filter((d) => d.id !== id),
        })
      },
    }),
    [patchSettings, settings],
  )

  return { patchSettings, settingsActions }
}
