/**
 * 画布内 AI 图像生成的调度 Provider（docs/data-model.md §13 首片：文生图）。
 * EditorView 挂载一次；状态机与调度内核在 state.ts（useImageJobsState），
 * 本组件只负责上下文分发与失败/丢弃横幅的外显。作业生命周期 = 编辑器
 * 挂载期：本 Provider 卸载（⌘, 设置页 / 返回首页）即协作式取消全部
 * running 作业（Rust 侧检查点放弃结果）。
 */
import type { ReactNode } from 'react'
import type { AssetRef } from '../../model/document'
import ErrorBanner from '../ErrorBanner'
import type { ProjectSettings } from '../settings'
import type { CanvasNode } from '../nodes/types'
import { ImageGenContext } from './context'
import { useImageJobsState } from './state'

/** Provider 依赖：均取 EditorView 的稳定引用（ref/命令栈与状态写入回调）。 */
interface ImageGenProviderProps {
  readonly projectId: string
  readonly nodesRef: { current: CanvasNode[] }
  readonly assetsRef: { current: { byId: Record<string, AssetRef> } | undefined }
  readonly settingsRef: { current: Pick<ProjectSettings, 'characters'> }
  readonly applyDataPatch: (id: string, patch: Record<string, unknown>) => void
  readonly addAsset: (asset: AssetRef) => void
  readonly removeAsset: (assetId: string) => void
  readonly pushHistory: (cmd: import('../history').HistoryCommand) => void
  readonly children: ReactNode
}

export function ImageGenProvider({
  projectId,
  nodesRef,
  assetsRef,
  settingsRef,
  applyDataPatch,
  addAsset,
  removeAsset,
  pushHistory,
  children,
}: ImageGenProviderProps) {
  const { api, notice } = useImageJobsState({
    projectId,
    nodesRef,
    assetsRef,
    settingsRef,
    applyDataPatch,
    addAsset,
    removeAsset,
    pushHistory,
  })
  return (
    <ImageGenContext.Provider value={api}>
      {notice !== null && <ErrorBanner message={notice} />}
      {children}
    </ImageGenContext.Provider>
  )
}
