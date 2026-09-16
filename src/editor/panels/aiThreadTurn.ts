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
import { isCancelledTurnResult } from '../ai/pendingTurns'
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
  const currentGeneration = () => generationRef.current
  return { beginTurn, cancelTurn, currentGeneration }
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
): void {
  useEffect(() => {
    const box = takeTurn(projectId)
    if (!box) return
    setBusy(true)
    let active = true
    let delivered = false
    void box.promise.then((result) => {
      if (!active) {
        returnTurn(projectId, box)
        return
      }
      delivered = true
      applyRef.current(result, box)
    })
    return () => {
      active = false
      if (!delivered) returnTurn(projectId, box)
    }
  }, [projectId, setBusy, applyRef])
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
) {
  const applyClaimRef = useRef<(result: TurnResult, box: TurnBox) => void>(
    () => undefined,
  )
  useEffect(() => {
    applyClaimRef.current = (result, box) => {
      setBusy(false)
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
  usePendingTurnClaim(opts.projectId, applyClaimRef, setBusy)
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
  const turnGen = useTurnGeneration()
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
  useTurnClaimDelivery(opts, heldBox, setBusy, setError)
  const send = async () => {
    const text = draft.trim()
    if (!text || busy || !opts.activeOption || !opts.activeProvider) return
    // 新一轮：世代 +1、重置取消标志（旧轮迟到的 signal 引用不影响本轮）
    const { generation, signal } = turnGen.beginTurn()
    opts.append([{ id: opts.nextId(), kind: 'msg', role: 'user', text }])
    setDraft('')
    setBusy(true)
    setError(null)
    opts.setArmedIdx(null)
    // 校验在循环内进行（issue 41）：未通过的批次回喂错误清单让模型有限次
    // 纠错，最终校验结果（通过/耗尽/纯讨论）随循环产出返回
    const settled = runModelTurn(
      opts.activeProvider,
      opts.activeOption.model,
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
    // 取消盒子的消费者（.then 后）——落定后据此打 canceller 标并判取消
    const boxRef: { current: TurnBox | null } = { current: null }
    const consumed = settled.then((result) => {
      const cancelBox = boxRef.current
      if (cancelBox && isCancelledTurnResult(result)) {
        Object.assign(cancelBox, {
          canceller: () => {
            signal.isCancelled = () => true
          },
        })
      }
      return result
    })
    const box: TurnBox = { promise: consumed }
    boxRef.current = box
    registerTurn(opts.projectId, box)
    const result = await consumed
    // 世代守卫：新一轮或取消之后，本回合结果不再交付本实例（取消回执
    // 已由取消路径上屏，不随迟到结果重复交付）
    if (aliveRef.current && generation === turnGen.currentGeneration()) {
      if (result.entries) opts.append(result.entries)
      else setError(result.error ?? '请求失败')
      setBusy(false)
      // 本实例消费，但提交确认前不撤销登记：落定与卸载同批调度时，
      // 未提交的追加被丢弃，持有机制在 cleanup 把盒子归还待重新认领
      heldBox.hold(box)
    } else if (isCancelledTurnResult(result)) {
      // 取消且本实例不再消费（已卸载/被取代）：注销注册表，避免重开复活
      // 已取消盒子、重复上屏取消回执（PR #187 评审 4024585104）
      unregisterTurn(opts.projectId, box)
    }
    // 已卸载或已被取代（取消/新轮次）：结果不上屏；已卸载时盒子留在
    // 注册表由重挂载/重开同一项目的实例认领（issue #63）
  }
  /** 取消在途回合（issue #154）：协作式——agentLoop 各检查点停止循环；
   * 推进世代使本回合迟到结果不再交付；回执由 appendCancelReceipt 上屏。 */
  const cancel = () => {
    if (!busy) return
    turnGen.cancelTurn()
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
