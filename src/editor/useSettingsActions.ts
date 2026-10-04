/**
 * 设定集编辑动作（docs/ui-design.md §5）：新增用占位名，改名经 Map 替换，
 * 删除不自动清除节点引用（失效引用由展示层兜底）。每个动作 = 一条
 * patchSettings 命令（before/after 整体替换 settings，入栈可撤销）。
 * 文档动作（issue 56）：新建占位、编辑保存整体 patch、删除——只触碰
 * documents 桶，props 与未参与编辑的桶透传保真。
 * 详情保存（issue 95）：updateCharacter/updateLocation 整体替换目标实体，
 * id/渐变与未编辑字段、其他实体保真；实体缺失零派发（不复活已删实体）。
 * 动作按桶拆为模块级工厂（PR #97 评审：函数 80 行上限），钩子只做组合。
 */
import { useCallback, useMemo } from 'react'
import type { HistoryCommand } from './history'
import type { SettingsActions } from './panels/settingsActions'
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

type Patch = (before: ProjectSettings, after: ProjectSettings) => void

/** 角色桶动作：各自 = 一条 patchSettings 命令（§5；issue 95 增详情保存）。 */
function characterActions(settings: ProjectSettings, patchSettings: Patch) {
  return {
    addCharacter: () => {
      const entity = createCharacter('新角色')
      patchSettings(settings, {
        ...settings,
        characters: [...settings.characters, entity],
      })
    },
    renameCharacter: (id: string, name: string) =>
      patchSettings(settings, {
        ...settings,
        characters: settings.characters.map((c) =>
          c.id === id ? { ...c, name } : c,
        ),
      }),
    deleteCharacter: (id: string) =>
      patchSettings(settings, {
        ...settings,
        characters: settings.characters.filter((c) => c.id !== id),
      }),
    /** 保存角色详情（issue 95）：缺失 id 零派发，同 updateDocument 守卫。 */
    updateCharacter: (id: string, p: { name?: string; bio?: string }) => {
      if (!settings.characters.some((c) => c.id === id)) return
      patchSettings(settings, {
        ...settings,
        characters: settings.characters.map((c) =>
          c.id === id ? { ...c, ...p } : c,
        ),
      })
    },
  }
}

/** 地点桶动作：同角色桶同构（issue 95 增详情保存）。 */
function locationActions(settings: ProjectSettings, patchSettings: Patch) {
  return {
    addLocation: () => {
      const entity = createLocation('新地点')
      patchSettings(settings, {
        ...settings,
        locations: [...settings.locations, entity],
      })
    },
    renameLocation: (id: string, name: string) =>
      patchSettings(settings, {
        ...settings,
        locations: settings.locations.map((l) =>
          l.id === id ? { ...l, name } : l,
        ),
      }),
    deleteLocation: (id: string) =>
      patchSettings(settings, {
        ...settings,
        locations: settings.locations.filter((l) => l.id !== id),
      }),
    /** 保存地点详情（issue 95）：同 updateCharacter 同构。 */
    updateLocation: (id: string, p: { name?: string; note?: string }) => {
      if (!settings.locations.some((l) => l.id === id)) return
      patchSettings(settings, {
        ...settings,
        locations: settings.locations.map((l) =>
          l.id === id ? { ...l, ...p } : l,
        ),
      })
    },
  }
}

/** 文档桶动作（issue 56）：新建占位、编辑保存整体 patch、删除。 */
function documentActions(settings: ProjectSettings, patchSettings: Patch) {
  return {
    addDocument: () => {
      const doc = createDocument()
      patchSettings(settings, {
        ...settings,
        documents: [...(settings.documents ?? []), doc],
      })
    },
    updateDocument: (id: string, p: DocumentPatch) => {
      if (!settings.documents?.some((d) => d.id === id)) return
      patchSettings(settings, {
        ...settings,
        documents: settings.documents.map((d) =>
          d.id === id ? { ...d, ...p } : d,
        ),
      })
    },
    deleteDocument: (id: string) => {
      // 缺失目标（含桶缺省）零派发（PR #298 评审）：与 updateDocument 同族
      // 守卫——过期 id 不得替换 settings 对象或入栈空操作命令
      if (!settings.documents?.some((d) => d.id === id)) return
      patchSettings(settings, {
        ...settings,
        documents: settings.documents.filter((d) => d.id !== id),
      })
    },
  }
}

/** 设定集编辑动作组（§5）：patchSettings 供外部直接打补丁，settingsActions
 * 由三桶工厂组合（useMemo 随 settings 重建，闭包取派发时最新快照）。 */
export function useSettingsActions(
  settings: ProjectSettings,
  setSettings: (next: ProjectSettings) => void,
  pushHistory: (cmd: HistoryCommand) => void,
): SettingsActionBundle {
  /** 设定集补丁命令：立即应用 after；undo/redo 闭包整体替换 settings。 */
  const patchSettings = useCallback(
    (before: ProjectSettings, after: ProjectSettings) => {
      setSettings(after)
      pushHistory({
        undo: () => setSettings(before),
        redo: () => setSettings(after),
      })
    },
    [setSettings, pushHistory],
  )

  const settingsActions = useMemo<SettingsActions>(
    () => ({
      ...characterActions(settings, patchSettings),
      ...locationActions(settings, patchSettings),
      ...documentActions(settings, patchSettings),
    }),
    [patchSettings, settings],
  )

  return { patchSettings, settingsActions }
}
