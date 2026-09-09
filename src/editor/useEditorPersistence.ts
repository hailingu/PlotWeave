/**
 * 编辑器防抖落盘（EditorView 拆出的持久化域，docs/ui-design.md §3/§10.2）：
 * 会话文档随状态变化防抖保存，失败即横幅提示并自动重试。视口本身无重渲染，
 * onMoveEnd 更新 ref 后经 markDirty 显式标脏换入最新文档——纯平移/缩放也
 * 落盘，卸载冲刷与后续内容保存拿到的都是最新视口（不落 stale 值）。
 */
import { useCallback, useRef, useState } from 'react'
import type { Viewport } from '@xyflow/react'
import { errorBannerMessage } from './errorBannerMessage'
import { sessionDoc } from './sessionDoc'
import { useDebouncedSave } from './useDebouncedSave'
import type { EditorDocument, EditorProjectContent } from './useEditorDocument'
import type { ProjectContent } from '../model/content'

/** 内容/视口变化后的防抖窗口（毫秒），与 useDebouncedSave 默认节律一致。 */
const SAVE_DEBOUNCE_MS = 600

/** 落盘诊断、标脏入口与画布持久化确认。 */
export interface EditorPersistence {
  /** 保存失败的用户可见诊断；null = 无失败（成功后清除）。 */
  saveError: string | null
  /** 显式标脏：供无重渲染的 transient 变更换入最新文档。 */
  markDirty: (doc: ProjectContent) => void
  /** 视口落定：更新 ref 并按最新视口标脏（§3 视口随文档持久化）。 */
  onMoveEnd: (event: unknown, viewport: Viewport) => void
  /** 画布文档确认落盘的等待器（AI 执行回执的持久化时序闸门）：
   * 仅在**注册之后开始**的保存成功落定后兑现——在途的旧保存捕获的是
   * 本次改动之前的文档，不算数；失败保持等待，由防抖重试接力。 */
  whenCanvasCommitted: () => Promise<void>
}

/** 组装当前会话文档（project 透传字段 + 编辑器可变状态）。 */
function buildSessionDoc(
  project: EditorProjectContent,
  doc: EditorDocument,
  viewport: Viewport | undefined,
): ProjectContent {
  return sessionDoc(project, {
    nodes: doc.nodes,
    edges: doc.edges,
    settings: doc.settings,
    episodeTitles: doc.episodeTitles,
    viewport,
    assets: doc.assets,
  })
}

/** 画布落盘确认闸门（whenCanvasCommitted 的实现）：包装 onSave 记录保存
 * 代次，成功后兑现全部早于本次代次的等待者；失败不兑现，等待者由后续
 * 重试保存兑现。等待者注册发生在渲染提交后的 effect 中，故任何晚于注册
 * 开始的保存都携带注册时的文档（含刚执行的 AI 批次）。 */
function useCanvasCommitBarrier(onSave: (doc: ProjectContent) => void | Promise<void>) {
  const attemptRef = useRef(0)
  const waitersRef = useRef<Array<{ minAttempt: number; resolve: () => void }>>([])
  const wrappedOnSave = useCallback(
    async (doc: ProjectContent) => {
      const attempt = ++attemptRef.current
      await onSave(doc)
      const waiters = waitersRef.current
      waitersRef.current = waiters.filter((waiter) => {
        if (waiter.minAttempt >= attempt) return true
        waiter.resolve()
        return false
      })
    },
    [onSave],
  )
  const whenCanvasCommitted = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waitersRef.current.push({ minAttempt: attemptRef.current, resolve })
      }),
    [],
  )
  return { wrappedOnSave, whenCanvasCommitted }
}

/** 防抖落盘与保存失败诊断（§10.2）。 */
export function useEditorPersistence(
  project: EditorProjectContent,
  doc: EditorDocument,
  onSave: (doc: ProjectContent) => void | Promise<void>,
): EditorPersistence {
  const [saveError, setSaveError] = useState<string | null>(null)
  const handleSaveResult = useCallback((err: unknown) => {
    if (err === null) {
      setSaveError(null)
      return
    }
    setSaveError(errorBannerMessage(err))
  }, [])

  const { wrappedOnSave, whenCanvasCommitted } = useCanvasCommitBarrier(onSave)
  const markDirty = useDebouncedSave(
    buildSessionDoc(project, doc, doc.viewportRef.current),
    wrappedOnSave,
    SAVE_DEBOUNCE_MS,
    handleSaveResult,
  )

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      doc.viewportRef.current = viewport
      markDirty(buildSessionDoc(project, doc, viewport))
    },
    [doc, markDirty, project],
  )

  return { saveError, markDirty, onMoveEnd, whenCanvasCommitted }
}
