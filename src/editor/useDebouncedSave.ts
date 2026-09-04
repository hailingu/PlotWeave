/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。
 * 序列化（运行态剥离、ProjectDocument 包装）在 projectStore 保存时
 * 经 src/model/convert.ts 完成，本 hook 只透传会话文档。
 * 保存失败不丢数据：重新置脏并按防抖节律自动重试，错误经 onSaveResult
 * 上浮给调用方做用户可见诊断（磁盘满/只读/保存边界拒收等）。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ProjectContent } from '../model/content'

/** 持久化签名（§9.4）：剥离 React Flow 会话态（selected/dragging/measured/
 * className）后序列化参与置脏判定的字段——与序列化层（convert.ts 只存
 * 语义字段、运行态样式类落盘剥离）同口径。纯选择/拖拽过程帧与纯样式类
 * 注入/剥离（集聚焦 pw-node-dim、fromStoryEdge 派生重建带来的 className
 * 差异）只改这些字段，签名不变即不置脏——update_node_ui 语义：不落盘、
 * 不刷新 updatedAt 改变首页排序。集标题（§3.5 renameEpisode）无独立
 * 脏标记通道，纳入签名随 effect 置脏。 */
function persistSignature(doc: ProjectContent): string {
  const strip = (item: object, keys: string[]) => {
    const rest = { ...item } as Record<string, unknown>
    for (const k of keys) delete rest[k]
    return rest
  }
  return JSON.stringify({
    name: doc.name,
    nodes: doc.nodes.map((n) => strip(n, ['selected', 'dragging', 'measured', 'className'])),
    edges: doc.edges.map((e) => strip(e, ['selected', 'className'])),
    settings: doc.settings,
    episodeTitles: doc.episodeTitles ?? {},
    // 资产索引（§7.3 会话内导入新增条目）纳入签名：漏签即导入不落盘
    assets: doc.assets ?? null,
  })
}

/** 画布变化防抖落盘：doc 任意片段变化后 delayMs 内无新变化才写入；
 * 组件卸载时若仍有脏数据则立即冲刷。onSave 可为异步；同一时刻至多一个
 * 保存在途（在途期间的新编辑合并进后续保存，旧文档不得后完成覆盖新内容），
 * 失败时重新置脏、按防抖节律自动重试并经 onSaveResult 上报（null 表示
 * 本次成功）。返回 markDirty(doc)：供无重渲染的 transient 变更（如视口
 * ref 更新）显式标脏并换入最新文档。 */
export function useDebouncedSave(
  doc: ProjectContent,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  delayMs = 600,
  onSaveResult?: (err: unknown) => void,
): (doc: ProjectContent) => void {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef(doc)
  latestRef.current = doc
  const firstRender = useRef(true)
  const lastSigRef = useRef(persistSignature(doc))
  // 卸载后终止失败重试：后台循环持有旧文档持续落盘，重开同一项目会出现
  // 第二个保存循环，存储恢复后陈旧循环可能覆盖新会话的编辑
  const unmountedRef = useRef(false)
  // 保存串行化：在途保存期间的新编辑合并进后续保存——并发起存时，先发起
  // 的旧文档若后完成（资产复验/文件系统延迟），会原子覆盖新内容且双双报成功
  const inFlightRef = useRef(false)

  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return // 在途：本轮跳过，新脏数据由在途循环接力
    while (dirtyRef.current) {
      dirtyRef.current = false
      inFlightRef.current = true
      try {
        await onSave(latestRef.current)
        onSaveResult?.(null)
      } catch (err) {
        onSaveResult?.(err)
        if (!unmountedRef.current) {
          // 失败不丢数据：重新置脏，按防抖节律自动重试（不紧循环）；
          // 卸载后不排新计时器——后台循环不得覆盖新会话的编辑
          dirtyRef.current = true
          saveTimer.current ??= setTimeout(() => {
            saveTimer.current = null
            void flushSave()
          }, delayMs)
          return
        }
        // 卸载后在途失败：不排重试计时器，但卸载前置脏的最新文档从未交付过
        // onSave（项目级重试只持有本次失败的旧文档）——补交一次，其成败与
        // 重试登记由存储层接管（§3.1 flushPersist 导航契约：离开不丢编辑）
        if (dirtyRef.current) {
          dirtyRef.current = false
          const latest = latestRef.current
          void Promise.resolve()
            .then(() => onSave(latest))
            .then(
              () => onSaveResult?.(null),
              (e: unknown) => onSaveResult?.(e),
            )
        }
        return
      } finally {
        inFlightRef.current = false
      }
      // 卸载后不再发起「新一轮」冲刷，但在途保存完成时仍须把卸载前置脏的
      // 最新文档补存一次（§3.1 flushPersist 导航契约：离开编辑器不丢编辑）
      if (unmountedRef.current && !dirtyRef.current) return
    }
  }, [onSave, onSaveResult, delayMs])

  const markDirty = useCallback(
    (next: ProjectContent) => {
      latestRef.current = next
      dirtyRef.current = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        void flushSave()
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
      void flushSave()
    }, delayMs)
    // 名称/节点/边/设定集/集标题/资产索引触发防抖（视口经 markDirty 或卸载
    // 冲刷兜底）；doc 仅用于计算签名，依赖以签名的组成字段为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.name, doc.nodes, doc.edges, doc.settings, doc.episodeTitles, doc.assets, flushSave, delayMs])

  useEffect(() => {
    // flushSave 依赖变化会重跑本 effect：重置卸载标记，仅真正的卸载终止重试
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      void flushSave()
    }
  }, [flushSave])

  return markDirty
}
