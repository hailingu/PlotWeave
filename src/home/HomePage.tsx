import { useEffect, useMemo, useState } from 'react'
import ProjectCard from './ProjectCard'
import { ConfirmDeleteDialog, RenameDialog } from './Dialogs'
import { filterProjects, type ProjectSummary } from './projects'

interface HomePageProps {
  projects: ProjectSummary[]
  /** 列表首次加载中（持久化命令异步返回）；加载完前不显示空状态引导。 */
  loading?: boolean
  /** 单击海报卡打开项目，窗口切换为编辑器（文档式双界面，§3.1；应用方修订：由双击改单击）。 */
  onOpenProject: (id: string) => void
  /** 工具栏「＋ 新建项目」、网格末尾「＋ 新剧」与空状态引导共用此入口。 */
  onCreateProject: () => void
  /** 卡片菜单 · 重命名（§3.2）。 */
  onRenameProject: (id: string, name: string) => void
  /** 卡片菜单 · 复制（§3.2）。 */
  onDuplicateProject: (id: string) => void
  /** 卡片菜单 · 删除（§3.2，确认对话框在本层弹出）。 */
  onDeleteProject: (id: string) => void
}

/**
 * 项目首页（文档浏览器）：竖版海报片库（docs/ui-design.md §3.2）。
 * 工具栏 = 搜索框（内存过滤）+「＋ 新建项目」；卡片右键或悬停 ⋯ 打开
 * 项目菜单（打开/重命名/复制/删除）；无项目时居中展示空状态引导。
 */
export default function HomePage({
  projects,
  loading = false,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
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

  // Esc 关闭菜单；点击菜单外任意处关闭
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      // e.target 可能是非 Element 的 EventTarget（如 document），安全判断避免抛错
      const target = e.target
      if (target instanceof Element && !target.closest('.editor-ctx')) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

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
                <ProjectCard key={p.id} project={p} onOpen={onOpenProject} onMenu={openMenu} />
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
          style={{ left: Math.min(menu.x, window.innerWidth - 150), top: menu.y }}
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
          projectName={deleting.name}
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
