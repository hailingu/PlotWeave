/**
 * 设定集编辑动作（docs/ui-design.md §5）：新增用占位名，改名经 Map 替换，
 * 删除不自动清除节点引用（失效引用由展示层兜底）。每个动作 = 一条
 * patchSettings 命令（before/after 整体替换 settings，入栈可撤销）。
 */
import { useCallback, useMemo } from 'react'
import type { HistoryCommand } from './history'
import type { SettingsActions } from './panels/LeftPanel'
import {
  createCharacter,
  createLocation,
  type ProjectSettings,
} from './settings'

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
    }),
    [patchSettings, settings],
  )

  return { patchSettings, settingsActions }
}
