import { useCallback, useRef, type RefObject } from 'react'
import { projectStore } from './projectStore'
import type { ProjectSummary } from './home/projects'

/**
 * 创建族尝试协调器（issue #132 失败反馈的对账内核，自 App.tsx 拆出守
 * 文件行数上限）：create 与 duplicate 的内部 create 都非幂等——原子
 * rename 之后的目录 fsync 失败或 IPC 应答丢失会让命令拒绝而已建出项目。
 * 每次尝试经 begin 登记「尝试前列表快照 + 主操作落定门」；失败后
 * reconcile 先等其它在途尝试的主操作落定并登记产出（claimed），再重列
 * 取快照外且未被认领的新项目——有即视为本次尝试可能已（部分）提交并
 * 认领之，没有才允许安全重试。已认领/产出的 id 跨尝试共享，他次尝试
 * （如先行的快速创建或复制）的产出不会被本次失败误认领；对账经内部
 * 互斥队列串行执行——并行的两个失败对账不会交叉认领同一产出，也不会
 * 互相等待（各自只等主操作落定门，主操作是独立 IPC，无环）。
 */
export function useCreateFamilyAttempts(
  refreshProjects: () => Promise<ProjectSummary[]>,
  projectsRef: RefObject<ProjectSummary[]>,
) {
  /** 已由某次创建族尝试产出/认领的项目 id（跨尝试对账排除用）。 */
  const claimedIdsRef = useRef(new Set<string>())
  /** 在途尝试 → 其主操作落定门（对账只等主操作落定，不等对方对账）。 */
  const inflightRef = useRef(new Map<object, Promise<void>>())
  /** 失败对账互斥队列（串行认领，防交叉误领）。 */
  const reconcileQueueRef = useRef(Promise.resolve())

  /** 登记一次创建族尝试；主操作（create/duplicate 的 IPC）落定即调用
   * opSettled（成功带产出 id），失败分支随后可 reconcile 对账。 */
  const begin = useCallback(() => {
    let release!: () => void
    const settled = new Promise<void>((res) => {
      release = res
    })
    const token = {}
    const attempt = {
      /** 尝试开始时的列表 id 快照。 */
      before: new Set((projectsRef.current ?? []).map((x) => x.id)),
      /** 主操作落定：登记产出（成功时）并解除在途门。 */
      opSettled: (createdId?: string) => {
        if (createdId !== undefined) claimedIdsRef.current.add(createdId)
        inflightRef.current.delete(token)
        release()
      },
      /** 失败对账（串行）：等其它在途尝试的主操作落定并登记产出后重列，
       * 认领一个快照外且未被认领的新项目。返回是否认领到（= 本次可能
       * 已提交，禁止盲重试）。 */
      reconcile: (): Promise<boolean> => {
        const run = async () => {
          await Promise.all(inflightRef.current.values())
          const list = await refreshProjects()
          const fresh = list.find(
            (x) =>
              !attempt.before.has(x.id) && !claimedIdsRef.current.has(x.id),
          )
          if (fresh === undefined) return false
          claimedIdsRef.current.add(fresh.id)
          return true
        }
        const queued = reconcileQueueRef.current.then(run, run)
        reconcileQueueRef.current = queued.then(
          () => undefined,
          () => undefined,
        )
        return queued
      },
    }
    inflightRef.current.set(token, settled)
    return attempt
  }, [refreshProjects, projectsRef])

  return { begin }
}

/** 创建族执行结果：created = 存储成功（id 为产出）；rejected = 被拒，其
 * 中 reconciled = 对账认领到产出（可能已提交，禁止盲重试）。 */
export type CreateFamilyOutcome =
  | { readonly kind: 'created'; readonly id: string }
  | {
      readonly kind: 'rejected'
      readonly err: unknown
      readonly reconciled: boolean
    }

/** 执行一次项目创建并含失败对账（issue #132/PR #199 评审）：主操作成败
 * 都先 opSettled 登记产出/解除在途门，失败再 reconcile。 */
export async function createWithReconcile(
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
  name: string,
): Promise<CreateFamilyOutcome> {
  const attempt = attempts.begin()
  try {
    const meta = await projectStore.create(name)
    attempt.opSettled(meta.id)
    return { kind: 'created', id: meta.id }
  } catch (err) {
    attempt.opSettled()
    return { kind: 'rejected', err, reconciled: await attempt.reconcile() }
  }
}

/** 执行一次项目复制并含失败对账（PR #199 评审）：复制非幂等——其内部
 * create 原子提交后才失败（fsync/应答丢失）时项目已建而清理拿不到 id，
 * 对账认领到产出即视为部分提交。 */
export async function duplicateWithReconcile(
  attempts: ReturnType<typeof useCreateFamilyAttempts>,
  id: string,
): Promise<CreateFamilyOutcome> {
  const attempt = attempts.begin()
  try {
    const copy = await projectStore.duplicate(id)
    attempt.opSettled(copy.id)
    return { kind: 'created', id: copy.id }
  } catch (err) {
    attempt.opSettled()
    return { kind: 'rejected', err, reconciled: await attempt.reconcile() }
  }
}
