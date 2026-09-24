// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandStack, type HistoryCommand } from './history'
import { useEditorDocument } from './useEditorDocument'
import { useSettingsActions } from './useSettingsActions'
import type { ProjectSettings } from './settings'

const base: ProjectSettings = {
  characters: [
    {
      id: 'c1',
      name: '阿黎',
      gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
    },
  ],
  locations: [{ id: 'l1', name: '咖啡馆' }],
}

function setup(settings: ProjectSettings = base) {
  const setSettings = vi.fn()
  const commands: HistoryCommand[] = []
  const pushHistory = vi.fn((cmd: HistoryCommand) => commands.push(cmd))
  const { result } = renderHook(() =>
    useSettingsActions(settings, setSettings, pushHistory),
  )
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
    result.current.settingsActions.updateCharacter('c1', {
      name: '小黎',
      bio: '侦探。\n雨夜登场。',
    })
    expect(setSettings).toHaveBeenCalledTimes(1)
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.characters[0]).toEqual({
      ...base.characters[0],
      name: '小黎',
      bio: '侦探。\n雨夜登场。',
    })
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
    expect(after.characters[0]).toMatchObject({
      id: 'c1',
      name: '新名',
      bio: '原小传',
    })
  })

  it('updateLocation：名称+备注同构', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.updateLocation('l1', {
      name: '老咖啡馆',
      note: '雨夜。',
    })
    const after = setSettings.mock.calls[0][0] as ProjectSettings
    expect(after.locations[0]).toEqual({
      id: 'l1',
      name: '老咖啡馆',
      note: '雨夜。',
    })
    expect(after.characters).toBe(base.characters)
  })

  it('updateCharacter/updateLocation：实体缺失时零派发（不复活已删实体）', () => {
    const { result, setSettings } = setup()
    result.current.settingsActions.updateCharacter('gone', { name: 'x' })
    result.current.settingsActions.updateLocation('gone', { name: 'x' })
    expect(setSettings).not.toHaveBeenCalled()
  })
})

/** 文档桶回归的设定集夹具（issue 271）：props 透传桶 + 两份文档（含成对关联）。 */
const withDocs: ProjectSettings = {
  characters: [
    {
      id: 'c1',
      name: '阿黎',
      gradient: 'linear-gradient(135deg,#e0176e,#7f6cf0)',
    },
  ],
  locations: [{ id: 'l1', name: '咖啡馆' }],
  props: [{ id: 'p1', name: '道具' }],
  documents: [
    {
      id: 'd1',
      title: '世界观',
      body: '霓虹都市。',
      relatedIds: [
        { kind: 'character', id: 'c1' },
        { kind: 'location', id: 'l1' },
      ],
    },
    { id: 'd2', title: '术语表', body: '', relatedIds: [] },
  ],
}

/** 状态化 harness（issue 271 评审）：真实 useEditorDocument 状态所有者 +
 * 真实 CommandStack，与 useEditorGraphActions 生产装配同构；断言可观察
 * settings 而非 mock 调用记录。 */
function setupStateful(initial: ProjectSettings) {
  const stack = new CommandStack()
  const pushHistory = (cmd: HistoryCommand) => stack.push(cmd)
  const { result } = renderHook(() => {
    const doc = useEditorDocument({
      id: 'p1',
      name: '测试项目',
      nodes: [],
      edges: [],
      settings: initial,
    })
    const { settingsActions } = useSettingsActions(
      doc.settings,
      doc.setSettings,
      pushHistory,
    )
    return { doc, settingsActions }
  })
  return { result, stack }
}

describe('useSettingsActions（issue 271 文档新建：桶缺省与透传）', () => {
  it('documents 缺省时新建单元素桶；undo 后回到缺省、redo 回到新建', async () => {
    const h = setupStateful(base)
    await act(async () => h.result.current.settingsActions.addDocument())
    const created = h.result.current.doc.settings
    expect(created.documents).toHaveLength(1)
    expect(created.documents![0]).toMatchObject({
      title: '新文档',
      body: '',
      relatedIds: [],
    })
    await act(async () => h.stack.undo())
    expect(h.result.current.doc.settings.documents).toBeUndefined()
    await act(async () => h.stack.redo())
    expect(h.result.current.doc.settings.documents).toEqual(created.documents)
  })

  it('桶存在时追加占位：既有文档与 characters/locations/props 引用透传；undo 还原', async () => {
    const h = setupStateful(withDocs)
    await act(async () => h.result.current.settingsActions.addDocument())
    const after = h.result.current.doc.settings
    expect(after.documents).toHaveLength(3)
    expect(after.documents![0]).toEqual(withDocs.documents![0])
    expect(after.characters).toBe(withDocs.characters)
    expect(after.locations).toBe(withDocs.locations)
    expect(after.props).toBe(withDocs.props)
    await act(async () => h.stack.undo())
    expect(h.result.current.doc.settings.documents).toEqual(withDocs.documents)
  })
})

describe('useSettingsActions（issue 271 文档更新/删除：完整文档与关联恢复）', () => {
  it('updateDocument 整体替换目标：兄弟与其他桶不动；undo/redo 还原完整文档（含成对关联）', async () => {
    const h = setupStateful(withDocs)
    const related = [{ kind: 'location' as const, id: 'l1' }]
    await act(async () =>
      h.result.current.settingsActions.updateDocument('d1', {
        title: '世界观·修订',
        body: '暴雨将至。',
        relatedIds: related,
      }),
    )
    const after = h.result.current.doc.settings
    expect(after.documents![0]).toEqual({
      id: 'd1',
      title: '世界观·修订',
      body: '暴雨将至。',
      relatedIds: related,
    })
    expect(after.documents![1]).toBe(withDocs.documents![1])
    expect(after.characters).toBe(withDocs.characters)
    expect(after.props).toBe(withDocs.props)
    await act(async () => h.stack.undo())
    expect(h.result.current.doc.settings.documents).toEqual(withDocs.documents)
    await act(async () => h.stack.redo())
    expect(h.result.current.doc.settings.documents).toEqual(after.documents)
  })

  it('deleteDocument 仅移除目标：undo 恢复完整文档（含关联），redo 再删', async () => {
    const h = setupStateful(withDocs)
    await act(async () => h.result.current.settingsActions.deleteDocument('d2'))
    expect(h.result.current.doc.settings.documents?.map((d) => d.id)).toEqual([
      'd1',
    ])
    expect(h.result.current.doc.settings.characters).toBe(withDocs.characters)
    await act(async () => h.stack.undo())
    expect(h.result.current.doc.settings.documents).toEqual(withDocs.documents)
    await act(async () => h.stack.redo())
    expect(h.result.current.doc.settings.documents?.map((d) => d.id)).toEqual([
      'd1',
    ])
  })
})

describe('useSettingsActions（issue 271 文档守卫：零派发不改语义）', () => {
  it('目标缺失与 documents 桶缺省：settings 引用不变、命令栈为空', async () => {
    const h = setupStateful(withDocs)
    await act(async () =>
      h.result.current.settingsActions.updateDocument('ghost', {
        title: 'x',
      }),
    )
    expect(h.result.current.doc.settings).toBe(withDocs)
    expect(h.stack.canUndo).toBe(false)

    const bare = setupStateful(base)
    await act(async () => {
      bare.result.current.settingsActions.updateDocument('d1', { title: 'x' })
      bare.result.current.settingsActions.deleteDocument('d1')
    })
    expect(bare.result.current.doc.settings).toBe(base)
    expect(bare.stack.canUndo).toBe(false)
  })
})
