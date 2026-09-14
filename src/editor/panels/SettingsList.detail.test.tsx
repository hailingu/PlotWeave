// @vitest-environment happy-dom
/**
 * 设定集人工详情编辑（issue 95）：点击条目展开侧栏内详情表单——
 * 名称/小传·备注回填、保存派发一条 updateCharacter/updateLocation 命令、
 * 取消/Esc（含组合输入）放弃草稿、空名称禁存、空态引导、
 * 新增后自动展开新条目并聚焦名称字段。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsList from './SettingsList'
import type { SettingsActions } from './settingsActions'
import type { ProjectSettings } from '../settings'

afterEach(cleanup)

const BASE: ProjectSettings = {
  characters: [{ id: 'c1', name: '陈默', gradient: 'g1', bio: '落魄侦探。' }],
  locations: [{ id: 'l1', name: '茶馆', note: '老城区。' }],
  documents: [{ id: 'doc-1', title: '人物小传', body: '正文', relatedIds: [] }],
}

function setup(settings: ProjectSettings = BASE) {
  const actions: SettingsActions = {
    addCharacter: vi.fn(),
    renameCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    addLocation: vi.fn(),
    renameLocation: vi.fn(),
    deleteLocation: vi.fn(),
    addDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
    updateCharacter: vi.fn(),
    updateLocation: vi.fn(),
  }
  const view = render(
    <SettingsList
      settings={settings}
      actions={actions}
      onOpenDocument={vi.fn()}
    />,
  )
  return { actions, ...view }
}

describe('设定集空态引导（issue 95）', () => {
  it('空项目显示新增引导文案，三个新增入口可见', () => {
    setup({ characters: [], locations: [] })
    expect(screen.getByText(/暂无设定/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ 新增角色' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ 新增地点' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '＋ 新增文档' })).toBeTruthy()
  })
})

describe('角色详情表单（issue 95）', () => {
  it('点击条目展开控件展开表单：名称与小传回填现值，未派发任何命令', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    expect(screen.getByLabelText('角色名称')).toBeTruthy()
    expect(screen.getByDisplayValue('陈默')).toBeTruthy()
    expect(screen.getByLabelText('角色小传')).toBeTruthy()
    expect(screen.getByDisplayValue('落魄侦探。')).toBeTruthy()
    expect(actions.updateCharacter).not.toHaveBeenCalled()
  })

  it('编辑名称与小传后保存：一次 updateCharacter，名称去空白、多行保留，表单关闭', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '  陈默2 ' },
    })
    fireEvent.change(screen.getByLabelText('角色小传'), {
      target: { value: '侦探。\n雨夜登场。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(actions.updateCharacter).toHaveBeenCalledTimes(1)
    expect(actions.updateCharacter).toHaveBeenCalledWith('c1', {
      name: '陈默2',
      bio: '侦探。\n雨夜登场。',
    })
    expect(screen.queryByLabelText('角色名称')).toBeNull()
  })

  it('名称为纯空白时保存禁用且零派发', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '   ' },
    })
    const save = screen.getByRole('button', {
      name: '保存',
    }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(actions.updateCharacter).not.toHaveBeenCalled()
  })

  it('取消关闭表单且不派发；再次展开显示已提交原值', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    fireEvent.change(screen.getByLabelText('角色小传'), {
      target: { value: '草稿改动' },
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('角色名称')).toBeNull()
    expect(actions.updateCharacter).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    expect(screen.getByDisplayValue('落魄侦探。')).toBeTruthy()
  })

  it('Esc 关闭表单不保存；组合输入中的 Esc 不误关', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    const bio = screen.getByLabelText('角色小传') as HTMLTextAreaElement
    fireEvent.change(bio, { target: { value: '改动' } })
    fireEvent.keyDown(bio, { key: 'Escape' })
    expect(screen.queryByLabelText('角色名称')).toBeNull()
    expect(actions.updateCharacter).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    const reopened = screen.getByLabelText('角色小传') as HTMLTextAreaElement
    fireEvent.keyDown(reopened, { key: 'Escape', isComposing: true })
    expect(screen.getByLabelText('角色名称')).toBeTruthy()
  })
})

describe('新增自动展开（issue 95）', () => {
  it('新增角色后新条目自动展开详情并聚焦名称输入框', () => {
    const view = setup()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增角色' }))
    view.rerender(
      <SettingsList
        settings={{
          ...BASE,
          characters: [
            ...BASE.characters,
            { id: 'c2', name: '新角色', gradient: 'g2' },
          ],
        }}
        actions={view.actions}
        onOpenDocument={vi.fn()}
      />,
    )
    const nameInput = screen.getByLabelText('角色名称') as HTMLInputElement
    expect(document.activeElement).toBe(nameInput)
    expect(view.actions.addCharacter).toHaveBeenCalledTimes(1)
  })
})

describe('地点详情表单（issue 95）', () => {
  it('展开回填名称与备注；保存派发一次 updateLocation', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑地点 茶馆'))
    expect(screen.getByDisplayValue('茶馆')).toBeTruthy()
    expect(screen.getByDisplayValue('老城区。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('地点名称'), {
      target: { value: '老茶馆' },
    })
    fireEvent.change(screen.getByLabelText('地点备注'), {
      target: { value: '雨夜灯笼。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(actions.updateLocation).toHaveBeenCalledTimes(1)
    expect(actions.updateLocation).toHaveBeenCalledWith('l1', {
      name: '老茶馆',
      note: '雨夜灯笼。',
    })
  })
})

describe('跨桶同 id 共存（PR #97 评审：独立 id 空间，数据模型 §8.1）', () => {
  const DUP: ProjectSettings = {
    characters: [{ id: 'dup-1', name: '陈默', gradient: 'g1' }],
    locations: [{ id: 'dup-1', name: '茶馆' }],
  }

  it('点击角色展开钮只展开角色表单，不同时展开同 id 地点表单', () => {
    const { actions } = setup(DUP)
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    expect(screen.getByLabelText('角色名称')).toBeTruthy()
    expect(screen.queryByLabelText('地点名称')).toBeNull()
    expect(actions.updateCharacter).not.toHaveBeenCalled()
  })

  it('点击地点展开钮只展开地点表单，不同时展开同 id 角色表单', () => {
    setup(DUP)
    fireEvent.click(screen.getByLabelText('编辑地点 茶馆'))
    expect(screen.getByLabelText('地点名称')).toBeTruthy()
    expect(screen.queryByLabelText('角色名称')).toBeNull()
  })
})

describe('并行编辑与按钮焦点（PR #97 评审第二轮）', () => {
  const RENAMED: ProjectSettings = {
    characters: [
      { id: 'c1', name: '陈默大侠', gradient: 'g1', bio: '落魄侦探。' },
    ],
    locations: BASE.locations,
  }

  it('表单打开期间行内改名提交：未触碰的名称字段跟随已提交值，保存不回退改名', () => {
    const view = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    // 行内改名（EditableName：双击进入 → 输入 → Enter 提交）
    fireEvent.doubleClick(screen.getByRole('button', { name: '陈默' }))
    const renameInput = screen.getByLabelText('角色名 陈默') as HTMLInputElement
    fireEvent.change(renameInput, { target: { value: '陈默大侠' } })
    fireEvent.keyDown(renameInput, { key: 'Enter' })
    fireEvent.blur(renameInput)
    expect(view.actions.renameCharacter).toHaveBeenCalledWith('c1', '陈默大侠')
    // 提交改名后 settings 更新：表单未触碰的名称输入框应显示最新已提交名
    view.rerender(
      <SettingsList
        settings={RENAMED}
        actions={view.actions}
        onOpenDocument={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('角色名称') as HTMLInputElement).value).toBe(
      '陈默大侠',
    )
    fireEvent.change(screen.getByLabelText('角色小传'), {
      target: { value: '新小传' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(view.actions.updateCharacter).toHaveBeenCalledWith('c1', {
      name: '陈默大侠',
      bio: '新小传',
    })
  })

  it('已触碰的名称字段保留用户草稿，外部改名不覆盖（快照基线边界）', () => {
    const view = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    fireEvent.change(screen.getByLabelText('角色名称'), {
      target: { value: '草稿名' },
    })
    view.rerender(
      <SettingsList
        settings={RENAMED}
        actions={view.actions}
        onOpenDocument={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('角色名称') as HTMLInputElement).value).toBe(
      '草稿名',
    )
    fireEvent.change(screen.getByLabelText('角色小传'), {
      target: { value: '新小传' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(view.actions.updateCharacter).toHaveBeenCalledWith('c1', {
      name: '草稿名',
      bio: '新小传',
    })
  })

  it('焦点移到表单操作按钮后按 Esc 仍丢弃草稿并关闭表单', () => {
    const { actions } = setup()
    fireEvent.click(screen.getByLabelText('编辑角色 陈默'))
    fireEvent.change(screen.getByLabelText('角色小传'), {
      target: { value: '草稿' },
    })
    const cancel = screen.getByRole('button', { name: '取消' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(screen.queryByLabelText('角色名称')).toBeNull()
    expect(actions.updateCharacter).not.toHaveBeenCalled()
  })
})

describe('设定集列表类名命名空间（issue 95 构建版面板空白回归）', () => {
  it('列表根不复用节点设置弹层的根类 pw-settings（settings.css 锚定弹层契约），避免被其绝对定位规则劫持', () => {
    setup()
    const root = screen.getByRole('region', { name: '设定集' })
    expect([...root.classList]).not.toContain('pw-settings')
  })
})
