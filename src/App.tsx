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
import { useExitFlush } from './useExitFlush'
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

/** 打开期间最新的 AI 会话快照（App state 之外，issue #61）：保存路径只写
 * 此引用、不触发渲染；AppView 在渲染时按 id 解析为挂载种子，设置页往返
 * 等重挂载场景据此恢复到最新历史。 */
interface LatestAiSession {
  id: string
  session: AiSession
}

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。aiSession 只是项目打开
 * /重开时刻的挂载种子；打开期间的最新值由 LatestAiSession 引用承载。 */
interface OpenProject {
  id: string
  doc: ProjectContent
  aiSession: AiSession
  aiSessionError: string | null
  /** 读取失败时关闭 AI 操作入口，直到重开成功；不影响画布。 */
  aiSessionLoadFailed: boolean
  /** 内存会话是否可作为挂载重试的落盘内容：读取失败时为 false——
   * 空回退会话落盘会覆盖可能可恢复的原文件。 */
  aiSessionRetryable: boolean
}

/** 分开读取画布与会话；等待共享保存链后优先恢复进程内未保存内容。
 * 单实例下该快照是最新编辑，无须与其他写入者的磁盘历史合并。 */
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
      aiSessionLoadFailed: false,
      aiSessionRetryable: true,
    }
  }
  try {
    const ai = await projectStore.loadAiSession(id)
    return {
      id,
      doc,
      aiSession: ai.session,
      aiSessionError: ai.repairError,
      aiSessionLoadFailed: false,
      // 读取不自动写回；损坏诊断保留到用户实际编辑后的保存成功。
      aiSessionRetryable: false,
    }
  } catch (err) {
    console.warn('[App] AI 会话恢复失败，已以空历史打开项目', err)
    return {
      id,
      doc,
      aiSession: { schemaVersion: 1, entries: [] },
      aiSessionError: String(err),
      aiSessionLoadFailed: true,
      aiSessionRetryable: false,
    }
  }
}

type OpenProjectSetter = Dispatch<SetStateAction<OpenProject | null>>
type RefreshProjects = () => Promise<void>
type UnsavedAiSessionsRef = RefObject<Map<string, UnsavedAiSession>>
/** 保存路径需要整体替换快照，故用可变盒子而非只读的 RefObject。 */
type LatestAiSessionRef = { current: LatestAiSession | null }

function useOpenProjectActions(
  setOpenProject: OpenProjectSetter,
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
  latestAiSession: LatestAiSessionRef,
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
      // 最新会话写入引用而非 React state：成功保存是每条 AI 消息的高频路径，
      // 不得引起 App 根起的整树重渲染（issue #61）。AI 操作区只在加载成功后
      // 开放；实际变更后的会话可在重挂载时重试。
      latestAiSession.current = { id, session }
      try {
        await projectStore.saveAiSession(id, session)
      } catch (err) {
        // 失败保留在打开项目视图之外：回首页再重开不丢内存副本。错误经项目级
        // 状态上浮（面板自身 catch 同步可见），内存会话是真实内容，重挂载可重试。
        unsavedAiSessions.current?.set(id, { session, error: String(err) })
        setOpenProject((project) =>
          project?.id === id
            ? { ...project, aiSessionError: String(err), aiSessionRetryable: true }
            : project,
        )
        throw err
      }
      unsavedAiSessions.current?.delete(id)
      // 保存成功才清除项目级恢复错误：重挂载编辑器不得再宣称会话未落盘。
      // 已是 null 时返回原引用，React 跳过本次提交。
      setOpenProject((project) =>
        project?.id === id && project.aiSessionError !== null
          ? { ...project, aiSessionError: null }
          : project,
      )
    },
    [latestAiSession, setOpenProject, unsavedAiSessions],
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
  latestAiSession,
  onOpenSettings,
  onCloseSettings,
}: {
  readonly projects: ProjectSummary[]
  readonly loading: boolean
  readonly openProject: OpenProject | null
  readonly settingsOpen: boolean
  readonly open: ReturnType<typeof useOpenProjectActions>
  readonly home: ReturnType<typeof useHomeProjectActions>
  readonly latestAiSession: LatestAiSessionRef
  readonly onOpenSettings: () => void
  readonly onCloseSettings: () => void
}) {
  let view: ReactNode
  if (settingsOpen) {
    view = <SettingsView onClose={onCloseSettings} />
  } else if (openProject) {
    // 挂载种子在渲染时解析：设置页关闭等重挂载时刻读取引用里的最新会话
    // （issue #61），而非打开项目时落盘/保留区的旧快照。
    const latest = latestAiSession.current
    const aiSession = latest?.id === openProject.id ? latest.session : openProject.aiSession
    view = <EditorView
      key={openProject.id}
      project={{ id: openProject.id, ...openProject.doc }}
      aiSession={aiSession}
      aiSessionError={openProject.aiSessionError}
      aiSessionRetryable={openProject.aiSessionRetryable}
      aiSessionLoadFailed={openProject.aiSessionLoadFailed}
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
  /** 打开期间最新 AI 会话：高频保存路径的 state 外挂载种子（issue #61）。 */
  const latestAiSessionRef = useRef<LatestAiSession | null>(null)

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

  // 退出重试保存成功（不经 UI 保存通道）时清除项目级错误与保留快照：
  // 否则面板持续宣称「保存失败」而会话实际已保存到主文件。清理与
  // handleSaveAiSession 的成功尾巴幂等重复，无害；无错误时返回原引用，
  // 不产生多余提交。
  useEffect(
    () =>
      projectStore.onAiSessionSaved((id) => {
        unsavedAiSessionsRef.current?.delete(id)
        setOpenProject((project) =>
          project?.id === id && project.aiSessionError !== null
            ? { ...project, aiSessionError: null }
            : project,
        )
      }),
    [],
  )

  // 墓碑吸收的会话在删除失败后补写失败：原始保存早已被吸收为成功、无
  // 调用方可上浮，只能经此事件登记保留快照——重开项目时内存副本胜出
  // 并提示可重试，退出屏障仍兜底。删除发起于首页，无需触碰打开态。
  useEffect(
    () =>
      projectStore.onAiSessionSaveFailed((id, { session, error }) => {
        unsavedAiSessionsRef.current?.set(id, { session, error })
      }),
    [],
  )

  const open = useOpenProjectActions(setOpenProject, refreshProjects, unsavedAiSessionsRef, latestAiSessionRef)
  const home = useHomeProjectActions(refreshProjects, unsavedAiSessionsRef)
  /** 退出冲刷屏障：未落盘会话仍在时阻止关闭窗口（见 useExitFlush）。 */
  const exitBlocked = useExitFlush()
  return <>
    {exitBlocked !== null && (
      <div
        role="alert"
        style={{ padding: '6px 16px', background: '#5c1d1d', color: '#ffe3e3', fontSize: 13 }}
      >
        {exitBlocked}
      </div>
    )}
    <AppView
      projects={projects}
      loading={loading}
      openProject={openProject}
      settingsOpen={settingsOpen}
      open={open}
      home={home}
      latestAiSession={latestAiSessionRef}
      onOpenSettings={() => startTransition(() => setSettingsOpen(true))}
      onCloseSettings={() => startTransition(() => setSettingsOpen(false))}
    />
  </>
}
