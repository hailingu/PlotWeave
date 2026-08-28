// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryCommand } from './history'
import { useSettingsActions } from './useSettingsActions'
import type { ProjectSettings } from './settings'

const base: ProjectSettings = {
  characters: [{ id: 'c1', name: '阿黎', gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)' }],
  locations: [{ id: 'l1', name: '咖啡馆' }],
}

function setup(settings: ProjectSettings = base) {
  const setSettings = vi.fn()
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() => useSettingsActions(settings, setSettings, pushHistory))
  return { result, setSettings, pushHistory, commands }
}

describe('useSettingsActions（§5 设定集编辑动作 = 补丁命令）', () => {
  it('addCharacter：追加占位名「新角色」实体并入栈；undo 还原 before', () => {
    const { result, setSettings, commands } = setup()
    result.current.settingsActions.addCharacter()
    expect(setSettings).toHaveBeenCalledTimes(1)
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters).toHaveLength(2)
    expect(after.characters[1].name).toBe('新角色')
    expect(commands).toHaveLength(1)
    commands[0].undo()
    expect(setSettings).toHaveBeenLastCalledWith(base)
    commands[0].redo()
    expect(setSettings).toHaveBeenLastCalledWith(after)
  })

  it('renameCharacter：按 id Map 替换，其余不动', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.renameCharacter('c1', '小黎')
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters[0]).toMatchObject({ id: 'c1', name: '小黎' })
    expect(after.locations).toBe(base.locations)
  })

  it('deleteCharacter：过滤该 id（不自动清除节点引用）', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.deleteCharacter('c1')
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters).toEqual([])
  })

  it('addLocation / renameLocation / deleteLocation 同构', () => {
    const { result, setSettings, commands } = setup()
    result.current.settingsActions.addLocation()
    let after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.locations).toHaveLength(2)
    expect(after.locations[1].name).toBe('新地点')

    result.current.settingsActions.renameLocation('l1', '旧咖啡馆')
    after = setSettings.mock.calls[1][0] as ProjectSettings
    expect(after.locations[0].name).toBe('旧咖啡馆')

    result.current.settingsActions.deleteLocation('l1')
    after = setSettings.mock.calls[2][0] as ProjectSettings
    expect(after.locations).toEqual([])
    expect(commands).toHaveLength(3)
  })

  it('patchSettings 直用：立即应用 after，命令 undo/redo 整体替换', () => {
    const { result, setSettings, commands } = setup()
    const after: ProjectSettings = { characters: [], locations: [] }
    result.current.patchSettings(base, after)
    expect(setSettings).toHaveBeenLastCalledWith(after)
    commands[0].undo()
    expect(setSettings).toHaveBeenLastCalledWith(base)
  })
})
