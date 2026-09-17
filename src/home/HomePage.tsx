import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActionErrorBanner, type HomeActionFailure } from './ActionErrorBanner'
import { ProjectCard } from './ProjectCard'
import { OpenErrorBanner, type OpenProjectError } from './OpenErrorBanner'
import { ConfirmDeleteDialog, RenameDialog } from './Dialogs'
import { filterProjects, type ProjectSummary } from './projects'

interface HomePageProps {
  readonly projects: ProjectSummary[]
  /** 列表首次加载中（持久化命令异步返回）；加载完前不显示空状态引导。 */
  readonly loading?: boolean
  /** 最近一次打开失败的可见反馈（issue #98）：非阻塞横幅展示，停留至
   * 下一次打开尝试或新建成功；null/缺省 = 无待展示错误。 */
  readonly openError?: OpenProjectError | null
  /** 最近一次项目变更失败（issue #132）：创建/重命名/复制/删除的存储
   * 拒绝以非阻塞横幅呈现（动作 + 目标 + 诊断 + 重试）；新一次变更尝试
   * 即视为旧错误过时。null/缺省 = 无待展示错误。 */
  readonly mutationError?: HomeActionFailure | null
  /** 变更失败横幅的重试入口（同参重发失败的动作）。 */
  readonly onRetryMutation?: () => void
  /** 列表读取失败诊断（issue #133）：无已知列表时以错误态代替首次使用
   * 引导；已有列表时保留卡片并显示刷新失败横幅。null/缺省 = 无错误。 */
  readonly loadError?: string | null
  /** 错误态/横幅的重试入口（重新拉取列表）。 */
  readonly onRetryLoad?: () => void
  /** 单击海报卡打开项目，窗口切换为编辑器（文档式双界面，§3.1；应用方修订：由双击改单击）。 */
  readonly onOpenProject: (id: string) => void
  /** 工具栏「＋ 新建项目」、网格末尾「＋ 新剧」与空状态引导共用此入口。 */
  readonly onCreateProject: () => void
  /** 卡片菜单 · 重命名（§3.2）。 */
  readonly onRenameProject: (id: string, name: string) => void
  /** 卡片菜单 · 复制（§3.2）。 */
  readonly onDuplicateProject: (id: string) => void
  /** 卡片菜单 · 删除（§3.2，确认对话框在本层弹出）。 */
  readonly onDeleteProject: (id: string) => void
}

/** 项目菜单的关闭语义（§3.2；自 HomePage 拆出以守祖父化组件行数）：
 * Esc 或点击菜单外任意处关闭；菜单内容元素（.editor-ctx 内）上的按下
 * 不关闭。 */
function useMenuDismiss(
  menu: { x: number; y: number; id: string } | null,
  close: () => void,
) {
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      // e.target 可能是非 Element 的 EventTarget（如 document），安全判断避免抛错
      const target = e.target
      if (target instanceof Element && !target.closest('.editor-ctx')) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, close])
}

/**
 * 项目首页（文档浏览器）：竖版海报片库（docs/ui-design.md §3.2）。
 * 工具栏 = 搜索框（内存过滤）+「＋ 新建项目」；卡片右键或悬停 ⋯ 打开
 * 项目菜单（打开/重命名/复制/删除）；无项目时居中展示空状态引导。
 */
/** 项目卡菜单/重命名/删除状态机（HomePage 拆分，issue #99）：右键菜单位
 * 置态、两步对话框态与「动作后收起菜单」收口。 */
function useProjectMenus(
  projects: ProjectSummary[],
  actions: {
    readonly onOpen: (id: string) => void
    readonly onRename: (id: string, name: string) => void
    readonly onDuplicate: (id: string) => void
    readonly onDelete: (id: string) => void
  },
) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  )
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const openMenu = (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    project: ProjectSummary,
  ) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, id: project.id })
  }
  const closeMenu = useCallback(() => setMenu(null), [])
  useMenuDismiss(menu, closeMenu)
  const menuProject = menu ? projects.find((p) => p.id === menu.id) : undefined
  return {
    menu,
    menuProject,
    renaming,
    deleting,
    openMenu,
    open: (id: string) => {
      actions.onOpen(id)
      setMenu(null)
    },
    rename: (project: ProjectSummary) => {
      setRenaming(project)
      setMenu(null)
    },
    duplicate: (id: string) => {
      actions.onDuplicate(id)
      setMenu(null)
    },
    requestDelete: (project: ProjectSummary) => {
      setDeleting(project)
      setMenu(null)
    },
    closeRename: () => setRenaming(null),
    confirmRename: (id: string, name: string) => {
      actions.onRename(id, name)
      setRenaming(null)
    },
    closeDelete: () => setDeleting(null),
    confirmDelete: (id: string) => {
      actions.onDelete(id)
      setDeleting(null)
    },
  }
}

/** 首页标题栏（HomePage 拆分，issue #99）：搜索与新建入口。 */
function HomeTitlebar({
  query,
  onQuery,
  onCreate,
}: {
  readonly query: string
  readonly onQuery: (value: string) => void
  readonly onCreate: () => void
}) {
  return (
    <header className="home-titlebar" data-tauri-drag-region>
      <span className="home-title" data-tauri-drag-region>
        PlotWeave
      </span>
      <span className="home-titlebar-actions">
        <input
          className="home-search"
          type="search"
          placeholder="🔍 搜索项目"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          aria-label="搜索项目"
        />
        <button type="button" className="home-create" onClick={onCreate}>
          ＋ 新建项目
        </button>
      </span>
    </header>
  )
}

/** 项目网格区（HomePage 拆分，issue #99）：空态引导、无匹配提示与
 * 项目卡网格（末尾常驻新建卡）。 */
/** 列表读取失败的错误块（issue #133）：读取失败 ≠ 空列表——无已知列表
 * 时以错误态代替首次使用引导（诊断 + 重试），绝不让目录级故障伪装成
 * 「你的库是空的」。 */
function ListErrorState({
  loadError,
  onRetry,
}: {
  readonly loadError: string
  readonly onRetry?: () => void
}) {
  return (
    <div className="home-empty" role="alert">
      <p className="home-list-error">
        项目列表加载失败：{loadError}
        <br />
        已有项目未受影响；请检查存储后重试。
      </p>
      {onRetry && (
        <button type="button" className="home-empty-create" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/** 已有列表的刷新失败横幅（issue #133）：保留卡片展示最近一次成功读取。 */
function RefreshErrorBanner({
  loadError,
  onRetry,
}: {
  readonly loadError: string
  readonly onRetry?: () => void
}) {
  return (
    <p className="home-refresh-error" role="alert">
      {`列表刷新失败：${loadError}——当前展示最近一次成功读取的结果`}
      {onRetry ? (
        <button type="button" className="home-retry" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </p>
  )
}

function ProjectGrid({
  loading,
  projects,
  visible,
  query,
  loadError,
  onRetry,
  onCreate,
  onOpen,
  onMenu,
}: {
  readonly loading: boolean
  readonly projects: ProjectSummary[]
  readonly visible: ProjectSummary[]
  readonly query: string
  readonly loadError: string | null
  readonly onRetry?: () => void
  readonly onCreate: () => void
  readonly onOpen: (id: string) => void
  readonly onMenu: (
    e: { clientX: number; clientY: number; preventDefault: () => void },
    project: ProjectSummary,
  ) => void
}) {
  if (!loading && projects.length === 0) {
    if (loadError !== null)
      return <ListErrorState loadError={loadError} onRetry={onRetry} />
    return (
      <div className="home-empty">
        <button type="button" className="home-empty-create" onClick={onCreate}>
          ＋ 创建你的第一部短剧
        </button>
      </div>
    )
  }
  return (
    <main className="home-grid-wrap">
      {visible.length === 0 ? (
        <p className="home-no-match">没有匹配「{query.trim()}」的项目</p>
      ) : (
        <div className="home-grid">
          {visible.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          ))}
          <button type="button" className="project-new" onClick={onCreate}>
            ＋ 新剧
          </button>
        </div>
      )}
    </main>
  )
}

/** 项目右键菜单（HomePage 拆分，issue #99；§3.2：打开/重命名/复制/
 * 删除）。 */
function ProjectMenu({
  menu,
  menuProject,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  readonly menu: { x: number; y: number; id: string }
  readonly menuProject: ProjectSummary
  readonly onOpen: (id: string) => void
  readonly onRename: (project: ProjectSummary) => void
  readonly onDuplicate: (id: string) => void
  readonly onDelete: (project: ProjectSummary) => void
}) {
  return (
    <div
      className="editor-ctx"
      style={{
        left: Math.min(menu.x, window.innerWidth - 150),
        top: menu.y,
      }}
      role="menu"
      aria-label="项目菜单"
    >
      <button
        type="button"
        className="editor-menu-item"
        role="menuitem"
        onClick={() => onOpen(menu.id)}
      >
        打开
      </button>
      <button
        type="button"
        className="editor-menu-item"
        role="menuitem"
        onClick={() => onRename(menuProject)}
      >
        重命名
      </button>
      <button
        type="button"
        className="editor-menu-item"
        role="menuitem"
        onClick={() => onDuplicate(menu.id)}
      >
        ⧉ 复制
      </button>
      <button
        type="button"
        className="editor-menu-item editor-menu-danger"
        role="menuitem"
        onClick={() => onDelete(menuProject)}
      >
        🗑 删除
      </button>
    </div>
  )
}

/** 重命名/删除对话框（HomePage 拆分，issue #99）。 */
function ProjectDialogs({
  renaming,
  deleting,
  onCloseRename,
  onConfirmRename,
  onCloseDelete,
  onConfirmDelete,
}: {
  readonly renaming: ProjectSummary | null
  readonly deleting: ProjectSummary | null
  readonly onCloseRename: () => void
  readonly onConfirmRename: (id: string, name: string) => void
  readonly onCloseDelete: () => void
  readonly onConfirmDelete: (id: string) => void
}) {
  return (
    <>
      {renaming && (
        <RenameDialog
          currentName={renaming.name}
          onCancel={onCloseRename}
          onConfirm={(name) => onConfirmRename(renaming.id, name)}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          title="删除项目"
          message={`删除「${deleting.name}」？项目文件将从磁盘移除，此操作不可撤销。`}
          onCancel={onCloseDelete}
          onConfirm={() => onConfirmDelete(deleting.id)}
        />
      )}
    </>
  )
}

export function HomePage({
  projects,
  loading = false,
  openError = null,
  mutationError = null,
  onRetryMutation,
  loadError = null,
  onRetryLoad,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => filterProjects(projects, query),
    [projects, query],
  )
  const menus = useProjectMenus(projects, {
    onOpen: onOpenProject,
    onRename: onRenameProject,
    onDuplicate: onDuplicateProject,
    onDelete: onDeleteProject,
  })

  return (
    <div className="home-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；按钮与输入框不带
          data-tauri-drag-region，保持可点击。 */}
      <HomeTitlebar
        query={query}
        onQuery={setQuery}
        onCreate={onCreateProject}
      />

      {/* 打开失败横幅（issue #98）：role=alert 即时播报；非阻塞，停留至
          下一次打开尝试或新建成功，不拦截首页任何操作。 */}
      {openError && <OpenErrorBanner error={openError} projects={projects} />}

      {/* 项目变更失败横幅（issue #132）：动作 + 目标 + 诊断 + 同参重试，
          非阻塞，停留至下一次变更尝试或重试成功。 */}
      {mutationError && onRetryMutation && (
        <ActionErrorBanner
          error={mutationError}
          projects={projects}
          onRetry={onRetryMutation}
        />
      )}

      {projects.length > 0 && loadError !== null && (
        <RefreshErrorBanner loadError={loadError} onRetry={onRetryLoad} />
      )}

      <ProjectGrid
        loading={loading}
        projects={projects}
        visible={visible}
        query={query}
        loadError={loadError}
        onRetry={onRetryLoad}
        onCreate={onCreateProject}
        onOpen={onOpenProject}
        onMenu={menus.openMenu}
      />

      {/* 项目菜单（§3.2：打开 / 重命名 / 复制 / 删除） */}
      {menus.menu && menus.menuProject && (
        <ProjectMenu
          menu={menus.menu}
          menuProject={menus.menuProject}
          onOpen={menus.open}
          onRename={menus.rename}
          onDuplicate={menus.duplicate}
          onDelete={menus.requestDelete}
        />
      )}

      <ProjectDialogs
        renaming={menus.renaming}
        deleting={menus.deleting}
        onCloseRename={menus.closeRename}
        onConfirmRename={menus.confirmRename}
        onCloseDelete={menus.closeDelete}
        onConfirmDelete={menus.confirmDelete}
      />
    </div>
  )
}
