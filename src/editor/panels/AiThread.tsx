import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { type AiCommand, type BatchValidation, type ValidatedCommand } from '../ai/commands'
import { settingsStore } from '../../settings/settingsStore'
import {
  listChatModels,
  type AppSettings,
  type ChatModelOption,
} from '../../settings/types'
import {
  buildMessages,
  cardResultEntry,
  readToolOf,
  runModelTurn,
} from './aiThreadModel'
import PreviewCard from './PreviewCard'
import type { AiSession, ThreadEntry } from '../ai/session'

/** 模型选择域（逻辑 hook，issue #39 拆分）：应用设置加载、面板内模型
 * 选择与三层派生（可用模型 → 生效模型 → provider key 就绪）。 */
function useAiModels() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  /** 面板内选中的模型 key；null = 跟随设置页默认。 */
  const [modelKey, setModelKey] = useState<string | null>(null)
  // 每次切到 AI 分段重载配置（从设置页回来也能刷新）；
  // key 状态直接从 provider 配置派生（keyEnc 密文存在即已配置）
  useEffect(() => {
    void settingsStore.load().then(setAppSettings)
  }, [])
  const options: ChatModelOption[] = appSettings ? listChatModels(appSettings) : []
  const activeKey =
    modelKey ??
    (appSettings?.defaultChat && options.some((o) => o.key === appSettings.defaultChat)
      ? appSettings.defaultChat
      : options[0]?.key) ??
    null
  const activeOption = options.find((o) => o.key === activeKey) ?? null
  const activeProvider =
    activeOption && appSettings
      ? (appSettings.providers.find((p) => p.id === activeOption.providerId) ?? null)
      : null
  const keyOkByProvider: Record<string, boolean> = Object.fromEntries(
    (appSettings?.providers ?? []).map((p) => [p.id, Boolean(p.keyEnc)]),
  )
  const ready =
    activeOption !== null && activeProvider !== null && keyOkByProvider[activeOption.providerId] === true
  return { options, activeKey, setModelKey, activeOption, activeProvider, keyOkByProvider, ready }
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

/** 用当前画布重建恢复卡片的完整预览，拒绝信任落盘的确认元数据；
 * 历史执行卡标注 historical——撤销栈不跨会话存活，不得宣称可撤销。
 * 条目 id 重定基为 1..n 有界序列：落盘 id 不受信，防止自增越过
 * MAX_SAFE_INTEGER 产生重复 key 与下次加载被归一化丢弃的条目。 */
function restoreThreadEntries(
  initialSession: AiSession | undefined,
  validateCommands: ((commands: AiCommand[]) => BatchValidation | null) | undefined,
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
    if (!validateCommands) return { ...based, card }
    const validation = validateCommands(card.v.commands)
    return validation ? { ...based, card: { ...card, v: validation } } : { ...based, card }
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
          t.map((e) => (e.id === entry.id && e.card?.uncommitted ? { ...e, card: stripExecutionRuntime(e.card) } : e)),
        )
      })
    }
  }, [thread, whenCanvasCommitted, setThread])
}

/** 会话线程域（逻辑 hook，issue #39 拆分）：条目追加、预览卡执行/忽略
 * 与危险批次的两步确认武装态；threadRef 供容器做滚动跟随。 */
function useAiThreadMessages(opts: {
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  readonly initialSession?: AiSession
  readonly onValidateCommands?: (commands: AiCommand[]) => BatchValidation | null
  /** 承载批次的画布文档确认落盘后兑现（见 useAiSessionPersistence 的落盘映射）。 */
  readonly whenCanvasCommitted?: () => Promise<void>
  /** 画布批次计数（§12.2 提交身份）：执行后 +1 记录到卡片，恢复时对账。 */
  readonly aiRevision?: number
}) {
  const [thread, setThread] = useState<ThreadEntry[]>(() =>
    restoreThreadEntries(opts.initialSession, opts.onValidateCommands, opts.aiRevision),
  )
  /** 危险批次的两步确认：处于武装态的会话条目下标，null = 无。 */
  const [armedIdx, setArmedIdx] = useState<number | null>(null)
  /** 会话条目自增 id（组件内稳定 key）：恢复条目已重定基为 1..n，从这里继续。 */
  const entryIdRef = useRef(opts.initialSession?.entries.length ?? 0)
  const nextId = () => ++entryIdRef.current
  const threadRef = useRef<HTMLDivElement>(null)

  /** 会话尾部追加（send 与预览卡回执共用）。 */
  const append = (entries: ThreadEntry[]) => setThread((t) => [...t, ...entries])

  /** 执行预览卡：成功 → 置状态并追加回执；失败 → 错误回执（批次未动）。
   * 成功但画布尚未确认落盘时标注 uncommitted 并记录执行后批次计数——
   * 持久化层据此降级为 pending，画布落盘确认后再写 executed。 */
  const executeCard = (idx: number) => {
    const entry = thread[idx]
    if (entry.card?.status !== 'pending' || !opts.onApplyAiBatch) return
    const aiRevisionAfter = opts.aiRevision === undefined ? undefined : opts.aiRevision + 1
    const err = opts.onApplyAiBatch(entry.card.v.commands)
    // 回执关联卡片 id（可能追加在会话尾部）：未确认落盘的执行按关联剔除回执
    const receipt = {
      ...cardResultEntry(err, entry.card.v.commands.length, nextId),
      cardReceiptFor: entry.id,
    }
    const awaiting = !err && opts.whenCanvasCommitted !== undefined
    setThread((t) => [
      ...t.map((e, i) =>
        i === idx && e.card
          ? {
              ...e,
              card: awaiting
                ? {
                    ...e.card,
                    status: 'executed' as const,
                    uncommitted: true as const,
                    ...(aiRevisionAfter !== undefined ? { aiRevisionAfter } : {}),
                  }
                : { ...e.card, status: err ? ('pending' as const) : ('executed' as const) },
            }
          : e,
      ),
      receipt,
    ])
    setArmedIdx(null)
  }

  const markDismissed = (idx: number) => {
    setThread((t) =>
      t.map((e, i) =>
        i === idx && e.card ? { ...e, card: { ...e.card, status: 'dismissed' as const } } : e,
      ),
    )
    setArmedIdx(null)
  }

  useCanvasCommitConfirmation(thread, setThread, opts.whenCanvasCommitted)

  return { thread, armedIdx, setArmedIdx, threadRef, nextId, append, executeCard, markDismissed }
}

/** 去掉执行确认的运行时标注（落盘确认与持久化映射共用）：uncommitted 与
 * aiRevisionAfter 都只在等待画布落盘期间有意义。 */
function stripExecutionRuntime(card: NonNullable<ThreadEntry['card']>): NonNullable<ThreadEntry['card']> {
  const next = { ...card }
  delete next.uncommitted
  delete next.aiRevisionAfter
  return next
}

/** 去掉回执与卡片的运行时关联标注（不落盘）。 */
function stripReceiptLink(entry: ThreadEntry): ThreadEntry {
  if (entry.cardReceiptFor === undefined) return entry
  const next = { ...entry }
  delete next.cardReceiptFor
  return next
}

/** 落盘映射：未确认画布落盘的执行卡降级为 pending 并剔除其回执（按关联
 * 而非位置——回执总是追加在会话尾部）——画布若尚未持久化，重开后该卡应
 * 重新可执行，而不是同时声称已执行；保留 aiRevisionAfter 供重开时与画布
 * 批次计数对账。其余条目原样落盘（剥掉运行时关联标注）。 */
function persistedEntries(thread: ThreadEntry[]): ThreadEntry[] {
  const uncommitted = new Set(
    thread.filter((entry) => entry.card?.uncommitted).map((entry) => entry.id),
  )
  const entries: ThreadEntry[] = []
  for (const entry of thread) {
    if (
      entry.kind === 'note' &&
      entry.cardReceiptFor !== undefined &&
      uncommitted.has(entry.cardReceiptFor)
    ) {
      continue
    }
    if (entry.card?.uncommitted) {
      const card = { ...stripExecutionRuntime(entry.card), status: 'pending' as const }
      if (entry.card.aiRevisionAfter !== undefined) card.aiRevisionAfter = entry.card.aiRevisionAfter
      entries.push({ ...stripReceiptLink(entry), card })
      continue
    }
    entries.push(stripReceiptLink(entry))
  }
  return entries
}

/** 单轮发送域（逻辑 hook，issue #39 拆分）：输入草稿、画布感知开关与
 * send 动作（用户条目入列 → Agent 循环 → 助手条目/回执入列）。 */
function useAiTurn(opts: {
  readonly activeOption: ChatModelOption | null
  readonly activeProvider: AppSettings['providers'][number] | null
  readonly thread: ThreadEntry[]
  readonly append: (entries: ThreadEntry[]) => void
  readonly nextId: () => number
  readonly setArmedIdx: (idx: number | null) => void
  readonly canvasDigest?: string
  readonly onValidateAi?: (text: string) => BatchValidation | null
  readonly onValidateCommands?: (commands: AiCommand[]) => BatchValidation | null
  readonly onReadNode?: (nodeId: string) => string | null
  readonly onReadSettings?: () => string
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knowsCanvas, setKnowsCanvas] = useState(true)

  const send = async () => {
    const text = draft.trim()
    if (!text || busy || !opts.activeOption || !opts.activeProvider) return
    opts.append([{ id: opts.nextId(), kind: 'msg', role: 'user', text }])
    setDraft('')
    setBusy(true)
    setError(null)
    opts.setArmedIdx(null)
    try {
      // 校验在循环内进行（issue 41）：未通过的批次回喂错误清单让模型有限次
      // 纠错，最终校验结果（通过/耗尽/纯讨论）随循环产出返回
      const entries = await runModelTurn(
        opts.activeProvider,
        opts.activeOption.model,
        buildMessages(opts.thread, text, knowsCanvas, opts.canvasDigest),
        readToolOf(opts.canvasDigest, opts.onReadNode, opts.onReadSettings),
        { commands: opts.onValidateCommands, prose: opts.onValidateAi },
        opts.nextId,
      )
      opts.append(entries)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  return { draft, setDraft, busy, error, knowsCanvas, setKnowsCanvas, send }
}

function useAiSessionPersistence(
  thread: ThreadEntry[],
  initialSessionError: string | null | undefined,
  onSaveSession: ((session: AiSession) => Promise<void>) | undefined,
  initialSessionRetryable: boolean | undefined,
): string | null {
  const [saveError, setSaveError] = useState<string | null>(initialSessionError ?? null)
  const hasMounted = useRef(false)
  /** 带错误进入面板时首帧是否重试落盘：修复回写失败/保存失败（内存是
   * 恢复或最新的会话）可重试；读取失败的空回退会话不可——落盘会覆盖
   * 可能可恢复的原文件，须等用户实际变更对话后才随变更保存。 */
  const retryOnMount = useRef(initialSessionError != null && initialSessionRetryable !== false)
  const saveSessionRef = useRef(onSaveSession)
  useEffect(() => {
    saveSessionRef.current = onSaveSession
  }, [onSaveSession])
  // 项目级错误在挂载后到达（重挂载期保存仍在途、拒绝晚到）时同步展示；
  // 只同步非空值，本地保存结果的清除不被过期 prop 覆盖
  useEffect(() => {
    if (initialSessionError != null) setSaveError(initialSessionError)
  }, [initialSessionError])
  useEffect(() => {
    const first = !hasMounted.current
    hasMounted.current = true
    if (first && !retryOnMount.current) return
    const save = saveSessionRef.current
    if (!save) return
    void save({ schemaVersion: 1, entries: persistedEntries(thread) })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(String(err)))
  }, [thread])
  return saveError
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
  return <div className="pw-ai-thread" ref={threadRef}>
    {saveError && <div className="pw-ai-msg pw-ai-msg-error">聊天记录保存失败：{saveError}</div>}
    {thread.length === 0 && ready && (
      <div className="pw-empty">和 AI 聊聊这一幕怎么写，或让它直接调整画布（会先出改动预览）。</div>
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

/** 模型选择器（§6）：未配置 key 的模型置灰。 */
function AiModelSelect({
  options,
  activeKey,
  keyOkByProvider,
  onSelect,
}: {
  readonly options: ChatModelOption[]
  readonly activeKey: string | null
  readonly keyOkByProvider: Record<string, boolean>
  readonly onSelect: (key: string) => void
}) {
  return (
    <select
      className="pw-ai-model"
      value={activeKey ?? ''}
      aria-label="对话模型"
      title="AI 面板内选择本次会话使用的模型（§6 模型选择器）"
      onChange={(e) => onSelect(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.key} value={o.key} disabled={keyOkByProvider[o.providerId] !== true}>
          {o.providerLabel} · {o.model}
          {keyOkByProvider[o.providerId] ? '' : '（未配置 key）'}
        </option>
      ))}
    </select>
  )
}

/** 输入行：消息输入（Enter 发送）+ 画布感知开关。 */
function AiComposer({
  draft,
  setDraft,
  ready,
  busy,
  knowsCanvas,
  setKnowsCanvas,
  onSend,
}: {
  readonly draft: string
  readonly setDraft: (v: string) => void
  readonly ready: boolean
  readonly busy: boolean
  readonly knowsCanvas: boolean
  readonly setKnowsCanvas: (updater: (v: boolean) => boolean) => void
  readonly onSend: () => void
}) {
  return (
    <div className="pw-ai-input">
      <input
        type="text"
        value={draft}
        placeholder={ready ? '输入消息，Enter 发送…' : '配置后可输入…'}
        aria-label="AI 对话输入"
        disabled={!ready || busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSend()
        }}
      />
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
  if (entry.kind === 'note') return <div className="pw-ai-note">{entry.text}</div>
  if (entry.role === 'user') return <div className="pw-ai-msg pw-ai-msg-user">{entry.text}</div>
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
/** ✦AI 会话面板的对外契约：校验/读工具/执行回调、恢复会话及其持久化通道。 */
interface AiThreadProps {
  readonly onOpenSettings?: () => void
  readonly canvasDigest?: string
  readonly onValidateAi?: (text: string) => BatchValidation | null
  readonly onValidateCommands?: (commands: AiCommand[]) => BatchValidation | null
  readonly onReadNode?: (nodeId: string) => string | null
  readonly onReadSettings?: () => string
  readonly onApplyAiBatch?: (commands: ValidatedCommand[]) => string | null
  /** 承载批次的画布文档确认落盘后兑现；执行卡据此推迟 executed 落盘。 */
  readonly whenCanvasCommitted?: () => Promise<void>
  /** 画布批次计数（§12.2 提交身份）：执行后 +1 记录到卡片，恢复时对账。 */
  readonly aiRevision?: number
  /** 打开项目时恢复的独立会话快照。 */
  readonly initialSession?: AiSession
  readonly initialSessionError?: string | null
  /** 内存会话可否作为挂载重试的落盘内容；读取失败（空回退）时为 false。 */
  readonly initialSessionRetryable?: boolean
  /** 会话变更的独立持久化通道；失败不清空当前内存历史。 */
  readonly onSaveSession?: (session: AiSession) => Promise<void>
}

export default function AiThread({
  onOpenSettings,
  canvasDigest,
  onValidateAi,
  onValidateCommands,
  onReadNode,
  onReadSettings,
  onApplyAiBatch,
  whenCanvasCommitted,
  aiRevision,
  initialSession,
  initialSessionError,
  initialSessionRetryable,
  onSaveSession,
}: AiThreadProps) {
  const m = useAiModels()
  const msg = useAiThreadMessages({
    onApplyAiBatch,
    initialSession,
    onValidateCommands,
    whenCanvasCommitted,
    aiRevision,
  })
  const saveError = useAiSessionPersistence(msg.thread, initialSessionError, onSaveSession, initialSessionRetryable)
  const turn = useAiTurn({
    activeOption: m.activeOption,
    activeProvider: m.activeProvider,
    thread: msg.thread,
    append: msg.append,
    nextId: msg.nextId,
    setArmedIdx: msg.setArmedIdx,
    canvasDigest,
    onValidateAi,
    onValidateCommands,
    onReadNode,
    onReadSettings,
  })
  // 新条目/思考态/错误出现时滚动到底（跟随原内联实现）
  useEffect(() => {
    msg.threadRef.current?.scrollTo({ top: msg.threadRef.current.scrollHeight })
  }, [msg.thread, msg.threadRef, turn.busy, turn.error])
  return (
    <div className="pw-ai">
      {!m.ready && <AiGuide hasModels={m.options.length > 0} onOpenSettings={onOpenSettings} />}
      {m.options.length > 0 && (
        <AiModelSelect
          options={m.options}
          activeKey={m.activeKey}
          keyOkByProvider={m.keyOkByProvider}
          onSelect={m.setModelKey}
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
        onArm={(index) => msg.setArmedIdx(msg.armedIdx === index ? null : index)}
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
      />
    </div>
  )
}
