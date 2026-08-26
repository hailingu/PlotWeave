import { useMemo, useState } from 'react'
import ProjectCard from './ProjectCard'
import { filterProjects, type ProjectSummary } from './projects'

interface HomePageProps {
  projects: ProjectSummary[]
  /** 列表首次加载中（持久化命令异步返回）；加载完前不显示空状态引导。 */
  loading?: boolean
  /** 双击海报卡打开项目，窗口切换为编辑器（文档式双界面，§3.1）。 */
  onOpenProject: (id: string) => void
  /** 工具栏「＋ 新建项目」、网格末尾「＋ 新剧」与空状态引导共用此入口。 */
  onCreateProject: () => void
}

/**
 * 项目首页（文档浏览器）：竖版海报片库（docs/ui-design.md §3.2）。
 * 工具栏 = 搜索框（内存过滤）+「＋ 新建项目」；无项目时居中展示
 * 「创建你的第一部短剧」空状态引导。
 */
export default function HomePage({
  projects,
  loading = false,
  onOpenProject,
  onCreateProject,
}: HomePageProps) {
  const [query, setQuery] = useState('')
  const visible = useMemo(
    () => filterProjects(projects, query),
    [projects, query],
  )

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
                <ProjectCard key={p.id} project={p} onOpen={onOpenProject} />
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
    </div>
  )
}
