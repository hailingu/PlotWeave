import {
  memo,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  type AiCommand,
  type BatchValidation,
  type ValidatedCommand,
} from '../ai/commands'
import { useSettingsSnapshot } from '../../settings/useSettingsSnapshot'
import { listChatModels, type ChatModelOption } from '../../settings/types'
import { cardResultEntry } from './aiThreadModel'
import { PreviewCard } from './PreviewCard'
import {
  stripExecutionRuntime,
  type AiSession,
  type ThreadEntry,
} from '../ai/session'

import { useAiSessionPersistence } from '../ai/useAiSessionPersistence'
import { revalidatePendingCard, useAiTurn } from './aiThreadTurn'
import { AiTopbar } from './AiThreadTopbar'

export { AiSettingsButton } from './AiThreadTopbar'

/** 模型选择域（逻辑 hook，issue #39 拆分）：应用设置加载、面板内模型
 * 选择与三层派生（可用模型 → 生效模型 → provider key 就绪）。 */
function useAiModels() {
  // 挂载时读一次设置快照（切回 AI 分段即重挂重读，从设置页回来能刷新）；
  // 读取失败保持 null → 空选项走引导（issue #120）；key 状态直接从
  // provider 配置派生（keyEnc 密文存在即已配置）
  const appSettings = useSettingsSnapshot()
  /** 面板内选中的模型 key；null = 跟随设置页默认。 */
  const [modelKey, setModelKey] = useState<string | null>(null)
  const options: ChatModelOption[] = appSettings
    ? listChatModels(appSettings)
    : []
  const activeKey =
    modelKey ??
    (appSettings?.defaultChat &&
    options.some((o) => o.key === appSettings.defaultChat)
      ? appSettings.defaultChat
      : options[0]?.key) ??
    null
  const activeOption = options.find((o) => o.key === activeKey) ?? null
  const activeProvider =
    activeOption && appSettings
      ? (appSettings.providers.find((p) => p.id === activeOption.providerId) ??
        null)
      : null
  const keyOkByProvider: Record<string, boolean> = Object.fromEntries(
    (appSettings?.providers ?? []).map((p) => [p.id, Boolean(p.keyEnc)]),
  )
  const ready =
    activeOption !== null &&
    activeProvider !== null &&
    keyOkByProvider[activeOption.providerId] === true
  return {
    options,
    activeKey,
    setModelKey,
    activeOption,
    activeProvider,
    keyOkByProvider,
    ready,
  }
}

/** 未确认画布落盘的执行卡与画布批次计数核对（§12.2 提交身份）：画布计数
 * 已达执行后计数 = 批次已随画布落盘，恢复为历史执行卡（不可再执行）；
 * 未达 = 未落盘，恢复为待执行卡。核对后剥离 aiRevisionAfter（运行时标注），
 * 再次执行时会重新记录。 */
function reconcilePendingCard(
  card: NonNullable<ThreadEntry['card']>,
  aiRevision: number | undefined,
): NonNullable<ThreadEntry['card']> {
  if (card.aiRevisionAfter === undefined) return card
  const next = { ...card }
  delete next.aiRevisionAfter
  if (aiRevision !== undefined && aiRevision >= card.aiRevisionAfter) {
    return { ...next, status: 'executed', historical: true }
  }
  return { ...next, status: 'pending' }
}

/** 用当前画布重建原先合法卡片的预览，拒绝信任落盘的确认元数据；
 * 校验拒绝卡没有完整原始批次，不能把空命令或合法子集重新判成合法整批。
 * 历史执行卡标注 historical——撤销栈不跨会话存活，不得宣称可撤销。
 * 条目 id 重定基为 1..n 有界序列：落盘 id 不受信，防止自增越过
 * MAX_SAFE_INTEGER 产生重复 key 与下次加载被归一化丢弃的条目。 */
function restoreThreadEntries(
  initialSession: AiSession | undefined,
  validateCommands:
    ((commands: AiCommand[]) => BatchValidation | null) | undefined,
  aiRevision: number | undefined,
): ThreadEntry[] {
  return (initialSession?.entries ?? []).map((entry, index) => {
    const based = { ...entry, id: index + 1 }
    if (based.card?.status === 'executed') {
      return { ...based, card: { ...based.card, historical: true } }
    }
    if (based.card?.status !== 'pending') return based
    const card = reconcilePendingCard(based.card, aiRevision)
    if (card.status === 'executed') return { ...based, card }
    return { ...based, card: revalidatePendingCard(card, validateCommands) }
  })
}

/** 画布落盘确认域（useAiThreadMessages 拆出）：uncommitted 执行卡在承载
 * 批次的画布文档确认落盘后转为已确认 executed。effect 在渲染提交之后运行：
 * 此时登记等待者一定晚于承载批次的文档渲染，在途的旧保存不会被误兑现
 * （见 useEditorPersistence 的 whenCanvasCommitted）。 */
function useCanvasCommitConfirmation(
  thread: ThreadEntry[],
  setThread: Dispatch<SetStateAction<ThreadEntry[]>>,
  whenCanvasCommitted: (() => Promise<void>) | undefined,
): void {
  /** 已登记等待的条目 id：重复渲染不得重复登记等待者。 */
  const awaitingRef = useRef(new Set<number>())
  useEffect(() => {
    if (!whenCanvasCommitted) return
    for (const entry of thread) {
      if (entry.card?.status !== 'executed' || !entry.card.uncommitted) continue
      if (awaitingRef.current.has(entry.id)) continue
      awaitingRef.current.add(entry.id)
      void whenCanvasCommitted().then(() => {
        awaitingRef.current.delete(entry.id)
        setThread((t) =>
          t.map((e) =>
            e.id === entry.id && e.card?.uncommitted
              ? { ...e, card: stripExecutionRuntime(e.card) }
              : e,
          ),
        )
      })
    }
  }, [thread, whenCanvasCommitted, setThread])
}

/** 执行结果写回所属卡片：失败可重试，成功清除旧诊断并按提交身份分流——
 * 带画布确认等待器即标注 uncommitted 并记录对账计数（嵌套形状保证计数
 * 必在，未确认卡不可能没有 aiRevisionAfter 身份），否则立即 executed。 */
function cardAfterExecution(
  card: NonNullable<ThreadEntry['card']>,
  err: string | null,
  identity: AiCommitIdentity | undefined,
): NonNullable<ThreadEntry['card']> {
  const next = stripExecutionRuntime(card)
  delete next.executionError
  if (err) return { ...next, status: 'pending', executionError: err }
  if (identity?.whenCanvasCommitted === undefined)
    return { ...next, status: 'executed' }
  return {
    ...next,
    status: 'executed',
    uncommitted: true,
    aiRevisionAfter: identity.aiRevision + 1,
  }
}

/** 执行预览卡的线程变换（useAiThreadMessages 拆分，issue #99）：成功 →
 * 置状态并追加回执；失败 → 错误回执（批次未动）；提交身份带画布确认
 * 等待器时标注 uncommitted 并记录执行后批次计数——持久化层据此降级为
 * pending，画布落盘确认后再写 executed。回执关联卡片 id（可能追加在
 * 会话尾部）：未确认落盘的执行按关联剔除回执。 */
function applyCardExecution(args: {
  readonly thread: ThreadEntry[]
  readonly setThread: Dispatch<SetStateAction<ThreadEntry[]>>
  readonly setArmedIdx: Dispatch<SetStateAction<number | null>>
  readonly entry: ThreadEntry
  readonly idx: number
  readonly nextId: () => number
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  readonly identity?: AiCommitIdentity
}): void {
  const { setThread, setArmedIdx, entry, idx, nextId } = args
  if (entry.card?.status !== 'pending' || !args.onApplyAiBatch) return
  const err = args.onApplyAiBatch(entry.card.v.commands)
  const receipt = {
    ...cardResultEntry(err, entry.card.v.commands.length, nextId),
    cardReceiptFor: entry.id,
  }
  setThread((t) => [
    ...t.map((e, i) =>
      i === idx && e.card
        ? { ...e, card: cardAfterExecution(e.card, err, args.identity) }
        : e,
    ),
    receipt,
  ])
  setArmedIdx(null)
}

/** 会话线程域（逻辑 hook，issue #39 拆分）：条目追加、预览卡执行/忽略
 * 与危险批次的两步确认武装态；threadRef 供容器做滚动跟随。 */
function useAiThreadMessages(opts: {
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  readonly initialSession?: AiSession
  readonly onValidateCommands?: (
    commands: AiCommand[],
  ) => BatchValidation | null
  /** 提交身份（issue #139）：计数供恢复对账，等待器决定 executed 落盘推迟。 */
  readonly identity?: AiCommitIdentity
}) {
  const [thread, setThread] = useState<ThreadEntry[]>(() =>
    restoreThreadEntries(
      opts.initialSession,
      opts.onValidateCommands,
      opts.identity?.aiRevision,
    ),
  )
  /** 危险批次的两步确认：处于武装态的会话条目下标，null = 无。 */
  const [armedIdx, setArmedIdx] = useState<number | null>(null)
  /** 会话条目自增 id（组件内稳定 key）：恢复条目已重定基为 1..n，从这里继续。 */
  const entryIdRef = useRef(opts.initialSession?.entries.length ?? 0)
  const nextId = () => ++entryIdRef.current
  const threadRef = useRef<HTMLDivElement>(null)

  /** 会话尾部追加（send 与预览卡回执共用）。 */
  const append = (entries: ThreadEntry[]) =>
    setThread((t) => [...t, ...entries])

  /** 执行预览卡：成功 → 置状态并追加回执；失败 → 错误回执（批次未动）。
   * 提交身份带画布确认等待器时标注 uncommitted 并记录执行后批次计数——
   * 持久化层据此降级为 pending，画布落盘确认后再写 executed。 */
  const executeCard = (idx: number) =>
    applyCardExecution({
      thread,
      setThread,
      setArmedIdx,
      entry: thread[idx]!,
      idx,
      nextId,
      onApplyAiBatch: opts.onApplyAiBatch,
      identity: opts.identity,
    })

  const markDismissed = (idx: number) => {
    setThread((t) =>
      t.map((e, i) => {
        if (i !== idx || !e.card) return e
        const card = { ...e.card, status: 'dismissed' as const }
        delete card.executionError
        return { ...e, card }
      }),
    )
    setArmedIdx(null)
  }

  /** 新会话（issue #89）：清空线程与武装态，经条目变更的持久化 effect
   * 落盘空会话（重开不复活）。条目 id 计数器继续自增——id 只需实例内
   * 唯一作渲染 key，恢复时本就按位置重定基，无重置必要。 */
  const resetSession = () => {
    setThread([])
    setArmedIdx(null)
  }

  useCanvasCommitConfirmation(
    thread,
    setThread,
    opts.identity?.whenCanvasCommitted,
  )

  return {
    thread,
    armedIdx,
    setArmedIdx,
    threadRef,
    nextId,
    append,
    executeCard,
    markDismissed,
    resetSession,
  }
}

function AiThreadTimeline({
  thread,
  threadRef,
  armedIdx,
  ready,
  busy,
  error,
  saveError,
  onArm,
  onExecute,
  onDismiss,
}: {
  readonly thread: ThreadEntry[]
  readonly threadRef: { current: HTMLDivElement | null }
  readonly armedIdx: number | null
  readonly ready: boolean
  readonly busy: boolean
  readonly error: string | null
  readonly saveError: string | null
  readonly onArm: (index: number) => void
  readonly onExecute: (index: number) => void
  readonly onDismiss: (index: number) => void
}) {
  // 新条目/思考态/错误出现时滚动到底（自 AiThread 移入：滚动域即时间线）
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [thread, threadRef, busy, error])
  return (
    <div className="pw-ai-thread" ref={threadRef}>
      {saveError && (
        <div className="pw-ai-msg pw-ai-msg-error">
          聊天记录保存失败：{saveError}
        </div>
      )}
      {thread.length === 0 && ready && (
        <div className="pw-empty">
          和 AI 聊聊这一幕怎么写，或让它直接调整画布（会先出改动预览）。
        </div>
      )}
      {thread.map((entry, index) => (
        <div key={entry.id} className="pw-ai-entry">
          <AiEntryBody
            entry={entry}
            armed={armedIdx === index}
            busy={busy}
            onArm={() => onArm(index)}
            onExecute={() => onExecute(index)}
            onDismiss={() => onDismiss(index)}
          />
        </div>
      ))}
      {busy && <div className="pw-ai-thinking">✦ 正在思考…</div>}
      {error && <div className="pw-ai-msg pw-ai-msg-error">{error}</div>}
    </div>
  )
}

/** 未接入引导：无可用模型或所选 provider 缺 key 时的空态与设置入口。 */
function AiGuide({
  hasModels,
  onOpenSettings,
}: {
  readonly hasModels: boolean
  readonly onOpenSettings?: () => void
}) {
  return (
    <div className="pw-ai-guide">
      <div className="pw-ai-guide-title">尚未接入 AI 服务</div>
      <p>
        {hasModels
          ? '所选 provider 尚未配置 API key（加密保存于本机设置）。'
          : '在设置页启用 provider 并添加模型（需先配置 API key）。'}
      </p>
      <button
        type="button"
        className="pw-ai-guide-btn"
        disabled={!onOpenSettings}
        onClick={onOpenSettings}
      >
        前往设置页（⌘,）
      </button>
    </div>
  )
}

/** 输入行（issue #154）：busy 时切换为取消按钮——在途回合可停止（协作式：
 * agentLoop 停止后续循环，在途 llm_chat 不被中止）；画布感知开关常驻。 */
function AiComposer({
  draft,
  setDraft,
  ready,
  busy,
  knowsCanvas,
  setKnowsCanvas,
  onSend,
  onCancel,
}: {
  readonly draft: string
  readonly setDraft: (v: string) => void
  readonly ready: boolean
  readonly busy: boolean
  readonly knowsCanvas: boolean
  readonly setKnowsCanvas: (updater: (v: boolean) => boolean) => void
  readonly onSend: () => void
  readonly onCancel: () => void
}) {
  return (
    <div className="pw-ai-input">
      {busy ? (
        <button
          type="button"
          className="pw-ai-cancel"
          aria-label="取消"
          onClick={onCancel}
        >
          取消
        </button>
      ) : (
        <input
          type="text"
          value={draft}
          placeholder={ready ? '输入消息，Enter 发送…' : '配置后可输入…'}
          aria-label="AI 对话输入"
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSend()
          }}
        />
      )}
      <button
        type="button"
        className={`pw-ai-ctx-toggle${knowsCanvas ? ' on' : ''}`}
        aria-pressed={knowsCanvas}
        title="开启后向 AI 提供画布结构快照"
        onClick={() => setKnowsCanvas((v) => !v)}
      >
        ◈ 了解当前画布
      </button>
    </div>
  )
}

/** 会话条目正文：回执 / 用户消息 / 助手消息（可附预览卡）（S3358 拆分；
 * issue #39 评审修复：自 AiThread 抽出为文件级组件，使容器回到 80 行内）。 */
function AiEntryBody({
  entry,
  armed,
  busy,
  onArm,
  onExecute,
  onDismiss,
}: {
  readonly entry: ThreadEntry
  readonly armed: boolean
  readonly busy: boolean
  readonly onArm: () => void
  readonly onExecute: () => void
  readonly onDismiss: () => void
}) {
  if (entry.kind === 'note')
    return <div className="pw-ai-note">{entry.text}</div>
  if (entry.role === 'user')
    return <div className="pw-ai-msg pw-ai-msg-user">{entry.text}</div>
  return (
    <>
      <div className="pw-ai-msg pw-ai-msg-agent">
        <span className="pw-ai-agent-flag">✦ ASSISTANT</span>
        {entry.text}
      </div>
      {entry.card && (
        <PreviewCard
          v={entry.card.v}
          status={entry.card.status}
          historical={entry.card.historical}
          armed={armed}
          busy={busy}
          onArm={onArm}
          onExecute={onExecute}
          onDismiss={onDismiss}
        />
      )}
    </>
  )
}

/**
 * ✦AI 会话（§6、数据模型 §12.2 朴素 tool-calling 循环）：
 * - 模型选择器：三层过滤后的可用模型（key 未配置的置灰）；
 * - 读工具（画布快照/节点详情）就地执行回喂，最多三轮；
 * - 写工具调用映射为命令批次 → 整批校验 → 改动预览卡 → 用户确认执行，
 *   删除类二次确认，整批一条复合命令入栈、⌘Z 一步回滚；
 * - 服务不支持工具时退回 ```json 围栏批次文本协议。
 * 逻辑在 useAiModels/useAiThreadMessages/useAiTurn，纯函数在 aiThreadModel.ts。
 */
/** 执行卡的提交身份（§12.2 提交身份，[issue #139](https://github.com/hailingu/PlotWeave/issues/139)
 * 收紧）：批次计数必带、画布确认等待器可选——嵌套形状在类型层固定两者
 * 耦合（等待器存在 ⇒ 计数必在）。要推迟 executed 落盘（等待器存在）而
 * 缺计数的装配，会让未确认卡落盘降级 pending 后没有 aiRevisionAfter 对账
 * 身份，重开时已随画布落盘的批次可被再次执行；该误配形态不可构造。
 * 只带计数的形态供恢复会话对账（不等提交）；省略整组为无持久化的隔离
 * 装配——执行成功立即 executed，不进入未确认态。 */
export interface AiCommitIdentity {
  /** 画布批次计数（§12.2 提交身份）：执行后 +1 记录到卡片，恢复时对账。 */
  readonly aiRevision: number
  /** 承载批次的画布文档确认落盘后兑现；执行卡据此推迟 executed 落盘。 */
  readonly whenCanvasCommitted?: () => Promise<void>
}

/** ✦AI 会话面板的对外契约：校验/读工具/执行回调、恢复会话及其持久化通道。 */
interface AiThreadProps {
  /** 项目 id：在途回合跨卸载归属的键（issue #63，见 ai/pendingTurns）。 */
  readonly projectId: string
  readonly onOpenSettings?: () => void
  readonly canvasDigest?: string
  readonly onValidateAi?: (text: string) => BatchValidation | null
  readonly onValidateCommands?: (
    commands: AiCommand[],
  ) => BatchValidation | null
  readonly onReadNode?: (nodeId: string) => string | null
  readonly onReadSettings?: () => string
  /** 读工具 get_document（issue 56）：按 id 返回文档全文 JSON。 */
  readonly onReadDocument?: (documentId: string) => string | null
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  /** 执行卡的提交身份（issue #139）：计数必带、等待器可选；见 AiCommitIdentity。 */
  readonly commitIdentity?: AiCommitIdentity
  /** 打开项目时恢复的独立会话快照。 */
  readonly initialSession?: AiSession
  readonly initialSessionError?: string | null
  /** 内存会话可否作为挂载重试的落盘内容；读取失败（空回退）时为 false。 */
  readonly initialSessionRetryable?: boolean
  /** 会话变更的独立持久化通道；失败不清空当前内存历史。 */
  readonly onSaveSession?: (session: AiSession) => Promise<void>
}

/** 装配会话三域（AiThread 拆分，issue #99）：模型选择、线程消息与回合
 * 驱动；持久化通道挂线程。 */
function useAiThreadAssembly(props: AiThreadProps) {
  const m = useAiModels()
  const msg = useAiThreadMessages({
    onApplyAiBatch: props.onApplyAiBatch,
    initialSession: props.initialSession,
    onValidateCommands: props.onValidateCommands,
    identity: props.commitIdentity,
  })
  const saveError = useAiSessionPersistence(
    msg.thread,
    props.initialSessionError,
    props.onSaveSession,
    props.initialSessionRetryable,
  )
  const turn = useAiTurn({
    projectId: props.projectId,
    activeOption: m.activeOption,
    activeProvider: m.activeProvider,
    thread: msg.thread,
    append: msg.append,
    nextId: msg.nextId,
    setArmedIdx: msg.setArmedIdx,
    canvasDigest: props.canvasDigest,
    onValidateAi: props.onValidateAi,
    onValidateCommands: props.onValidateCommands,
    onReadNode: props.onReadNode,
    onReadSettings: props.onReadSettings,
    onReadDocument: props.onReadDocument,
  })
  return { m, msg, saveError, turn }
}

/** memo 边界（issue #157）：位置帧（拖拽过程帧）不重渲染 AI 会话面板——
 * 输入（画布摘要、提交身份捆绑对象、校验/读取/落地回调、会话快照）在
 * 无内容变化的帧间引用稳定（提交身份由装配层 useMemo 稳定，见
 * EditorView）；会话内交互照常驱动自身状态更新。 */
export const AiThread = memo(function AiThread(props: AiThreadProps) {
  const { m, msg, saveError, turn } = useAiThreadAssembly(props)
  const onOpenSettings = props.onOpenSettings
  return (
    <div className="pw-ai">
      <AiTopbar
        options={m.options}
        activeKey={m.activeKey}
        keyOkByProvider={m.keyOkByProvider}
        onSelect={m.setModelKey}
        onOpenSettings={onOpenSettings}
        onNewSession={() => {
          turn.clearError()
          msg.resetSession()
        }}
        newSessionReady={!turn.busy && msg.thread.length > 0}
      />
      {!m.ready && (
        <AiGuide
          hasModels={m.options.length > 0}
          onOpenSettings={onOpenSettings}
        />
      )}
      <AiThreadTimeline
        thread={msg.thread}
        threadRef={msg.threadRef}
        armedIdx={msg.armedIdx}
        ready={m.ready}
        busy={turn.busy}
        error={turn.error}
        saveError={saveError}
        onArm={(index) =>
          msg.setArmedIdx(msg.armedIdx === index ? null : index)
        }
        onExecute={msg.executeCard}
        onDismiss={msg.markDismissed}
      />
      <AiComposer
        draft={turn.draft}
        setDraft={turn.setDraft}
        ready={m.ready}
        busy={turn.busy}
        knowsCanvas={turn.knowsCanvas}
        setKnowsCanvas={turn.setKnowsCanvas}
        onSend={() => void turn.send()}
        onCancel={() => {
          turn.cancel()
          turn.appendCancelReceipt()
        }}
      />
    </div>
  )
})
