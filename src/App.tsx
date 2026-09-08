import { lazy, startTransition, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import HomePage from './home/HomePage'
import { projectStore, type ProjectContent } from './projectStore'
import type { ProjectSummary } from './home/projects'

/** 编辑器视图按域惰性加载：React Flow 的运行时引用全部封闭在编辑器域内，
 * 拆出入口 chunk 后冷启动只解析首页所需代码（issue #34）。
 * 切换经 startTransition 包裹：chunk 未就绪前保留当前界面而非整窗空白
 * （评审 P2，pullrequestreview-5138102539）。 */
const EditorView = lazy(() => import('./editor/EditorView'))

/** 设置视图低频使用（⌘, 叠加打开），同样惰性加载不占入口 chunk。 */
const SettingsView = lazy(() => import('./settings/SettingsView'))

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。 */
interface OpenProject {
  id: string
  doc: ProjectContent
}

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）+ 设置界面——
 * 项目首页 / 编辑器是同一窗口的两种状态，设置页经 ⌘, 叠加打开
 * （独立窗口形态随桌面端演进升级），关闭后回到原界面。
 * 项目数据经 projectStore 持久化（Tauri 落盘 / 浏览器内存回退）。
 */
export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [openProject, setOpenProject] = useState<OpenProject | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await projectStore.list())
    } catch (err) {
      console.warn('[App] 项目列表加载失败', err)
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // ⌘, 打开设置（macOS 惯例，§8.2）；输入控件聚焦时不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        startTransition(() => setSettingsOpen(true))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleCreateProject = useCallback(async () => {
    try {
      const meta = await projectStore.create('未命名短剧')
      // create 只回摘要：按落盘文档载入会话，保留 create_project 盖的 createdAt——
      // 手工拼空文档会丢创建时间，首次保存把保存时刻误盖为创建时间（§3 溯源字段）
      const doc = await projectStore.load(meta.id)
      startTransition(() => setOpenProject({ id: meta.id, doc }))
    } catch (err) {
      console.warn('[App] 新建项目失败', err)
    }
    void refreshProjects()
  }, [refreshProjects])

  const handleOpenProject = useCallback(
    async (id: string) => {
      try {
        const doc = await projectStore.load(id)
        startTransition(() => setOpenProject({ id, doc }))
      } catch (err) {
        console.warn('[App] 打开项目失败', err)
      }
    },
    [],
  )

  const handleBackHome = useCallback(() => {
    setOpenProject(null)
    void refreshProjects()
  }, [refreshProjects])

  /** 画布防抖保存（§10.2）：失败 Promise 上浮给编辑器——重置脏标记自动
   * 重试并横幅提示，不再经 saveQuiet 静默吞错丢编辑。 */
  const handleSave = useCallback(
    (id: string) => (doc: ProjectContent) => projectStore.save(id, doc),
    [],
  )

  /** 编辑器工具栏项目名内联改名（§3.3）：更新打开态，随防抖落盘。 */
  const handleEditorRename = useCallback((name: string) => {
    setOpenProject((p) => (p ? { ...p, doc: { ...p.doc, name } } : p))
  }, [])

  /** 首页卡片菜单 · 重命名（§3.2）：读原文档改 name 后保存。 */
  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      try {
        const doc = await projectStore.load(id)
        await projectStore.saveQuiet(id, { ...doc, name })
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 重命名失败', err)
      }
    },
    [refreshProjects],
  )

  const handleDuplicateProject = useCallback(
    async (id: string) => {
      try {
        await projectStore.duplicate(id)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 复制项目失败', err)
      }
    },
    [refreshProjects],
  )

  const handleDeleteProject = useCallback(
    async (id: string) => {
      try {
        await projectStore.delete(id)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 删除项目失败', err)
      }
    },
    [refreshProjects],
  )

  let view: ReactNode
  if (settingsOpen) {
    view = <SettingsView onClose={() => setSettingsOpen(false)} />
  } else if (openProject) {
    view = <EditorView
      key={openProject.id}
      project={{ id: openProject.id, ...openProject.doc }}
      onBackHome={handleBackHome}
      onRenameProject={handleEditorRename}
        onOpenSettings={() => startTransition(() => setSettingsOpen(true))}
      onSave={handleSave(openProject.id)}
    />
  } else {
    view = <HomePage
      projects={projects}
      loading={loading}
      onOpenProject={handleOpenProject}
      onCreateProject={() => void handleCreateProject()}
      onRenameProject={(id, name) => void handleRenameProject(id, name)}
      onDuplicateProject={(id) => void handleDuplicateProject(id)}
      onDeleteProject={(id) => void handleDeleteProject(id)}
    />
  }
  return <Suspense fallback={null}>{view}</Suspense>
}
