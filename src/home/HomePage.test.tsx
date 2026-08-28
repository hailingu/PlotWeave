// @vitest-environment happy-dom
/**
 * 首页（文档浏览器）组件测试：搜索过滤、空状态/加载态切换、项目菜单
 * 四动作（打开/重命名/复制/删除）与两个对话框的提交/取消路径。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import HomePage from './HomePage'
import type { ProjectSummary } from './projects'

afterEach(cleanup)

const mk = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'p1',
  name: '都市奇缘',
  sceneCount: 3,
  updatedAt: new Date().toISOString(),
  ...over,
})

function setup(projects: ProjectSummary[] = [mk()], loading = false) {
  const spies = {
    onOpenProject: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
  }
  render(<HomePage projects={projects} loading={loading} {...spies} />)
  return spies
}

describe('HomePage 列表与搜索', () => {
  it('渲染项目卡；单击海报触发 onOpenProject', () => {
    const spies = setup()
    fireEvent.click(screen.getByRole('button', { name: '打开项目 都市奇缘' }))
    expect(spies.onOpenProject).toHaveBeenCalledWith('p1')
  })

  it('搜索框内存过滤；无匹配时显示提示', () => {
    setup([mk(), mk({ id: 'p2', name: '午夜出租车' })])
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目' }), {
      target: { value: '出租车' },
    })
    expect(screen.queryByRole('button', { name: '打开项目 都市奇缘' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开项目 午夜出租车' })).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目' }), {
      target: { value: '不存在' },
    })
    expect(screen.getByText(/没有匹配/)).toBeTruthy()
  })

  it('空项目显示创建引导；loading 期间不显示', () => {
    const spies = setup([])
    fireEvent.click(screen.getByRole('button', { name: '＋ 创建你的第一部短剧' }))
    expect(spies.onCreateProject).toHaveBeenCalledTimes(1)

    cleanup()
    setup([], true)
    expect(screen.queryByRole('button', { name: '＋ 创建你的第一部短剧' })).toBeNull()
  })

  it('工具栏「＋ 新建项目」与网格末尾「＋ 新剧」都走 onCreateProject', () => {
    const spies = setup()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新建项目' }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 新剧' }))
    expect(spies.onCreateProject).toHaveBeenCalledTimes(2)
  })
})

describe('HomePage 项目菜单', () => {
  const openMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: '项目菜单 都市奇缘' }))
    return screen.getByRole('menu', { name: '项目菜单' })
  }

  it('⋯ 打开菜单；「打开」触发 onOpenProject 并关闭菜单', () => {
    const spies = setup()
    const menu = openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '打开' }))
    expect(spies.onOpenProject).toHaveBeenCalledWith('p1')
    expect(menu.isConnected).toBe(false)
  })

  it('Esc 与菜单外点击都关闭菜单', () => {
    setup()
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    openMenu()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('「⧉ 复制」触发 onDuplicateProject', () => {
    const spies = setup()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '⧉ 复制' }))
    expect(spies.onDuplicateProject).toHaveBeenCalledWith('p1')
  })
})

describe('HomePage 重命名流程', () => {
  const openRename = () => {
    fireEvent.click(screen.getByRole('button', { name: '项目菜单 都市奇缘' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    return screen.getByRole('textbox', { name: '项目名' }) as HTMLInputElement
  }

  it('改名后 Enter 提交 onRenameProject 并关闭对话框', () => {
    const spies = setup()
    const input = openRename()
    expect(input.value).toBe('都市奇缘')
    fireEvent.change(input, { target: { value: '  新名字  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spies.onRenameProject).toHaveBeenCalledWith('p1', '新名字')
    expect(screen.queryByRole('dialog', { name: '重命名项目' })).toBeNull()
  })

  it('名字未变时提交视为取消（不触发 onRenameProject）', () => {
    const spies = setup()
    const input = openRename()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spies.onRenameProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '重命名项目' })).toBeNull()
  })

  it('空白名禁用提交按钮；Esc 取消', () => {
    const spies = setup()
    const input = openRename()
    fireEvent.change(input, { target: { value: '   ' } })
    const submit = screen.getByRole('button', { name: '重命名', hidden: false })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(spies.onRenameProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '重命名项目' })).toBeNull()
  })
})

describe('HomePage 删除流程', () => {
  const openDelete = () => {
    fireEvent.click(screen.getByRole('button', { name: '项目菜单 都市奇缘' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '🗑 删除' }))
  }

  it('确认后触发 onDeleteProject 并关闭对话框', () => {
    const spies = setup()
    openDelete()
    expect(screen.getByText(/删除「都市奇缘」？/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(spies.onDeleteProject).toHaveBeenCalledWith('p1')
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
  })

  it('Esc 取消删除（不触发 onDeleteProject）', () => {
    const spies = setup()
    openDelete()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(spies.onDeleteProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除项目' })).toBeNull()
  })
})
