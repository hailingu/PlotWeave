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

describe('useSettingsActions（issue 95 人工详情编辑）', () => {
  it('updateCharacter：名称+小传整体 patch；id/渐变与其他实体不动；undo/redo 还原', () => {
    const { result, setSettings, commands } = setup()
    result.current.settingsActions.updateCharacter('c1', { name: '小黎', bio: '侦探。\n雨夜登场。' })
    expect(setSettings).toHaveBeenCalledTimes(1)
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters[0]).toEqual({ ...base.characters[0], name: '小黎', bio: '侦探。\n雨夜登场。' })
    expect(after.locations).toBe(base.locations)
    commands[0].undo()
    expect(setSettings).toHaveBeenLastCalledWith(base)
    commands[0].redo()
    expect(setSettings).toHaveBeenLastCalledWith(after)
  })

  it('updateCharacter：patch 不含 bio 时保留原小传（未编辑字段保真）', () => {
    const withBio: ProjectSettings = {
      characters: [{ id: 'c1', name: '阿黎', gradient: 'g', bio: '原小传' }],
      locations: [],
    }
    const { result, setSettings } = setup(withBio)
    result.current.settingsActions.updateCharacter('c1', { name: '新名' })
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters[0]).toMatchObject({ id: 'c1', name: '新名', bio: '原小传' })
  })

  it('updateLocation：名称+备注同构', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.updateLocation('l1', { name: '老咖啡馆', note: '雨夜。' })
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.locations[0]).toEqual({ id: 'l1', name: '老咖啡馆', note: '雨夜。' })
    expect(after.characters).toBe(base.characters)
  })

  it('updateCharacter/updateLocation：实体缺失时零派发（不复活已删实体）', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.updateCharacter('gone', { name: 'x' })
    result.current.settingsActions.updateLocation('gone', { name: 'x' })
    expect(setSettings).not.toHaveBeenCalled()
  })
})
