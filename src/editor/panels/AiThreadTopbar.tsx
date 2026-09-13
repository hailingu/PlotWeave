import { useEffect, useState } from 'react'
import { type ChatModelOption } from '../../settings/types'

/**
 * ✦AI 会话面板顶栏（issue #99 从 AiThread.tsx 抽出，使容器回到行数上限内）：
 * 模型选择器、新会话两步确认入口与常驻设置入口；均为纯展示组件，状态经
 * props 进出，装配回调由 AiThread 容器负责。
 */

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
        <option
          key={o.key}
          value={o.key}
          disabled={keyOkByProvider[o.providerId] !== true}
        >
          {o.providerLabel} · {o.model}
          {keyOkByProvider[o.providerId] ? '' : '（未配置 key）'}
        </option>
      ))}
    </select>
  )
}

/** 常驻设置入口按钮（issue #87）：AiTopbar 与会话读取失败态共用。不依赖
 * 配置状态——配置齐全后空态引导消失、会话损坏时聊天操作区不挂载，此处
 * 都是 ⌘, 快捷键之外唯一的可见设置回访入口。 */
export function AiSettingsButton({
  onOpenSettings,
}: {
  readonly onOpenSettings?: () => void
}) {
  return (
    <button
      type="button"
      className="pw-ai-settings-btn"
      aria-label="打开设置"
      title="打开设置页（⌘,）"
      disabled={!onOpenSettings}
      onClick={onOpenSettings}
    >
      ⚙
    </button>
  )
}

/** 新会话入口（issue #89）：两步确认（预览卡删除同款）——清空不可 ⌘Z，
 * 未确认预览卡随会话一并丢弃。空会话或 busy（发送中/认领恢复）时禁用：
 * busy 门闸保证清空时回合注册表必空，迟到回复不可能写入新会话。 */
function AiNewSessionButton({
  ready,
  onNewSession,
}: {
  readonly ready: boolean
  readonly onNewSession?: () => void
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!ready) setArmed(false)
  }, [ready])
  const click = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onNewSession?.()
  }
  return (
    <button
      type="button"
      className={`pw-ai-new-btn${armed ? ' armed' : ''}`}
      title={
        armed
          ? '再点一次确认清空，未确认预览卡将一并丢弃'
          : '开始新的 AI 会话（清空当前对话）'
      }
      disabled={!ready || !onNewSession}
      onClick={click}
    >
      {armed ? '再点一次确认清空' : '新会话'}
    </button>
  )
}

/** 面板顶栏（issue #87）：模型选择器与常驻设置入口同行。设置入口不依赖
 * 配置状态——配置齐全后空态引导消失，此处是 ⌘, 之外唯一的可见回访入口。 */
export function AiTopbar({
  options,
  activeKey,
  keyOkByProvider,
  onSelect,
  onOpenSettings,
  onNewSession,
  newSessionReady,
}: {
  readonly options: ChatModelOption[]
  readonly activeKey: string | null
  readonly keyOkByProvider: Record<string, boolean>
  readonly onSelect: (key: string) => void
  readonly onOpenSettings?: () => void
  /** 开新会话回调；缺省或 newSessionReady=false 时入口禁用（issue #89）。 */
  readonly onNewSession?: () => void
  /** 可清空条件：非 busy 且线程非空（空会话无可清）。 */
  readonly newSessionReady?: boolean
}) {
  return (
    <div className="pw-ai-topbar">
      {options.length > 0 && (
        <AiModelSelect
          options={options}
          activeKey={activeKey}
          keyOkByProvider={keyOkByProvider}
          onSelect={onSelect}
        />
      )}
      <AiNewSessionButton
        ready={newSessionReady === true}
        onNewSession={onNewSession}
      />
      <AiSettingsButton onOpenSettings={onOpenSettings} />
    </div>
  )
}
