/** 首页项目列表读取、诊断与保存通知刷新；严格读取保留对账所需的失败语义。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { projectStore } from './projectStore'
import type { ProjectSummary } from './home/projects'

/** 项目列表状态与保存落定的刷新编排（issue #101，自 App 拆出以守 80 行
 * 组件上限）：返回首页的读取与保存落定触发的再刷新并发时按发起序收敛，
 * 只有最近发起的请求可以写列表——慢的旧响应不得覆盖较新的结果。保存落定
 * （含失败登记后的链上后台重试成功）且首页可见时自动再刷新；保存失败不
 * 通知，首页保持磁盘现状不虚报成功。编辑器打开期间首页不可见，且列表
 * state 更新会整树重渲染（issue #61），不刷新。首页可见性经渲染期同步
 * 镜像而非 effect 闭包：保存落定的通知可能早于订阅 effect 重跑到达，
 * 闭包会错过刚提交的导航。 */
export function useProjectSummaries(isHomeVisible: () => boolean): {
  readonly projects: ProjectSummary[]
  readonly loading: boolean
  /** 最近一次读取失败的诊断（#133）：null = 无错误。失败不清空已知列表。 */
  readonly loadError: string | null
  /** 日常刷新：读取失败已发布诊断，事件入口无需再处理拒绝。 */
  readonly refreshProjects: () => Promise<void>
  /** 严格读取并发布列表：保留拒绝，供创建族基线与失败对账。 */
  readonly readProjects: () => Promise<ProjectSummary[]>
} {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refreshSeqRef = useRef(0)
  const homeVisibleRef = useRef(true)
  homeVisibleRef.current = isHomeVisible()

  /** 拉取并发布列表；返回本次拉到的列表（调用方可做前后对账，issue #132
   * 评审：create 拒绝但项目已存在时不盲重试）。 */
  const readProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const seq = ++refreshSeqRef.current
    try {
      const list = await projectStore.list()
      // 仅最新请求发布（代际收敛）：较旧失败已在守卫下跳过，不覆盖较新成功
      if (seq === refreshSeqRef.current) {
        setProjects(list)
        setLoadError(null)
      }
      return list
    } catch (err) {
      console.warn('[App] 项目列表加载失败', err)
      // 读取失败 ≠ 空列表（#133）：保留已知列表供展示，只置错误态交由
      // HomePage 呈现诊断/重试；项目文件本身未受影响（整次枚举失败）
      if (seq === refreshSeqRef.current) setLoadError(String(err))
      throw err
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false)
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    // readProjects 已记录诊断并保留卡片，普通刷新在这里消费拒绝。
    await readProjects().catch(() => undefined)
  }, [readProjects])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  useEffect(
    () =>
      projectStore.onProjectSaved(() => {
        if (homeVisibleRef.current) void refreshProjects()
      }),
    [refreshProjects],
  )

  return { projects, loading, loadError, refreshProjects, readProjects }
}
