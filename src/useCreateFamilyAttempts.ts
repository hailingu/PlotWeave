/** 首页创建/复制的完整尝试队列，避免非幂等失败对账跨请求认领项目。 */
import { useCallback, useRef } from 'react'
import { projectStore } from './projectStore'
import { seedProjects } from './projectStore/seeds'
import type { ProjectSummary } from './home/projects'
import type { CreateFamilyOutcome } from './home/createFamilyOutcome'

/** 列表维护使用固定示例身份；创建/复制生成新身份，不能认领这些维护产物。 */
const seedIds = new Set(seedProjects().map(({ meta }) => meta.id))

/** 在独占的尝试窗口内读取存储基线、执行变更并对账。基线失败时不写入；
 * 操作拒绝后读取也失败时保留未知状态，不能用空列表开放盲重试。 */
async function executeAttempt(
  readProjects: () => Promise<ProjectSummary[]>,
  operation: () => Promise<ProjectSummary>,
): Promise<CreateFamilyOutcome> {
  let before: Set<string>
  try {
    before = new Set((await readProjects()).map((project) => project.id))
  } catch (err) {
    return { kind: 'rejected', err, commitState: 'absent' }
  }
  try {
    const project = await operation()
    return { kind: 'created', id: project.id }
  } catch (err) {
    try {
      const projects = await readProjects()
      const committed = projects.some(
        (project) => !before.has(project.id) && !seedIds.has(project.id),
      )
      return {
        kind: 'rejected',
        err,
        commitState: committed ? 'present' : 'absent',
      }
    } catch {
      // 严格读取入口已发布列表诊断；这里保留原始变更错误与提交未知状态。
      return { kind: 'rejected', err, commitState: 'unknown' }
    }
  }
}

/** 创建和复制共用队列：前次失败对账结束后，下一次才读取存储基线并
 * 执行。整段独占消除双拒绝时的归属歧义；不依赖尚未渲染的列表镜像，
 * 也不改变 IPC/落盘身份契约。删除不在队列内，清空库后的普通刷新或对账
 * 读取可能播种示例；固定示例身份不计入本次尝试产出。 */
export function useCreateFamilyAttempts(
  readProjects: () => Promise<ProjectSummary[]>,
) {
  const queueRef = useRef(Promise.resolve())
  /** 排队执行完整尝试；失败也释放队列，后续请求重新读取权威基线。 */
  const run = useCallback(
    (
      operation: () => Promise<ProjectSummary>,
    ): Promise<CreateFamilyOutcome> => {
      const execute = () => executeAttempt(readProjects, operation)
      const result = queueRef.current.then(execute)
      queueRef.current = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    [readProjects],
  )
  return { run }
}

/** 创建从基线读取到失败对账都位于共享队列内。 */
export function createWithReconcile(
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
  name: string,
): Promise<CreateFamilyOutcome> {
  return attempts.run(() => projectStore.create(name))
}

/** 复制包括内部创建、资产拷贝与失败清理，全程占有同一尝试窗口。 */
export function duplicateWithReconcile(
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
  id: string,
): Promise<CreateFamilyOutcome> {
  return attempts.run(() => projectStore.duplicate(id))
}
