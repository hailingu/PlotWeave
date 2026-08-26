import { useEffect, useRef, useState } from 'react'
import SegmentedControl from './SegmentedControl'
import PanelResizer from './PanelResizer'
import { sendChat, type ChatMessage } from '../ai/chat'
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
}

/**
 * 编辑器右栏（docs/ui-design.md §3.4/§6）：
 * 「检查器 / ✦AI」分段。检查器展示选中节点的派生字段（只读），
 * ✦AI 为对话面板结构占位——BYOK provider 未配置时给引导卡，
 * 输入区常驻「了解当前画布」上下文标识。改动预览卡随后续任务落地。
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
            <AiThread onOpenSettings={onOpenSettings} canvasDigest={canvasDigest} />
          )}
        </div>
      </div>
    </aside>
  )
}

/**
 * ✦AI 会话（§6）：用户 = 品牌渐变右气泡，Agent = 浅色左气泡带 ✦。
 * 输入区常驻「了解当前画布」标识——开启时把画布快照压缩进 system prompt；
 * 未配置 provider/模型时显示引导卡并直达设置页（§8.2）。
 * AI 不直接改动画布：改动预览卡随数据模型 §12 流程评审落地。
 */
function AiThread({
  onOpenSettings,
  canvasDigest,
}: {
  onOpenSettings?: () => void
  canvasDigest?: string
}) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [keyOk, setKeyOk] = useState<boolean | null>(null)
  const [thread, setThread] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knowsCanvas, setKnowsCanvas] = useState(true)
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
    const userMsg: ChatMessage = { role: 'user', content: text }
    const history = [...thread, userMsg]
    setThread(history)
    setDraft('')
    setBusy(true)
    setError(null)
    try {
      const system: ChatMessage = {
        role: 'system',
        content:
          '你是短剧创作助手，帮助编剧讨论剧情结构、人物动机与台词。当前不直接修改画布数据。',
      }
      const messages = [
        system,
        ...(knowsCanvas && canvasDigest
          ? [{ role: 'system' as const, content: `当前画布快照：\n${canvasDigest}` }]
          : []),
        ...history,
      ]
      const reply = await sendChat(chatModel.provider, chatModel.model, messages)
      setThread((t) => [...t, { role: 'assistant', content: reply }])
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
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
          <div className="pw-empty">和 AI 聊聊这一幕怎么写？</div>
        )}
        {thread.map((msg, i) =>
          msg.role === 'user' ? (
            <div key={i} className="pw-ai-msg pw-ai-msg-user">
              {msg.content}
            </div>
          ) : (
            <div key={i} className="pw-ai-msg pw-ai-msg-agent">
              <span className="pw-ai-agent-flag">✦ ASSISTANT</span>
              {msg.content}
            </div>
          ),
        )}
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
