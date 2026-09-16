/**
 * ✦AI 会话回合域（issue #99 自 AiThread.tsx 按域拆出）：在途回合的
 * 登记/认领/持有（issue #63 跨卸载交付）、单轮发送与认领条目重定映射。
 * 盒子语义见 ../ai/pendingTurns；纯函数在 aiThreadModel.ts。
 */
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  toInboundCommands,
  type AiCommand,
  type BatchValidation,
} from '../ai/commands'
import {
  registerTurn,
  returnTurn,
  takeTurn,
  unregisterTurn,
  type TurnBox,
  type TurnResult,
} from '../ai/pendingTurns'
import { type AppSettings, type ChatModelOption } from '../../settings/types'
import { buildMessages, readToolOf, runModelTurn } from './aiThreadModel'
import { TurnCancelledError } from '../ai/agentLoop'
import { type ThreadEntry } from '../ai/session'

/** 回合世代守卫与取消信号（issue #154）：send 时 beginTurn 推进世代、
 * 重置信号；cancelTurn 置位并推进世代。回合 settle 时只有 generation 与
 * 发起时一致（无更新的轮次）才交付上屏——新一轮或取消之后的迟到结果
 * 都被丢弃，不覆盖新轮次、不误形成预览，也不重复上屏取消回执。 */
function useTurnGeneration() {
  const generationRef = useRef(0)
  const flagRef = useRef({ cancelled: false })
  const beginTurn = () => {
    const generation = ++generationRef.current
    const flag = { cancelled: false }
    flagRef.current = flag
    // signal 为可变方法：认领方的 canceller 据此停止旧轮（PR #187 评审）
    const signal: { isCancelled: () => boolean } = {
      isCancelled: () => flag.cancelled,
    }
    return { generation, signal }
  }
  const cancelTurn = () => {
    generationRef.current += 1
    flagRef.current.cancelled = true
  }
  /** 当前世代是否已被取消（本回合 signal 置位）——含 reject 形状（在途
   * 请求先 reject 时结果为错误而非取消，仍视为已取消，PR #187 评审）。 */
  const isCurrentTurnCancelled = () => flagRef.current.cancelled
  const currentGeneration = () => generationRef.current
  return { beginTurn, cancelTurn, isCurrentTurnCancelled, currentGeneration }
}

/** 回合生命周期（issue #154，useAiTurn 拆分降行数）：发起时 begin 建 signal
 * 并登记盒子；settle 按世代守卫交付或注销（取消时避免重开复活）；cancel
 * 置位本世代 signal 并推进世代（发起方 settle 据此注销，claim 方据此不恢复 busy）。 */
function useTurnLifecycle(projectId: string) {
  const { beginTurn, cancelTurn, isCurrentTurnCancelled, currentGeneration } =
    useTurnGeneration()
  const boxRef = useRef<TurnBox | null>(null)
  const begin = () => beginTurn()
  const register = (box: TurnBox) => {
    boxRef.current = box
    registerTurn(projectId, box)
  }
  /** settle 守卫：本实例仍拥有当前世代才交付；否则已取消则注销盒子。 */
  const settle = (
    generation: number,
    alive: boolean,
    consume: () => void,
    hold: (box: TurnBox) => void,
  ) => {
    const box = boxRef.current
    if (alive && generation === currentGeneration()) {
      consume()
      if (box) hold(box)
    } else if (isCurrentTurnCancelled() && box) {
      unregisterTurn(projectId, box)
    }
  }
  return { begin, register, settle, cancel: cancelTurn }
}

/** 运行一轮模型回合并登记盒子（useAiTurn 拆分降行数）：runModelTurn 跑
 * agentLoop（带 signal），结果收敛为 TurnResult；盒子从创建起即带
 * canceller（置位 signal）——认领方据此可停止旧轮（PR #187 评审 4025795506）。 */
function runTurn(
  opts: UseAiTurnOpts,
  text: string,
  knowsCanvas: boolean,
  signal: { isCancelled: () => boolean },
  register: (box: TurnBox) => void,
): Promise<TurnResult> {
  const settled = runModelTurn(
    opts.activeProvider!,
    opts.activeOption!.model,
    buildMessages(opts.thread, text, knowsCanvas, opts.canvasDigest),
    readToolOf(
      opts.canvasDigest,
      opts.onReadNode,
      opts.onReadSettings,
      opts.onReadDocument,
    ),
    { commands: opts.onValidateCommands, prose: opts.onValidateAi },
    opts.nextId,
    signal,
  ).then(
    (entries): TurnResult => ({ entries, error: null }),
    (err): TurnResult =>
      err instanceof TurnCancelledError
        ? { entries: [{ id: 0, kind: 'note', text: '已取消' }], error: null }
        : { entries: null, error: String(err) },
  )
  const box: TurnBox = {
    promise: settled,
    canceller: () => {
      signal.isCancelled = () => true
    },
  }
  register(box)
  return settled
}

/** 认领条目的重定映射：id 经当前实例重定基（旧计数器已随卸载作废，
 * 沿用会与恢复条目撞 key）；待执行卡按当前画布重校验——迟到批次带回的
 * 校验结果基于已卸载实例的旧闭包，不得作为执行预览（issue #63 评审）。 */
function claimedEntries(
  entries: ThreadEntry[],
  nextId: () => number,
  validateCommands:
    ((commands: AiCommand[]) => BatchValidation | null) | undefined,
): ThreadEntry[] {
  return entries.map((entry) => {
    const claimed = { ...entry, id: nextId() }
    if (entry.card?.status !== 'pending') return claimed
    return {
      ...claimed,
      card: revalidatePendingCard(entry.card, validateCommands),
    }
  })
}

/** 回合盒子的提交确认持有（issue #63 评审）：结果交付 setState 后先持有
 * 盒子；对应更新提交（同批的持久化 effect 已先行入队落盘）后，后置
 * effect 才撤销登记。落定与卸载同批调度时，未提交的追加会被卸载丢弃，
 * cleanup 把未确认的盒子归还注册表，重挂载重新认领——回复不因竞态
 * 丢失；已提交则盒子已释放，不产生重复认领。 */
function useHeldTurnBox(projectId: string) {
  const heldRef = useRef<TurnBox | null>(null)
  useEffect(() => {
    const held = heldRef.current
    if (!held) return
    heldRef.current = null
    unregisterTurn(projectId, held)
  })
  useEffect(
    () => () => {
      const held = heldRef.current
      if (held) returnTurn(projectId, held)
    },
    [projectId],
  )
  const hold = (box: TurnBox) => {
    heldRef.current = box
  }
  return { hold }
}

/** 在途回合认领域（issue #63）：挂载即独占认领本项目的在途回合——
 * 等待中恢复忙碌态，落定经 applyRef 交付（含盒子，交付后由持有机制
 * 确认提交再释放）；等待中或已交付未提交时卸载，盒子归还注册表。
 * StrictMode 双挂载下首个 effect 的 cleanup 先归还、第二个 effect
 * 再取回，认领不丢失。 */
function usePendingTurnClaim(
  projectId: string,
  applyRef: { readonly current: (result: TurnResult, box: TurnBox) => void },
  setBusy: Dispatch<SetStateAction<boolean>>,
  claimBoxRef: { current: TurnBox | null },
): void {
  useEffect(() => {
    const box = takeTurn(projectId)
    if (!box) return
    setBusy(true)
    claimBoxRef.current = box
    let active = true
    let delivered = false
    void box.promise.then((result) => {
      if (!active) {
        returnTurn(projectId, box)
        return
      }
      delivered = true
      // claimBoxRef 由 applyRef 统一清理（取消时 cancel 已置 null）
      applyRef.current(result, box)
    })
    return () => {
      active = false
      if (!delivered) returnTurn(projectId, box)
    }
  }, [projectId, setBusy, applyRef, claimBoxRef])
}

/** useAiTurn 的选项契约（AiThread 容器透传）。 */
export interface UseAiTurnOpts {
  readonly projectId: string
  readonly activeOption: ChatModelOption | null
  readonly activeProvider: AppSettings['providers'][number] | null
  readonly thread: ThreadEntry[]
  readonly append: (entries: ThreadEntry[]) => void
  readonly nextId: () => number
  readonly setArmedIdx: (idx: number | null) => void
  readonly canvasDigest?: string
  readonly onValidateAi?: (text: string) => BatchValidation | null
  readonly onValidateCommands?: (
    commands: AiCommand[],
  ) => BatchValidation | null
  readonly onReadNode?: (nodeId: string) => string | null
  readonly onReadSettings?: () => string
  readonly onReadDocument?: (documentId: string) => string | null
}

/** 认领落定结果的交付（useAiTurn 拆分，issue #99）：条目映射见
 * claimedEntries；盒子交持有机制确认提交后释放（useHeldTurnBox）。 */
function useTurnClaimDelivery(
  opts: UseAiTurnOpts,
  heldBox: ReturnType<typeof useHeldTurnBox>,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
  claimBoxRef: { current: TurnBox | null },
) {
  const applyClaimRef = useRef<(result: TurnResult, box: TurnBox) => void>(
    () => undefined,
  )
  useEffect(() => {
    applyClaimRef.current = (result, box) => {
      setBusy(false)
      // 取消守卫：claim 期间被取消的盒子不交付（PR #187 评审 4025795506）。
      // cancel 把 claimBoxRef 置 null 并置位 signal，迟到结果不得上屏。
      const wasCancelled = claimBoxRef.current === null
      claimBoxRef.current = null
      if (wasCancelled) return
      if (result.entries) {
        opts.append(
          claimedEntries(result.entries, opts.nextId, opts.onValidateCommands),
        )
      } else {
        setError(result.error ?? '请求失败')
      }
      heldBox.hold(box)
    }
  })
  usePendingTurnClaim(opts.projectId, applyClaimRef, setBusy, claimBoxRef)
  return applyClaimRef
}

/** 单轮发送域（逻辑 hook，issue #39 拆分）：输入草稿、画布感知开关与
 * send 动作（用户条目入列 → Agent 循环 → 助手条目/回执入列）。
 * 在途回合按项目登记（issue #63）：卸载期间落定的结果由重挂载/重开
 * 同一项目的实例认领（见 pendingTurns 与 usePendingTurnClaim）。 */
export function useAiTurn(opts: UseAiTurnOpts) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knowsCanvas, setKnowsCanvas] = useState(true)
  const turn = useTurnLifecycle(opts.projectId)
  /** 发起实例是否仍挂载：卸载后不得撤销登记（盒子留给认领方）或上屏。
   * StrictMode 双挂载会先跑一次 cleanup，effect 体内须重置回 true。 */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const heldBox = useHeldTurnBox(opts.projectId)
  /** 认领盒子的 canceller（issue #154）：claim 存入、cancel 调用以停止旧轮。 */
  const claimBoxRef = useRef<TurnBox | null>(null)
  useTurnClaimDelivery(opts, heldBox, setBusy, setError, claimBoxRef)
  const send = async () => {
    const text = draft.trim()
    if (!text || busy || !opts.activeOption || !opts.activeProvider) return
    // 新一轮：世代 +1、重置取消标志（旧轮迟到的 signal 引用不影响本轮）
    const { generation, signal } = turn.begin()
    opts.append([{ id: opts.nextId(), kind: 'msg', role: 'user', text }])
    setDraft('')
    setBusy(true)
    setError(null)
    opts.setArmedIdx(null)
    // 校验在循环内进行（issue 41）：批次回喂纠错，最终校验随循环产出
    const result = await runTurn(opts, text, knowsCanvas, signal, turn.register)
    // 世代守卫：新一轮或取消之后，本回合结果不再交付本实例（取消回执
    // 已由取消路径上屏，不随迟到结果重复交付）
    turn.settle(
      generation,
      aliveRef.current,
      () => {
        if (result.entries) opts.append(result.entries)
        else setError(result.error ?? '请求失败')
        setBusy(false)
      },
      heldBox.hold,
    )
    // 已卸载或已被取代（取消/新轮次）：结果不上屏；已取消盒子已注销，
    // 普通（未取消）在途回合的盒子由认领路径转移（issue #63）
  }
  /** 取消在途回合（issue #154）：协作式——agentLoop 各检查点停止循环；
   * 推进世代使本回合迟到结果不再交付；回执由 appendCancelReceipt 上屏。 */
  const cancel = () => {
    if (!busy) return
    turn.cancel()
    // 认领的回合：置位 signal 停止旧轮，并清 claimBoxRef 使守卫跳过交付
    const claimed = claimBoxRef.current
    if (claimed) {
      claimBoxRef.current = null
      claimed.canceller?.()
    }
    setBusy(false)
  }
  /** 取消回执上屏（issue #154）：随会话持久化的「已取消」note；供 AiThread
   * 在 cancel 后调用。 */
  const appendCancelReceipt = () =>
    opts.append([{ id: opts.nextId(), kind: 'note', text: '已取消' }])
  /** 清除上屏的请求错误（issue #89 评审）：新会话不得继承上一会话的
   * 失败诊断——错误仅由下次 send 开头清除会让空会话带着旧横幅。 */
  const clearError = () => setError(null)
  return {
    draft,
    setDraft,
    busy,
    error,
    clearError,
    knowsCanvas,
    setKnowsCanvas,
    send,
    cancel,
    appendCancelReceipt,
  }
}

/** 恢复/认领的待执行卡按当前画布重校验（§12.2 历史展示同口径）：落盘或
 * 迟到批次带回的校验结果可能基于离开前的旧画布（认领回合约住的是已
 * 卸载实例的校验闭包），预览与可执行状态必须反映当前内容；拒绝卡缺少
 * 完整原始批次，不重判为合法整批。 */
export function revalidatePendingCard(
  card: NonNullable<ThreadEntry['card']>,
  validateCommands:
    ((commands: AiCommand[]) => BatchValidation | null) | undefined,
): NonNullable<ThreadEntry['card']> {
  if (!validateCommands || !card.v.ok) return card
  const validation = validateCommands(toInboundCommands(card.v.commands))
  return validation ? { ...card, v: validation } : card
}
