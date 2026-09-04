/**
 * 生成作业状态与调度内核（docs/data-model.md §13 首片）：ImageGenProvider
 * 的无 UI 部分。作业表按节点 id 键控；start 同步占位（异步间隙内双击不
 * 重复发起）；完成结果先过输入签名守护再以命令写回（可撤销）；签名丢弃
 * 与失败路径经 notice 横幅外显；Provider 卸载即协作式取消全部 running
 * 作业（§13 作业生命周期 = 编辑器挂载期）。无状态的过程内核
 * （runStart/applyGenerationResult/executeJob）为模块级纯函数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssetRef } from '../../model/document'
import { settingsStore } from '../../settings/settingsStore'
import { uid } from '../../uid'
import { normalizeAssetRef, tauriInvoke } from '../projectAssets'
import type { CanvasNode } from '../nodes/types'
import type { ImageGenApi, ImageJobView } from './context'
import { resolveImageGenPlan } from './plan'
import { signatureMatches, type ImageGenInput } from './signature'

/** 非桌面环境的统一文案（浏览器预览无 IPC，无法代理生成）。 */
const PREVIEW_UNSUPPORTED = '浏览器预览不支持图像生成（媒体落盘需桌面端 Rust 侧执行）'

/** 调度内核的依赖：EditorView 的稳定引用（ref/命令回调）。 */
export interface ImageJobsDeps {
  projectId: string
  nodesRef: { current: CanvasNode[] }
  patchNode: (id: string, patch: Record<string, unknown>) => void
  addAsset: (asset: AssetRef) => void
}

/** 错误对象的用户可见文案：字符串原样、其余 toString 兜底。 */
function errorText(err: unknown): string {
  return typeof err === 'string' ? err : String(err)
}

function isDesktopTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Rust 生成命令的执行与 §9.3 预检（媒体已落盘，前端只收条目）。 */
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
  const generated = normalizeAssetRef(raw as never)
  // 入索引前过 Rust 预检（与库导入同域，§9.3 set_asset 强制预检）
  const checked = await tauriInvoke<unknown>('validate_project_asset', {
    id: projectId,
    asset: generated,
  })
  return normalizeAssetRef(checked as never)
}

/** 结果落位内核（成功路径）：签名守护 → 并入资产索引 → 命令写回；
 * 输入已前进时经 dropResult 丢弃并横幅提示（媒体文件留存待回收，§7.3）。 */
function applyGenerationResult(
  deps: {
    nodesRef: ImageJobsDeps['nodesRef']
    patchNode: ImageJobsDeps['patchNode']
    addAsset: ImageJobsDeps['addAsset']
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
  deps.addAsset(asset)
  deps.patchNode(nodeId, {
    outputs: { ...node.data.outputs, primary: { assetId: asset.id } },
  })
}

/** 发起内核：解析计划 → 执行作业（结果经 applyResult 落位）。作业占位由
 * start 同步完成（双击窗口内不重复发起计费请求），此处只消费 jobId。 */
async function runStart(
  deps: {
    projectId: string
    nodesRef: ImageJobsDeps['nodesRef']
    jobAlive: (nodeId: string, jobId: string) => boolean
    setJobError: (nodeId: string, message: string) => void
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

/** 生成作业的状态机与调度回调（ImageGenProvider 挂载一次）。 */
export function useImageJobsState(deps: ImageJobsDeps): {
  api: ImageGenApi
  notice: string | null
} {
  const { projectId, nodesRef, patchNode, addAsset } = deps
  const [jobs, setJobs] = useState<Record<string, ImageJobView>>({})
  /** 异步完成时读取最新作业表（setState 闭包会拿到过期快照）。 */
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const [notice, setNotice] = useState<string | null>(null)
  /** Provider 存活标志：卸载后完成回调不得再写任何状态（写也是 no-op，
   * 显式跳过以保持语义清晰）。 */
  const aliveRef = useRef(true)

  /** 卸载清理（§13 作业生命周期 = 编辑器挂载期）：EditorView 卸载
   * （⌘, 设置页 / 返回首页）即对全部 running 作业发协作式取消——Rust 侧
   * 在检查点放弃结果（落盘前），防孤儿媒体文件与卸载后写回。 */
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const job of Object.values(jobsRef.current)) {
        if (job?.status === 'running') {
          void tauriInvoke('llm_image_cancel', { jobId: job.jobId }).catch(() => {})
        }
      }
    }
  }, [])

  /** 作业仍是对应 jobId 的 running 态且组件存活才允许写状态（被取消/
   * 替换/卸载即过期）；只读 jobsRef，行为稳定（空依赖）。 */
  const jobAlive = useCallback((nodeId: string, jobId: string): boolean => {
    const cur = jobsRef.current[nodeId]
    return aliveRef.current && cur?.status === 'running' && cur.jobId === jobId
  }, [])

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

  const applyResult = useCallback(
    (nodeId: string, input: ImageGenInput, asset: AssetRef) =>
      applyGenerationResult(
        { nodesRef, patchNode, addAsset, clearJob, dropResult },
        nodeId,
        input,
        asset,
      ),
    [addAsset, clearJob, dropResult, nodesRef, patchNode],
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
      void runStart({ projectId, nodesRef, jobAlive, setJobError, applyResult }, nodeId, jobId)
    },
    [applyResult, jobAlive, nodesRef, projectId, setJobError],
  )

  const cancel = useCallback(
    (nodeId: string) => {
      const cur = jobsRef.current[nodeId]
      if (cur?.status !== 'running') return
      const jobId = cur.jobId
      clearJob(nodeId)
      void tauriInvoke('llm_image_cancel', { jobId }).catch(() => {})
    },
    [clearJob],
  )

  const api = useMemo<ImageGenApi>(
    () => ({ jobOf: (nodeId) => jobs[nodeId] ?? null, start, cancel }),
    [jobs, start, cancel],
  )
  return { api, notice }
}
