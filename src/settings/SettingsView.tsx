import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultSettings,
  resolveChatModel,
  type AppSettings,
  type ProviderConfig,
} from './types'
import { settingsStore } from './settingsStore'
import { useSettingsSaver } from './useSettingsSaver'

/** SettingsViewProps。 */
interface SettingsViewProps {
  /** 关闭设置返回上一界面（编辑器或首页）。 */
  readonly onClose: () => void
}

/** 设置加载状态（issue #120）：加载完成前不渲染编辑表单——彼时编辑
 * 会把初始默认值连同改动全量落盘；失败进入可重试错误态，原文件不动。 */
type SettingsLoadPhase =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/** 设置加载失败分段（issue #120）：可见错误 + 重试 + 原文件保护说明。 */
function SettingsLoadError({
  message,
  onRetry,
}: {
  readonly message: string
  readonly onRetry: () => void
}) {
  return (
    <div className="settings-card" role="alert">
      <p>设置读取失败：{message}</p>
      <p className="settings-hint">
        原配置文件未被改动；修复文件或权限后可重试。此状态下关闭设置不会保存任何更改。
      </p>
      <button type="button" className="pw-dialog-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}

/** 默认模型分段的提示文案：无可用模型 / 已选 / 未选（S3358 独立成函数）。 */
function defaultModelHint(
  optionCount: number,
  chatModel: { provider: ProviderConfig; model: string } | null,
): string {
  if (optionCount === 0)
    return '暂无可用模型：请启用 provider、配置 API key 并添加模型 id。'
  if (chatModel)
    return `当前对话走 ${chatModel.provider.label} · ${chatModel.model}。`
  return '尚未选择默认模型，AI 面板将显示引导。'
}

/** 默认模型分段卡片（§8.2）的依赖：设置快照、写回与可用组合派生。 */
interface DefaultModelsSectionProps {
  readonly settings: AppSettings
  readonly update: (next: AppSettings) => void
  readonly chatOptions: Array<{ value: string; label: string }>
  readonly chatModel: { provider: ProviderConfig; model: string } | null
}

/** 默认模型分段（§8.2）：AI 对话与图像生成（图片节点默认，§13）的默认
 * 模型下拉，候选为三层过滤后的可用组合；未选时 AI 面板显示引导。 */
function DefaultModelsSection({
  settings,
  update,
  chatOptions,
  chatModel,
}: DefaultModelsSectionProps) {
  return (
    <>
      <h3 className="settings-sec">默认模型</h3>
      <div className="settings-card">
        <label className="pw-set-field">
          <span className="pw-set-label">
            AI 对话模型（三层过滤后的可用组合）
          </span>
          <select
            className="pw-set-input"
            value={settings.defaultChat ?? ''}
            onChange={(e) =>
              update({ ...settings, defaultChat: e.target.value || null })
            }
          >
            <option value="">未选择</option>
            {chatOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pw-set-field">
          <span className="pw-set-label">
            图像生成模型（图片节点默认，§13）
          </span>
          <select
            className="pw-set-input"
            value={settings.defaultImage ?? ''}
            onChange={(e) =>
              update({ ...settings, defaultImage: e.target.value || null })
            }
          >
            <option value="">未选择</option>
            {chatOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          图像模型需支持 /images/generations（如
          gpt-image-1）；对话模型不能生图——清单是跨用途共享的模型
          id，请按用途选用。
        </p>
        <p className="settings-hint">
          {defaultModelHint(chatOptions.length, chatModel)}
        </p>
      </div>
    </>
  )
}

/** Provider key 编辑表单族（SettingsView 拆分，issue #99）：草稿/错误
 * 态 + 提交（Rust 加密返回密文 envelope 合并进配置走防抖落盘）/清除。 */
function useProviderKeyForms(
  settings: AppSettings,
  update: (next: AppSettings) => void,
) {
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
  const [keyError, setKeyError] = useState<Record<string, string>>({})
  const patchProvider = (id: string, patch: Partial<ProviderConfig>) => {
    update({
      ...settings,
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
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
  return {
    keyDraft,
    setKeyDraft,
    keyError,
    patchProvider,
    submitKey,
    removeKey,
  }
}

/** 默认模型下拉选项（SettingsView 拆分）：启用且配 Base URL 的
 * provider 的模型清单。 */
function chatModelOptionsOf(settings: AppSettings) {
  return settings.providers
    .filter((p) => p.enabled && p.baseUrl && p.models.length > 0)
    .flatMap((p) =>
      p.models.map((m) => ({
        value: `${p.id}:${m}`,
        label: `${p.label} · ${m}`,
      })),
    )
}

/** 设置页分段导航（SettingsView 拆分，issue #99）：分段列表静态占位。 */
function SettingsNav() {
  return (
    <nav className="settings-nav" aria-label="设置分段">
      <div className="pw-settings-group" style={{ paddingLeft: 0 }}>
        分段
      </div>
      <span className="settings-nav-item on">Provider</span>
      <span className="settings-nav-item">默认模型</span>
    </nav>
  )
}

/** 设置页顶栏与关闭错误（SettingsView 拆分，issue #99）。 */
function SettingsChrome({
  handleClose,
  closing,
  closeError,
}: {
  readonly handleClose: () => void
  readonly closing: boolean
  readonly closeError: string | null
}) {
  return (
    <>
      <header className="editor-titlebar" data-tauri-drag-region>
        <span className="editor-title" data-tauri-drag-region>
          设置
        </span>
        <button
          type="button"
          className="editor-tbtn io"
          onClick={handleClose}
          disabled={closing}
          aria-label="关闭设置"
        >
          {closing ? '保存中…' : '完成'}
        </button>
      </header>
      {closeError !== null && (
        <p
          className="settings-key-error"
          role="alert"
          style={{ margin: '8px 16px 0' }}
        >
          {closeError}
        </p>
      )}
    </>
  )
}

/** API KEY 行（ProviderCard 拆分，issue #99）：不存明文——提交后经 Rust
 * 加密落盘 keyEnc 密文，输入框只持草稿。 */
function ProviderKeyField({
  provider,
  keyConfigured,
  keyDraft,
  keyError,
  onSubmitKey,
  onRemoveKey,
  onKeyDraftChange,
}: {
  readonly provider: ProviderConfig
  readonly keyConfigured: boolean
  readonly keyDraft: string
  readonly keyError: string | undefined
  readonly onSubmitKey: () => void
  readonly onRemoveKey: () => void
  readonly onKeyDraftChange: (value: string) => void
}) {
  return (
    <div className="pw-set-field">
      <span className="pw-set-label">API KEY</span>
      <div className="settings-key-row">
        <span className={`settings-key-state${keyConfigured ? ' ok' : ''}`}>
          {keyConfigured ? '已配置' : '未配置'}
        </span>
        <input
          className="pw-set-input settings-key-input"
          type="password"
          placeholder={keyConfigured ? '更新 key…' : '粘贴 API key'}
          value={keyDraft}
          aria-label={`${provider.label} API key`}
          onChange={(e) => onKeyDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmitKey()
          }}
        />
        <button type="button" className="pw-dialog-btn" onClick={onSubmitKey}>
          保存
        </button>
        {keyConfigured && (
          <button type="button" className="pw-dialog-btn" onClick={onRemoveKey}>
            清除
          </button>
        )}
      </div>
      {keyError && <span className="settings-key-error">{keyError}</span>}
    </div>
  )
}

/** 单个 Provider 卡片（SettingsView 拆分，issue #99）：启用开关、Base
 * URL、API key 行（不存明文，keyEnc 密文落盘）与模型清单编辑。 */
function ProviderCard({
  provider,
  keyConfigured,
  keyDraft,
  keyError,
  onPatch,
  onSubmitKey,
  onRemoveKey,
  onKeyDraftChange,
}: {
  readonly provider: ProviderConfig
  readonly keyConfigured: boolean
  readonly keyDraft: string
  readonly keyError: string | undefined
  readonly onPatch: (patch: Partial<ProviderConfig>) => void
  readonly onSubmitKey: () => void
  readonly onRemoveKey: () => void
  readonly onKeyDraftChange: (value: string) => void
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <b>{provider.label}</b>
        <span className="pw-sp" />
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
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
          value={provider.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
        />
      </label>
      <ProviderKeyField
        provider={provider}
        keyConfigured={keyConfigured}
        keyDraft={keyDraft}
        keyError={keyError}
        onSubmitKey={onSubmitKey}
        onRemoveKey={onRemoveKey}
        onKeyDraftChange={onKeyDraftChange}
      />
      <div className="pw-set-field">
        <span className="pw-set-label">模型（每行一个 id）</span>
        <textarea
          className="pw-set-input"
          rows={3}
          value={provider.models.join('\n')}
          placeholder="例：gpt-4o-mini"
          onChange={(e) =>
            onPatch({
              models: e.target.value
                .split('\n')
                .map((m) => m.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </div>
  )
}

/** 可编辑态主体（SettingsView 拆分，issue #120）：Provider 卡片 + 默认
 * 模型分段 + key 加密说明；含 key 表单族状态，仅在设置加载成功后由
 * SettingsView 挂载——失败/加载中不渲染，编辑入口即被阻断。 */
function SettingsEditorBody({
  settings,
  update,
}: {
  readonly settings: AppSettings
  readonly update: (next: AppSettings) => void
}) {
  const {
    keyDraft,
    setKeyDraft,
    keyError,
    patchProvider,
    submitKey,
    removeKey,
  } = useProviderKeyForms(settings, update)
  // key 状态直接从 provider 配置派生（keyEnc 存在即已配置）
  const keyStatus = Object.fromEntries(
    settings.providers.map((p) => [p.id, Boolean(p.keyEnc)]),
  )
  const chatModel = resolveChatModel(settings)
  const chatOptions = chatModelOptionsOf(settings)
  return (
    <>
      {/* Provider 分段 */}
      <h3 className="settings-sec">Provider</h3>
      {settings.providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          keyConfigured={keyStatus[p.id] === true}
          keyDraft={keyDraft[p.id] ?? ''}
          keyError={keyError[p.id]}
          onPatch={(patch) => patchProvider(p.id, patch)}
          onSubmitKey={() => void submitKey(p.id)}
          onRemoveKey={() => removeKey(p.id)}
          onKeyDraftChange={(value) =>
            setKeyDraft((d) => ({ ...d, [p.id]: value }))
          }
        />
      ))}

      {/* 默认模型分段 */}
      <DefaultModelsSection
        settings={settings}
        update={update}
        chatOptions={chatOptions}
        chatModel={chatModel}
      />
      <p className="settings-hint">
        API key 经 AES-256-GCM
        加密后保存在本机设置文件（绑定此电脑），不回显明文；
        外观跟随系统，不设主题开关。
      </p>
    </>
  )
}

/**
 * 设置页（docs/ui-design.md §8.2 修订）：⌘, 打开，左侧分段列表。
 * Provider 分段：Base URL / 启用 / API key（加密后存本机设置，
 * 不回显明文）/ 模型清单；默认模型分段：三层过滤后的可用组合下拉。
 * 编辑即保存（防抖 500ms，关闭时冲刷未落盘编辑）；无外观设置（跟随
 * 系统，原则 1）。加载完成前不渲染编辑表单，读取失败进入可重试
 * 错误态且不保存（issue #120）。
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [loadPhase, setLoadPhase] = useState<SettingsLoadPhase>({
    status: 'loading',
  })
  /** load 代际（PR #175 评审）：StrictMode 双挂载/重试使新请求先行完成
   * 时，迟到的旧完成不得覆盖修复快照或把界面拉回错误态——仅最新代
   * 可写状态。 */
  const loadGenRef = useRef(0)
  /** 「编辑即保存」状态族（防抖/关闭冲刷/失败重试）拆至 useSettingsSaver。 */
  const { update, handleClose, closeError, closing } = useSettingsSaver(
    setSettings,
    onClose,
  )

  /** 读取设置（issue #120）：成功才进入可编辑态；失败保持错误态可重试，
   * 原配置不被默认值覆盖。完成按代际守卫：仅最新发起的请求可写状态。 */
  const reloadSettings = useCallback(() => {
    const gen = ++loadGenRef.current
    setLoadPhase({ status: 'loading' })
    settingsStore
      .load()
      .then((s) => {
        if (gen !== loadGenRef.current) return // 旧请求迟到完成：丢弃
        setSettings(s)
        setLoadPhase({ status: 'ready' })
      })
      .catch((err: unknown) => {
        if (gen !== loadGenRef.current) return
        setLoadPhase({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      })
  }, [])

  useEffect(() => {
    reloadSettings()
  }, [reloadSettings])

  return (
    <div className="settings-root">
      <SettingsChrome
        handleClose={handleClose}
        closing={closing}
        closeError={closeError}
      />
      <main className="settings-body">
        <SettingsNav />
        <section className="settings-content">
          {loadPhase.status === 'error' && (
            <SettingsLoadError
              message={loadPhase.message}
              onRetry={reloadSettings}
            />
          )}
          {loadPhase.status === 'loading' && (
            <p className="settings-hint">正在加载设置…</p>
          )}
          {loadPhase.status === 'ready' && (
            <SettingsEditorBody settings={settings} update={update} />
          )}
        </section>
      </main>
    </div>
  )
}
