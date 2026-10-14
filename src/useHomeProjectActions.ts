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

/**
 * 首页卡片变更动作族（自 App.tsx 拆出，issue #545）：重命名/复制/删除
 * 三条非幂等变更的 store 编排与失败对账——复制与创建共用创建族对账
 * （PR #199），失败横幅经 useHomeActionFeedback 上浮，成功路径刷新
 * 首页摘要。仅服务首页，不触碰打开态与编辑器域。
 */
export function useHomeProjectActions(
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
          () => handleRenameProject(id, name),
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
        console.warn('[App] 删除项目失败', err)
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
