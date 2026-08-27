import { useEffect, useRef, useState } from 'react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import { sendChat, type ChatMessage } from '../ai/chat'
import {
  type AiCommand,
  type BatchValidation,
} from '../ai/commands'
import { settingsStore } from '../../settings/settingsStore'
import { resolveChatModel, type AppSettings } from '../../settings/types'
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
  open: boolean
  width: number
  onResize: (width: number) => void
  tab: RightTab
  onTabChange: (tab: RightTab) => void
  /** 画布当前选中节点；无选中时检查器显示空态。 */
  selectedNode?: CanvasNode
  /** 选中索引卡的 attach 下挂分镜数（§7.2 派生，检查器展示用）。 */
  attachedShotCount?: number
  /** 项目设定集：检查器解析实体引用（§5）。 */
  settings: ProjectSettings
  /** 打开设置页（§8.2 BYOK 配置入口）。 */
  onOpenSettings?: () => void
  /** 画布上下文快照（§6「了解当前画布」）：附到 system prompt。 */
  canvasDigest?: string
  /** 校验助手回复中的命令批次（§6/数据模型 §12）；纯讨论回复返回 null。 */
  onValidateAi?: (text: string) => BatchValidation | null
  /** 执行已确认的批次：整批为一条复合命令入栈，返回错误文案或 null。 */
  onApplyAiBatch?: (commands: AiCommand[]) => string | null
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
              onApplyAiBatch={onApplyAiBatch}
            />
          )}
        </div>
      </div>
    </aside>
  )
}

/** 会话条目：对话消息（助手消息可携带改动预览卡状态）或系统回执。 */
interface ThreadEntry {
  kind: 'msg' | 'note'
  role?: 'user' | 'assistant'
  text: string
  card?: {
    v: BatchValidation
    status: 'pending' | 'executed' | 'dismissed'
  }
}

/**
 * ✦AI 会话（§6、数据模型 §12）：Agent 只产出命令——
 * 讨论走普通气泡；批次命令经 onValidateAi 整批校验后渲染为改动预览卡，
 * 用户确认才执行（删除类二次确认），整批一条复合命令入栈、⌘Z 一步回滚。
 * 输入区常驻「了解当前画布」标识；未配置 provider/模型时显示引导卡（§8.2）。
 */
function AiThread({
  onOpenSettings,
  canvasDigest,
  onValidateAi,
  onApplyAiBatch,
}: {
  onOpenSettings?: () => void
  canvasDigest?: string
  onValidateAi?: (text: string) => BatchValidation | null
  onApplyAiBatch?: (commands: AiCommand[]) => string | null
}) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [keyOk, setKeyOk] = useState<boolean | null>(null)
  const [thread, setThread] = useState<ThreadEntry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knowsCanvas, setKnowsCanvas] = useState(true)
  /** 危险批次的两步确认：处于武装态的会话条目下标，null = 无。 */
  const [armedIdx, setArmedIdx] = useState<number | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // 每次切到 AI 分段重载配置（从设置页回来也能刷新）
  useEffect(() => {
    void settingsStore.load().then(async (s) => {
      setAppSettings(s)
      const chat = resolveChatModel(s)
      setKeyOk(chat ? await settingsStore.hasProviderKey(chat.provider.id).catch(() => false) : null)
    })
  }, [])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [thread, busy, error])

  const chatModel = appSettings ? resolveChatModel(appSettings) : null
  const ready = Boolean(chatModel && keyOk)

  const send = async () => {
    const text = draft.trim()
    if (!text || busy || !chatModel) return
    setThread((t) => [...t, { kind: 'msg', role: 'user', text }])
    setDraft('')
    setBusy(true)
    setError(null)
    setArmedIdx(null)
    try {
      const system: ChatMessage = {
        role: 'system',
        content:
          '你是短剧创作助手，帮助编剧讨论剧情结构、人物动机与台词。\n' +
          '需要改动画布时，Agent 只产出命令（执行前界面会向用户展示改动预览并等待确认，' +
          '所以你不要声称已经完成修改）：在回复中输出一个 ```json 围栏，' +
          '格式 {"commands":[…]}。\n' +
          '命令集：\n' +
          '- {"op":"create_node","nodeType":"scene|beat|dialogue|branch|shot","ref":"临时别名","data":{…}}' +
          '（data 可只写要定制的字段，其余用默认；ref 供后续命令引用新节点）\n' +
          '- {"op":"update_node","nodeId":"id 或 ref","patch":{…}}（只写要改的字段）\n' +
          '- {"op":"delete_node","nodeId":"id 或 ref"}\n' +
          '- {"op":"connect_edge","sourceId":"…","targetId":"…"}（缺省 = 剧情流 sequence）\n' +
          '- {"op":"connect_edge","sourceId":"…","targetId":"…","edgeKind":"branch","optionIndex":0}' +
          '（分支选项出口，optionIndex 从 0 起）\n' +
          '- {"op":"connect_edge","sourceId":"场景id","targetId":"分镜id","edgeKind":"attach"}' +
          '（分镜卡垂直下挂）\n' +
          '- {"op":"disconnect_edge","sourceId":"…","targetId":"…"}\n' +
          '各类型节点字段（data/patch 只接受这些字段）：\n' +
          '- scene 场景：name、sceneNo(场号)、interior(内外景)、locationId、time、weather、synopsis(梗概)、characterIds(在场角色 id 数组)\n' +
          '- beat 节奏卡：name、tone(情绪基调)\n' +
          '- dialogue 对白：name、lines[{kind:"line"|"action", text, speaker(角色 id), side:"left"|"right", vo}]\n' +
          '- branch 分支：prompt(问句)、options[字符串数组]\n' +
          '- shot 分镜卡：shotNo(镜号)、size(景别)、picture(画面描述)、prompt(镜头 Prompt)、refs\n' +
          '画布快照的「剧情流顺序」即大纲投影：重排剧情 = 同一批次内先 disconnect 旧边' +
          '再 connect 新边；调整场次/镜号直接 patch sceneNo/shotNo；\n' +
          '分集：scene/beat/dialogue/branch 支持 episodeNo（数字集号，大纲按它分组，' +
          '快照节点行的「集N」即当前归属）；分镜卡随宿主场景，不可单独分集；\n' +
          '设定集段落给出角色/地点实体 id，写 characterIds/locationId 时引用它们。\n' +
          '规则：只使用快照里出现过的 id（新节点用 ref）；连线不得自环或成环；' +
          '把全部变更放进同一个批次；每条命令可用 "reason" 说明理由。',
      }
      const messages: ChatMessage[] = [
        system,
        ...(knowsCanvas && canvasDigest
          ? [{ role: 'system' as const, content: `当前画布快照：\n${canvasDigest}` }]
          : []),
      ]
      // 历史里的批次文本不再重复喂回（已渲染为预览卡，防止上下文膨胀）
      for (const e of thread) {
        if (e.kind === 'msg') messages.push({ role: e.role ?? 'assistant', content: e.text })
      }
      messages.push({ role: 'user', content: text })
      const reply = await sendChat(chatModel.provider, chatModel.model, messages)
      const v = onValidateAi?.(reply) ?? null
      // 有批次时：围栏 JSON 只进预览卡，气泡与历史回喂都只保留散文部分
      const prose = v ? reply.replace(/```json[\s\S]*?```/gi, '').trim() : reply
      setThread((t) => [
        ...t,
        {
          kind: 'msg',
          role: 'assistant',
          text: prose || '（本次回复只有改动批次，见下方预览卡）',
          ...(v ? { card: { v, status: 'pending' as const } } : {}),
        },
      ])
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 执行预览卡：成功 → 置状态并追加回执；失败 → 错误回执（批次未动）。 */
  const executeCard = (idx: number) => {
    const card = thread[idx].card
    if (!card || card.status !== 'pending' || !onApplyAiBatch) return
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
        ? { kind: 'note' as const, text: `执行失败：${err}` }
        : {
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

  return (
    <div className="pw-ai">
      {!ready && (
        <div className="pw-ai-guide">
          <div className="pw-ai-guide-title">尚未接入 AI 服务</div>
          <p>
            {chatModel === null
              ? '在设置页选择默认对话模型（需先启用 provider 并添加模型）。'
              : '该 provider 尚未配置 API key（存系统钥匙串）。'}
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
      <div className="pw-ai-thread" ref={threadRef}>
        {thread.length === 0 && ready && (
          <div className="pw-empty">和 AI 聊聊这一幕怎么写，或让它直接调整画布（会先出改动预览）。</div>
        )}
        {thread.map((entry, i) => (
          <div key={i} className="pw-ai-entry">
            {entry.kind === 'note' ? (
              <div className="pw-ai-note">{entry.text}</div>
            ) : entry.role === 'user' ? (
              <div className="pw-ai-msg pw-ai-msg-user">{entry.text}</div>
            ) : (
              <>
                <div className="pw-ai-msg pw-ai-msg-agent">
                  <span className="pw-ai-agent-flag">✦ ASSISTANT</span>
                  {entry.text}
                </div>
                {entry.card && <PreviewCard
                  v={entry.card.v}
                  status={entry.card.status}
                  armed={armedIdx === i}
                  busy={busy}
                  onArm={() => setArmedIdx(armedIdx === i ? null : i)}
                  onExecute={() => executeCard(i)}
                  onDismiss={() => markDismissed(i)}
                />}
              </>
            )}
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
  v: BatchValidation
  status: 'pending' | 'executed' | 'dismissed'
  armed: boolean
  busy: boolean
  onArm: () => void
  onExecute: () => void
  onDismiss: () => void
}) {
  if (status === 'dismissed') return null
  return (
    <div className={`pw-ai-card${v.hasDeletes ? ' danger' : ''}`} role="group" aria-label="AI 改动预览">
      <div className="pw-ai-card-head">✦ 改动预览 · {v.commands.length} 项</div>
      {!v.ok && (
        <ul className="pw-ai-issues">
          {v.issues.map((iss, k) => (
            <li key={k} className="pw-ai-issue">第 {iss.index + 1} 条：{iss.message}</li>
          ))}
        </ul>
      )}
      {v.ok && (
        <ul className="pw-ai-items">
          {v.items.map((item, k) => (
            <li key={k} className={`pw-ai-item${item.danger ? ' danger' : ''}`}>
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
              {v.hasDeletes
                ? armed
                  ? '再点一次确认执行删除'
                  : `执行（含 ${v.items.filter((i) => i.danger).length} 项删除）`
                : '✓ 执行改动'}
            </button>
          </>
        )}
      </div>
      {!v.ok && <div className="pw-ai-note">批次未通过校验，画布未发生任何变化。</div>}
    </div>
  )
}
