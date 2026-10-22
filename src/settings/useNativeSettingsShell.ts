/** Native settings transport delegates every mutation to the mounted React settings owner. */
import { useEffect, useRef, useState } from 'react'
import { isSwiftHost } from '../platform/hostEnvironment'
import {
  publishNativeProjection,
  registerNativeIntentHandler,
} from '../platform/nativeShell'
import { settingsStore } from './settingsStore'
import {
  BUILTIN_PROVIDERS,
  listChatModels,
  type AppSettings,
  type ProviderConfig,
} from './types'

/** Current controller state and its existing persistence/close actions; credentials stay private. */
export interface NativeSettingsOptions {
  settings: AppSettings
  phase: 'loading' | 'ready' | 'error'
  error: string | null
  closing: boolean
  loadGeneration: { readonly current: number }
  update: (next: AppSettings) => void
  requestClose: () => Promise<boolean>
  trackPendingKey: (work: Promise<void>) => Promise<void>
  reload: () => void
}

/** Lifetime and per-provider key revisions invalidate asynchronous encryption completions. */
interface IntentState {
  current: NativeSettingsOptions
  active: boolean
  keyRevisions: Map<string, number>
  /** Latest per-field edit identity per provider; bounded to the three draft fields of current providers. */
  editRevisions: Map<string, Map<string, number>>
}

/** Reject unknown fields instead of permitting credential or identity writes through a provider patch. */
function providerPatch(value: unknown): Partial<ProviderConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Provider 修改必须是对象。')
  const patch = value as Record<string, unknown>
  const allowed = new Set(['label', 'baseUrl', 'enabled', 'models'])
  if (Object.keys(patch).some((key) => !allowed.has(key)))
    throw new Error('Provider 修改包含不可编辑字段。')
  if (
    (patch.label !== undefined && typeof patch.label !== 'string') ||
    (patch.baseUrl !== undefined && typeof patch.baseUrl !== 'string') ||
    (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
    (patch.models !== undefined &&
      (!Array.isArray(patch.models) ||
        !patch.models.every((model: unknown) => typeof model === 'string')))
  )
    throw new Error('Provider 修改字段类型无效。')
  return patch as Partial<ProviderConfig>
}

/** Edit identities pair one native field edit with the snapshot that applied it; malformed metadata mutates nothing. */
function providerEditMetadata(
  value: unknown,
  patch: Partial<ProviderConfig>,
): Record<string, number> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Provider 编辑身份必须是对象。')
  const allowed = new Set(['label', 'baseUrl', 'models'])
  const identities: Record<string, number> = {}
  for (const [field, revision] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!allowed.has(field) || !(field in patch))
      throw new Error('Provider 编辑身份字段无效。')
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision <= 0
    )
      throw new Error('Provider 编辑身份必须是正整数。')
    identities[field] = revision
  }
  return identities
}

/** Requires the loaded live provider before any mutation can enter the existing saver. */
function readyProvider(
  state: IntentState,
  id: unknown,
  allowClosing = false,
): ProviderConfig {
  const current = state.current
  if (
    !state.active ||
    current.phase !== 'ready' ||
    (current.closing && !allowClosing)
  )
    throw new Error('设置尚未就绪或正在关闭，不能修改。')
  const provider = current.settings.providers.find((item) => item.id === id)
  if (!provider) throw new Error('Provider 不存在，请重新打开设置。')
  return provider
}

/** Updates the synchronous intent snapshot as well as React so batched native edits compose. */
function commit(state: IntentState, next: AppSettings): void {
  state.current = { ...state.current, settings: next }
  state.current.update(next)
}

/** Replaces only owned provider fields on the latest snapshot, retaining concurrent changes. */
function patchCurrentProvider(
  state: IntentState,
  id: string,
  patch: Partial<ProviderConfig>,
  edit: Record<string, number> = {},
): void {
  if (Object.keys(edit).length > 0) {
    let fields = state.editRevisions.get(id)
    if (!fields) {
      fields = new Map()
      state.editRevisions.set(id, fields)
    }
    for (const [field, revision] of Object.entries(edit))
      fields.set(field, revision)
  }
  const settings = state.current.settings
  commit(state, {
    ...settings,
    providers: settings.providers.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider,
    ),
  })
}

/** Key encryption must not resurrect a removed key, unmounted page, or superseded load. */
async function setKey(
  state: IntentState,
  args: Record<string, unknown>,
): Promise<void> {
  const provider = readyProvider(state, args.id)
  if (typeof args.key !== 'string' || args.key.trim().length === 0)
    throw new Error('API key 不能为空。')
  const generation = state.current.loadGeneration.current
  const revision = (state.keyRevisions.get(provider.id) ?? 0) + 1
  state.keyRevisions.set(provider.id, revision)
  const encrypted = await settingsStore.setProviderKey(
    state.current.settings,
    provider.id,
    args.key.trim(),
  )
  readyProvider(state, provider.id, true)
  if (
    generation !== state.current.loadGeneration.current ||
    revision !== state.keyRevisions.get(provider.id)
  )
    throw new Error('设置已改变，本次密钥结果已失效，请重试。')
  const keyEnc = encrypted.providers.find(
    (item) => item.id === provider.id,
  )?.keyEnc
  if (typeof keyEnc !== 'string') throw new Error('密钥加密结果无效。')
  patchCurrentProvider(state, provider.id, { keyEnc })
}

/** Merges only explicitly selected defaults onto the current owner snapshot; null clears its own field. */
function setDefaults(state: IntentState, args: Record<string, unknown>): void {
  if (!state.active || state.current.phase !== 'ready' || state.current.closing)
    throw new Error('设置尚未就绪或正在关闭，不能修改。')
  const keys = Object.keys(args)
  if (keys.length === 0) throw new Error('默认模型修改不能为空。')
  const next = { ...state.current.settings }
  for (const key of keys) {
    if (key !== 'defaultChat' && key !== 'defaultImage')
      throw new Error('默认模型修改包含不可编辑字段。')
    const value = args[key]
    if (value !== null && typeof value !== 'string')
      throw new Error('默认模型必须是字符串或空值。')
    next[key] = value
  }
  commit(state, next)
}

/** Dispatches only settings-owned commands; close awaits the same fixed-point saver as Web. */
async function runIntent(
  state: IntentState,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  switch (command) {
    case 'settings.patchProvider': {
      const provider = readyProvider(state, args.id)
      const patch = providerPatch(args.patch)
      const edit = providerEditMetadata(args.edit, patch)
      if (
        BUILTIN_PROVIDERS.some((item) => item.id === provider.id) &&
        patch.label !== undefined &&
        patch.label !== provider.label
      )
        throw new Error('内置 Provider 的名称不可修改。')
      patchCurrentProvider(state, provider.id, patch, edit)
      return
    }
    case 'settings.setKey':
      await state.current.trackPendingKey(setKey(state, args))
      return
    case 'settings.removeKey': {
      const provider = readyProvider(state, args.id)
      state.keyRevisions.set(
        provider.id,
        (state.keyRevisions.get(provider.id) ?? 0) + 1,
      )
      patchCurrentProvider(state, provider.id, { keyEnc: undefined })
      return
    }
    case 'settings.setDefaults':
      setDefaults(state, args)
      return
    case 'settings.close':
      if (!(await state.current.requestClose()))
        throw new Error('保存设置失败，请重试关闭。')
      return
    case 'settings.retry':
      if (
        !state.active ||
        state.current.phase === 'ready' ||
        state.current.closing
      )
        throw new Error('当前设置无需重试读取。')
      state.current.reload()
      return
    default:
      throw new Error('未知的设置命令。')
  }
}

/** Published identities stay bounded to each current provider's latest per-field edit. */
function providerEdits(
  state: IntentState,
  id: string,
): { edits?: Record<string, number> } {
  const fields = state.editRevisions.get(id)
  return fields && fields.size > 0 ? { edits: Object.fromEntries(fields) } : {}
}

/** Publishes credential-free snapshots and registers intents while the production owner is mounted. */
export function useNativeSettingsShell(options: NativeSettingsOptions): void {
  const stateRef = useRef<IntentState>({
    current: options,
    active: false,
    keyRevisions: new Map(),
    editRevisions: new Map(),
  })
  stateRef.current.current = options
  const [intentError, setIntentError] = useState<string | null>(null)
  useEffect(() => {
    if (!isSwiftHost()) return
    const state = stateRef.current
    state.active = true
    const off = registerNativeIntentHandler(
      'settings',
      async (command, args) => {
        setIntentError(null)
        try {
          await runIntent(state, command, args)
        } catch (error) {
          if (state.active)
            setIntentError(
              error instanceof Error ? error.message : String(error),
            )
          throw error
        }
      },
    )
    return () => {
      state.active = false
      state.keyRevisions.clear()
      state.editRevisions.clear()
      off()
    }
  }, [])
  useEffect(() => {
    const settings = options.settings
    const state = stateRef.current
    for (const id of state.editRevisions.keys())
      if (!settings.providers.some((provider) => provider.id === id))
        state.editRevisions.delete(id)
    publishNativeProjection('settings', {
      phase: options.phase,
      error: options.error ?? intentError,
      closing: options.closing,
      providers: settings.providers.map(
        ({ id, label, baseUrl, enabled, models, keyEnc }) => ({
          id,
          label,
          baseUrl,
          enabled,
          models,
          keyConfigured: Boolean(keyEnc),
          ...providerEdits(state, id),
        }),
      ),
      defaultChat: settings.defaultChat,
      defaultImage: settings.defaultImage,
      modelOptions: listChatModels(settings).map((item) => ({
        value: item.key,
        label: `${item.providerLabel} · ${item.model}`,
      })),
    })
  }, [options, intentError])
}
