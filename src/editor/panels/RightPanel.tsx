import { useEffect, useRef, useState } from 'react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import { llmChat, type AssistantMessage, type ChatMessage } from '../ai/chat'
import { AI_TOOLS, toolCallsToCommands, type ToolCall } from '../ai/tools'
import { type AiCommand, type BatchValidation } from '../ai/commands'
import { settingsStore } from '../../settings/settingsStore'
import {
  listChatModels,
  type AppSettings,
  type ChatModelOption,
  type ProviderConfig,
} from '../../settings/types'
import {
  resolveCharacterName,
  resolveLocationName,
  type ProjectSettings,
} from '../settings'
import type { CanvasNode } from '../nodes/types'

/** 右栏分段（docs/ui-design.md §3.4）：检查器 = 选中节点的字段视图；✦AI = 对话面板。 */
export type RightTab = 'inspector' | 'ai'

const TABS = [
  { value: 'inspector' as const, label: '检查器' },
  { value: 'ai' as const, label: '✦ AI' },
]

const TYPE_LABELS: Record<CanvasNode['type'], string> = {
  scene: '场景 · 索引卡',
  dialogue: '对白 · 气泡流',
  beat: '节奏卡 · 节拍胶囊',
  branch: '分支 · 岔路路标',
  shot: '分镜卡 · 监视器卡',
}

/** 检查器字段行：按节点类型派生只读视图（编辑随后续 ⚙️ 设置面板任务落地）。 */
function inspectorRows(
  node: CanvasNode,
  shotCount: number,
  settings: ProjectSettings,
): { label: string; value: string }[] {
  switch (node.type) {
    case 'scene': {
      const locationName = node.data.locationId
        ? resolveLocationName(settings, node.data.locationId)
        : null
      return [
        { label: '名称', value: node.data.name },
        { label: '场号', value: `SCENE ${String(node.data.sceneNo).padStart(2, '0')}` },
        { label: '内外景', value: node.data.interior ? '内' : '外' },
        { label: '地点', value: locationName ?? (node.data.locationId ? '（已删除）' : '未指定') },
        { label: '时间', value: node.data.time },
        ...(node.data.weather ? [{ label: '天气', value: node.data.weather }] : []),
        { label: '分镜', value: `🎞 ${shotCount} 镜` },
        { label: '梗概', value: node.data.synopsis },
        {
          label: '在场角色',
          value:
            node.data.characterIds
              .map((id) => resolveCharacterName(settings, id) ?? '（已删除）')
              .join(' / ') || '—',
        },
      ]
    }
    case 'dialogue': {
      const speakers = new Set(
        node.data.lines.flatMap((l) =>
          l.kind === 'line' && l.speaker ? [resolveCharacterName(settings, l.speaker) ?? '（已删除）'] : [],
        ),
      )
      const actions = node.data.lines.filter((l) => l.kind === 'action').length
      return [
        { label: '名称', value: node.data.name },
        { label: '人物', value: [...speakers].join(' / ') },
        { label: '台词', value: `${node.data.lines.length - actions} 句` },
        { label: '动作行', value: `${actions} 行` },
      ]
    }
    case 'beat':
      return [
        { label: '名称', value: node.data.name },
        { label: '基调', value: node.data.tone },
      ]
    case 'branch':
      return [
        { label: '问句', value: node.data.prompt },
        { label: '选项', value: node.data.options.join(' / ') },
      ]
    case 'shot':
      return [
        { label: '镜号', value: `SHOT ${String(node.data.shotNo).padStart(2, '0')}` },
        { label: '景别', value: node.data.size },
        { label: '画面描述', value: node.data.picture },
        { label: '镜头 PROMPT', value: node.data.prompt },
        { label: '引用', value: node.data.refs.map((r) => r.label).join(' / ') || '—' },
      ]
  }
}

interface RightPanelProps {
  readonly open: boolean
  readonly width: number
  readonly onResize: (width: number) => void
  readonly tab: RightTab
  readonly onTabChange: (tab: RightTab) => void
  /** 画布当前选中节点；无选中时检查器显示空态。 */
  readonly selectedNode?: CanvasNode
  /** 选中索引卡的 attach 下挂分镜数（§7.2 派生，检查器展示用）。 */
  readonly attachedShotCount?: number
  /** 项目设定集：检查器解析实体引用（§5）。 */
  readonly settings: ProjectSettings
  /** 打开设置页（§8.2 BYOK 配置入口）。 */
  readonly onOpenSettings?: () => void
  /** 画布上下文快照（§6「了解当前画布」）：附到 system prompt，并作为读工具返回。 */
  readonly canvasDigest?: string
  /** 校验助手回复中的命令批次（§6/数据模型 §12）；纯讨论回复返回 null。 */
  readonly onValidateAi?: (text: string) => BatchValidation | null
  /** 校验工具调用映射出的命令数组（tool-calling 通道）。 */
  readonly onValidateCommands?: (commands: AiCommand[]) => BatchValidation | null
  /** 读工具 get_node：返回节点 JSON 文本，节点不存在返回 null。 */
  readonly onReadNode?: (nodeId: string) => string | null
  /** 执行已确认的批次：整批为一条复合命令入栈，返回错误文案或 null。 */
  readonly onApplyAiBatch?: (commands: AiCommand[]) => string | null
}

/**
 * 编辑器右栏（docs/ui-design.md §3.4/§6）：
 * 「检查器 / ✦AI」分段。检查器展示选中节点的派生字段（只读），
 * ✦AI 会话支持改动预览卡——Agent 产出的命令批次经整批校验后
 * 由用户确认执行（删除类二次确认），整批一步撤销（数据模型 §12）。
 */
export default function RightPanel({
  open,
  width,
  onResize,
  tab,
  onTabChange,
  selectedNode,
  attachedShotCount = 0,
  settings,
  onOpenSettings,
  canvasDigest,
  onValidateAi,
  onValidateCommands,
  onReadNode,
  onApplyAiBatch,
}: RightPanelProps) {
  const rows = selectedNode ? inspectorRows(selectedNode, attachedShotCount, settings) : []

  return (
    <aside
      className={`pw-panel pw-panel-right${open ? '' : ' pw-panel-closed'}`}
      style={{ width: open ? width : 0 }}
      aria-hidden={!open}
    >
      {open && (
        <PanelResizer direction={-1} startWidth={width} onResize={onResize} />
      )}
      <div className="pw-panel-inner" style={{ width }}>
        <div className="pw-panel-head">
          <SegmentedControl groupLabel="右栏分段" options={TABS} value={tab} onChange={onTabChange} />
        </div>
        <div className="pw-panel-scroll">
          {tab === 'inspector' &&
            (selectedNode ? (
              <div className="pw-inspector">
                <div className="pw-inspector-type">{TYPE_LABELS[selectedNode.type]}</div>
                {rows.map((row) => (
                  <div key={row.label} className="pw-inspector-row">
                    <span className="pw-inspector-label">{row.label}</span>
                    <span className="pw-inspector-value">{row.value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pw-empty">在画布中选择一个节点，查看它的字段。</div>
            ))}
          {tab === 'ai' && (
            <AiThread
              onOpenSettings={onOpenSettings}
              canvasDigest={canvasDigest}
              onValidateAi={onValidateAi}
              onValidateCommands={onValidateCommands}
              onReadNode={onReadNode}
              onApplyAiBatch={onApplyAiBatch}
            />
          )}
        </div>
      </div>
    </aside>
  )
}

/** 会话条目：对话消息（助手消息可携带改动预览卡状态）或系统回执。
 * id 为面板内自增序号——条目只追加不删除，作稳定渲染 key（S6479）。 */
interface ThreadEntry {
  id: number
  kind: 'msg' | 'note'
  role?: 'user' | 'assistant'
  text: string
  card?: {
    v: BatchValidation
    status: 'pending' | 'executed' | 'dismissed'
  }
}

/** 助手人格与命令协议说明（§6/数据模型 §12.2）。 */
const SYSTEM_PROMPT =
  '你是短剧创作助手，帮助编剧讨论剧情结构、人物动机与台词。\n' +
  '需要改动画布时，只产出命令：执行前界面会向用户展示改动预览并等待确认，' +
  '所以你不要声称已经完成修改。优先调用工具（推荐把一次改动的全部命令放进' +
  '一个 batch）；服务不支持工具时退回 ```json 围栏批次（格式 {"commands":[…]}）。\n' +
  '需要画布信息时先调用读工具 get_graph_snapshot / get_node。\n' +
  '命令要点：create_node 的 data 只写要定制的字段，ref 供本批后续命令引用' +
  '新节点；update_node_spec 的 patch 只写要改的字段；connect_edge 缺省为剧情流，' +
  'branch 需 optionIndex（0 基），attach 仅 场景→分镜卡；episodeNo 仅' +
  'scene/beat/dialogue/branch 可写（分镜随宿主场景）。\n' +
  '画布快照的「剧情流顺序」即大纲投影：重排剧情 = 同一批次内先 disconnect 旧边' +
  '再 connect 新边；设定集段落给出角色/地点实体 id，写 characterIds/locationId 时引用它们。\n' +
  '规则：只使用快照里出现过的 id（新节点用 ref）；连线不得自环或成环；' +
  '每条命令可用 reason 说明理由。'

/** 组装本次请求的消息序列：系统提示 + 画布快照（可选）+ 会话历史 + 新输入。
 * 历史里的批次文本不再重复喂回（已渲染为预览卡，防止上下文膨胀）。 */
function buildMessages(
  thread: ThreadEntry[],
  text: string,
  knowsCanvas: boolean,
  canvasDigest?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(knowsCanvas && canvasDigest
      ? [{ role: 'system' as const, content: `当前画布快照：\n${canvasDigest}` }]
      : []),
  ]
  for (const e of thread) {
    if (e.kind === 'msg') messages.push({ role: e.role ?? 'assistant', content: e.text })
  }
  messages.push({ role: 'user', content: text })
  return messages
}

/** 朴素 tool-calling 循环（数据模型 §12.2）：读工具就地执行回喂后重问，
 * 最多三轮；产出写命令/错误或纯文本即终止。messages 原地追加。 */
async function runAgentLoop(
  provider: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  readTool: (name: string, args: Record<string, unknown>) => string,
): Promise<{ prose: string; toolCommands: AiCommand[] | null; toolErrors: string[] }> {
  let prose = ''
  let toolCommands: AiCommand[] | null = null
  let toolErrors: string[] = []
  for (let round = 0; round < 3; round++) {
    const reply: AssistantMessage = await llmChat(provider, model, messages, AI_TOOLS)
    const calls: ToolCall[] = reply.tool_calls ?? []
    const { commands: cmds, readRequests, errors } = toolCallsToCommands(calls)
    const hasWrites = cmds.length > 0 || errors.length > 0
    if (hasWrites) {
      prose = (reply.content ?? '').trim()
      toolCommands = cmds
      toolErrors = errors
      break
    }
    if (readRequests.length > 0) {
      messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls })
      for (const r of readRequests) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: readTool(r.name, r.args) })
      }
      continue
    }
    prose = (reply.content ?? '').trim()
    toolErrors = errors
    break
  }
  return { prose, toolCommands, toolErrors }
}

/**
 * ✦AI 会话（§6、数据模型 §12.2 朴素 tool-calling 循环）：
 * - 模型选择器：三层过滤后的可用模型（key 未配置的置灰）；
 * - 读工具（画布快照/节点详情）就地执行回喂，最多三轮；
 * - 写工具调用映射为命令批次 → 整批校验 → 改动预览卡 → 用户确认执行，
 *   删除类二次确认，整批一条复合命令入栈、⌘Z 一步回滚；
 * - 服务不支持工具时退回 ```json 围栏批次文本协议。
 */
function AiThread({
  onOpenSettings,
  canvasDigest,
  onValidateAi,
  onValidateCommands,
  onReadNode,
  onApplyAiBatch,
}: {
  readonly onOpenSettings?: () => void
  readonly canvasDigest?: string
  readonly onValidateAi?: (text: string) => BatchValidation | null
  readonly onValidateCommands?: (commands: AiCommand[]) => BatchValidation | null
  readonly onReadNode?: (nodeId: string) => string | null
  readonly onApplyAiBatch?: (commands: AiCommand[]) => string | null
}) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  /** 面板内选中的模型 key；null = 跟随设置页默认。 */
  const [modelKey, setModelKey] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadEntry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knowsCanvas, setKnowsCanvas] = useState(true)
  /** 危险批次的两步确认：处于武装态的会话条目下标，null = 无。 */
  const [armedIdx, setArmedIdx] = useState<number | null>(null)
  /** 会话条目自增 id（组件内稳定 key）。 */
  const entryIdRef = useRef(0)
  const nextId = () => ++entryIdRef.current
  const threadRef = useRef<HTMLDivElement>(null)

  // 每次切到 AI 分段重载配置（从设置页回来也能刷新）；
  // key 状态直接从 provider 配置派生（keyEnc 密文存在即已配置）
  useEffect(() => {
    void settingsStore.load().then(setAppSettings)
  }, [])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [thread, busy, error])

  const options: ChatModelOption[] = appSettings ? listChatModels(appSettings) : []
  const activeKey =
    modelKey ??
    (appSettings?.defaultChat && options.some((o) => o.key === appSettings.defaultChat)
      ? appSettings.defaultChat
      : options[0]?.key) ??
    null
  const activeOption = options.find((o) => o.key === activeKey) ?? null
  const keyOkByProvider: Record<string, boolean> = Object.fromEntries(
    (appSettings?.providers ?? []).map((p) => [p.id, Boolean(p.keyEnc)]),
  )
  const activeKeyOk = activeOption ? keyOkByProvider[activeOption.providerId] === true : false
  const ready = activeOption !== null && activeKeyOk

  const send = async () => {
    const text = draft.trim()
    if (!text || busy || !appSettings) return
    const provider = activeOption
      ? appSettings.providers.find((p) => p.id === activeOption.providerId)
      : null
    if (!activeOption || !provider) return
    setThread((t) => [...t, { id: nextId(), kind: 'msg', role: 'user', text }])
    setDraft('')
    setBusy(true)
    setError(null)
    setArmedIdx(null)
    try {
      const messages = buildMessages(thread, text, knowsCanvas, canvasDigest)
      const { prose, toolCommands, toolErrors } = await runAgentLoop(
        provider,
        activeOption.model,
        messages,
        executeReadTool,
      )

      // 验证与展示：工具命令直接校验；纯文本走围栏解析（兼容无工具的服务）
      const validation =
        toolCommands && toolCommands.length > 0
          ? (onValidateCommands?.(toolCommands) ?? null)
          : (onValidateAi?.(prose) ?? null)
      let displayText = validation
        ? prose.replace(/```json[\s\S]*?```/gi, '').trim()
        : prose
      if (!displayText && !validation) displayText = '（模型未返回内容）'
      setThread((t) => [
        ...t,
        ...(toolErrors.length > 0
          ? [{ id: nextId(), kind: 'note' as const, text: `⚠ ${toolErrors.join('；')}` }]
          : []),
        {
          id: nextId(),
          kind: 'msg',
          role: 'assistant',
          text: displayText || (validation ? '（本次回复只有改动批次，见下方预览卡）' : ''),
          ...(validation ? { card: { v: validation, status: 'pending' as const } } : {}),
        },
      ])
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 读工具就地执行：快照来自常驻 prop，节点详情按 id 现查。 */
  const executeReadTool = (name: string, args: Record<string, unknown>): string => {
    if (name === 'get_graph_snapshot') return canvasDigest ?? '（画布为空）'
    if (name === 'get_node') {
      const id = typeof args.nodeId === 'string' ? args.nodeId : ''
      return onReadNode?.(id) ?? `node not found: ${id}`
    }
    return `unknown read tool: ${name}`
  }

  /** 执行预览卡：成功 → 置状态并追加回执；失败 → 错误回执（批次未动）。 */
  const executeCard = (idx: number) => {
    const entry = thread[idx]
    if (entry.card?.status !== 'pending' || !onApplyAiBatch) return
    const card = entry.card
    const err = onApplyAiBatch(card.v.commands)
    setThread((t) =>
      t.map((e, i) =>
        i === idx && e.card
          ? { ...e, card: { ...e.card, status: err ? 'pending' : 'executed' } }
          : e,
      ),
    )
    setArmedIdx(null)
    setThread((t) => [
      ...t,
      err
        ? { id: nextId(), kind: 'note' as const, text: `执行失败：${err}` }
        : {
            id: nextId(),
            kind: 'note' as const,
            text: `✓ 已执行 ${card.v.commands.length} 项改动，⌘Z 可整批撤销。`,
          },
    ])
  }

  const markDismissed = (idx: number) => {
    setThread((t) =>
      t.map((e, i) =>
        i === idx && e.card ? { ...e, card: { ...e.card, status: 'dismissed' } } : e,
      ),
    )
    setArmedIdx(null)
  }

  /** 会话条目正文：回执 / 用户消息 / 助手消息（可附预览卡）（S3358 拆分）。 */
  const entryBody = (entry: ThreadEntry, i: number) => {
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
            armed={armedIdx === i}
            busy={busy}
            onArm={() => setArmedIdx(armedIdx === i ? null : i)}
            onExecute={() => executeCard(i)}
            onDismiss={() => markDismissed(i)}
          />
        )}
      </>
    )
  }

  return (
    <div className="pw-ai">
      {!ready && (
        <div className="pw-ai-guide">
          <div className="pw-ai-guide-title">尚未接入 AI 服务</div>
          <p>
            {options.length === 0
              ? '在设置页启用 provider 并添加模型（需先配置 API key）。'
              : '所选 provider 尚未配置 API key（加密保存于本机设置）。'}
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
      )}
      {options.length > 0 && (
        <select
          className="pw-ai-model"
          value={activeKey ?? ''}
          aria-label="对话模型"
          title="AI 面板内选择本次会话使用的模型（§6 模型选择器）"
          onChange={(e) => setModelKey(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.key} value={o.key} disabled={keyOkByProvider[o.providerId] !== true}>
              {o.providerLabel} · {o.model}
              {keyOkByProvider[o.providerId] ? '' : '（未配置 key）'}
            </option>
          ))}
        </select>
      )}
      <div className="pw-ai-thread" ref={threadRef}>
        {thread.length === 0 && ready && (
          <div className="pw-empty">和 AI 聊聊这一幕怎么写，或让它直接调整画布（会先出改动预览）。</div>
        )}
        {thread.map((entry, i) => (
          <div key={entry.id} className="pw-ai-entry">
            {entryBody(entry, i)}
          </div>
        ))}
        {busy && <div className="pw-ai-thinking">✦ 正在思考…</div>}
        {error && <div className="pw-ai-msg pw-ai-msg-error">{error}</div>}
      </div>
      <div className="pw-ai-input">
        <input
          type="text"
          value={draft}
          placeholder={ready ? '输入消息，Enter 发送…' : '配置后可输入…'}
          aria-label="AI 对话输入"
          disabled={!ready || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
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
    </div>
  )
}

const ITEM_ICONS: Record<BatchValidation['items'][number]['kind'], string> = {
  create: '＋',
  update: '✎',
  connect: '⟶',
  disconnect: '⤫',
  delete: '🗑',
}

/** 执行按钮文案：含删除时按武装态分两步（S3358 独立成函数）。 */
function executeLabel(v: BatchValidation, armed: boolean): string {
  if (!v.hasDeletes) return '✓ 执行改动'
  if (armed) return '再点一次确认执行删除'
  return `执行（含 ${v.items.filter((i) => i.danger).length} 项删除）`
}

/**
 * 改动预览卡（§6）：整卡 = 一个 batch 命令。删除项 danger 置顶
 * （校验器已排序）；含删除时执行需两步确认，不提供自动执行开关。
 */
function PreviewCard({
  v,
  status,
  armed,
  busy,
  onArm,
  onExecute,
  onDismiss,
}: {
  readonly v: BatchValidation
  readonly status: 'pending' | 'executed' | 'dismissed'
  readonly armed: boolean
  readonly busy: boolean
  readonly onArm: () => void
  readonly onExecute: () => void
  readonly onDismiss: () => void
}) {
  if (status === 'dismissed') return null
  return (
    // 原生 section 地标承载分组语义（S6819）
    <section className={`pw-ai-card${v.hasDeletes ? ' danger' : ''}`} aria-label="AI 改动预览">
      <div className="pw-ai-card-head">✦ 改动预览 · {v.commands.length} 项</div>
      {!v.ok && (
        <ul className="pw-ai-issues">
          {v.issues.map((iss) => (
            <li key={iss.index} className="pw-ai-issue">第 {iss.index + 1} 条：{iss.message}</li>
          ))}
        </ul>
      )}
      {v.ok && (
        <ul className="pw-ai-items">
          {v.items.map((item) => (
            <li key={item.key} className={`pw-ai-item${item.danger ? ' danger' : ''}`}>
              <span className="pw-ai-item-icon" aria-hidden>{ITEM_ICONS[item.kind]}</span>
              {item.label}
            </li>
          ))}
        </ul>
      )}
      <div className="pw-ai-actions">
        {status === 'executed' ? (
          <span className="pw-ai-note">✓ 已执行，⌘Z 可整批撤销</span>
        ) : (
          <>
            <button
              type="button"
              className="pw-ai-btn"
              disabled={!v.ok || busy}
              onClick={onDismiss}
            >
              忽略
            </button>
            <button
              type="button"
              className={`pw-ai-btn primary${v.hasDeletes ? ' danger' : ''}`}
              disabled={!v.ok || busy}
              onClick={() => {
                if (!v.hasDeletes || armed) onExecute()
                else onArm()
              }}
            >
              {executeLabel(v, armed)}
            </button>
          </>
        )}
      </div>
      {!v.ok && <div className="pw-ai-note">批次未通过校验，画布未发生任何变化。</div>}
    </section>
  )
}
