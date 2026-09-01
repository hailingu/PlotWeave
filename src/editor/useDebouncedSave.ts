/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。
 * 序列化（运行态剥离、ProjectDocument 包装）在 projectStore 保存时
 * 经 src/model/convert.ts 完成，本 hook 只透传会话文档。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ProjectContent } from '../model/content'

/** 持久化签名（§9.4）：剥离 React Flow 会话态（selected/dragging/measured）
 * 后序列化参与置脏判定的字段。纯选择/拖拽过程帧只改这些字段，签名不变
 * 即不置脏——update_node_ui 语义：不落盘、不刷新 updatedAt 改变首页排序。
 * 集标题（§3.5 renameEpisode）无独立脏标记通道，纳入签名随 effect 置脏。 */
function persistSignature(doc: ProjectContent): string {
  const strip = (item: object, keys: string[]) => {
    const rest = { ...item } as Record<string, unknown>
    for (const k of keys) delete rest[k]
    return rest
  }
  return JSON.stringify({
    name: doc.name,
    nodes: doc.nodes.map((n) => strip(n, ['selected', 'dragging', 'measured'])),
    edges: doc.edges.map((e) => strip(e, ['selected'])),
    settings: doc.settings,
    episodeTitles: doc.episodeTitles ?? {},
  })
}

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
  const lastSigRef = useRef(persistSignature(doc))

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
    const sig = persistSignature(doc)
    if (sig === lastSigRef.current) return // 纯会话态变化（选择/拖拽过程帧）：不置脏
    lastSigRef.current = sig
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flushSave()
    }, delayMs)
    // 名称/节点/边/设定集/集标题触发防抖（视口经 markDirty 或卸载冲刷兜底）；
    // doc 仅用于计算签名，依赖以签名的组成字段为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.name, doc.nodes, doc.edges, doc.settings, doc.episodeTitles, flushSave, delayMs])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flushSave()
    }
  }, [flushSave])

  return markDirty
}
