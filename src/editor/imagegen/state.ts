/**
 * 生成作业状态与调度内核（docs/data-model.md §13 首片）：ImageGenProvider
 * 的无 UI 部分。作业表按节点 id 键控；start 同步占位（异步间隙内双击不
 * 重复发起）；完成结果先过输入签名守护，再以**复合命令**写回——资产入
 * 索引与 outputs 同栈撤销/重做（§7.3 库资产导入同构，撤销不留不可达索引
 * 条目）；签名丢弃与失败路径经 notice 横幅外显；Provider 卸载即协作式
 * 取消全部 running 作业（§13 作业生命周期 = 编辑器挂载期）。无状态的
 * 过程内核（runStart/applyGenerationResult）为模块级纯函数。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { AssetRef } from '../../model/document'
import { settingsStore } from '../../settings/settingsStore'
import { uid } from '../../uid'
import { normalizeAssetRef, tauriInvoke } from '../projectAssets'
import type { ProjectSettings } from '../settings'
import type { HistoryCommand } from '../history'
import type { CanvasNode } from '../nodes/types'
import type { ImageGenApi, ImageJobView } from './context'
import { resolveImageGenPlan } from './plan'
import { signatureMatches, type ImageGenInput } from './signature'

/** 非桌面环境的统一文案（浏览器预览无 IPC，无法代理生成）。 */
const PREVIEW_UNSUPPORTED = '浏览器预览不支持图像生成（媒体落盘需桌面端 Rust 侧执行）'

/** 调度内核的依赖：EditorView 的稳定引用（ref/命令栈与状态写入回调）。 */
export interface ImageJobsDeps {
  projectId: string
  /** 反应式节点表：宿主节点删除观察（nodesRef 只读镜像不触发重渲染）。 */
  nodes: CanvasNode[]
  nodesRef: { current: CanvasNode[] }
  /** 资产索引镜像：替换产物时查旧产物记录（决定能否随命令移出索引）。 */
  assetsRef: { current: { byId: Record<string, AssetRef> } | undefined }
  /** 设定集镜像：旧产物回收判定需扫角色头像引用（avatarAssetId）。 */
  settingsRef: { current: Pick<ProjectSettings, 'characters'> }
  /** 纯状态写入（复合命令的初始应用与 undo/redo 共用，不单独入栈）。 */
  applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  addAsset: (asset: AssetRef) => void
  removeAsset: (assetId: string) => void
  pushHistory: (cmd: HistoryCommand) => void
}

/** 错误对象的用户可见文案：字符串原样、其余 toString 兜底。 */
function errorText(err: unknown): string {
  return typeof err === 'string' ? err : String(err)
}

function isDesktopTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Rust 生成命令的执行（§9.3 预检已在命令内完成，前端单次 IPC 直收
 * 已校验的资产条目）。 */
async function runGeneration(
  projectId: string,
  jobId: string,
  plan: { provider: { id: string; baseUrl: string }; model: string; prompt: string; size: string },
): Promise<AssetRef> {
  const raw = await tauriInvoke<unknown>('llm_image_generate', {
    request: {
      projectId,
      jobId,
      providerId: plan.provider.id,
      baseUrl: plan.provider.baseUrl,
      model: plan.model,
      prompt: plan.prompt,
      size: plan.size,
    },
  })
  return normalizeAssetRef(raw as never)
}

/** 资产是否仍被引用（角色头像 avatarAssetId、图片 outputs.primary、分镜
 * refs）——替换产物时判断旧产物能否安全移出索引（§7.3 索引删除、媒体
 * 留存回收）。avatarAssetId 是落盘模型的演进字段（CharacterEntity 未
 * 声明，但 serialize 整对象透传、运行时可携带）——按 `in` 收窄读取。 */
function assetReferencedBy(
  nodes: CanvasNode[],
  characters: ProjectSettings['characters'],
  assetId: string,
): boolean {
  const avatarHit = characters.some(
    (c) => 'avatarAssetId' in c && c.avatarAssetId === assetId,
  )
  if (avatarHit) return true
  return nodes.some((n) => {
    if (n.type === 'image') return n.data.outputs.primary?.assetId === assetId
    if (n.type === 'shot') return n.data.refs.some((r) => r.assetId === assetId)
    return false
  })
}

/** 结果落位内核（成功路径）：签名守护 → 复合命令写回（资产入索引 +
 * outputs 纯状态写入同栈撤销/重做，§7.3 库资产导入同构——撤销不留
 * 不可达索引条目，媒体文件留存待回收）；重新生成时旧产物若不再被
 * 任何其他节点引用则随同一命令移出索引（undo 恢复），被引用或已不在
 * 索引则保持不动；输入已前进时经 dropResult 丢弃并横幅提示（媒体
 * 文件留存待回收，§7.3）。 */
function applyGenerationResult(
  deps: {
    nodesRef: ImageJobsDeps['nodesRef']
    assetsRef: ImageJobsDeps['assetsRef']
    settingsRef: ImageJobsDeps['settingsRef']
    applyDataPatch: ImageJobsDeps['applyDataPatch']
    addAsset: ImageJobsDeps['addAsset']
    removeAsset: ImageJobsDeps['removeAsset']
    pushHistory: ImageJobsDeps['pushHistory']
    clearJob: (nodeId: string) => void
    dropResult: (nodeId: string) => void
  },
  nodeId: string,
  input: ImageGenInput,
  asset: AssetRef,
): void {
  deps.clearJob(nodeId)
  const node = deps.nodesRef.current.find((n) => n.id === nodeId)
  if (node?.type !== 'image' || !signatureMatches(input, node.data)) {
    deps.dropResult(nodeId)
    return
  }
  const before = node.data.outputs
  const next = { ...before, primary: { assetId: asset.id } }
  // 旧产物回收判定：换下了旧 primary 且无人再引用（头像/其他节点）且
  // 记录仍在索引。查桶用自有属性检查——悬空 assetId 可能是 '__proto__'
  // 等原型链键名，普通对象桶的继承值不得被当成 AssetRef 回收。
  const prevId = before.primary?.assetId
  const byId = deps.assetsRef.current?.byId
  const superseded =
    prevId !== undefined &&
    prevId !== asset.id &&
    !assetReferencedBy(
      deps.nodesRef.current.filter((n) => n.id !== nodeId),
      deps.settingsRef.current.characters,
      prevId,
    ) &&
    byId !== undefined &&
    Object.prototype.hasOwnProperty.call(byId, prevId)
      ? byId[prevId]
      : undefined
  deps.addAsset(asset)
  if (superseded !== undefined) deps.removeAsset(superseded.id)
  deps.applyDataPatch(nodeId, { outputs: next })
  deps.pushHistory({
    undo: () => {
      deps.removeAsset(asset.id)
      if (superseded !== undefined) deps.addAsset(superseded)
      deps.applyDataPatch(nodeId, { outputs: before })
    },
    redo: () => {
      deps.addAsset(asset)
      if (superseded !== undefined) deps.removeAsset(superseded.id)
      deps.applyDataPatch(nodeId, { outputs: next })
    },
  })
}

/** 发起内核：解析计划 → 执行作业（结果经 applyResult 落位）。作业占位由
 * start 同步完成（双击窗口内不重复发起计费请求），此处只消费 jobId；
 * 设置加载间隙中宿主节点可能被删——提交前复核，不为已删节点付账。 */
async function runStart(
  deps: {
    projectId: string
    nodesRef: ImageJobsDeps['nodesRef']
    jobAlive: (nodeId: string, jobId: string) => boolean
    setJobError: (nodeId: string, message: string) => void
    clearJob: (nodeId: string) => void
    applyResult: (nodeId: string, input: ImageGenInput, asset: AssetRef) => void
  },
  nodeId: string,
  jobId: string,
): Promise<void> {
  if (!isDesktopTauri()) {
    deps.setJobError(nodeId, PREVIEW_UNSUPPORTED)
    return
  }
  const node = deps.nodesRef.current.find((n) => n.id === nodeId)
  if (node?.type !== 'image') {
    // start 占位前已验类型；此分支仅为防御，显式报错不静默
    deps.setJobError(nodeId, '节点已不是图片节点，作业未执行')
    return
  }
  const plan = resolveImageGenPlan(node.data, await settingsStore.load())
  if (!plan.ok) {
    deps.setJobError(nodeId, plan.message)
    return
  }
  if (!deps.nodesRef.current.some((n) => n.id === nodeId)) {
    deps.clearJob(nodeId)
    return
  }
  const input: ImageGenInput = {
    prompt: node.data.prompt,
    model: node.data.model,
    size: node.data.size,
  }
  try {
    const asset = await runGeneration(deps.projectId, jobId, plan)
    if (deps.jobAlive(nodeId, jobId)) deps.applyResult(nodeId, input, asset)
  } catch (err) {
    if (deps.jobAlive(nodeId, jobId)) deps.setJobError(nodeId, errorText(err))
  }
}

/** 作业写回守卫（Provider 生命周期，§13 作业生命周期 = 编辑器挂载期）：
 * aliveRef 标记挂载状态，卸载清理对全部 running 作业发协作式取消——
 * Rust 侧在检查点放弃结果（落盘前），防孤儿媒体文件与卸载后写回；
 * jobAlive 供完成回调判定「仍是该作业且组件存活」。 */
function useJobWriteGuard(
  jobsRef: { current: Record<string, ImageJobView> },
): (nodeId: string, jobId: string) => boolean {
  const aliveRef = useRef(true)
  // 稳定读取器：清理时经函数调用取最新作业表（直接在 cleanup 读 ref.current
  // 会触发 exhaustive-deps 的两难告警——参数化 ref 无法被插件豁免）
  const readJobs = useCallback(() => jobsRef.current, [jobsRef])
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const job of Object.values(readJobs())) {
        if (job?.status === 'running') {
          void tauriInvoke('llm_image_cancel', { jobId: job.jobId }).catch(() => {})
        }
      }
    }
  }, [readJobs])
  return useCallback(
    (nodeId: string, jobId: string): boolean => {
      const cur = jobsRef.current[nodeId]
      return aliveRef.current && cur?.status === 'running' && cur.jobId === jobId
    },
    [jobsRef],
  )
}

/** 宿主节点删除观察（§13 作业生命周期）：running 作业的宿主节点被删即
 * 协作式取消（Rust 未过检查点即放弃结果）并清作业表——不为已删节点
 * 白白支付、不留孤儿媒体；结果若已过检查点返回，jobAlive 已清即静默
 * 丢弃。删除可撤销：undo 复活节点后作业已清，重新生成即可。 */
function useNodeDeletionWatch(
  nodes: CanvasNode[],
  jobsRef: { current: Record<string, ImageJobView> },
  clearJob: (nodeId: string) => void,
): void {
  useEffect(() => {
    const alive = new Set(nodes.map((n) => n.id))
    for (const [nodeId, job] of Object.entries(jobsRef.current)) {
      if (job?.status !== 'running' || alive.has(nodeId)) continue
      void tauriInvoke('llm_image_cancel', { jobId: job.jobId }).catch(() => {})
      clearJob(nodeId)
    }
  }, [nodes, jobsRef, clearJob])
}

/** 作业表状态族（useImageJobsState 的状态层）：jobs 表与 ref 镜像、
 * 错误写入、清表与签名丢弃横幅。 */
function useJobTable(): {
  jobs: Record<string, ImageJobView>
  setJobs: Dispatch<SetStateAction<Record<string, ImageJobView>>>
  jobsRef: { current: Record<string, ImageJobView> }
  notice: string | null
  setJobError: (nodeId: string, message: string) => void
  clearJob: (nodeId: string) => void
  dropResult: (nodeId: string) => void
} {
  const [jobs, setJobs] = useState<Record<string, ImageJobView>>({})
  /** 异步完成时读取最新作业表（setState 闭包会拿到过期快照）；start 的
   * 同步占位也直接写此处（绕过 React 批处理窗口挡双击）。 */
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const [notice, setNotice] = useState<string | null>(null)
  const setJobError = useCallback((nodeId: string, message: string) => {
    setJobs((cur) => ({ ...cur, [nodeId]: { status: 'error', message } }))
  }, [])
  const clearJob = useCallback((nodeId: string) => {
    setJobs((cur) => {
      if (!(nodeId in cur)) return cur
      return Object.fromEntries(Object.entries(cur).filter(([k]) => k !== nodeId))
    })
  }, [])
  const dropResult = useCallback((nodeId: string) => {
    setNotice(
      `图片节点 ${nodeId} 的输入已修改，本次生成结果已丢弃（媒体文件留存待回收，可重新生成）`,
    )
  }, [])
  return { jobs, setJobs, jobsRef, notice, setJobError, clearJob, dropResult }
}

/** 生成作业的状态机与调度回调（ImageGenProvider 挂载一次）。 */
export function useImageJobsState(deps: ImageJobsDeps): {
  api: ImageGenApi
  notice: string | null
} {
  const { projectId, nodes, nodesRef, assetsRef, settingsRef, applyDataPatch, addAsset, removeAsset, pushHistory } =
    deps
  const { jobs, setJobs, jobsRef, notice, setJobError, clearJob, dropResult } = useJobTable()
  /** 作业写回守卫：卸载协作式取消 + 存活/身份判定（useJobWriteGuard）。 */
  const jobAlive = useJobWriteGuard(jobsRef)
  /** 宿主节点删除观察：running 作业随宿主删除协作式取消并清表。 */
  useNodeDeletionWatch(nodes, jobsRef, clearJob)

  const applyResult = useCallback(
    (nodeId: string, input: ImageGenInput, asset: AssetRef) =>
      applyGenerationResult(
        {
          nodesRef,
          assetsRef,
          settingsRef,
          applyDataPatch,
          addAsset,
          removeAsset,
          pushHistory,
          clearJob,
          dropResult,
        },
        nodeId,
        input,
        asset,
      ),
    [
      addAsset,
      applyDataPatch,
      assetsRef,
      clearJob,
      dropResult,
      nodesRef,
      pushHistory,
      removeAsset,
      settingsRef,
    ],
  )

  /** 发起：同步验型 + running 守卫并**同步占位**（直接写 jobsRef，绕过
   * React 批处理窗口）——设置加载（桌面端异步 IPC）返回前，双击的第二次
   * 调用看到 running 即返回，不重复发起计费请求。 */
  const start = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (node?.type !== 'image') return
      if (jobsRef.current[nodeId]?.status === 'running') return
      const jobId = uid('imgjob')
      jobsRef.current = { ...jobsRef.current, [nodeId]: { status: 'running', jobId } }
      setJobs(jobsRef.current)
      void runStart({ projectId, nodesRef, jobAlive, setJobError, clearJob, applyResult }, nodeId, jobId)
    },
    [applyResult, clearJob, jobAlive, jobsRef, nodesRef, projectId, setJobError, setJobs],
  )

  const cancel = useCallback(
    (nodeId: string) => {
      const cur = jobsRef.current[nodeId]
      if (cur?.status !== 'running') return
      const jobId = cur.jobId
      clearJob(nodeId)
      void tauriInvoke('llm_image_cancel', { jobId }).catch(() => {})
    },
    [clearJob, jobsRef],
  )

  const api = useMemo<ImageGenApi>(
    () => ({ jobOf: (nodeId) => jobs[nodeId] ?? null, start, cancel }),
    [jobs, start, cancel],
  )
  return { api, notice }
}
