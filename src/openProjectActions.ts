import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { OpenProjectError } from './home/OpenErrorBanner'
import { useHomeActionFeedback } from './useHomeActionFeedback'
import type { CreateFamilyOutcome } from './home/createFamilyOutcome'
import {
  createWithReconcile,
  useCreateFamilyAttempts,
} from './useCreateFamilyAttempts'
import { useWebExitAction } from './useWebExitAction'
import { useExitGuardedCallback } from './useExitGuardedCallback'
import { displayIpcError } from './ipcError'
import { projectStore, type ProjectContent } from './projectStore'
import type { AiSession } from './ai/session'
import { createDiagnostic } from './diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  aiSessionRecoveryFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'AI_SESSION_RECOVERY_FAILED',
  ),
  projectCreateFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_CREATE_FAILED',
  ),
  projectCreatedOpenFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_CREATED_OPEN_FAILED',
  ),
  projectOpenFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_OPEN_FAILED',
  ),
}

/**
 * 打开/新建项目的协调域（自 App.tsx 拆出，issue #545）：持有打开态的
 * 数据形状与带外快照引用、画布+AI 会话的分离加载、AI 会话的跨页面
 * 生命周期与保存通道，以及打开/新建尝试的并发收敛。App.tsx 只保留
 * 视图装配与壳层接线；本模块不触碰 editor/**（外壳→功能方向，
 * issue #399），编辑器重挂载种子经 LatestAiSession/LatestDoc 引用
 * 由 AppView 在渲染时解析。
 */

/** 未落盘会话的保留条目：保存失败后跨首页保留，重开项目时恢复并自动重试。 */
export interface UnsavedAiSession {
  session: AiSession
  error: string
}

/** 打开期间最新的 AI 会话快照（App state 之外，issue #61）：保存路径只写
 * 此引用、不触发渲染；AppView 在渲染时按 id 解析为挂载种子，设置页往返
 * 等重挂载场景据此恢复到最新历史。 */
export interface LatestAiSession {
  id: string
  session: AiSession
}

/** 打开期间最新的画布文档快照（App state 之外，issue #118）：保存路径只写
 * 此引用、不触发渲染；设置页互斥路由会卸载编辑器，重挂载若以打开时刻的
 * openProject.doc 为种子，下一次全量保存就会回滚往返前的较新编辑。 */
export interface LatestDoc {
  id: string
  doc: ProjectContent
}

/** 编辑器态：已加载的项目（id + 名称 + 画布文档）。aiSession 只是项目打开
 * /重开时刻的挂载种子；打开期间的最新值由 LatestAiSession 引用承载。 */
export interface OpenProject {
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
    logEvents.aiSessionRecoveryFailed(
      '[App] AI 会话恢复失败，已以空历史打开项目',
      err,
    )
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

/** 打开态 setState 的形状：与 App 根的 OpenProject state 对接。 */
export type OpenProjectSetter = Dispatch<SetStateAction<OpenProject | null>>
/** 打开失败横幅 setState 的形状（issue #98）。 */
export type OpenErrorSetter = Dispatch<SetStateAction<OpenProjectError | null>>
/** 首页摘要刷新入口的形状（useProjectSummaries 提供）。 */
export type RefreshProjects = () => Promise<void>
/** 未落盘会话保留区的引用形状。 */
export type UnsavedAiSessionsRef = RefObject<Map<string, UnsavedAiSession>>
/** 保存路径需要整体替换快照，故用可变盒子而非只读的 RefObject。 */
export type LatestAiSessionRef = { current: LatestAiSession | null }
/** 画布保存路径同样整体替换快照，用可变盒子。 */
export type LatestDocRef = { current: LatestDoc | null }

/** 打开失败原因的可读化（issue #98）：Error 取 message（避免「Error: 」
 * 前缀上屏），Tauri IPC 常见的字符串拒绝原样保留，其余形态 String() 兜底；
 * IPC 机器码前缀（issue #229）只服务程序判定，一律剥离不上屏。 */
export function openFailureDetail(err: unknown): string {
  return displayIpcError(err)
}

/** 应用级会话生命周期：持有跨页面快照，订阅共享保存链结果，并在卸载时
 * 解除订阅；普通保存的最新内容与失败恢复副本均不依赖编辑器挂载状态。 */
export function useAiSessionLifecycle(setOpenProject: OpenProjectSetter) {
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

/** 打开/新建尝试的代序号容器：共享可变盒子，便于尝试路径拆分后的
 * 各 hook 引用同一次发起序（序号语义见 useProjectOpenAttempt）。 */
type OpenAttemptSeqRef = { current: number }

/** 新建尝试路径（useProjectOpenAttempt 拆分，守 80 行上限）：代序号 +
 * 带外引用失效 + 作废排队导航，创建族对账（issue #132/PR #199：只有
 * 确认未创建才开放重试），创建成功后按序进入编辑器——创建成功但打开
 * 失败不虚报变更失败，由 #98 打开横幅承接。 */
function useCreateProjectAttempt(
  openAttemptSeqRef: OpenAttemptSeqRef,
  setOpenProject: OpenProjectSetter,
  setOpenFailure: OpenErrorSetter,
  refreshProjects: RefreshProjects,
  latestDoc: LatestDocRef,
  feedback: ReturnType<typeof useHomeActionFeedback>,
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
) {
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
    // 创建族从基线读取到失败对账完整串行；只有确认未创建才开放重试。
    const outcome = await createWithReconcile(attempts, '未命名短剧')
    if (outcome.kind === 'rejected') {
      logEvents.projectCreateFailed('[App] 新建项目失败', outcome.err)
      if (outcome.commitState !== 'present') {
        feedback.fail(
          fbSeq,
          {
            action: 'create',
            targetName: '未命名短剧',
            detail: createFamilyFailureDetail(outcome, 'create'),
          },
          outcome.commitState === 'absent'
            ? () => handleCreateProject()
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
      logEvents.projectCreatedOpenFailed('[App] 新建后打开失败', err)
      // 被取代的旧尝试拒绝晚到：不发布横幅（与 handleOpenProject 同款）
      if (seq === openAttemptSeqRef.current)
        setOpenFailure({ id: outcome.id, detail: openFailureDetail(err) })
    }
    void refreshProjects()
  }, [
    openAttemptSeqRef,
    latestDoc,
    refreshProjects,
    setOpenFailure,
    setOpenProject,
    feedback,
    attempts,
  ])
  return handleCreateProject
}

/** 打开/新建尝试的代序号与两条尝试路径（useOpenProjectActions 拆分，
 * issue #99 格式化后回到 80 行内；创建路径再拆至 useCreateProjectAttempt）。
 * 加载期间首页控件仍可操作，慢的旧尝试可能在新尝试开始后才落定——只有
 * 最新发起的尝试可以发布结果（进入编辑器或失败横幅），被取代的旧尝试只
 * 留诊断；与 useProjectSummaries 的刷新序号收敛同款语义（标准「状态、
 * 并发与失败边界」：并发执行须先定义取代行为）。 */
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

  const handleCreateProject = useCreateProjectAttempt(
    openAttemptSeqRef,
    setOpenProject,
    setOpenFailure,
    refreshProjects,
    latestDoc,
    feedback,
    attempts,
  )

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
        logEvents.projectOpenFailed('[App] 打开项目失败', err)
        // 被取代的旧尝试拒绝晚到：不发布横幅，防止新尝试已清除/进入编辑器
        // 后旧错误复活或「后完成者」覆盖「后发起者」。
        if (seq !== openAttemptSeqRef.current) return
        setOpenFailure({ id, detail: openFailureDetail(err) })
      }
    },
    [latestDoc, setOpenFailure, setOpenProject, unsavedAiSessions],
  )

  return {
    handleCreateProject: useWebExitAction(handleCreateProject),
    handleOpenProject: useWebExitAction(handleOpenProject),
  }
}

/** 打开/新建/返回/改名与 AI 会话保存的对外动作集（App 根的 open 桨）：
 * 组合 useProjectOpenAttempt 的并发收敛、退出护栏写通道与带外引用同步，
 * 供 AppView 透传给首页与编辑器。 */
export function useOpenProjectActions({
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
  const writeOpenProject = useExitGuardedCallback(setOpenProject)
  const { handleCreateProject, handleOpenProject } = useProjectOpenAttempt(
    writeOpenProject,
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
    writeOpenProject(null)
    latestDoc.current = null
    void refreshProjects()
  }, [latestDoc, refreshProjects, writeOpenProject])

  const handleEditorRename = useCallback(
    (name: string) => {
      writeOpenProject((project) => {
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
    [latestDoc, writeOpenProject],
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
export function createFamilyFailureDetail(
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
