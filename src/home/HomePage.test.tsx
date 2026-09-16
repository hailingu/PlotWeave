// @vitest-environment happy-dom
/**
 * 首页（文档浏览器）组件测试：搜索过滤、空状态/加载态切换、项目菜单
 * 四动作（打开/重命名/复制/删除）与两个对话框的提交/取消路径。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import HomePage from './HomePage'
import type { OpenProjectError } from './OpenErrorBanner'
import type { ProjectSummary } from './projects'

afterEach(cleanup)

const mk = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'p1',
  name: '都市奇缘',
  sceneCount: 3,
  updatedAt: new Date().toISOString(),
  ...over,
})

function setup(
  projects: ProjectSummary[] = [mk()],
  loading = false,
  openError: OpenProjectError | null = null,
  loadError: string | null = null,
) {
  const spies = {
    onOpenProject: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onRetryLoad: vi.fn(),
  }
  render(
    <HomePage
      projects={projects}
      loading={loading}
      openError={openError}
      loadError={loadError}
      {...spies}
    />,
  )
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
    expect(
      screen.queryByRole('button', { name: '打开项目 都市奇缘' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: '打开项目 午夜出租车' }),
    ).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目' }), {
      target: { value: '不存在' },
    })
    expect(screen.getByText(/没有匹配/)).toBeTruthy()
  })

  it('空项目显示创建引导；loading 期间不显示', () => {
    const spies = setup([])
    fireEvent.click(
      screen.getByRole('button', { name: '＋ 创建你的第一部短剧' }),
    )
    expect(spies.onCreateProject).toHaveBeenCalledTimes(1)

    cleanup()
    setup([], true)
    expect(
      screen.queryByRole('button', { name: '＋ 创建你的第一部短剧' }),
    ).toBeNull()
  })

  it('工具栏「＋ 新建项目」与网格末尾「＋ 新剧」都走 onCreateProject', () => {
    const spies = setup()
    fireEvent.click(screen.getByRole('button', { name: '＋ 新建项目' }))
    fireEvent.click(screen.getByRole('button', { name: '＋ 新剧' }))
    expect(spies.onCreateProject).toHaveBeenCalledTimes(2)
  })
})

describe('HomePage 列表读取失败错误态（issue #133）', () => {
  it('无已知列表时显示错误态与重试，不显示首次使用引导', () => {
    const spies = setup([], false, null, '读取设置目录失败：权限不足')
    expect(
      screen.queryByRole('button', { name: '＋ 创建你的第一部短剧' }),
    ).toBeNull()
    expect(screen.getByText(/项目列表加载失败/)).toBeTruthy()
    expect(screen.getByText(/权限不足/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(spies.onRetryLoad).toHaveBeenCalledTimes(1)
    // 工具栏新建仍可用：错误态不拦截创建入口
    expect(screen.getByRole('button', { name: '＋ 新建项目' })).toBeTruthy()
  })

  it('已有列表时刷新失败：卡片保留并显示诊断横幅与重试', () => {
    const spies = setup([mk()], false, null, '读取设置目录失败：权限不足')
    expect(
      screen.getByRole('button', { name: '打开项目 都市奇缘' }),
    ).toBeTruthy()
    expect(screen.getByText(/刷新失败/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(spies.onRetryLoad).toHaveBeenCalledTimes(1)
  })

  it('无错误时空态与网格行为不变', () => {
    setup([])
    expect(
      screen.getByRole('button', { name: '＋ 创建你的第一部短剧' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })
})

describe('HomePage 打开失败横幅（issue #98）', () => {
  it('openError 命中列表项目：横幅点名项目并显示可读原因；卡片仍可操作', () => {
    const spies = setup([mk()], false, {
      id: 'p1',
      detail: '文档版本过新（schemaVersion 2），请升级应用',
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('打开「都市奇缘」失败')
    expect(alert.textContent).toContain('请升级应用')
    // 横幅非阻塞：打开失败后首页操作能力保留（issue #98 期望结果）
    fireEvent.click(screen.getByRole('button', { name: '打开项目 都市奇缘' }))
    expect(spies.onOpenProject).toHaveBeenCalledWith('p1')
  })

  it('openError 的项目不在列表（损坏文件可能未进列表）：用通用文案', () => {
    setup([], false, { id: 'ghost', detail: '项目文件不可读' })
    expect(screen.getByRole('alert').textContent).toBe(
      '打开项目失败：项目文件不可读',
    )
  })

  it('无 openError 时不渲染横幅', () => {
    setup()
    expect(screen.queryByRole('alert')).toBeNull()
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
