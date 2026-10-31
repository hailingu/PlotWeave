import { useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { isSwiftHost } from '../../platform/hostEnvironment'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from '../../platform/nativeShell'
import type { ThreadEntry } from '../../ai/session'
import type { ChatModelOption } from '../../settings/types'
import type { AiTurnFeedback } from '../panels/aiTurnStatus'
import { requiresBatchConfirmation } from '../ai/commands'

/** Production AI controller inputs; credentials are deliberately absent from this bridge shape. */
export interface NativeAiOptions {
  projectId: string
  models: {
    options: ChatModelOption[]
    activeKey: string | null
    keyOkByProvider: Record<string, boolean>
    ready: boolean
    setModelKey: (value: string | null) => void
  }
  messages: {
    thread: ThreadEntry[]
    armedIdx: number | null
    setArmedIdx: (value: number | null) => void
    executeCard: (index: number) => void
    markDismissed: (index: number) => void
    resetSession: () => void
  }
  turn: {
    busy: boolean
    feedback: AiTurnFeedback | null
    error: string | null
    knowsCanvas: boolean
    setKnowsCanvas: (value: boolean) => void
    send: (text?: string) => Promise<void>
    cancel: () => void
    appendCancelReceipt: () => void
    clearError: () => void
  }
  saveError: string | null
}

/** Current owner and immediate send reservation close React's render interval for duplicate submissions. */
interface NativeAiOwner {
  current: NativeAiOptions
  active: boolean
  sendToken: number
  sending: number | null
}

/** Resolve a still-pending card before interpreting any native preview action. */
function pendingCard(options: NativeAiOptions, args: Record<string, unknown>) {
  const index = options.messages.thread.findIndex(
    (entry) => entry.id === args.entryId,
  )
  const card = options.messages.thread[index]?.card
  if (card?.status !== 'pending' || card.historical || options.turn.busy)
    throw new Error('这条改动已失效或正在执行。')
  return { index, card }
}

/** Native preview actions resolve live stable entry IDs and enforce the same deletion confirmation. */
function cardAction(
  options: NativeAiOptions,
  command: string,
  args: Record<string, unknown>,
): void {
  const { index, card } = pendingCard(options, args)
  if (command === 'ai.arm') {
    options.messages.setArmedIdx(
      options.messages.armedIdx === index ? null : index,
    )
    return
  }
  if (command === 'ai.dismiss') {
    options.messages.markDismissed(index)
    return
  }
  if (!card.v.ok) throw new Error('这批改动未通过验证。')
  if (requiresBatchConfirmation(card.v) && options.messages.armedIdx !== index)
    throw new Error('请先确认包含删除或分集冲突的改动。')
  options.messages.executeCard(index)
}

/** Every command captures one active, committed options snapshot for the matching project. */
function activeOptions(
  owner: NativeAiOwner,
  args: Record<string, unknown>,
): NativeAiOptions {
  const options = owner.current
  if (!owner.active || args.projectId !== options.projectId)
    throw new Error('AI 命令所属项目已关闭。')
  return options
}

/** Only an available configured model can become the session's current selection. */
function selectModel(
  options: NativeAiOptions,
  args: Record<string, unknown>,
): void {
  if (
    typeof args.model !== 'string' ||
    !options.models.options.some(
      (item) =>
        item.key === args.model &&
        options.models.keyOkByProvider[item.providerId],
    )
  )
    throw new Error('模型不可用或尚未配置 key。')
  options.models.setModelKey(args.model)
}

/** Context changes retain the native boolean contract and the existing AI turn owner. */
function setContext(
  options: NativeAiOptions,
  args: Record<string, unknown>,
): void {
  if (typeof args.enabled !== 'boolean') throw new Error('画布上下文开关无效。')
  options.turn.setKnowsCanvas(args.enabled)
}

/** Reserve synchronously; only this send's completion may release its reservation. */
async function sendMessage(
  owner: NativeAiOwner,
  options: NativeAiOptions,
  args: Record<string, unknown>,
): Promise<void> {
  if (
    typeof args.text !== 'string' ||
    !args.text.trim() ||
    !options.models.ready ||
    options.turn.busy ||
    owner.sending !== null
  )
    throw new Error('暂时无法发送，请检查模型设置或等待当前回合。')
  const token = ++owner.sendToken
  owner.sending = token
  try {
    await options.turn.send(args.text)
  } finally {
    if (owner.sending === token) owner.sending = null
  }
}

/** Cancellation remains reachable during the render interval before busy is projected. */
function cancelTurn(owner: NativeAiOwner, options: NativeAiOptions): void {
  if (options.turn.busy || owner.sending !== null) {
    options.turn.cancel()
    options.turn.appendCancelReceipt()
    owner.sending = null
  }
}

/** Clearing requires explicit confirmation and cannot overtake an active send. */
function clearSession(
  owner: NativeAiOwner,
  options: NativeAiOptions,
  args: Record<string, unknown>,
): void {
  if (args.confirmed !== true || options.turn.busy || owner.sending !== null)
    throw new Error('清空会话需要确认，并须等待当前回合结束。')
  options.turn.clearError()
  options.messages.resetSession()
}

/** Commands use existing AI lifecycle/persistence rather than constructing a second thread or graph writer. */
async function run(
  owner: NativeAiOwner,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  const options = activeOptions(owner, args)
  if (command === 'ai.selectModel') return selectModel(options, args)
  if (command === 'ai.context') return setContext(options, args)
  if (command === 'ai.send') return sendMessage(owner, options, args)
  if (command === 'ai.cancel') return cancelTurn(owner, options)
  if (command === 'ai.clear') return clearSession(owner, options, args)
  if (
    command === 'ai.arm' ||
    command === 'ai.execute' ||
    command === 'ai.dismiss'
  )
    return cardAction(options, command, args)
  throw new Error('未知的 AI 命令。')
}

/** Publishes credential-free session snapshots for the native AI panel and registers its action owner. */
export function useNativeAiShell(options: NativeAiOptions): void {
  const owner = useRef<NativeAiOwner>({
    current: options,
    active: false,
    sendToken: 0,
    sending: null,
  })
  useLayoutEffect(() => {
    owner.current.current = options
  }, [options])
  useEffect(() => {
    if (!isSwiftHost()) return
    const active = owner.current
    active.active = true
    const off = registerNativeIntentHandler('ai', (command, args) => {
      let result: Promise<void> | undefined
      flushSync(() => {
        result = run(active, command, args)
      })
      return result
    })
    return () => {
      active.active = false
      off()
    }
  }, [])
  const encoded = isSwiftHost()
    ? JSON.stringify({
        projectId: options.projectId,
        ready: options.models.ready,
        model: options.models.activeKey,
        models: options.models.options.map((item) => ({
          value: item.key,
          label: `${item.providerLabel} · ${item.model}`,
          available: options.models.keyOkByProvider[item.providerId] === true,
        })),
        busy: options.turn.busy,
        feedback: options.turn.feedback,
        error: options.turn.error,
        saveError: options.saveError,
        knowsCanvas: options.turn.knowsCanvas,
        thread: options.messages.thread,
        armedEntryId:
          options.messages.armedIdx === null
            ? null
            : (options.messages.thread[options.messages.armedIdx]?.id ?? null),
      })
    : ''
  useEffect(() => {
    if (encoded) publishNativeProjection('ai', JSON.parse(encoded) as unknown)
  }, [encoded])
}
