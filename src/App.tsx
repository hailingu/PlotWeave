import {
  lazy,
  startTransition,
  Suspense,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { HomePage } from './home/HomePage'
import type { OpenProjectError } from './home/OpenErrorBanner'
import { useHomeActionFeedback } from './useHomeActionFeedback'
import type { HomeActionFailure } from './home/ActionErrorBanner'
import {
  useAiSessionLifecycle,
  useOpenProjectActions,
  type LatestAiSessionRef,
  type LatestDoc,
  type LatestDocRef,
  type OpenProject,
} from './openProjectActions'
import { useHomeProjectActions } from './useHomeProjectActions'
import { useExitFlush } from './useExitFlush'
import { useNativeAppShell } from './useNativeAppShell'
import { useNativeHomeRecovery } from './useNativeHomeRecovery'
import { useAppSettingsShortcut } from './useAppSettingsShortcut'
import { isSwiftHost } from './platform/hostEnvironment'
import { ErrorBanner } from './editor/ErrorBanner'
import { projectStore } from './projectStore'
import { useProjectSummaries } from './useProjectSummaries'
import { useCreateFamilyAttempts } from './useCreateFamilyAttempts'
import type { ProjectSummary } from './home/projects'

/** 编辑器视图按域惰性加载：React Flow 的运行时引用全部封闭在编辑器域内，
 * 拆出入口 chunk 后冷启动只解析首页所需代码（issue #34）。
 * 切换经 startTransition 包裹：chunk 未就绪前保留当前界面而非整窗空白
 * （评审 P2，pullrequestreview-5138102539）。
 * 命名导出经 default 映射装配 React.lazy（issue #164，规范：named
 * exports only——lazy 是装配点而非保留 default export 的理由）。 */
const EditorView = lazy(() =>
  import('./editor/EditorView').then((m) => ({ default: m.EditorView })),
)

/** 设置视图低频使用（⌘, 叠加打开），同样惰性加载不占入口 chunk。 */
const SettingsView = lazy(() =>
  import('./settings/SettingsView').then((m) => ({ default: m.SettingsView })),
)

/** 编辑器视图装配（AppView 拆分，PR #199 评审守组件 80 行上限）：带外
 * 最新会话/画布文档的重挂载种子解析与保存接线——设置页关闭等重挂载
 * 时刻读取引用里的最新内容，而非打开项目时落盘/保留区的旧快照
 * （issue #61/#118）。 */
function EditorScreen({
  openProject,
  open,
  latestAiSession,
  latestDoc,
  onOpenSettings,
}: {
  readonly openProject: OpenProject
  readonly open: ReturnType<typeof useOpenProjectActions>
  readonly latestAiSession: LatestAiSessionRef
  readonly latestDoc: LatestDocRef
  readonly onOpenSettings: () => void
}) {
  const latest = latestAiSession.current
  const aiSession =
    latest?.id === openProject.id ? latest.session : openProject.aiSession
  const latestCanvasDoc = latestDoc.current
  const doc =
    latestCanvasDoc?.id === openProject.id
      ? latestCanvasDoc.doc
      : openProject.doc
  return (
    <EditorView
      key={openProject.id}
      project={{ id: openProject.id, ...doc }}
      aiSession={aiSession}
      aiSessionError={openProject.aiSessionError}
      aiSessionRetryable={openProject.aiSessionRetryable}
      aiSessionLoadFailed={openProject.aiSessionLoadFailed}
      onBackHome={open.handleBackHome}
      onRenameProject={open.handleEditorRename}
      onOpenSettings={onOpenSettings}
      // 先同步登记再委托存储（issue #118）：防抖卸载冲刷的交付无论
      // 保存成败都进入引用，失败时重挂载种子仍是内存最新文档。
      onSave={(next) => {
        latestDoc.current = { id: openProject.id, doc: next }
        return projectStore.save(openProject.id, next)
      }}
      onSaveAiSession={open.handleSaveAiSession(openProject.id)}
    />
  )
}

/** Application view assembly shared by web and native shell routes. */
interface AppViewProps {
  readonly projects: ProjectSummary[]
  readonly loading: boolean
  readonly loadError: string | null
  readonly onRetryLoad: () => void
  readonly openProject: OpenProject | null
  readonly openFailure: OpenProjectError | null
  readonly mutationFailure: {
    readonly error: HomeActionFailure
    // 可显式 undefined = 该失败无同参重试（issue #231）
    readonly retry?: (() => void) | undefined
  } | null
  readonly onRetryMutation?: () => void
  readonly settingsOpen: boolean
  readonly open: ReturnType<typeof useOpenProjectActions>
  readonly home: ReturnType<typeof useHomeProjectActions>
  readonly latestAiSession: LatestAiSessionRef
  readonly latestDoc: LatestDocRef
  readonly onOpenSettings: () => void
  readonly onCloseSettings: () => void
}

function AppView({
  projects,
  loading,
  loadError,
  onRetryLoad,
  openProject,
  openFailure,
  mutationFailure,
  onRetryMutation,
  settingsOpen,
  open,
  home,
  latestAiSession,
  latestDoc,
  onOpenSettings,
  onCloseSettings,
}: AppViewProps) {
  if (isSwiftHost()) {
    return (
      <Suspense fallback={null}>
        <div hidden>
          {settingsOpen && <SettingsView onClose={onCloseSettings} />}
        </div>
        {openProject && (
          <EditorScreen
            openProject={openProject}
            open={open}
            latestAiSession={latestAiSession}
            latestDoc={latestDoc}
            onOpenSettings={onOpenSettings}
          />
        )}
      </Suspense>
    )
  }
  let view: ReactNode
  if (settingsOpen) {
    view = <SettingsView onClose={onCloseSettings} />
  } else if (openProject) {
    view = (
      <EditorScreen
        openProject={openProject}
        open={open}
        latestAiSession={latestAiSession}
        latestDoc={latestDoc}
        onOpenSettings={onOpenSettings}
      />
    )
  } else {
    view = (
      <HomeScreen
        projects={projects}
        loading={loading}
        loadError={loadError}
        onRetryLoad={onRetryLoad}
        openError={openFailure}
        mutationError={mutationFailure?.error ?? null}
        onRetryMutation={mutationFailure?.retry ? onRetryMutation : undefined}
        open={open}
        home={home}
      />
    )
  }
  return <Suspense fallback={null}>{view}</Suspense>
}

/** 首页视图装配（AppView 拆分，80 行上限）：列表数据 + 打开/新建/重命名/
 * 复制/删除动作接线与读取失败错误态（#133）/变更失败横幅（#132）透传。 */
function HomeScreen({
  projects,
  loading,
  loadError,
  onRetryLoad,
  openError,
  mutationError,
  onRetryMutation,
  open,
  home,
}: {
  readonly projects: ProjectSummary[]
  readonly loading: boolean
  readonly loadError: string | null
  readonly onRetryLoad: () => void
  readonly openError: OpenProjectError | null
  readonly mutationError: HomeActionFailure | null
  // 可显式 undefined = 无同参重试（issue #231）
  readonly onRetryMutation?: (() => void) | undefined
  readonly open: ReturnType<typeof useOpenProjectActions>
  readonly home: ReturnType<typeof useHomeProjectActions>
}) {
  return (
    <HomePage
      projects={projects}
      loading={loading}
      loadError={loadError}
      onRetryLoad={onRetryLoad}
      openError={openError}
      mutationError={mutationError}
      onRetryMutation={onRetryMutation}
      onOpenProject={(id) => void open.handleOpenProject(id)}
      onCreateProject={() => void open.handleCreateProject()}
      onRenameProject={(id, name) => void home.handleRenameProject(id, name)}
      onDuplicateProject={(id) => void home.handleDuplicateProject(id)}
      onDeleteProject={(id) => void home.handleDeleteProject(id)}
    />
  )
}

/** Maps only existing App coordination capabilities into native navigation intents. */
function nativeAppActions(
  open: ReturnType<typeof useOpenProjectActions>,
  home: ReturnType<typeof useHomeProjectActions>,
  settings: () => void,
  retry: (id?: string | null) => Promise<void>,
) {
  return {
    create: open.handleCreateProject,
    open: open.handleOpenProject,
    rename: home.handleRenameProject,
    duplicate: home.handleDuplicateProject,
    delete: home.handleDeleteProject,
    home: open.handleBackHome,
    settings,
    retry,
  }
}

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）+ 设置界面——
 * 项目首页 / 编辑器是同一窗口的两种状态，设置页经 ⌘, 叠加打开
 * （独立窗口形态随桌面端演进升级），关闭后回到原界面。
 * 项目数据经 projectStore 持久化（Tauri 落盘 / 浏览器内存回退）。
 * 打开/新建协调在 openProjectActions（issue #545 拆出），首页变更
 * 动作族在 useHomeProjectActions；此处只做壳层接线与视图装配。
 */
export function App() {
  const [openProject, setOpenProject] = useState<OpenProject | null>(null)
  const [openFailure, setOpenFailure] = useState<OpenProjectError | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 打开期间最新画布文档：保存路径的 state 外挂载种子（issue #118）。 */
  const latestDocRef = useRef<LatestDoc | null>(null)
  const { unsavedAiSessionsRef, latestAiSessionRef } =
    useAiSessionLifecycle(setOpenProject)
  const { projects, loading, loadError, refreshProjects, readProjects } =
    useProjectSummaries(() => openProject === null)
  // 首页项目变更失败反馈（issue #132）：创建/重命名/复制/删除共用
  const actionFeedback = useHomeActionFeedback()
  const attempts = useCreateFamilyAttempts(readProjects)

  useAppSettingsShortcut(() => startTransition(() => setSettingsOpen(true)))

  const open = useOpenProjectActions({
    setOpenProject,
    setOpenFailure,
    refreshProjects,
    unsavedAiSessions: unsavedAiSessionsRef,
    latestAiSession: latestAiSessionRef,
    latestDoc: latestDocRef,
    feedback: actionFeedback,
    attempts,
  })
  const home = useHomeProjectActions(
    refreshProjects,
    unsavedAiSessionsRef,
    actionFeedback,
    attempts,
  )
  /** 退出冲刷屏障：未落盘会话仍在时阻止关闭窗口（见 useExitFlush）。 */
  const exitBlocked = useExitFlush()
  const recovery = useNativeHomeRecovery({
    exitBlocked,
    loadError,
    openFailure,
    feedback: actionFeedback,
    refresh: refreshProjects,
    open: open.handleOpenProject,
  })
  useNativeAppShell({
    projects,
    loading,
    settingsOpen,
    project: openProject
      ? { id: openProject.id, name: openProject.doc.name }
      : null,
    error: recovery.error,
    recovery: recovery.recovery,
    actions: nativeAppActions(
      open,
      home,
      () => startTransition(() => setSettingsOpen(true)),
      recovery.retry,
    ),
  })

  return (
    <>
      {exitBlocked !== null && <ErrorBanner message={exitBlocked} />}
      <AppView
        projects={projects}
        loading={loading}
        loadError={loadError}
        onRetryLoad={() => void refreshProjects()}
        openProject={openProject}
        openFailure={openFailure}
        mutationFailure={actionFeedback.failure}
        onRetryMutation={() => void actionFeedback.retry()}
        settingsOpen={settingsOpen}
        open={open}
        home={home}
        latestAiSession={latestAiSessionRef}
        latestDoc={latestDocRef}
        onOpenSettings={() => startTransition(() => setSettingsOpen(true))}
        onCloseSettings={() => startTransition(() => setSettingsOpen(false))}
      />
    </>
  )
}
