/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。
 * 序列化（运行态剥离、ProjectDocument 包装）在 projectStore 保存时
 * 经 src/model/convert.ts 完成，本 hook 只透传会话文档。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ProjectContent } from '../model/content'

/** 画布变化防抖落盘：doc 任意片段变化后 delayMs 内无新变化才写入；
 * 组件卸载时若仍有脏数据则立即冲刷。返回 markDirty(doc)：供无重渲染的
 * transient 变更（如视口 ref 更新）显式标脏并换入最新文档。 */
export function useDebouncedSave(
  doc: ProjectContent,
  onSave: (doc: ProjectContent) => void,
  delayMs = 600,
): (doc: ProjectContent) => void {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef(doc)
  latestRef.current = doc
  const firstRender = useRef(true)

  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    onSave(latestRef.current)
  }, [onSave])

  const markDirty = useCallback(
    (next: ProjectContent) => {
      latestRef.current = next
      dirtyRef.current = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        flushSave()
      }, delayMs)
    },
    [flushSave, delayMs],
  )

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushSave()
    }, delayMs)
    // 名称/节点/边/设定集触发防抖（集标题、视口经 markDirty 或卸载冲刷兜底）
  }, [doc.name, doc.nodes, doc.edges, doc.settings, flushSave, delayMs])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flushSave()
    }
  }, [flushSave])

  return markDirty
}
