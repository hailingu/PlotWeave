import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'
import HomePage from './home/HomePage'
import { projectStore, type ProjectContent } from './projectStore'
import type { ProjectSummary } from './home/projects'
import type { AiSession } from './editor/ai/session'

/** 编辑器视图按域惰性加载：React Flow 的运行时引用全部封闭在编辑器域内，
 * 拆出入口 chunk 后冷启动只解析首页所需代码（issue #34）。
 * 切换经 startTransition 包裹：chunk 未就绪前保留当前界面而非整窗空白
 * （评审 P2，pullrequestreview-5138102539）。 */
const EditorView = lazy(() => import('./editor/EditorView'))

/** 设置视图低频使用（⌘, 叠加打开），同样惰性加载不占入口 chunk。 */
const SettingsView = lazy(() => import('./settings/SettingsView'))

/** 未落盘会话的保留条目：保存失败后跨首页保留，重开项目时恢复并自动重试。 */
interface UnsavedAiSession {
  session: AiSession
  error: string
}

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。 */
interface OpenProject {
  id: string
  doc: ProjectContent
  aiSession: AiSession
  aiSessionError: string | null
  /** 内存会话是否可作为挂载重试的落盘内容：读取失败时为 false——
   * 空回退会话落盘会覆盖可能可恢复的原文件。 */
  aiSessionRetryable: boolean
}

/** 分开读取画布与会话：会话局部损坏不能阻止用户打开可用的项目文档。
 * 保留区在加载屏障之后读取——保存在途时重开，拒绝处理器会在 load 等待
 * 共享保存链期间写入保留区，屏障前先取会拿到过期的 undefined。存在未
 * 落盘保留会话时以其胜出：它是权威用户内容，重试标记打开。 */
async function loadOpenProject(
  id: string,
  unsavedAiSessions?: ReadonlyMap<string, UnsavedAiSession>,
): Promise<OpenProject> {
  const doc = await projectStore.load(id)
  const unsaved = unsavedAiSessions?.get(id)
  if (unsaved) {
    return {
      id,
      doc,
      aiSession: unsaved.session,
      aiSessionError: `上次会话保存失败，已保留待重试：${unsaved.error}`,
      aiSessionRetryable: true,
    }
  }
  try {
    const ai = await projectStore.loadAiSession(id)
    return { id, doc, aiSession: ai.session, aiSessionError: ai.repairError, aiSessionRetryable: true }
  } catch (err) {
    console.warn('[App] AI 会话恢复失败，已以空历史打开项目', err)
    return {
      id,
      doc,
      aiSession: { schemaVersion: 1, entries: [] },
      aiSessionError: String(err),
      aiSessionRetryable: false,
    }
  }
}

type OpenProjectSetter = Dispatch<SetStateAction<OpenProject | null>>
type RefreshProjects = () => Promise<void>
type UnsavedAiSessionsRef = RefObject<Map<string, UnsavedAiSession>>

function useOpenProjectActions(
  setOpenProject: OpenProjectSetter,
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
) {
  const handleCreateProject = useCallback(async () => {
    try {
      const meta = await projectStore.create('未命名短剧')
      const open = await loadOpenProject(meta.id)
      startTransition(() => setOpenProject(open))
    } catch (err) {
      console.warn('[App] 新建项目失败', err)
    }
    void refreshProjects()
  }, [refreshProjects, setOpenProject])

  const handleOpenProject = useCallback(async (id: string) => {
    try {
      const open = await loadOpenProject(id, unsavedAiSessions.current ?? undefined)
      startTransition(() => setOpenProject(open))
    } catch (err) {
      console.warn('[App] 打开项目失败', err)
    }
  }, [setOpenProject, unsavedAiSessions])

  const handleBackHome = useCallback(() => {
    setOpenProject(null)
    void refreshProjects()
  }, [refreshProjects, setOpenProject])

  const handleEditorRename = useCallback((name: string) => {
    setOpenProject((project) => (project ? { ...project, doc: { ...project.doc, name } } : project))
  }, [setOpenProject])

  const handleSaveAiSession = useCallback(
    (id: string) => async (session: AiSession) => {
      // 接受实际变更即标记可重试：变更后的会话是权威用户内容，不再是
      // 读取失败时的空回退，重挂载重试落盘安全
      setOpenProject((project) =>
        project?.id === id ? { ...project, aiSession: session, aiSessionRetryable: true } : project,
      )
      try {
        await projectStore.saveAiSession(id, session)
      } catch (err) {
        // 失败保留在打开项目视图之外：回首页再重开不丢内存副本
        unsavedAiSessions.current?.set(id, { session, error: String(err) })
        setOpenProject((project) =>
          project?.id === id ? { ...project, aiSessionError: String(err) } : project,
        )
        throw err
      }
      unsavedAiSessions.current?.delete(id)
      // 保存成功才清除项目级恢复错误：重挂载编辑器不得再宣称会话未落盘
      setOpenProject((project) => (project?.id === id ? { ...project, aiSessionError: null } : project))
    },
    [setOpenProject, unsavedAiSessions],
  )

  return { handleCreateProject, handleOpenProject, handleBackHome, handleEditorRename, handleSaveAiSession }
}

function useHomeProjectActions(
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
) {
  const handleRenameProject = useCallback(async (id: string, name: string) => {
    try {
      const doc = await projectStore.load(id)
      await projectStore.saveQuiet(id, { ...doc, name })
      await refreshProjects()
    } catch (err) {
      console.warn('[App] 重命名失败', err)
    }
  }, [refreshProjects])

  const handleDuplicateProject = useCallback(async (id: string) => {
    try {
      await projectStore.duplicate(id)
      await refreshProjects()
    } catch (err) {
      console.warn('[App] 复制项目失败', err)
    }
  }, [refreshProjects])

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      await projectStore.delete(id)
      unsavedAiSessions.current?.delete(id)
      await refreshProjects()
    } catch (err) {
      console.warn('[App] 删除项目失败', err)
    }
  }, [refreshProjects, unsavedAiSessions])

  return { handleRenameProject, handleDuplicateProject, handleDeleteProject }
}

function AppView({
  projects,
  loading,
  openProject,
  settingsOpen,
  open,
  home,
  onOpenSettings,
  onCloseSettings,
}: {
  readonly projects: ProjectSummary[]
  readonly loading: boolean
  readonly openProject: OpenProject | null
  readonly settingsOpen: boolean
  readonly open: ReturnType<typeof useOpenProjectActions>
  readonly home: ReturnType<typeof useHomeProjectActions>
  readonly onOpenSettings: () => void
  readonly onCloseSettings: () => void
}) {
  let view: ReactNode
  if (settingsOpen) {
    view = <SettingsView onClose={onCloseSettings} />
  } else if (openProject) {
    view = <EditorView
      key={openProject.id}
      project={{ id: openProject.id, ...openProject.doc }}
      aiSession={openProject.aiSession}
      aiSessionError={openProject.aiSessionError}
      aiSessionRetryable={openProject.aiSessionRetryable}
      onBackHome={open.handleBackHome}
      onRenameProject={open.handleEditorRename}
      onOpenSettings={onOpenSettings}
      onSave={(doc) => projectStore.save(openProject.id, doc)}
      onSaveAiSession={open.handleSaveAiSession(openProject.id)}
    />
  } else {
    view = <HomePage
      projects={projects}
      loading={loading}
      onOpenProject={open.handleOpenProject}
      onCreateProject={() => void open.handleCreateProject()}
      onRenameProject={(id, name) => void home.handleRenameProject(id, name)}
      onDuplicateProject={(id) => void home.handleDuplicateProject(id)}
      onDeleteProject={(id) => void home.handleDeleteProject(id)}
    />
  }
  return <Suspense fallback={null}>{view}</Suspense>
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
  /** 保存失败会话的保留区：不属于任何一次打开会话的瞬态视图，跨首页存活。 */
  const unsavedAiSessionsRef = useRef(new Map<string, UnsavedAiSession>())

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

  const open = useOpenProjectActions(setOpenProject, refreshProjects, unsavedAiSessionsRef)
  const home = useHomeProjectActions(refreshProjects, unsavedAiSessionsRef)
  return <AppView
    projects={projects}
    loading={loading}
    openProject={openProject}
    settingsOpen={settingsOpen}
    open={open}
    home={home}
    onOpenSettings={() => startTransition(() => setSettingsOpen(true))}
    onCloseSettings={() => startTransition(() => setSettingsOpen(false))}
  />
}
