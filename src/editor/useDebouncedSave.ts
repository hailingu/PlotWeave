/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。序列化剥离见 persist.ts。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { Edge } from '@xyflow/react'
import { stripEdge, stripNode } from './persist'
import type { ProjectSettings } from './settings'
import type { CanvasNode } from './nodes/types'

/** 落盘文档：项目名 + 画布 + 设定集 + 集标题。 */
export interface EditorDocument {
  name: string
  nodes: CanvasNode[]
  edges: Edge[]
  settings: ProjectSettings
  episodeTitles: Record<number, string>
}

/** 画布变化防抖落盘：doc 任意片段变化后 delayMs 内无新变化才写入；
 * 组件卸载时若仍有脏数据则立即冲刷。 */
export function useDebouncedSave(
  doc: EditorDocument,
  onSave: (doc: EditorDocument) => void,
  delayMs = 600,
): void {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef(doc)
  latestRef.current = doc
  const firstRender = useRef(true)

  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const cur = latestRef.current
    onSave({
      name: cur.name,
      nodes: cur.nodes.map(stripNode),
      edges: cur.edges.map(stripEdge),
      settings: cur.settings,
      episodeTitles: cur.episodeTitles,
    })
  }, [onSave])

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
    // 与 EditorView 原实现一致：名称/节点/边/设定集触发防抖（集标题经卸载冲刷兜底）
  }, [doc.name, doc.nodes, doc.edges, doc.settings, flushSave, delayMs])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flushSave()
    }
  }, [flushSave])
}
