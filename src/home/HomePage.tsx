import { useCallback, useEffect, useMemo, useState } from 'react'
import ProjectCard from './ProjectCard'
import OpenErrorBanner, { type OpenProjectError } from './OpenErrorBanner'
import { ConfirmDeleteDialog, RenameDialog } from './Dialogs'
import { filterProjects, type ProjectSummary } from './projects'

interface HomePageProps {
  readonly projects: ProjectSummary[]
  /** 列表首次加载中（持久化命令异步返回）；加载完前不显示空状态引导。 */
  readonly loading?: boolean
  /** 最近一次打开失败的可见反馈（issue #98）：非阻塞横幅展示，停留至
   * 下一次打开尝试或新建成功；null/缺省 = 无待展示错误。 */
  readonly openError?: OpenProjectError | null
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
export default function HomePage({
  projects,
  loading = false,
  openError = null,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  )
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const visible = useMemo(
    () => filterProjects(projects, query),
    [projects, query],
  )

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

  return (
    <div className="home-root">
      {/* Overlay 标题栏下整行作为窗口拖拽区；按钮与输入框不带
          data-tauri-drag-region，保持可点击。 */}
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
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索项目"
          />
          <button
            type="button"
            className="home-create"
            onClick={onCreateProject}
          >
            ＋ 新建项目
          </button>
        </span>
      </header>

      {/* 打开失败横幅（issue #98）：role=alert 即时播报；非阻塞，停留至
          下一次打开尝试或新建成功，不拦截首页任何操作。 */}
      {openError && <OpenErrorBanner error={openError} projects={projects} />}

      {!loading && projects.length === 0 ? (
        <div className="home-empty">
          <button
            type="button"
            className="home-empty-create"
            onClick={onCreateProject}
          >
            ＋ 创建你的第一部短剧
          </button>
        </div>
      ) : (
        <main className="home-grid-wrap">
          {visible.length === 0 ? (
            <p className="home-no-match">没有匹配「{query.trim()}」的项目</p>
          ) : (
            <div className="home-grid">
              {visible.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={onOpenProject}
                  onMenu={openMenu}
                />
              ))}
              <button
                type="button"
                className="project-new"
                onClick={onCreateProject}
              >
                ＋ 新剧
              </button>
            </div>
          )}
        </main>
      )}

      {/* 项目菜单（§3.2：打开 / 重命名 / 复制 / 删除） */}
      {menu && menuProject && (
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
            onClick={() => {
              onOpenProject(menu.id)
              setMenu(null)
            }}
          >
            打开
          </button>
          <button
            type="button"
            className="editor-menu-item"
            role="menuitem"
            onClick={() => {
              setRenaming(menuProject)
              setMenu(null)
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="editor-menu-item"
            role="menuitem"
            onClick={() => {
              onDuplicateProject(menu.id)
              setMenu(null)
            }}
          >
            ⧉ 复制
          </button>
          <button
            type="button"
            className="editor-menu-item editor-menu-danger"
            role="menuitem"
            onClick={() => {
              setDeleting(menuProject)
              setMenu(null)
            }}
          >
            🗑 删除
          </button>
        </div>
      )}

      {renaming && (
        <RenameDialog
          currentName={renaming.name}
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            onRenameProject(renaming.id, name)
            setRenaming(null)
          }}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          title="删除项目"
          message={`删除「${deleting.name}」？项目文件将从磁盘移除，此操作不可撤销。`}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDeleteProject(deleting.id)
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
