/**
 * 编辑器防抖落盘（持久化路径的调度部分，剥离出来的纯 hook）。
 * 画布变化防抖全量落盘；跳过首次加载，仅在脏状态下卸载冲刷，
 * 避免「只打开不编辑」也盖更新时间戳。
 * 序列化（运行态剥离、ProjectDocument 包装）在 projectStore 保存时
 * 经 src/model/convert.ts 完成，本 hook 只透传会话文档。
 * 保存失败不丢数据：重新置脏并按防抖节律自动重试，错误经 onSaveResult
 * 上浮给调用方做用户可见诊断（磁盘满/只读/保存边界拒收等）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import { graphSignature } from './graphSignature'
import type { SaveStatus } from './saveStatus'
import { registerCanvasFlushGate } from '../canvasSaveRegistry'
import { onRetryPersisted } from '../projectStore/saveChain'
import type { ProjectContent } from '../model/content'
import { assertWebWriteAllowed } from '../webExitFence'

/** 持久化签名（§9.4）：剥离 React Flow 会话态（selected/dragging/measured/
 * className）后序列化参与置脏判定的字段——与序列化层（convert.ts 只存
 * 语义字段、运行态样式类落盘剔离）同口径。纯选择帧与纯样式类
 * 注入/剔离（集聚焦 pw-node-dim、fromStoryEdge 派生重建带来的 className
 * 差异）只改这些字段，签名不变即不置脏——update_node_ui 语义：不落盘、
 * 不刷新 updatedAt 改变首页排序。拖拽过程帧改变 position（持久字段），
 * 签名逐帧变化并由防抖合并到终帧落盘；逐项缓存（issue #272）使每帧
 * 只重新序列化被拖节点。集标题（§3.5 renameEpisode）无独立
 * 脏标记通道，纳入签名随 effect 置脏。画布部分复用 graphSignature：
 * AI 执行卡恢复对账消费同一语义签名。 */
/** 持久字段域（单一契约，issue #155）：签名与置脏监听共用本元组——
 * persistSignature 序列化它，usePersistSignature 的记忆依赖列与它一一对应；
 * 新增持久字段两处同步，杜绝「签名含字段而变更监听遗漏」的漂移。 */
type PersistFields = Pick<
  ProjectContent,
  | 'name'
  | 'nodes'
  | 'edges'
  | 'settings'
  | 'aiRevision'
  | 'episodeTitles'
  | 'assets'
>

function persistFields(doc: PersistFields): readonly unknown[] {
  return [
    doc.name,
    graphSignature(doc.nodes, doc.edges, doc.settings),
    // AI 批次计数是文档内容（§12.2 提交身份）：只增不减，单独变化也必须置脏
    doc.aiRevision ?? 0,
    doc.episodeTitles ?? {},
    // 资产索引（§7.3 会话内导入新增条目）纳入签名：漏签即导入不落盘
    doc.assets ?? null,
  ]
}

function persistSignature(doc: PersistFields): string {
  return JSON.stringify(persistFields(doc))
}

/** 签名按持久字段引用记忆（issue #272）：宿主每渲染重新组装会话文档对象，
 * 但字段本身仅在真实变化时换引用——AI 面板/聚焦等无关重渲染不再重算
 * O(图大小) 的序列化。 */
function usePersistSignature(doc: ProjectContent): string {
  const { name, nodes, edges, settings, aiRevision, episodeTitles, assets } =
    doc
  return useMemo(
    () =>
      persistSignature({
        name,
        nodes,
        edges,
        settings,
        aiRevision,
        episodeTitles,
        assets,
      }),
    [name, nodes, edges, settings, aiRevision, episodeTitles, assets],
  )
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
 * 延迟），会原子覆盖新内容且双双报成功。initialSig 由宿主每渲染算一次
 * 传入（PR #191 评审）：useRef 参数每渲染求值，宿主内重复计算会把
 * O(图大小) 的签名开销按调用点翻倍。 */
function useSaveGateRefs(
  doc: ProjectContent,
  initialSig: string,
  setSaveStatus: (status: SaveStatus) => void,
) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const latestRef = useRef(doc)
  // 状态更新自身会重渲染；只有输入文档真的变化才接管显式 markDirty 的快照。
  // 视口不参与内容置脏签名，但仍参与输入更新识别，保持原透传语义。
  const inputRef = useRef({
    sig: initialSig,
    x: doc.viewport?.x,
    y: doc.viewport?.y,
    zoom: doc.viewport?.zoom,
  })
  if (
    inputRef.current.sig !== initialSig ||
    inputRef.current.x !== doc.viewport?.x ||
    inputRef.current.y !== doc.viewport?.y ||
    inputRef.current.zoom !== doc.viewport?.zoom
  ) {
    latestRef.current = doc
    inputRef.current = {
      sig: initialSig,
      x: doc.viewport?.x,
      y: doc.viewport?.y,
      zoom: doc.viewport?.zoom,
    }
  }
  const firstRender = useRef(true)
  const lastSigRef = useRef(initialSig)
  const unmountedRef = useRef(false)
  const inFlightRef = useRef(false)
  /** 在途保存循环（flushSave 的 run）：退出冲刷闸据此真实等待在途落定，
   * 而非像防抖触发那样静默跳过（issue #119）。 */
  const inFlightPromiseRef = useRef<Promise<void> | null>(null)
  /** 冲刷失败时提交的文档（issue #119，PR #174 评审）：保存链对同一登记
   * 文档重存成功时，据此关联本次失败的重试。 */
  const lastFailedDocRef = useRef<ProjectContent | null>(null)
  /** 编辑序号水位（PR #174 评审）：markDirty 与签名置脏各自递增——失败
   * 时记录当时的序号，重存完成通知仅当序号未前进（无更新编辑）才生效，
   * 使完成只兑现被该次重存覆盖的等待者/脏态。 */
  const editSeqRef = useRef(0)
  const failedEditSeqRef = useRef<number | null>(null)
  /** 已确认落盘的编辑水位（PR #174 评审）：链上重存成功时登记——同水位
   * 的后续冗余重复保存失败不重新置脏/上浮/再排程。 */
  const persistedSeqRef = useRef<number | null>(null)
  // 所有成员均为实例内稳定 ref 或 React setter；状态重渲染不重挂卸载冲刷。
  return useRef({
    setSaveStatus,
    saveTimer,
    dirtyRef,
    latestRef,
    firstRender,
    lastSigRef,
    unmountedRef,
    inFlightRef,
    inFlightPromiseRef,
    lastFailedDocRef,
    editSeqRef,
    failedEditSeqRef,
    persistedSeqRef,
  }).current
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

/** 文档变更置脏（useDebouncedSave 拆分，issue #99）：首渲染跳过；
 * 名称/节点/边/设定集/AI 批次计数/集标题/资产索引触发防抖（视口经
 * markDirty 或卸载冲刷兜底）。effect 依赖持久化签名本身（单一契约，
 * issue #155）：签名包含的每个字段变化都使签名不同、必然进入触发条件，
 * 新增持久字段自动同步；纯会话态变化（选择/拖拽过程帧）签名不变即不
 * 触发。sig 由宿主每渲染算一次传入（PR #191 评审）：本 hook 与 gate
 * refs 的初值共用同一计算，避免 O(图大小) 的签名开销按调用点翻倍。
 * 真实编辑前进编辑序号（PR #174 评审：重存完成通知的生效水位）。 */
function useSignatureSaveWatch(
  gates: ReturnType<typeof useSaveGateRefs>,
  sig: string,
  delayMs: number,
  flushSave: () => Promise<void>,
) {
  const {
    firstRender,
    lastSigRef,
    dirtyRef,
    saveTimer,
    editSeqRef,
    setSaveStatus,
  } = gates
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      lastSigRef.current = sig
      return
    }
    if (sig === lastSigRef.current) return
    lastSigRef.current = sig
    editSeqRef.current++
    dirtyRef.current = true
    setSaveStatus('saving')
    scheduleFlush(saveTimer, delayMs, flushSave)
  }, [
    sig,
    firstRender,
    lastSigRef,
    dirtyRef,
    saveTimer,
    flushSave,
    delayMs,
    editSeqRef,
    setSaveStatus,
  ])
}

/** 卸载冲刷（#699）：生命周期只绑定稳定 refs；回调在 commit 后更新，
 * 父级渲染不会清计时器或冒充卸载，未提交渲染也不能替换卸载动作。 */
function useUnmountFlush(
  unmountedRef: MutableRefObject<boolean>,
  saveTimer: SaveTimerRef,
  onUnmount: () => void,
) {
  const committedOnUnmount = useRef(onUnmount)
  useLayoutEffect(() => {
    committedOnUnmount.current = onUnmount
  }, [onUnmount])
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      committedOnUnmount.current()
    }
  }, [saveTimer, unmountedRef])
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

/** 提交内容是否已被持久化覆盖（PR #174 评审）：链上重存成功登记的水位
 * 与本次提交的水位一致且未卸载——冗余重复保存失败据此静默处理。 */
function isCoveredByPersistedWatermark(
  unmountedRef: { current: boolean },
  persistedSeqRef: { current: number | null },
  submittedSeq: number,
): boolean {
  return (
    !unmountedRef.current &&
    persistedSeqRef.current !== null &&
    submittedSeq === persistedSeqRef.current
  )
}

/** 一次真实保存尝试：按提交编辑水位确认状态，失败沿用原重试/卸载补交契约。 */
async function persistLatest(
  gates: ReturnType<typeof useSaveGateRefs>,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult: ((err: unknown) => void) | undefined,
  delayMs: number,
  flushSave: () => Promise<void>,
): Promise<boolean> {
  const { dirtyRef, inFlightRef, latestRef, editSeqRef, unmountedRef } = gates
  dirtyRef.current = false
  inFlightRef.current = true
  gates.setSaveStatus('saving')
  const submitted = latestRef.current
  const submittedSeq = editSeqRef.current
  try {
    await onSave(submitted)
    gates.setSaveStatus(
      dirtyRef.current || editSeqRef.current !== submittedSeq
        ? 'saving'
        : 'saved',
    )
    onSaveResult?.(null)
    return true
  } catch (error) {
    // 外部重存已确认同一水位时，冗余重写失败不能反向宣称内容未保存。
    if (
      isCoveredByPersistedWatermark(
        unmountedRef,
        gates.persistedSeqRef,
        submittedSeq,
      )
    )
      return false
    gates.setSaveStatus('failed')
    onSaveResult?.(error)
    if (!unmountedRef.current) {
      dirtyRef.current = true
      gates.lastFailedDocRef.current = submitted
      gates.failedEditSeqRef.current = submittedSeq
      gates.saveTimer.current ??= setTimeout(() => {
        gates.saveTimer.current = null
        void flushSave()
      }, delayMs)
    } else {
      deliverLatestAfterUnmount(latestRef, dirtyRef, onSave, onSaveResult)
    }
    return false
  } finally {
    inFlightRef.current = false
  }
}

/** 串行冲刷循环；状态发布不改变保存顺序、退出等待或卸载补交。 */
function useFlushSave(
  gates: ReturnType<typeof useSaveGateRefs>,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult: ((err: unknown) => void) | undefined,
  delayMs: number,
): () => Promise<void> {
  const flushSave = useCallback(async () => {
    if (gates.inFlightRef.current) return
    await startTrackedSaveRun(
      (async () => {
        while (gates.dirtyRef.current) {
          const continueSaving = await persistLatest(
            gates,
            onSave,
            onSaveResult,
            delayMs,
            flushSave,
          )
          if (
            !continueSaving ||
            (gates.unmountedRef.current && !gates.dirtyRef.current)
          )
            return
        }
      })(),
      gates.inFlightPromiseRef,
    )
  }, [gates, onSave, onSaveResult, delayMs])
  return flushSave
}

/** 同一保存 owner 的稳定转发入口：计时器、重试和在途接力在实际交付时
 * 读取最新已 commit 的写通道，回执也交给最新已 commit 的订阅方。
 * layout effect 发布，禁止未提交渲染泄漏；转发不新增 Promise/调度边界。 */
function useCommittedSaveCallbacks(
  onSave: (doc: ProjectContent) => void | Promise<void>,
  onSaveResult: ((err: unknown) => void) | undefined,
) {
  const committed = useRef({ onSave, onSaveResult })
  useLayoutEffect(() => {
    committed.current = { onSave, onSaveResult }
  }, [onSave, onSaveResult])
  const save = useCallback(
    (doc: ProjectContent) => committed.current.onSave(doc),
    [],
  )
  const result = useCallback(
    (error: unknown) => committed.current.onSaveResult?.(error),
    [],
  )
  return { save, result }
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
  const { save, result } = useCommittedSaveCallbacks(onSave, onSaveResult)
  const {
    saveTimer,
    dirtyRef,
    latestRef,
    inFlightRef,
    editSeqRef,
    setSaveStatus,
  } = gates

  const flushSave = useFlushSave(gates, save, result, delayMs)
  const flushForExit = useExitFlushAction(flushSave, gates.inFlightPromiseRef)

  const markDirty = useCallback(
    (next: ProjectContent) => {
      assertWebWriteAllowed()
      latestRef.current = next
      editSeqRef.current++ // 纯视口等 transient 编辑也前进水位（PR #174 评审）
      dirtyRef.current = true
      setSaveStatus('saving')
      scheduleFlush(saveTimer, delayMs, flushSave)
    },
    [
      flushSave,
      delayMs,
      latestRef,
      dirtyRef,
      editSeqRef,
      saveTimer,
      setSaveStatus,
    ],
  )

  /** 卸载冲刷：无在途保存时走常规冲刷；有在途保存时立即补交最新文档——
   * 在途循环的接力要等本次保存落定，设置页往返的重挂载若先发生，重挂载
   * 种子会停留在在途旧文档且新编辑器不再吸收补交内容（issue #118 评审）。
   * 补交前置脏已清，在途保存落定后循环不会再重复交付。 */
  const flushOnUnmount = useCallback(() => {
    if (inFlightRef.current) {
      deliverLatestAfterUnmount(latestRef, dirtyRef, save, result)
      return
    }
    void flushSave()
  }, [dirtyRef, flushSave, inFlightRef, latestRef, save, result])

  return { flushSave, markDirty, flushOnUnmount, flushForExit }
}

/** 画布保存动作与只读状态；动作引用稳定，状态不拥有第二份文档。 */
export interface DebouncedSave {
  readonly markDirty: (doc: ProjectContent) => void
  readonly saveStatus: SaveStatus
}

/** 画布防抖落盘 hook（语义见模块头）：返回置脏回调及真实状态；失败重试、卸载/
 * 退出冲刷与跳过首帧的语义不变，错误经 onSaveResult 上浮。 */
export function useDebouncedSave(
  doc: ProjectContent,
  onSave: (doc: ProjectContent) => void | Promise<void>,
  delayMs = 600,
  onSaveResult?: (err: unknown) => void,
  onRetryPersistedSuccess?: () => void,
): DebouncedSave {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  // 持久化签名每渲染至多计算一次（PR #191 评审）且按字段引用记忆
  // （issue #272）：gate refs 初值与置脏监听共用
  const sig = usePersistSignature(doc)
  const gates = useSaveGateRefs(doc, sig, setSaveStatus)
  const { dirtyRef, inFlightRef } = gates
  const { flushSave, markDirty, flushOnUnmount, flushForExit } = useSaveFlush(
    gates,
    onSave,
    onSaveResult,
    delayMs,
  )

  useSignatureSaveWatch(gates, sig, delayMs, flushSave)
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

  // 链上重存成功清脏（issue #119，PR #174 评审）：闸冲刷失败后保存链会
  // 登记并重存同一文档，成功时登记持久化覆盖水位——同水位的冗余重复保
  // 存失败不再置脏/上浮/排程。无更新编辑（水位未前进）时清脏并对齐完成
  // 语义；B 等更新编辑的等待者只由其真实保存兑现，防抖节律接管其重试。
  // 覆盖登记不依赖瞬态脏标志：排队中的重复保存会把脏标志提前清掉。
  useEffect(
    () =>
      onRetryPersisted((persisted) => {
        if (
          gates.lastFailedDocRef.current !== persisted ||
          gates.failedEditSeqRef.current === null
        )
          return
        const seq = gates.failedEditSeqRef.current
        gates.persistedSeqRef.current = seq
        if (gates.editSeqRef.current === seq) {
          gates.lastFailedDocRef.current = null
          gates.failedEditSeqRef.current = null
          dirtyRef.current = false
          setSaveStatus('saved')
          onRetryPersistedSuccess?.()
        }
      }),
    [
      dirtyRef,
      gates.lastFailedDocRef,
      gates.failedEditSeqRef,
      gates.editSeqRef,
      gates.persistedSeqRef,
      onRetryPersistedSuccess,
    ],
  )

  // 新签名的 effect 尚未运行时，也不能在本次渲染沿用旧的 saved 状态。
  return {
    markDirty,
    saveStatus: sig === gates.lastSigRef.current ? saveStatus : 'saving',
  }
}
