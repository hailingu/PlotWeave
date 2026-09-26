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
import { HomePage } from './home/HomePage'
import type { OpenProjectError } from './home/OpenErrorBanner'
import { useHomeActionFeedback } from './useHomeActionFeedback'
import type { HomeActionFailure } from './home/ActionErrorBanner'
import type { CreateFamilyOutcome } from './home/createFamilyOutcome'
import {
  createWithReconcile,
  duplicateWithReconcile,
  useCreateFamilyAttempts,
} from './useCreateFamilyAttempts'
import { useExitFlush } from './useExitFlush'
import { ErrorBanner } from './editor/ErrorBanner'
import { displayIpcError } from './ipcError'
import { useProjectSummaries } from './useProjectSummaries'
import { projectStore, type ProjectContent } from './projectStore'
import type { ProjectSummary } from './home/projects'
import type { AiSession } from './editor/ai/session'

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

/** 打开期间最新的画布文档快照（App state 之外，issue #118）：保存路径只写
 * 此引用、不触发渲染；设置页互斥路由会卸载编辑器，重挂载若以打开时刻的
 * openProject.doc 为种子，下一次全量保存就会回滚往返前的较新编辑。 */
interface LatestDoc {
  id: string
  doc: ProjectContent
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
type OpenErrorSetter = Dispatch<SetStateAction<OpenProjectError | null>>
type RefreshProjects = () => Promise<void>
type UnsavedAiSessionsRef = RefObject<Map<string, UnsavedAiSession>>
/** 保存路径需要整体替换快照，故用可变盒子而非只读的 RefObject。 */
type LatestAiSessionRef = { current: LatestAiSession | null }
type LatestDocRef = { current: LatestDoc | null }

/** 打开失败原因的可读化（issue #98）：Error 取 message（避免「Error: 」
 * 前缀上屏），Tauri IPC 常见的字符串拒绝原样保留，其余形态 String() 兜底；
 * IPC 机器码前缀（issue #229）只服务程序判定，一律剥离不上屏。 */
function openFailureDetail(err: unknown): string {
  return displayIpcError(err)
}

/** 应用级会话生命周期：持有跨页面快照，订阅共享保存链结果，并在卸载时
 * 解除订阅；普通保存的最新内容与失败恢复副本均不依赖编辑器挂载状态。 */
function useAiSessionLifecycle(setOpenProject: OpenProjectSetter) {
  /** 保存失败会话的保留区：不属于任何一次打开会话的瞬态视图，跨首页存活。 */
  const unsavedAiSessionsRef = useRef(new Map<string, UnsavedAiSession>())
  /** 打开期间最新 AI 会话：高频保存路径的 state 外挂载种子（issue #61）。 */
  const latestAiSessionRef = useRef<LatestAiSession | null>(null)

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
    [setOpenProject],
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

  return { unsavedAiSessionsRef, latestAiSessionRef }
}

/** AI 会话保存通道（自 useOpenProjectActions 拆出以守 80 行函数上限，
 * PR #110 评审）：最新会话写入引用而非 React state——成功保存是每条 AI
 * 消息的高频路径，不得引起 App 根起的整树重渲染（issue #61）；失败保留
 * 在打开项目视图之外并上浮项目级错误，重挂载可重试。 */
function useAiSessionSave(
  setOpenProject: OpenProjectSetter,
  unsavedAiSessions: UnsavedAiSessionsRef,
  latestAiSession: LatestAiSessionRef,
) {
  const handleSaveAiSession = useCallback(
    (id: string) => async (session: AiSession) => {
      // AI 操作区只在加载成功后开放；实际变更后的会话可在重挂载时重试。
      latestAiSession.current = { id, session }
      try {
        await projectStore.saveAiSession(id, session)
      } catch (err) {
        // 失败保留在打开项目视图之外：回首页再重开不丢内存副本。错误经项目级
        // 状态上浮（面板自身 catch 同步可见），内存会话是真实内容，重挂载可重试。
        unsavedAiSessions.current?.set(id, { session, error: String(err) })
        setOpenProject((project) =>
          project?.id === id
            ? {
                ...project,
                aiSessionError: String(err),
                aiSessionRetryable: true,
              }
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
  return handleSaveAiSession
}

/** 打开/新建尝试的代序号与两条尝试路径（useOpenProjectActions 拆分，
 * issue #99 格式化后回到 80 行内）。加载期间首页控件仍可操作，慢的旧尝
 * 试可能在新尝试开始后才落定——只有最新发起的尝试可以发布结果（进入编
 * 辑器或失败横幅），被取代的旧尝试只留诊断；与 useProjectSummaries 的刷
 * 新序号收敛同款语义（标准「状态、并发与失败边界」：并发执行须先定义取
 * 代行为）。 */
function useProjectOpenAttempt(
  setOpenProject: OpenProjectSetter,
  setOpenFailure: OpenErrorSetter,
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
  latestDoc: LatestDocRef,
  feedback: ReturnType<typeof useHomeActionFeedback>,
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
) {
  const openAttemptSeqRef = useRef(0)

  const handleCreateProject = useCallback(async () => {
    const seq = ++openAttemptSeqRef.current
    const fbSeq = feedback.begin()
    // 新一次打开尝试即作废旧会话的带外最新文档（issue #118 评审）：返回
    // 首页时编辑器卸载冲刷会经 onSave 复活引用，打开尝试开始时的清除才是
    // 权威失效点——重开项目一律以磁盘载入为准。
    latestDoc.current = null
    // 作废旧尝试已排队未提交的导航（PR #110 评审）：chunk 挂起窗口内首页
    // 仍可交互，此前尝试可能已通过序号检查并排队——排队更新无法从外部
    // 取消，只能以同车道（transition）的 null 更新按入队序覆盖，否则被
    // 取代的导航会在 chunk 就绪后提交并吞掉新尝试的失败横幅。无排队发布
    // 时为同值更新，React 跳过。
    startTransition(() => setOpenProject(null))
    // 存储创建与随后打开分段反馈（issue #132）：创建被拒 = 变更失败横幅
    // （可重试）；创建成功但打开失败 = 项目已存在，不虚报变更失败，由
    // #98 打开横幅承接。
    // 创建族从基线读取到失败对账完整串行；只有确认未创建才开放重试。
    const outcome = await createWithReconcile(attempts, '未命名短剧')
    if (outcome.kind === 'rejected') {
      console.warn('[App] 新建项目失败', outcome.err)
      if (outcome.commitState !== 'present') {
        feedback.fail(
          fbSeq,
          {
            action: 'create',
            targetName: '未命名短剧',
            detail: createFamilyFailureDetail(outcome, 'create'),
          },
          outcome.commitState === 'absent'
            ? () => void handleCreateProject()
            : undefined,
        )
      }
      return
    }
    feedback.succeed(fbSeq)
    try {
      const open = await loadOpenProject(outcome.id)
      // 项目本身已创建，被取代也仍刷新列表；只有最新尝试进入编辑器并
      // 清理横幅，否则旧尝试的成功导航与横幅清理会晚于新尝试的发布。
      if (seq === openAttemptSeqRef.current) {
        setOpenFailure(null)
        startTransition(() => setOpenProject(open))
      }
    } catch (err) {
      console.warn('[App] 新建后打开失败', err)
      // 被取代的旧尝试拒绝晚到：不发布横幅（与 handleOpenProject 同款）
      if (seq === openAttemptSeqRef.current)
        setOpenFailure({ id: outcome.id, detail: openFailureDetail(err) })
    }
    void refreshProjects()
  }, [
    latestDoc,
    refreshProjects,
    setOpenFailure,
    setOpenProject,
    feedback,
    attempts,
  ])

  const handleOpenProject = useCallback(
    async (id: string) => {
      const seq = ++openAttemptSeqRef.current
      // 权威失效点同 handleCreateProject（issue #118 评审）：重开同一项目
      // 时，返回首页后卸载冲刷复活的引用不得压过磁盘载入结果。
      latestDoc.current = null
      // 新一次打开尝试即视为旧错误过时（issue #98）：失败后重试或改开其他
      // 项目，上一次失败的原因不得残留；本次失败会用新原因覆盖。
      setOpenFailure(null)
      // 作废旧尝试已排队未提交的导航（机制见 handleCreateProject 注释）。
      startTransition(() => setOpenProject(null))
      try {
        const open = await loadOpenProject(
          id,
          unsavedAiSessions.current ?? undefined,
        )
        // 被取代的旧尝试成功晚到：不发布导航，新尝试的失败横幅保留。
        if (seq !== openAttemptSeqRef.current) return
        startTransition(() => setOpenProject(open))
      } catch (err) {
        console.warn('[App] 打开项目失败', err)
        // 被取代的旧尝试拒绝晚到：不发布横幅，防止新尝试已清除/进入编辑器
        // 后旧错误复活或「后完成者」覆盖「后发起者」。
        if (seq !== openAttemptSeqRef.current) return
        setOpenFailure({ id, detail: openFailureDetail(err) })
      }
    },
    [latestDoc, setOpenFailure, setOpenProject, unsavedAiSessions],
  )

  return { handleCreateProject, handleOpenProject }
}

function useOpenProjectActions({
  setOpenProject,
  setOpenFailure,
  refreshProjects,
  unsavedAiSessions,
  latestAiSession,
  latestDoc,
  feedback,
  attempts,
}: {
  readonly setOpenProject: OpenProjectSetter
  readonly setOpenFailure: OpenErrorSetter
  readonly refreshProjects: RefreshProjects
  readonly unsavedAiSessions: UnsavedAiSessionsRef
  readonly latestAiSession: LatestAiSessionRef
  readonly latestDoc: LatestDocRef
  readonly feedback: ReturnType<typeof useHomeActionFeedback>
  readonly attempts: ReturnType<typeof useCreateFamilyAttempts>
}) {
  const { handleCreateProject, handleOpenProject } = useProjectOpenAttempt(
    setOpenProject,
    setOpenFailure,
    refreshProjects,
    unsavedAiSessions,
    latestDoc,
    feedback,
    attempts,
  )

  const handleBackHome = useCallback(() => {
    // 常规路径下返回首页即清除带外最新文档；但随后的编辑器卸载冲刷仍会经
    // onSave 闭包复活引用，权威失效点在打开尝试开始处（issue #118 评审）。
    latestDoc.current = null
    setOpenProject(null)
    void refreshProjects()
  }, [latestDoc, refreshProjects, setOpenProject])

  const handleEditorRename = useCallback(
    (name: string) => {
      setOpenProject((project) => {
        if (!project) return project
        // 同步补丁带外最新文档（issue #118 评审）：重挂载种子解析以它优先，
        // 只更新 openProject.doc 会让首次防抖保存之后的改名被旧名回退且
        // 永不落盘。updater 在 StrictMode 下双调，两次写同值，幂等无害。
        if (latestDoc.current?.id === project.id) {
          latestDoc.current = {
            id: project.id,
            doc: { ...latestDoc.current.doc, name },
          }
        }
        return { ...project, doc: { ...project.doc, name } }
      })
    },
    [latestDoc, setOpenProject],
  )

  const handleSaveAiSession = useAiSessionSave(
    setOpenProject,
    unsavedAiSessions,
    latestAiSession,
  )

  return {
    handleCreateProject,
    handleOpenProject,
    handleBackHome,
    handleEditorRename,
    handleSaveAiSession,
  }
}

/** 创建族诊断区分未提交、部分提交与无法确认；未知时引导先刷新核对。 */
function createFamilyFailureDetail(
  outcome: Extract<CreateFamilyOutcome, { kind: 'rejected' }>,
  action: 'create' | 'duplicate',
): string {
  const detail = openFailureDetail(outcome.err)
  if (outcome.commitState === 'unknown')
    return `${detail}（无法确认是否已创建，请刷新项目列表后核对）`
  if (action === 'duplicate' && outcome.commitState === 'present')
    return `${detail}（列表可能已出现未完成的空副本，可手动删除）`
  return detail
}

function useHomeProjectActions(
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
  feedback: ReturnType<typeof useHomeActionFeedback>,
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
) {
  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      const seq = feedback.begin()
      try {
        const doc = await projectStore.load(id)
        // 拒绝式保存（PR #199 评审）：落盘失败必须上浮失败横幅，立即可见
        // 可重试；失败同经保存链登记后台重试，绝不静默吞掉
        const renamed = { ...doc, name }
        feedback.watchSave(seq, renamed)
        await projectStore.save(id, renamed)
        feedback.succeed(seq)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 重命名失败', err)
        feedback.fail(
          seq,
          {
            action: 'rename',
            targetId: id,
            targetName: name,
            detail: openFailureDetail(err),
          },
          () => void handleRenameProject(id, name),
        )
      }
    },
    [refreshProjects, feedback],
  )

  const handleDuplicateProject = useCallback(
    async (id: string) => {
      const seq = feedback.begin()
      // 复制同样非幂等（PR #199 评审）：失败后对账——认领到产出即部分
      // 提交（列表已出现未完成的空副本），不给盲重试（重试会再造一份并
      // 留下空副本），横幅提示手动处理
      const outcome = await duplicateWithReconcile(attempts, id)
      if (outcome.kind === 'rejected') {
        console.warn('[App] 复制项目失败', outcome.err)
        const detail = createFamilyFailureDetail(outcome, 'duplicate')
        feedback.fail(
          seq,
          { action: 'duplicate', targetId: id, detail },
          outcome.commitState === 'absent'
            ? () => void handleDuplicateProject(id)
            : undefined,
        )
        return
      }
      feedback.succeed(seq)
      await refreshProjects()
    },
    [refreshProjects, feedback, attempts],
  )

  const handleDeleteProject = useCallback(
    async (id: string) => {
      const seq = feedback.begin()
      try {
        await projectStore.delete(id)
        unsavedAiSessions.current?.delete(id)
        feedback.succeed(seq)
        await refreshProjects()
      } catch (err) {
        console.warn('[App] 删除项目失败', err)
        feedback.fail(
          seq,
          { action: 'delete', targetId: id, detail: openFailureDetail(err) },
          () => void handleDeleteProject(id),
        )
      }
    },
    [refreshProjects, unsavedAiSessions, feedback],
  )

  return { handleRenameProject, handleDuplicateProject, handleDeleteProject }
}

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
}: {
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
}) {
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

/**
 * 应用根组件：文档式双界面（docs/ui-design.md §3.1）+ 设置界面——
 * 项目首页 / 编辑器是同一窗口的两种状态，设置页经 ⌘, 叠加打开
 * （独立窗口形态随桌面端演进升级），关闭后回到原界面。
 * 项目数据经 projectStore 持久化（Tauri 落盘 / 浏览器内存回退）。
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

  // ⌘,/Ctrl+, 打开设置（macOS 惯例，§8.2）：文档级监听只判键值与修饰
  // 键，不按焦点目标过滤——输入控件聚焦时同样触发（issue #274）；
  // aria-modal 弹窗打开时挂起（issue #263 评审）：应用级入口同样服从
  // 键盘模态边界，编辑器与弹窗不被静默卸载，弹窗关闭后恢复
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        if (document.querySelector('dialog[aria-modal="true"]')) return
        e.preventDefault()
        startTransition(() => setSettingsOpen(true))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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
        onRetryMutation={actionFeedback.retry}
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
