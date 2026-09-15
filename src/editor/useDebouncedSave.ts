/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。
 * 序列化（运行态剥离、ProjectDocument 包装）在 projectStore 保存时
 * 经 src/model/convert.ts 完成，本 hook 只透传会话文档。
 * 保存失败不丢数据：重新置脏并按防抖节律自动重试，错误经 onSaveResult
 * 上浮给调用方做用户可见诊断（磁盘满/只读/保存边界拒收等）。
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { graphSignature } from './graphSignature'
import { registerCanvasFlushGate } from '../canvasSaveRegistry'
import type { ProjectContent } from '../model/content'

/** 持久化签名（§9.4）：剥离 React Flow 会话态（selected/dragging/measured/
 * className）后序列化参与置脏判定的字段——与序列化层（convert.ts 只存
 * 语义字段、运行态样式类落盘剥离）同口径。纯选择/拖拽过程帧与纯样式类
 * 注入/剥离（集聚焦 pw-node-dim、fromStoryEdge 派生重建带来的 className
 * 差异）只改这些字段，签名不变即不置脏——update_node_ui 语义：不落盘、
 * 不刷新 updatedAt 改变首页排序。集标题（§3.5 renameEpisode）无独立
 * 脏标记通道，纳入签名随 effect 置脏。画布部分复用 graphSignature：
 * AI 执行卡恢复对账消费同一语义签名。 */
function persistSignature(doc: ProjectContent): string {
  return JSON.stringify({
    name: doc.name,
    graph: graphSignature(doc.nodes, doc.edges, doc.settings),
    // AI 批次计数是文档内容（§12.2 提交身份）：只增不减，单独变化也必须置脏
    aiRevision: doc.aiRevision ?? 0,
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
type SaveTimerRef = MutableRefObject<ReturnType<typeof setTimeout> | null>

/** 保存闸 refs（useDebouncedSave 拆分，issue #99）。卸载后终止失败重试：
 * 后台循环持有旧文档持续落盘，重开同一项目会出现第二个保存循环，存储恢
 * 复后陈旧循环可能覆盖新会话的编辑。保存串行化：在途保存期间的新编辑合
 * 并进后续保存——并发发起时，先发起的旧文档若后完成（资产复验/文件系统
 * 延迟），会原子覆盖新内容且双双报成功。 */
function useSaveGateRefs(doc: ProjectContent) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef(doc)
  latestRef.current = doc
  const firstRender = useRef(true)
  const lastSigRef = useRef(persistSignature(doc))
  const unmountedRef = useRef(false)
  const inFlightRef = useRef(false)
  /** 在途保存循环（flushSave 的 run）：退出冲刷闸据此真实等待在途落定，
   * 而非像防抖触发那样静默跳过（issue #119）。 */
  const inFlightPromiseRef = useRef<Promise<void> | null>(null)
  return {
    saveTimer,
    dirtyRef,
    latestRef,
    firstRender,
    lastSigRef,
    unmountedRef,
    inFlightRef,
    inFlightPromiseRef,
  }
}

/** 按防抖节律排下一次冲刷（useDebouncedSave 拆分）：先清旧计时器。 */
function scheduleFlush(
  saveTimer: SaveTimerRef,
  delayMs: number,
  flushSave: () => Promise<void>,
): void {
  if (saveTimer.current) clearTimeout(saveTimer.current)
  saveTimer.current = setTimeout(() => {
    saveTimer.current = null
    void flushSave()
  }, delayMs)
}

/** 卸载后在途失败的补交（useDebouncedSave 拆分）：不排重试计时器，但卸
 * 载前置脏的最新文档从未交付过 onSave（项目级重试只持有本次失败的旧文
 * 档）——补交一次，其成败与重试登记由存储层接管（§3.1 flushPersist 导航
 * 契约：离开不丢编辑）。 */
function deliverLatestAfterUnmount(
  latestRef: MutableRefObject<ProjectContent>,
  dirtyRef: MutableRefObject<boolean>,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult?: (err: unknown) => void,
): void {
  if (!dirtyRef.current) return
  dirtyRef.current = false
  const latest = latestRef.current
  void Promise.resolve()
    .then(() => onSave(latest))
    .then(
      () => onSaveResult?.(null),
      (e: unknown) => onSaveResult?.(e),
    )
}

/** 文档签名比对（useDebouncedSave 拆分）：纯会话态变化（选择/拖拽过程
 * 帧）不置脏；签名命中即更新基线。 */
function signatureChanged(
  doc: ProjectContent,
  lastSigRef: MutableRefObject<string>,
): boolean {
  const sig = persistSignature(doc)
  if (sig === lastSigRef.current) return false
  lastSigRef.current = sig
  return true
}

/** 文档变更置脏（useDebouncedSave 拆分，issue #99）：首渲染跳过；
 * 名称/节点/边/设定集/集标题/资产索引触发防抖（视口经 markDirty 或卸载
 * 冲刷兜底）；doc 仅用于计算签名，依赖以签名的组成字段为准。 */
function useSignatureSaveWatch(
  doc: ProjectContent,
  firstRender: MutableRefObject<boolean>,
  lastSigRef: MutableRefObject<string>,
  dirtyRef: MutableRefObject<boolean>,
  saveTimer: SaveTimerRef,
  delayMs: number,
  flushSave: () => Promise<void>,
) {
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!signatureChanged(doc, lastSigRef)) return
    dirtyRef.current = true
    scheduleFlush(saveTimer, delayMs, flushSave)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    doc.name,
    doc.nodes,
    doc.edges,
    doc.settings,
    doc.episodeTitles,
    doc.assets,
    firstRender,
    lastSigRef,
    dirtyRef,
    saveTimer,
    flushSave,
    delayMs,
  ])
}

/** 卸载冲刷（useDebouncedSave 拆分）：effect 依赖变化会重跑本 effect——
 * 重置卸载标记，仅真正的卸载触发 onUnmount 冲刷。 */
function useUnmountFlush(
  unmountedRef: MutableRefObject<boolean>,
  saveTimer: SaveTimerRef,
  onUnmount: () => void,
) {
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      onUnmount()
    }
  }, [onUnmount, saveTimer, unmountedRef])
}

/** 启动保存循环并登记/解除在途 Promise（useSaveFlush 拆出，PR #174 评审：
 * 宿主钩子守 80 行上限）。循环体同步执行到首个 await——inFlightRef 置位
 * 仍发生在 flushSave 入口检查之后的同一同步段，并发触发照旧被挡回。 */
function startTrackedSaveRun(
  run: Promise<void>,
  inFlightPromiseRef: MutableRefObject<Promise<void> | null>,
): Promise<void> {
  inFlightPromiseRef.current = run
  const settle = () => {
    if (inFlightPromiseRef.current === run) inFlightPromiseRef.current = null
  }
  void run.then(settle, settle)
  return run
}

/** 退出冲刷闸的冲刷动作（issue #119，useSaveFlush 拆出以守 80 行上限）：
 * 先等在途保存循环真实落定（其间接力保存含在途期间的新编辑），再补一轮
 * 立即冲刷。失败保留脏态（hasPending 仍真）交防抖节律重试，不在闸内紧
 * 循环。 */
function useExitFlushAction(
  flushSave: () => Promise<void>,
  inFlightPromiseRef: MutableRefObject<Promise<void> | null>,
): () => Promise<void> {
  return useCallback(async () => {
    while (inFlightPromiseRef.current !== null) {
      await inFlightPromiseRef.current.catch(() => undefined)
    }
    await flushSave()
  }, [flushSave, inFlightPromiseRef])
}

/** 防抖冲刷动作（useSaveFlush 拆出，PR #174 评审：在途登记与退出闸加入
 * 后宿主钩子超 80 行上限，与 issue #99/#118 同款拆分）。循环体同步执行到
 * 首个 await——inFlightRef 置位发生在入口检查之后的同一同步段，并发触发
 * 照旧被挡回；失败按未卸载/已卸载分流（重试节律 / 卸载补交）。 */
function useFlushSave(
  gates: ReturnType<typeof useSaveGateRefs>,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult: ((err: unknown) => void) | undefined,
  delayMs: number,
): () => Promise<void> {
  const { saveTimer, dirtyRef, latestRef, unmountedRef, inFlightRef } = gates
  const flushSave = useCallback(async () => {
    if (inFlightRef.current) return // 在途：本轮跳过，新脏数据由在途循环接力
    await startTrackedSaveRun(
      (async () => {
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
            deliverLatestAfterUnmount(latestRef, dirtyRef, onSave, onSaveResult)
            return
          } finally {
            inFlightRef.current = false
          }
          // 卸载后不再发起「新一轮」冲刷，但在途保存完成时仍须把卸载前置脏
          // 的最新文档补存一次（§3.1 flushPersist 导航契约：离开编辑器不丢
          // 编辑）
          if (unmountedRef.current && !dirtyRef.current) return
        }
      })(),
      gates.inFlightPromiseRef,
    )
  }, [
    onSave,
    onSaveResult,
    delayMs,
    latestRef,
    dirtyRef,
    saveTimer,
    unmountedRef,
    inFlightRef,
    gates.inFlightPromiseRef,
  ])
  return flushSave
}

/** 冲刷与标脏动作（useDebouncedSave 拆分，issue #118 评审：主 hook 守
 * 80 行上限）：消费保存闸 refs 组装三条动作通道。闸 ref 实例内恒稳定，
 * 列入依赖以满足 exhaustive-deps（issue #99 拆分）。 */
function useSaveFlush(
  gates: ReturnType<typeof useSaveGateRefs>,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult: ((err: unknown) => void) | undefined,
  delayMs: number,
) {
  const { saveTimer, dirtyRef, latestRef, inFlightRef } = gates

  const flushSave = useFlushSave(gates, onSave, onSaveResult, delayMs)
  const flushForExit = useExitFlushAction(flushSave, gates.inFlightPromiseRef)

  const markDirty = useCallback(
    (next: ProjectContent) => {
      latestRef.current = next
      dirtyRef.current = true
      scheduleFlush(saveTimer, delayMs, flushSave)
    },
    [flushSave, delayMs, latestRef, dirtyRef, saveTimer],
  )

  /** 卸载冲刷：无在途保存时走常规冲刷；有在途保存时立即补交最新文档——
   * 在途循环的接力要等本次保存落定，设置页往返的重挂载若先发生，重挂载
   * 种子会停留在在途旧文档且新编辑器不再吸收补交内容（issue #118 评审）。
   * 补交前置脏已清，在途保存落定后循环不会再重复交付。 */
  const flushOnUnmount = useCallback(() => {
    if (inFlightRef.current) {
      deliverLatestAfterUnmount(latestRef, dirtyRef, onSave, onSaveResult)
      return
    }
    void flushSave()
  }, [dirtyRef, flushSave, inFlightRef, latestRef, onSave, onSaveResult])

  return { flushSave, markDirty, flushOnUnmount, flushForExit }
}

export function useDebouncedSave(
  doc: ProjectContent,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  delayMs = 600,
  onSaveResult?: (err: unknown) => void,
): (doc: ProjectContent) => void {
  const gates = useSaveGateRefs(doc)
  const { dirtyRef, inFlightRef } = gates
  const { flushSave, markDirty, flushOnUnmount, flushForExit } = useSaveFlush(
    gates,
    onSave,
    onSaveResult,
    delayMs,
  )

  useSignatureSaveWatch(
    doc,
    gates.firstRender,
    gates.lastSigRef,
    gates.dirtyRef,
    gates.saveTimer,
    delayMs,
    flushSave,
  )
  useUnmountFlush(gates.unmountedRef, gates.saveTimer, flushOnUnmount)

  // 退出冲刷闸（issue #119）：防抖脏文档是组件内 refs，App 级退出屏障
  // （useExitFlush）经 canvasSaveRegistry 感知并立即冲刷；卸载注销。
  // 有脏或在途即视为待保存——防抖计时未到不代表可放行退出。
  useEffect(() => {
    registerCanvasFlushGate({
      hasPending: () => dirtyRef.current || inFlightRef.current,
      flush: flushForExit,
    })
    return () => registerCanvasFlushGate(null)
  }, [dirtyRef, inFlightRef, flushForExit])

  return markDirty
}
