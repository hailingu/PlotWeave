import { useEffect, useRef, useState } from 'react'
import {
  defaultSettings,
  resolveChatModel,
  type AppSettings,
  type ProviderConfig,
} from './types'
import { settingsStore } from './settingsStore'

interface SettingsViewProps {
  /** 关闭设置返回上一界面（编辑器或首页）。 */
  readonly onClose: () => void
}

/** 默认模型分段的提示文案：无可用模型 / 已选 / 未选（S3358 独立成函数）。 */
function defaultModelHint(
  optionCount: number,
  chatModel: { provider: ProviderConfig; model: string } | null,
): string {
  if (optionCount === 0) return '暂无可用模型：请启用 provider、配置 API key 并添加模型 id。'
  if (chatModel) return `当前对话走 ${chatModel.provider.label} · ${chatModel.model}。`
  return '尚未选择默认模型，AI 面板将显示引导。'
}

/**
 * 设置页（docs/ui-design.md §8.2 修订）：⌘, 打开，左侧分段列表。
 * Provider 分段：Base URL / 启用 / API key（加密后存本机设置，
 * 不回显明文）/ 模型清单；默认模型分段：三层过滤后的可用组合下拉。
 * 编辑即保存（防抖 500ms）；无外观设置（跟随系统，原则 1）。
 */
export default function SettingsView({ onClose }: SettingsViewProps) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void settingsStore.load().then((s) => {
      setSettings(s)
    })
  }, [])

  // 编辑即保存：防抖 500ms 全量落盘
  const update = (next: AppSettings) => {
    setSettings(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void settingsStore.save(next), 500)
  }
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const patchProvider = (id: string, patch: Partial<ProviderConfig>) => {
    update({
      ...settings,
      providers: settings.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    })
  }

  const submitKey = async (providerId: string) => {
    const key = (keyDraft[providerId] ?? '').trim()
    if (!key) return
    try {
      // Rust 加密返回密文 envelope → 合并进 provider 配置走防抖落盘
      update(await settingsStore.setProviderKey(settings, providerId, key))
      setKeyDraft((d) => ({ ...d, [providerId]: '' }))
      setKeyError((e) => ({ ...e, [providerId]: '' }))
    } catch (err) {
      setKeyError((e) => ({ ...e, [providerId]: String(err) }))
    }
  }

  const removeKey = (providerId: string) => {
    patchProvider(providerId, { keyEnc: undefined })
  }

  // key 状态直接从 provider 配置派生（keyEnc 存在即已配置）
  const keyStatus = Object.fromEntries(
    settings.providers.map((p) => [p.id, Boolean(p.keyEnc)]),
  )

  const chatModel = resolveChatModel(settings)
  const chatOptions = settings.providers
    .filter((p) => p.enabled && p.baseUrl && p.models.length > 0)
    .flatMap((p) => p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.label} · ${m}` })))

  return (
    <div className="settings-root">
      <header className="editor-titlebar" data-tauri-drag-region>
        <span className="editor-title" data-tauri-drag-region>
          设置
        </span>
        <button type="button" className="editor-tbtn io" onClick={onClose} aria-label="关闭设置">
          完成
        </button>
      </header>
      <main className="settings-body">
        <nav className="settings-nav" aria-label="设置分段">
          <div className="pw-settings-group" style={{ paddingLeft: 0 }}>
            分段
          </div>
          <span className="settings-nav-item on">Provider</span>
          <span className="settings-nav-item">默认模型</span>
        </nav>
        <section className="settings-content">
          {/* Provider 分段 */}
          <h3 className="settings-sec">Provider</h3>
          {settings.providers.map((p) => (
            <div key={p.id} className="settings-card">
              <div className="settings-card-head">
                <b>{p.label}</b>
                <span className="pw-sp" />
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => patchProvider(p.id, { enabled: e.target.checked })}
                  />
                  {/* 表达式容器显式化文本，避免与前一元素间的空白歧义（S6772）；
                      视觉间距由 .settings-toggle 的 gap 提供 */}
                  {'启用'}
                </label>
              </div>
              <label className="pw-set-field">
                <span className="pw-set-label">BASE URL（OpenAI 兼容）</span>
                <input
                  className="pw-set-input"
                  value={p.baseUrl}
                  onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                />
              </label>
              <div className="pw-set-field">
                <span className="pw-set-label">API KEY</span>
                <div className="settings-key-row">
                  <span className={`settings-key-state${keyStatus[p.id] ? ' ok' : ''}`}>
                    {keyStatus[p.id] ? '已配置' : '未配置'}
                  </span>
                  <input
                    className="pw-set-input settings-key-input"
                    type="password"
                    placeholder={keyStatus[p.id] ? '更新 key…' : '粘贴 API key'}
                    value={keyDraft[p.id] ?? ''}
                    aria-label={`${p.label} API key`}
                    onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitKey(p.id)
                    }}
                  />
                  <button type="button" className="pw-dialog-btn" onClick={() => submitKey(p.id)}>
                    保存
                  </button>
                  {keyStatus[p.id] && (
                    <button type="button" className="pw-dialog-btn" onClick={() => removeKey(p.id)}>
                      清除
                    </button>
                  )}
                </div>
                {keyError[p.id] && <span className="settings-key-error">{keyError[p.id]}</span>}
              </div>
              <div className="pw-set-field">
                <span className="pw-set-label">模型（每行一个 id）</span>
                <textarea
                  className="pw-set-input"
                  rows={3}
                  value={p.models.join('\n')}
                  placeholder="例：gpt-4o-mini"
                  onChange={(e) =>
                    patchProvider(p.id, {
                      models: e.target.value
                        .split('\n')
                        .map((m) => m.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
            </div>
          ))}

          {/* 默认模型分段 */}
          <h3 className="settings-sec">默认模型</h3>
          <div className="settings-card">
            <label className="pw-set-field">
              <span className="pw-set-label">AI 对话模型（三层过滤后的可用组合）</span>
              <select
                className="pw-set-input"
                value={settings.defaultChat ?? ''}
                onChange={(e) => update({ ...settings, defaultChat: e.target.value || null })}
              >
                <option value="">未选择</option>
                {chatOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-hint">{defaultModelHint(chatOptions.length, chatModel)}</p>
          </div>
          <p className="settings-hint">
            API key 经 AES-256-GCM 加密后保存在本机设置文件（绑定此电脑），不回显明文；
            外观跟随系统，不设主题开关。
          </p>
        </section>
      </main>
    </div>
  )
}
