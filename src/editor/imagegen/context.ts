/**
 * 图像生成调度的上下文与消费 hook（docs/data-model.md §13 首片）。
 * 与 Provider 组件分文件：本文件只导出上下文与 hook（对齐 nodeEdit 的
 * 分层），Provider（ImageGenProvider.tsx）只导出组件。
 */
import { createContext, useContext } from 'react'

/** 节点作业的运行态视图：running 携带 jobId（取消与过期完成判定用）。 */
export type ImageJobView =
  | { status: 'running'; jobId: string }
  | { status: 'error'; message: string }

/** 图片节点消费的生成调度接口。 */
export interface ImageGenApi {
  /** 节点当前作业；null = 空闲。 */
  jobOf: (nodeId: string) => ImageJobView | null
  /** 发起生成（按 nodesRef 中的最新节点数据解析计划）；同步占位作业表，
   * 设置加载的异步间隙内重复调用不会重复发起。 */
  start: (nodeId: string) => void
  /** 协作式取消进行中的作业（Rust 侧放弃结果）。 */
  cancel: (nodeId: string) => void
}

export const ImageGenContext = createContext<ImageGenApi | null>(null)

/** 图片节点/表单内取生成调度能力；必须在 ImageGenProvider 内使用。 */
export function useImageJobs(): ImageGenApi {
  const ctx = useContext(ImageGenContext)
  if (!ctx) {
    throw new Error('useImageJobs 必须在 ImageGenProvider 内使用')
  }
  return ctx
}
