import { useCallback } from 'react'
import { useHomeActionFeedback } from './useHomeActionFeedback'
import {
  useCreateFamilyAttempts,
  duplicateWithReconcile,
} from './useCreateFamilyAttempts'
import { projectStore } from './projectStore'
import { useWebExitAction } from './useWebExitAction'
import {
  createFamilyFailureDetail,
  openFailureDetail,
  type RefreshProjects,
  type UnsavedAiSessionsRef,
} from './openProjectActions'
import { createDiagnostic } from './diagnostics'

/** 失败事件显式绑定级别、域与机器码；旧前缀和上下文原样交付。 */
const logEvents = {
  projectRenameFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_RENAME_FAILED',
  ),
  projectDuplicateFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_DUPLICATE_FAILED',
  ),
  projectDeleteFailed: createDiagnostic(
    'WARN',
    'plotweave::frontend::app',
    'PROJECT_DELETE_FAILED',
  ),
}

/**
 * 首页卡片变更动作族模块（自 App.tsx 拆出，issue #545）：仅服务首页的
 * 重命名/复制/删除动作编排，不触碰打开态与编辑器域；对外入口是
 * useHomeProjectActions，动作细则见各导出符号的意图文档。
 */
/** 每项目最新重命名意图令牌（issue #801）：重命名各自独立执行
 * load→rename→save，保存队列仅按 save 到达序串行——慢读取的旧意图会在
 * 新名称落盘后把旧名写回。发起即认领本项目令牌，读档返回后仅最新令牌
 * 可交付保存；被取代的旧意图静默作废（其可见结果已由新意图拥有，不是
 * 失败，不上横幅）。注册表随进程存续，与保存链 owner 同生命周期语义。 */
const renameIntents = new Map<string, symbol>()

/** 重命名动作（useHomeProjectActions 拆分，守 80 行上限）：读档改名后
 * 拒绝式保存（PR #199 评审：落盘失败上浮横幅并可重试，失败同经保存链
 * 登记后台重试，绝不静默吞掉），成功后刷新首页摘要。 */
function useRenameProject(
  refreshProjects: RefreshProjects,
  feedback: ReturnType<typeof useHomeActionFeedback>,
) {
  const handleRenameProject = useCallback(
    async (id: string, name: string) => {
      const seq = feedback.begin()
      const intent = Symbol('renameIntent')
      renameIntents.set(id, intent)
      try {
        const doc = await projectStore.load(id)
        // 后发起的重命名拥有最终持久化状态（issue #801）：读档期间已被
        // 新意图取代的旧意图不再交付保存，迟到的读取结果就此作废
        if (renameIntents.get(id) !== intent) return
        const renamed = { ...doc, name }
        feedback.watchSave(seq, renamed)
        await projectStore.save(id, renamed)
        feedback.succeed(seq)
        await refreshProjects()
      } catch (err) {
        logEvents.projectRenameFailed('[App] 重命名失败', err)
        feedback.fail(
          seq,
          {
            action: 'rename',
            targetId: id,
            targetName: name,
            detail: openFailureDetail(err),
          },
          () => handleRenameProject(id, name),
        )
      }
    },
    [refreshProjects, feedback],
  )
  return handleRenameProject
}

/** 首页卡片变更动作集（App 根的 home 桨）：重命名/复制/删除三条非幂等
 * 变更的 store 编排与失败对账——复制与创建共用创建族对账（PR #199：
 * 部分提交不给盲重试），失败横幅经 useHomeActionFeedback 上浮，成功
 * 路径刷新首页摘要。 */
export function useHomeProjectActions(
  refreshProjects: RefreshProjects,
  unsavedAiSessions: UnsavedAiSessionsRef,
  feedback: ReturnType<typeof useHomeActionFeedback>,
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
) {
  const handleRenameProject = useRenameProject(refreshProjects, feedback)

  const handleDuplicateProject = useCallback(
    async (id: string) => {
      const seq = feedback.begin()
      // 复制同样非幂等（PR #199 评审）：失败后对账——认领到产出即部分
      // 提交（列表已出现未完成的空副本），不给盲重试（重试会再造一份并
      // 留下空副本），横幅提示手动处理
      const outcome = await duplicateWithReconcile(attempts, id)
      if (outcome.kind === 'rejected') {
        logEvents.projectDuplicateFailed('[App] 复制项目失败', outcome.err)
        const detail = createFamilyFailureDetail(outcome, 'duplicate')
        feedback.fail(
          seq,
          { action: 'duplicate', targetId: id, detail },
          outcome.commitState === 'absent'
            ? () => handleDuplicateProject(id)
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
        logEvents.projectDeleteFailed('[App] 删除项目失败', err)
        feedback.fail(
          seq,
          { action: 'delete', targetId: id, detail: openFailureDetail(err) },
          () => handleDeleteProject(id),
        )
      }
    },
    [refreshProjects, unsavedAiSessions, feedback],
  )

  return {
    handleRenameProject: useWebExitAction(handleRenameProject),
    handleDuplicateProject: useWebExitAction(handleDuplicateProject),
    handleDeleteProject: useWebExitAction(handleDeleteProject),
  }
}
